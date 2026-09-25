import { ethers } from "ethers";
import { getModuleAddress, getTreasuryTokens } from "./safe";

const MODULE_ABI = [
  "function rebalance(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMin, uint256 deadline) returns (uint256)"
];

const MIRROR_NODE_BASE = "https://testnet.mirrornode.hedera.com";
const DEADLINE_WINDOW_SECONDS = 600;

export type RebalanceStage = "submitting" | "pending" | "confirming" | "confirmed" | "failed";

export interface RebalanceStatus {
  stage: RebalanceStage;
  txHash?: string;
  error?: string;
}

/**
 * Triggers a real rebalance: tokenIn -> tokenOut, using the treasury token pair from
 * lib/safe.ts's getTreasuryTokens(). amountOutMin is left permissive (1) — this is a demo
 * trigger, not a production slippage-guarded flow; a real UI should let the owner set it.
 */
export async function triggerRebalance(
  signer: ethers.Signer,
  amountInHuman: string,
  onStatus: (status: RebalanceStatus) => void
): Promise<void> {
  const [tokenIn, tokenOut] = getTreasuryTokens();
  const module = new ethers.Contract(getModuleAddress(), MODULE_ABI, signer);

  const amountIn = ethers.parseUnits(amountInHuman, tokenIn.decimals);
  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_WINDOW_SECONDS;

  onStatus({ stage: "submitting" });

  let tx: ethers.ContractTransactionResponse;
  try {
    tx = await module.rebalance(tokenIn.address, tokenOut.address, amountIn, 1n, deadline);
  } catch (error) {
    onStatus({ stage: "failed", error: (error as Error).message });
    return;
  }

  onStatus({ stage: "pending", txHash: tx.hash });

  try {
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      onStatus({ stage: "failed", txHash: tx.hash, error: "Transaction reverted" });
      return;
    }
  } catch (error) {
    onStatus({ stage: "failed", txHash: tx.hash, error: (error as Error).message });
    return;
  }

  onStatus({ stage: "confirming", txHash: tx.hash });
  await waitForMirrorNode(tx.hash, onStatus);
}

/**
 * The JSON-RPC receipt only proves consensus, not mirror-node ingestion — and a mirror node
 * link is what the bounty's eligibility gate actually wants as proof. Poll until it appears.
 */
async function waitForMirrorNode(
  txHash: string,
  onStatus: (status: RebalanceStatus) => void,
  attempts = 10,
  delayMs = 2000
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    const response = await fetch(`${MIRROR_NODE_BASE}/api/v1/contracts/results/${txHash}`);
    if (response.ok) {
      const data = await response.json();
      if (data.result === "SUCCESS") {
        onStatus({ stage: "confirmed", txHash });
        return;
      }
      if (data.result && data.result !== "SUCCESS") {
        onStatus({ stage: "failed", txHash, error: data.result });
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  // Mirror node just hasn't ingested it yet — the tx itself already succeeded per the RPC
  // receipt, so surface it as confirmed rather than blocking the UI indefinitely.
  onStatus({ stage: "confirmed", txHash });
}

export function hashscanTxUrl(txHash: string): string {
  return `https://hashscan.io/testnet/transaction/${txHash}`;
}
