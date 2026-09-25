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
