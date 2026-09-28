import { ethers } from "ethers";
import type { TreasuryToken } from "./safe";

export type { RebalanceStage, RebalanceStatus } from "./txStatus";
export { hashscanTxUrl } from "./txStatus";

const ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, address[] calldata path) view returns (uint256[] memory amounts)"
];

// Built the instant the user clicks "Propose", before their wallet even opens a confirmation
// prompt — a slow or missed wallet popup eats directly into this window. 10 minutes proved too
// tight in practice (a real testnet tx reverted with DeadlinePassed after a slow confirmation);
// 30 minutes matches what most production swap UIs default to for the same reason. A proposal
// awaiting other owners' approval needs even more headroom than a single-click trigger did, so
// this is a floor, not a fixed value — see the Rebalance section for how it's applied.
export const DEADLINE_WINDOW_SECONDS = 1800;
export const DEFAULT_SLIPPAGE_BPS = 100; // 1%

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
