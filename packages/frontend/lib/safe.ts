import { ethers } from "ethers";

/**
 * Read-only helpers for the deployed Safe and RebalanceModule. The rebalance trigger flow
 * (Phase 9) builds on top of these, not the other way round.
 */

const SAFE_ABI = [
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function isModuleEnabled(address module) view returns (bool)"
];

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

export interface TreasuryToken {
  address: string;
  symbol: string;
  decimals: number;
}

// Next.js inlines NEXT_PUBLIC_* vars into the client bundle only where they're referenced with a
// static, literal `process.env.NEXT_PUBLIC_X` — a dynamic `process.env[name]` lookup can't be
// statically analyzed, so it silently resolves to nothing in the browser. Every accessor below
// stays static for that reason, even though it reads more repetitively than a shared helper.
function requireEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`${name} is not set — deploy the contracts first (see README.md Setup)`);
  }
  return value;
}

export function getSafeAddress(): string {
  return requireEnv("NEXT_PUBLIC_SAFE_ADDRESS", process.env.NEXT_PUBLIC_SAFE_ADDRESS);
}

export function getModuleAddress(): string {
  return requireEnv("NEXT_PUBLIC_MODULE_ADDRESS", process.env.NEXT_PUBLIC_MODULE_ADDRESS);
}

/** Tokens shown on the treasury dashboard — defaults match the WHBAR/SAUCE pair demo-rebalance.ts uses. */
export function getTreasuryTokens(): TreasuryToken[] {
  return [
    {
      address: process.env.NEXT_PUBLIC_TOKEN_IN_ADDRESS || "0x0000000000000000000000000000000000003ad2",
      symbol: process.env.NEXT_PUBLIC_TOKEN_IN_SYMBOL || "WHBAR",
      decimals: 8
    },
    {
      address: process.env.NEXT_PUBLIC_TOKEN_OUT_ADDRESS || "0x0000000000000000000000000000000000120f46",
      symbol: process.env.NEXT_PUBLIC_TOKEN_OUT_SYMBOL || "SAUCE",
      decimals: 6
    }
  ];
}

export interface SafeState {
  owners: string[];
  threshold: number;
  moduleEnabled: boolean;
}

export async function getSafeState(provider: ethers.Provider): Promise<SafeState> {
  const safe = new ethers.Contract(getSafeAddress(), SAFE_ABI, provider);
  const [owners, threshold, moduleEnabled] = await Promise.all([
    safe.getOwners(),
    safe.getThreshold(),
    safe.isModuleEnabled(getModuleAddress())
  ]);
  return { owners, threshold: Number(threshold), moduleEnabled };
}

export interface TokenBalance extends TreasuryToken {
  balance: string;
}

export async function getTreasuryBalances(provider: ethers.Provider): Promise<TokenBalance[]> {
  const safeAddress = getSafeAddress();
  const tokens = getTreasuryTokens();

  return Promise.all(
    tokens.map(async (token) => {
      const erc20 = new ethers.Contract(token.address, ERC20_ABI, provider);
      const raw = await erc20.balanceOf(safeAddress);
      return { ...token, balance: ethers.formatUnits(raw, token.decimals) };
    })
  );
}
