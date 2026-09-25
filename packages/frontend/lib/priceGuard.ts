import { ethers } from "ethers";
import { type TreasuryToken } from "./safe";
import { waitForMirrorNode, type RebalanceStatus } from "./txStatus";

const PRICE_GUARD_ABI = [
  "function trigger(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMin, uint256 deadline, bytes[] calldata priceUpdateData) payable returns (uint256)",
  "function setTrigger(int64 _triggerPrice, int32 _triggerExpo, uint8 _comparison, uint256 _maxPriceAgeSeconds)",
  "function triggerPrice() view returns (int64)",
  "function triggerExpo() view returns (int32)",
  "function comparison() view returns (uint8)",
  "function maxPriceAgeSeconds() view returns (uint256)",
  "function pyth() view returns (address)",
  "function priceId() view returns (bytes32)"
];

const PYTH_ABI = [
  "function getPriceUnsafe(bytes32 id) view returns (int64 price, uint64 conf, int32 expo, uint256 publishTime)"
];

export enum Comparison {
  Below = 0,
  Above = 1
}

export function getPriceGuardAddress(): string {
  const address = process.env.NEXT_PUBLIC_PRICE_GUARD_MODULE_ADDRESS;
  if (!address) {
    throw new Error("NEXT_PUBLIC_PRICE_GUARD_MODULE_ADDRESS is not set — see README.md Setup");
  }
  return address;
}

export interface PriceGuardState {
  triggerPrice: bigint;
  triggerExpo: number;
  comparison: Comparison;
  maxPriceAgeSeconds: bigint;
  observedPrice: bigint;
  observedExpo: number;
  observedAgeSeconds: number;
  conditionMet: boolean;
}

/** Scales two Pyth-style (price, expo) pairs to a common exponent before comparing — mirrors
 * the contract's own normalize() so the UI never disagrees with what will actually happen on-chain. */
function compareNormalized(
  observedPrice: bigint,
  observedExpo: number,
  triggerPrice: bigint,
  triggerExpo: number,
  comparison: Comparison
): boolean {
  let a = observedPrice;
  let b = triggerPrice;
  if (observedExpo !== triggerExpo) {
    if (observedExpo < triggerExpo) {
      b = b * 10n ** BigInt(triggerExpo - observedExpo);
    } else {
      a = a * 10n ** BigInt(observedExpo - triggerExpo);
    }
  }
  return comparison === Comparison.Below ? a <= b : a >= b;
}

export async function getPriceGuardState(provider: ethers.Provider): Promise<PriceGuardState> {
  const module = new ethers.Contract(getPriceGuardAddress(), PRICE_GUARD_ABI, provider);
  const [triggerPrice, triggerExpo, comparison, maxPriceAgeSeconds, pythAddress, priceId] = await Promise.all([
    module.triggerPrice(),
    module.triggerExpo(),
    module.comparison(),
    module.maxPriceAgeSeconds(),
    module.pyth(),
    module.priceId()
  ]);

  const pyth = new ethers.Contract(pythAddress, PYTH_ABI, provider);
  const observed = await pyth.getPriceUnsafe(priceId);
  const observedAgeSeconds = Math.floor(Date.now() / 1000) - Number(observed.publishTime);
  const comparisonValue = Number(comparison) as Comparison;

  return {
    triggerPrice,
    triggerExpo: Number(triggerExpo),
    comparison: comparisonValue,
    maxPriceAgeSeconds,
    observedPrice: observed.price,
    observedExpo: Number(observed.expo),
    observedAgeSeconds,
    conditionMet: compareNormalized(
      observed.price,
      Number(observed.expo),
      triggerPrice,
      Number(triggerExpo),
      comparisonValue
    )
  };
}

export function formatPythPrice(price: bigint, expo: number): string {
  const value = Number(price) * Math.pow(10, expo);
  return value.toFixed(6);
}

/**
 * Fires PriceGuardedRebalanceModule.trigger(). Passes an empty priceUpdateData array — Pyth's
 * Hermes API (the off-chain service for fresh signed updates) now requires an API key we haven't
 * wired in here, so this reads whatever price is already stored on the testnet contract rather
 * than pushing a new one. getUpdateFee([]) is 0, so no value is sent. See README's "Known
 * limitation" note. A production integration should fetch real update data server-side (never
 * expose a Hermes key to the browser) and pay the real fee.
 */
export async function triggerPriceGuard(
  signer: ethers.Signer,
  tokenIn: TreasuryToken,
  tokenOut: TreasuryToken,
  amountInHuman: string,
  onStatus: (status: RebalanceStatus) => void
): Promise<void> {
  const module = new ethers.Contract(getPriceGuardAddress(), PRICE_GUARD_ABI, signer);
  const amountIn = ethers.parseUnits(amountInHuman, tokenIn.decimals);
  // Same 30-minute window as rebalance.ts, for the same reason — see its DEADLINE_WINDOW_SECONDS
  // comment. A real testnet trigger reverted with DeadlinePassed after a slow wallet confirmation
  // at the old 10-minute window.
  const deadline = Math.floor(Date.now() / 1000) + 1800;

  onStatus({ stage: "submitting" });

  let tx: ethers.ContractTransactionResponse;
  try {
    tx = await module.trigger(tokenIn.address, tokenOut.address, amountIn, 1n, deadline, [], { value: 0 });
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
