import { useEffect, useState } from "react";
import type { BrowserProvider, Signer } from "ethers";
import {
  decodeProposal,
  decodeProposalAction,
  encodeProposal,
  getApprovals,
  getProposalHash,
  getSafeNonce,
  approveProposal,
  executeProposal,
  type SafeProposal,
  type DecodedAction,
  type ProposalKind
} from "./multisig";
import { getProposalsTopicId, publishProposal, fetchRecentProposals, type TopicProposal } from "./hcs";
import type { RebalanceStatus } from "./txStatus";

// How often the "is this proposal still valid" check re-runs while one is pending — cheap reads
// (nonce, approvedHashes), and a stale proposal sitting unnoticed for a while is exactly the
// failure mode this exists to catch. The deadline check also needs a ticking clock independent of
// any on-chain read, since a deadline can pass without any new block prompting a re-render.
const STALE_CHECK_INTERVAL_MS = 15_000;

export interface TopicProposalPreview {
  topic: TopicProposal;
  proposal: SafeProposal;
  action: DecodedAction;
}

/**
 * State machine behind any Safe-quorum action — a rebalance or an owner add/remove, both built on
 * the same `execTransaction`/`approveHash` plumbing in multisig.ts (see that file's header).
 * Generic over *which* kind(s) of proposal this instance deals with (`relevantKinds`), so the
 * Rebalance section and the Owners section each get their own instance of this hook with their
 * own independent pending-proposal state, while both read/write the same shared HCS topic and
 * filter to only the proposal kinds they care about.
 *
 * Approving and executing are always two separate, explicit actions — even when an approval
 * happens to cross the threshold, execution still needs its own click via `executeNow()`, so a
 * wallet confirmation for "approve" never silently becomes a second wallet confirmation for
 * "move the treasury's funds" or "change who controls the Safe."
 */
