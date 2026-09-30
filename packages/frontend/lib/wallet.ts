import { BrowserProvider } from "ethers";

/**
 * Hedera testnet is a standard EVM JSON-RPC chain, so any EIP-1193 wallet works here —
 * MetaMask, HashPack, or Blade in EVM mode. No HashConnect/WalletConnect SDK needed.
 */
const HEDERA_TESTNET_CHAIN_ID = "0x128"; // 296 in hex
const HEDERA_TESTNET_PARAMS = {
  chainId: HEDERA_TESTNET_CHAIN_ID,
  chainName: "Hedera Testnet",
  nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
  rpcUrls: ["https://testnet.hashio.io/api"],
  blockExplorerUrls: ["https://hashscan.io/testnet"]
};

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
      on?: (event: string, handler: (...args: unknown[]) => void) => void;
      removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
    };
  }
}

export class NoWalletError extends Error {
  constructor() {
    super("No EIP-1193 wallet found — install MetaMask, HashPack, or Blade.");
  }
}

export async function connectWallet(): Promise<{ provider: BrowserProvider; account: string }> {
  if (!window.ethereum) {
    throw new NoWalletError();
  }

  await window.ethereum.request({ method: "eth_requestAccounts" });
  await ensureHederaTestnet();

  const provider = new BrowserProvider(window.ethereum);
  const accounts = await provider.send("eth_accounts", []);
  return { provider, account: accounts[0] };
}

/**
 * Restores a connection that already exists from the wallet's own perspective, without prompting
 * — `eth_accounts` (unlike `eth_requestAccounts`) just returns whatever accounts this origin is
 * already authorized for, empty if none. Lets the app come back connected after a page refresh
 * instead of showing "Connect wallet" again every time, without re-asking for permission the
 * wallet already granted.
 */
export async function tryReconnectWallet(): Promise<{ provider: BrowserProvider; account: string } | null> {
  if (!window.ethereum) return null;
  const accounts = (await window.ethereum.request({ method: "eth_accounts" })) as string[];
  if (!accounts || accounts.length === 0) return null;
  const provider = new BrowserProvider(window.ethereum);
  return { provider, account: accounts[0] };
}

/**
 * EIP-1193 has no universal "disconnect" — a wallet's connection is really just its own
 * permission grant, which most wallets don't let a page revoke without a newer, unevenly
 * supported RPC method (EIP-2255). Best effort: try to revoke, but the disconnect that actually
 * matters is the caller dropping its own provider/account state.
 */
export async function disconnectWallet(): Promise<void> {
  if (!window.ethereum) return;
  try {
    await window.ethereum.request({
      method: "wallet_revokePermissions",
      params: [{ eth_accounts: {} }]
    });
  } catch {
    // Not supported by this wallet — the caller still clears its own state, which is the part
    // that actually controls what this app treats as "connected".
  }
}

export function onAccountsChanged(handler: (accounts: string[]) => void): () => void {
  if (!window.ethereum?.on) return () => {};
  const listener = (...args: unknown[]) => handler(args[0] as string[]);
  window.ethereum.on("accountsChanged", listener);
  return () => window.ethereum?.removeListener?.("accountsChanged", listener);
}

async function ensureHederaTestnet(): Promise<void> {
  if (!window.ethereum) return;

  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: HEDERA_TESTNET_CHAIN_ID }]
    });
  } catch (error) {
    const err = error as { code?: number };
    if (err.code === 4902) {
      // Chain not added to the wallet yet.
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [HEDERA_TESTNET_PARAMS]
      });
    } else {
      throw error;
    }
  }
}
