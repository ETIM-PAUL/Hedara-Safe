import { ethers } from "ethers";

/**
 * Phase 8 scaffold. Minimal read helpers for the deployed Safe — extended in Phase 9 with the
 * rebalance trigger flow. Keep wallet-connection logic here, not scattered in components.
 */

const SAFE_ABI = [
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)"
];

export function getSafeAddress(): string {
  const address = process.env.NEXT_PUBLIC_SAFE_ADDRESS;
  if (!address) {
    throw new Error("NEXT_PUBLIC_SAFE_ADDRESS is not set — deploy the Safe first (see BUILD_PLAN.md Phase 4)");
  }
  return address;
}

export async function getSafeOwners(provider: ethers.Provider) {
  const safe = new ethers.Contract(getSafeAddress(), SAFE_ABI, provider);
  const [owners, threshold] = await Promise.all([safe.getOwners(), safe.getThreshold()]);
  return { owners, threshold: Number(threshold) };
}
