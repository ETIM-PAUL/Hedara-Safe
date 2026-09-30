import { useEffect, useState } from "react";
import type { BrowserProvider } from "ethers";
import {
  buildRebalanceProposal,
  decodeProposal,
  decodeRebalanceCalldata,
  encodeProposal,
  getApprovals,
  getProposalHash,
  getSafeNonce,
  approveProposal,
  executeProposal,
  type RebalanceProposal,
  type DecodedRebalance
} from "./multisig";
import type { RebalanceStatus } from "./txStatus";

// How often the "is this proposal still valid" check re-runs while one is pending — cheap reads
// (nonce, approvedHashes), and a stale proposal sitting unnoticed for a while is exactly the
// failure mode this exists to catch. The deadline check also needs a ticking clock independent of
// any on-chain read, since a deadline can pass without any new block prompting a re-render.
const STALE_CHECK_INTERVAL_MS = 15_000;

/**
 * State machine behind the Rebalance section once `rebalance()` requires the Safe's own
 * signature quorum (see multisig.ts): build or load a proposal, track which owners have
 * approved its hash on-chain, and execute it. Approving and executing are always two separate,
 * explicit actions — even when an approval happens to cross the threshold, execution still needs
 * its own click via `executeNow()`, so a wallet confirmation for "approve" never silently becomes
 * a second wallet confirmation for "move the treasury's funds."
 */
export function useMultisigRebalance(params: {
  provider: BrowserProvider | null;
  owners: string[];
  threshold: number;
  onConfirmed: () => Promise<void>;
  setToast: (message: string) => void;
}) {
  const { provider, owners, threshold, onConfirmed, setToast } = params;

  const [proposal, setProposal] = useState<RebalanceProposal | null>(null);
  const [decoded, setDecoded] = useState<DecodedRebalance | null>(null);
  const [hash, setHash] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<string[]>([]);
  const [pasteInput, setPasteInput] = useState("");
  const [status, setStatus] = useState<RebalanceStatus | null>(null);
  const [currentNonce, setCurrentNonce] = useState<bigint | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const isRunning = status !== null && status.stage !== "confirmed" && status.stage !== "failed";

  // A pending proposal can go stale two ways: its deadline passes (execution would revert with
  // DeadlinePassed), or another Safe transaction executes in the meantime, bumping the nonce its
  // hash was built against (execution would revert on signature/hash mismatch). Neither shows up
  // on its own — the deadline needs a ticking clock, the nonce needs a fresh on-chain read.
  const isExpired = decoded !== null && decoded.deadline * 1000 <= now;
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

  async function refreshApprovals(currentHash: string) {
    if (!provider) return [];
    const current = await getApprovals(provider, owners, currentHash);
    setApprovals(current);
    return current;
  }

  /** Builds a brand-new proposal from the swap form and casts the proposer's own approval. */
  async function propose(
    signer: import("ethers").Signer,
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
    amountOutMin: bigint,
    deadline: number
  ) {
    if (!provider) return;
    setStatus(null);
    const built = await buildRebalanceProposal(provider, tokenIn, tokenOut, amountIn, amountOutMin, deadline);
    const txHash = await getProposalHash(provider, built);
    setProposal(built);
    setDecoded(decodeRebalanceCalldata(built.data));
    setHash(txHash);

    await approveProposal(signer, txHash, setStatus);
    const current = await refreshApprovals(txHash);
    notifyApprovalOutcome(current);
  }

  /** Loads a proposal another owner shared out of band (there's no backend to relay it) — decodes
   * it for review before this owner approves anything. */
  async function loadProposal(blob: string) {
    if (!provider) return;
    try {
      const loaded = decodeProposal(blob);
      const txHash = await getProposalHash(provider, loaded);
      setProposal(loaded);
      setDecoded(decodeRebalanceCalldata(loaded.data));
      setHash(txHash);
      setStatus(null);
      await refreshApprovals(txHash);
    } catch (error) {
      setToast((error as Error).message);
    }
  }

  async function approve(signer: import("ethers").Signer) {
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
      setToast("Approved — threshold met. Click \"Execute now\" to send the swap.");
    }
  }

  async function executeNow(signer: import("ethers").Signer) {
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
    propose,
    loadProposal,
    approve,
    executeNow,
    reset,
    shareableBlob: proposal ? encodeProposal(proposal) : null
  };
}
