import { ethers } from "ethers";
import { type TreasuryToken } from "./safe";
import { waitForMirrorNode, type RebalanceStatus } from "./txStatus";

const PRICE_GUARD_ABI = [
  "function trigger(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMin, uint256 deadline, bytes[] calldata updateData) payable returns (uint256)",
  "function switchOracleAndTrigger(address newOracle, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMin, uint256 deadline, bytes[] calldata updateData) payable returns (uint256)",
  "function setTrigger(int64 _triggerPrice, int32 _triggerExpo, uint8 _comparison, uint256 _maxPriceAgeSeconds)",
  "function triggerPrice() view returns (int64)",
  "function triggerExpo() view returns (int32)",
  "function comparison() view returns (uint8)",
  "function maxPriceAgeSeconds() view returns (uint256)",
  "function oracle() view returns (address)"
];

const ORACLE_ADAPTER_ABI = [
  "function getPrice() view returns (int64 price, int32 expo, uint256 publishTime)"
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

export interface OracleOption {
  name: string;
  address: string;
}

/** Known adapter deployments, read from env — only the ones actually set show up as switch options. */
export function getOracleOptions(): OracleOption[] {
  const candidates: OracleOption[] = [
    { name: "Chainlink", address: process.env.NEXT_PUBLIC_CHAINLINK_ADAPTER_ADDRESS ?? "" },
    { name: "Supra", address: process.env.NEXT_PUBLIC_SUPRA_ADAPTER_ADDRESS ?? "" }
  ];
  return candidates.filter((o) => o.address);
}

export function oracleName(address: string, options: OracleOption[]): string {
  const match = options.find((o) => o.address.toLowerCase() === address.toLowerCase());
  return match?.name ?? address;
}

export interface PriceGuardState {
  oracleAddress: string;
  triggerPrice: bigint;
  triggerExpo: number;
  comparison: Comparison;
  maxPriceAgeSeconds: bigint;
  observedPrice: bigint;
  observedExpo: number;
  observedAgeSeconds: number;
  conditionMet: boolean;
}

/** Scales two (price, expo) pairs to a common exponent before comparing — mirrors the contract's
 * own normalize() so the UI never disagrees with what will actually happen on-chain. Chainlink
 * and Supra use different native decimal conventions (8 vs. 18), which is exactly why this
 * normalization exists, not just for a stale trigger config. */
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

/** Reads a price from any adapter without going through the module — used to preview what a
 * candidate oracle (not yet switched to) would report, before committing to switchOracleAndTrigger. */
export async function getAdapterPrice(
  provider: ethers.Provider,
  adapterAddress: string
): Promise<{ price: bigint; expo: number; ageSeconds: number }> {
  const adapter = new ethers.Contract(adapterAddress, ORACLE_ADAPTER_ABI, provider);
  const observed = await adapter.getPrice();
  return {
    price: observed.price,
    expo: Number(observed.expo),
    ageSeconds: Math.floor(Date.now() / 1000) - Number(observed.publishTime)
  };
}

/** Previews whether a candidate oracle (which may not be the module's currently active one)
 * would satisfy the module's existing trigger condition — so the UI can show whether picking a
 * different oracle in the dropdown would actually let the button fire, before spending a
 * signature to find out. */
export async function previewCondition(
  provider: ethers.Provider,
  candidateOracleAddress: string,
  triggerPrice: bigint,
  triggerExpo: number,
  comparison: Comparison
): Promise<{ price: bigint; expo: number; ageSeconds: number; conditionMet: boolean }> {
  const observed = await getAdapterPrice(provider, candidateOracleAddress);
  return {
    ...observed,
    conditionMet: compareNormalized(observed.price, observed.expo, triggerPrice, triggerExpo, comparison)
  };
}

export async function getPriceGuardState(provider: ethers.Provider): Promise<PriceGuardState> {
  const module = new ethers.Contract(getPriceGuardAddress(), PRICE_GUARD_ABI, provider);
  const [triggerPrice, triggerExpo, comparison, maxPriceAgeSeconds, oracleAddress] = await Promise.all([
    module.triggerPrice(),
    module.triggerExpo(),
    module.comparison(),
    module.maxPriceAgeSeconds(),
    module.oracle()
  ]);

  const observed = await getAdapterPrice(provider, oracleAddress);
  const comparisonValue = Number(comparison) as Comparison;

  return {
    oracleAddress,
    triggerPrice,
    triggerExpo: Number(triggerExpo),
    comparison: comparisonValue,
    maxPriceAgeSeconds,
    observedPrice: observed.price,
    observedExpo: observed.expo,
    observedAgeSeconds: observed.ageSeconds,
    conditionMet: compareNormalized(observed.price, observed.expo, triggerPrice, Number(triggerExpo), comparisonValue)
  };
}

export function formatOraclePrice(price: bigint, expo: number): string {
  const value = Number(price) * Math.pow(10, expo);
  return value.toFixed(6);
}

/**
 * Fires a trigger, optionally switching the active oracle first — both in one signed
 * transaction. If `selectedOracleAddress` differs from the module's current oracle, this calls
 * the owner-only switchOracleAndTrigger() (one signature does both); otherwise it calls the
 * plain permissionless trigger(). Either way, updateData is empty: correct and sufficient for
 * Chainlink/Supra, which are push-model and already fresh with no fee to pay.
 */
export async function triggerPriceGuard(
  signer: ethers.Signer,
  currentOracleAddress: string,
  selectedOracleAddress: string,
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
  const switching = selectedOracleAddress.toLowerCase() !== currentOracleAddress.toLowerCase();

  onStatus({ stage: "submitting" });

  let tx: ethers.ContractTransactionResponse;
  try {
    tx = switching
      ? await module.switchOracleAndTrigger(
          selectedOracleAddress,
          tokenIn.address,
          tokenOut.address,
          amountIn,
          1n,
          deadline,
          [],
          { value: 0 }
        )
      : await module.trigger(tokenIn.address, tokenOut.address, amountIn, 1n, deadline, [], { value: 0 });
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
