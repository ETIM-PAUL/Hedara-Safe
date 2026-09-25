"use client";

import { useState } from "react";
import type { BrowserProvider } from "ethers";
import { connectWallet, NoWalletError } from "@/lib/wallet";
import { getSafeState, getTreasuryBalances, getSafeAddress, type SafeState, type TokenBalance } from "@/lib/safe";

export default function Home() {
  const [account, setAccount] = useState<string | null>(null);
  const [safeState, setSafeState] = useState<SafeState | null>(null);
  const [balances, setBalances] = useState<TokenBalance[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  let safeAddress: string | null = null;
  let configError: string | null = null;
  try {
    safeAddress = getSafeAddress();
  } catch (err) {
    configError = (err as Error).message;
  }

  async function handleConnect() {
    setError(null);
    setLoading(true);
    try {
      const { provider, account: connectedAccount } = await connectWallet();
      setAccount(connectedAccount);
      await loadSafeData(provider);
    } catch (err) {
      setError(err instanceof NoWalletError ? err.message : `Failed to connect: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }

  async function loadSafeData(provider: BrowserProvider) {
    const [state, tokenBalances] = await Promise.all([
      getSafeState(provider),
      getTreasuryBalances(provider)
    ]);
    setSafeState(state);
    setBalances(tokenBalances);
  }

  return (
    <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif", maxWidth: 640 }}>
      <h1>hedera-safe-swap</h1>
      <p>Safe multisig treasury, rebalanced through SaucerSwap.</p>

      {!account ? (
        <button onClick={handleConnect} disabled={loading || !!configError} style={{ padding: "0.5rem 1rem" }}>
          {loading ? "Connecting..." : "Connect Wallet"}
        </button>
      ) : (
        <p>
          Connected as <code>{account}</code>
        </p>
      )}

      {error && <p style={{ color: "crimson" }}>{error}</p>}
      {configError && <p style={{ color: "crimson" }}>{configError}</p>}

      <section style={{ marginTop: "1.5rem" }}>
        <h2>Safe</h2>
        {safeAddress && (
          <p>
            Address: <code>{safeAddress}</code>
          </p>
        )}
        {safeState ? (
          <ul>
            <li>Owners: {safeState.owners.join(", ")}</li>
            <li>Threshold: {safeState.threshold}</li>
            <li>RebalanceModule enabled: {safeState.moduleEnabled ? "yes" : "no"}</li>
          </ul>
        ) : (
          <p>Connect a wallet to load Safe state.</p>
        )}
      </section>

      <section style={{ marginTop: "1.5rem" }}>
        <h2>Treasury</h2>
        {balances ? (
          <ul>
            {balances.map((token) => (
              <li key={token.address}>
                {token.symbol}: {token.balance}
              </li>
            ))}
          </ul>
        ) : (
          <p>Connect a wallet to load balances.</p>
        )}
      </section>

      <p style={{ marginTop: "2rem", fontSize: "0.85rem", color: "#666" }}>
        Rebalance trigger UI is the next increment. Until then, use{" "}
        <code>packages/contracts/scripts/demo-rebalance.ts</code>.
      </p>
    </main>
  );
}
