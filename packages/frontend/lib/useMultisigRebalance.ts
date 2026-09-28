import { useState } from "react";
import type { BrowserProvider } from "ethers";
import {
  buildRebalanceProposal,
  decodeProposal,
  decodeRebalanceCalldata,
  encodeProposal,
  getApprovals,
  getProposalHash,
  approveProposal,
  executeProposal,
  type RebalanceProposal,
  type DecodedRebalance
} from "./multisig";
import type { RebalanceStatus } from "./txStatus";

/**
 * State machine behind the Rebalance section once `rebalance()` requires the Safe's own
 * signature quorum (see multisig.ts): build or load a proposal, track which owners have
 * approved its hash on-chain, and execute the moment enough of them have — automatically, if the
 * approval that just landed is the one that crosses the threshold, so a 1-of-N Safe still feels
 * like a single click.
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

  const isRunning = status !== null && status.stage !== "confirmed" && status.stage !== "failed";

  function reset() {
    setProposal(null);
    setDecoded(null);
    setHash(null);
    setApprovals([]);
    setPasteInput("");
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
    await maybeAutoExecute(signer, built, current, txHash);
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
    await approveProposal(signer, hash, setStatus);
    const current = await refreshApprovals(hash);
    await maybeAutoExecute(signer, proposal, current, hash);
  }

  async function maybeAutoExecute(
    signer: import("ethers").Signer,
    activeProposal: RebalanceProposal,
    currentApprovals: string[],
    currentHash: string
  ) {
    if (currentApprovals.length < threshold) {
      setToast(
        `Approved — waiting for ${threshold - currentApprovals.length} more owner approval(s) before this can execute.`
      );
      return;
    }
    await executeProposal(signer, activeProposal, currentApprovals, setStatus);
    if (provider) await refreshApprovals(currentHash);
    await onConfirmed();
  }

  async function executeNow(signer: import("ethers").Signer) {
    if (!provider || !proposal || !hash) return;
    const current = await refreshApprovals(hash);
    if (current.length < threshold) {
      setToast(`Still need ${threshold - current.length} more owner approval(s).`);
      return;
    }
    await executeProposal(signer, proposal, current, setStatus);
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
    propose,
    loadProposal,
    approve,
    executeNow,
    reset,
    shareableBlob: proposal ? encodeProposal(proposal) : null
  };
}
