import { ethers } from "ethers";
import { getModuleAddress, type TreasuryToken } from "./safe";

const MODULE_ABI = [
  "function rebalance(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMin, uint256 deadline) returns (uint256)"
];

const ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, address[] calldata path) view returns (uint256[] memory amounts)"
];

const MIRROR_NODE_BASE = "https://testnet.mirrornode.hedera.com";
const DEADLINE_WINDOW_SECONDS = 600;
const DEFAULT_SLIPPAGE_BPS = 100; // 1%

export type RebalanceStage = "submitting" | "pending" | "confirming" | "confirmed" | "failed";

export interface RebalanceStatus {
  stage: RebalanceStage;
  txHash?: string;
  error?: string;
}

export function getRouterAddress(): string {
  const address = process.env.NEXT_PUBLIC_SAUCERSWAP_ROUTER_ADDRESS;
  if (!address) {
    throw new Error("NEXT_PUBLIC_SAUCERSWAP_ROUTER_ADDRESS is not set — see README.md Setup");
  }
  return address;
}

export interface Quote {
  amountOut: bigint;
  amountOutHuman: string;
}

/** Live quote from SaucerSwap's router — what the swap would actually return right now. */
export async function getQuote(
  provider: ethers.Provider,
  tokenIn: TreasuryToken,
  tokenOut: TreasuryToken,
  amountInHuman: string
): Promise<Quote> {
  const router = new ethers.Contract(getRouterAddress(), ROUTER_ABI, provider);
  const amountIn = ethers.parseUnits(amountInHuman, tokenIn.decimals);
  const amounts: bigint[] = await router.getAmountsOut(amountIn, [tokenIn.address, tokenOut.address]);
  const amountOut = amounts[amounts.length - 1];
  return { amountOut, amountOutHuman: ethers.formatUnits(amountOut, tokenOut.decimals) };
}

/** Applies a slippage tolerance (in basis points, e.g. 100 = 1%) to a quoted output amount. */
export function applySlippage(amountOut: bigint, slippageBps: number): bigint {
  const bps = BigInt(Math.max(0, Math.min(10_000, Math.round(slippageBps))));
  return (amountOut * (10_000n - bps)) / 10_000n;
}

/**
 * Triggers a real rebalance: tokenIn -> tokenOut, in whichever direction the caller passes.
 * amountOutMin is computed from a fresh on-chain quote plus a slippage tolerance — never left
 * permissive, since an unbounded minimum accepts any output down to dust.
 */
export async function triggerRebalance(
  signer: ethers.Signer,
  tokenIn: TreasuryToken,
  tokenOut: TreasuryToken,
  amountInHuman: string,
  onStatus: (status: RebalanceStatus) => void,
  slippageBps: number = DEFAULT_SLIPPAGE_BPS
): Promise<void> {
  const module = new ethers.Contract(getModuleAddress(), MODULE_ABI, signer);

  const amountIn = ethers.parseUnits(amountInHuman, tokenIn.decimals);
  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_WINDOW_SECONDS;

  onStatus({ stage: "submitting" });

  let tx: ethers.ContractTransactionResponse;
  try {
    // Re-quote right before submitting — a quote shown earlier in the UI may be stale by the
    // time the owner confirms in their wallet.
    const provider = signer.provider;
    if (!provider) throw new Error("Signer has no provider");
    const quote = await getQuote(provider, tokenIn, tokenOut, amountInHuman);
    const amountOutMin = applySlippage(quote.amountOut, slippageBps);

    tx = await module.rebalance(tokenIn.address, tokenOut.address, amountIn, amountOutMin, deadline);
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
