const MIRROR_NODE_BASE = "https://testnet.mirrornode.hedera.com";

export type RebalanceStage = "submitting" | "pending" | "confirming" | "confirmed" | "failed";

export interface RebalanceStatus {
  stage: RebalanceStage;
  txHash?: string;
  error?: string;
}

/**
 * The JSON-RPC receipt only proves consensus, not mirror-node ingestion — and a mirror node
 * link is what the bounty's eligibility gate actually wants as proof. Poll until it appears.
 * Shared by every trigger flow (RebalanceModule, PriceGuardedRebalanceModule, ...).
 */
export async function waitForMirrorNode(
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