export function useMultisigRebalance(params: {
  provider: BrowserProvider | null;
  owners: string[];
  threshold: number;
  relevantKinds: ProposalKind[];
  onConfirmed: () => Promise<void>;
  setToast: (message: string) => void;
}) {
  const { provider, owners, threshold, relevantKinds, onConfirmed, setToast } = params;

  const [proposal, setProposal] = useState<SafeProposal | null>(null);
  const [decoded, setDecoded] = useState<DecodedAction | null>(null);
  const [hash, setHash] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<string[]>([]);
  const [pasteInput, setPasteInput] = useState("");
  const [status, setStatus] = useState<RebalanceStatus | null>(null);
  const [currentNonce, setCurrentNonce] = useState<bigint | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [recentProposals, setRecentProposals] = useState<TopicProposalPreview[]>([]);
  const [recentProposalsLoading, setRecentProposalsLoading] = useState(false);

  const isRunning = status !== null && status.stage !== "confirmed" && status.stage !== "failed";

  // A pending proposal can go stale two ways: its deadline passes (rebalance only — execution
  // would revert with DeadlinePassed), or another Safe transaction executes in the meantime,
  // bumping the nonce its hash was built against (execution would revert on signature/hash
  // mismatch, any proposal kind). Neither shows up on its own — the deadline needs a ticking
  // clock, the nonce needs a fresh on-chain read.
  const isExpired = decoded !== null && decoded.kind === "rebalance" && decoded.deadline * 1000 <= now;
  const isStaleNonce = proposal !== null && currentNonce !== null && BigInt(proposal.nonce) !== currentNonce;
  const isStale = isExpired || isStaleNonce;

  useEffect(() => {
    if (!proposal) return;
    const timer = setInterval(() => setNow(Date.now()), STALE_CHECK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [proposal]);

  useEffect(() => {
    if (!proposal || !provider) {
      setCurrentNonce(null);
      return;
    }
    let cancelled = false;
    const check = () => {
      getSafeNonce(provider)
        .then((n) => {
          if (!cancelled) setCurrentNonce(n);
        })
        .catch(() => {
          /* transient RPC hiccup — next interval tick will retry */
        });
    };
    check();
    const timer = setInterval(check, STALE_CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [proposal, provider]);

  function reset() {
    setProposal(null);
    setDecoded(null);
    setHash(null);
    setApprovals([]);
    setPasteInput("");
    setCurrentNonce(null);
  }

  async function refreshRecentProposals() {
    if (!getProposalsTopicId()) return;
    setRecentProposalsLoading(true);
    try {
      const topicMessages = await fetchRecentProposals();
      const previews: TopicProposalPreview[] = [];
      for (const topic of topicMessages) {
        try {
          const decodedProposal = decodeProposal(topic.blob);
          if (!relevantKinds.includes(decodedProposal.kind)) continue;
          previews.push({ topic, proposal: decodedProposal, action: decodeProposalAction(decodedProposal) });
        } catch {
          // Not a proposal this UI understands (different kind's calldata, old format, garbage) —
          // skip it rather than let one bad message break the whole list.
        }
      }
      setRecentProposals(previews);
    } catch {
      setToast("Couldn't reach the mirror node to load proposals — try Refresh in a moment.");
    } finally {
      setRecentProposalsLoading(false);
    }
  }

  // Loads the topic's recent messages once there's a reason to look — no active proposal of our
  // own yet, and an owner might need to pick one up from another owner's session.
  useEffect(() => {
    if (proposal) return;
    refreshRecentProposals();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposal]);

  async function refreshApprovals(currentHash: string) {
    if (!provider) return [];
    const current = await getApprovals(provider, owners, currentHash);
    setApprovals(current);
    return current;
  }

  /** Adopts a freshly built proposal (from buildRebalanceProposal/buildAddOwnerProposal/
   * buildRemoveOwnerProposal in multisig.ts) and casts the proposer's own approval. */
  async function propose(signer: Signer, built: SafeProposal) {
    if (!provider) return;
    setStatus(null);
    const txHash = await getProposalHash(provider, built);
    setProposal(built);
    setDecoded(decodeProposalAction(built));
    setHash(txHash);

    await approveProposal(signer, txHash, setStatus);
    const current = await refreshApprovals(txHash);
    notifyApprovalOutcome(current);

    // Best-effort — if this fails (relay not configured, transient error), the Copy-to-share
    // button is still right there as a fallback. Never blocks the approval that already landed.
    const published = await publishProposal(encodeProposal(built));
    if (!published && getProposalsTopicId()) {
      setToast("Approved, but couldn't publish to the proposal topic — use Copy to share it instead.");
    }
  }

  /** Loads a proposal another owner shared out of band (there's no backend to relay it) — decodes
   * it for review before this owner approves anything. */
  async function loadProposal(blob: string) {
    if (!provider) {
      setToast("Connect a wallet first.");
      return;
    }
    try {
      const loaded = decodeProposal(blob);
      if (!relevantKinds.includes(loaded.kind)) {
        setToast("That proposal doesn't belong in this section.");
        return;
      }
      const txHash = await getProposalHash(provider, loaded);
      setProposal(loaded);
      setDecoded(decodeProposalAction(loaded));
      setHash(txHash);
      setStatus(null);
      await refreshApprovals(txHash);
    } catch (error) {
      setToast((error as Error).message);
    }
  }

  async function approve(signer: Signer) {
    if (!provider || !proposal || !hash) return;
    if (isStale) {
      setToast("This proposal is stale — discard it and propose again.");
      return;
    }
    await approveProposal(signer, hash, setStatus);
    const current = await refreshApprovals(hash);
    notifyApprovalOutcome(current);
  }

  function notifyApprovalOutcome(currentApprovals: string[]) {
    if (currentApprovals.length < threshold) {
      setToast(
        `Approved — waiting for ${threshold - currentApprovals.length} more owner approval(s) before this can execute.`
      );
    } else {
      setToast('Approved — threshold met. Click "Execute now" to send it.');
    }
  }

  async function executeNow(signer: Signer) {
    if (!provider || !proposal || !hash) return;
    if (isStale) {
      setToast("This proposal is stale — discard it and propose again.");
      return;
    }
    const current = await refreshApprovals(hash);
    if (current.length < threshold) {
      setToast(`Still need ${threshold - current.length} more owner approval(s).`);
      return;
    }
    const executed = await executeProposal(signer, proposal, current, setStatus);
    if (executed) reset();
    await onConfirmed();
  }

  return {
    proposal,
    decoded,
    hash,
    approvals,
    pasteInput,
    setPasteInput,
    status,
    isRunning,
    isExpired,
    isStaleNonce,
    isStale,
    recentProposals,
    recentProposalsLoading,
    refreshRecentProposals,
    hasProposalsTopic: getProposalsTopicId() !== null,
    propose,
    loadProposal,
    approve,
    executeNow,
    reset,
    shareableBlob: proposal ? encodeProposal(proposal) : null
  };
}
