"use client";

import { useState } from "react";
import type { BrowserProvider } from "ethers";
import { connectWallet, NoWalletError } from "@/lib/wallet";
import {
  getSafeState,
  getTreasuryBalances,
  getSafeAddress,
  getTreasuryTokens,
  type SafeState,
  type TokenBalance
} from "@/lib/safe";
import {
  triggerRebalance,
  hashscanTxUrl,
  type RebalanceStatus,
  type RebalanceStage
} from "@/lib/rebalance";
import { useAnimatedNumber } from "@/lib/useAnimatedNumber";

const STAGES: { key: RebalanceStage; label: string }[] = [
  { key: "submitting", label: "Submitted" },
  { key: "pending", label: "Pending" },
  { key: "confirming", label: "Mirror node" },
  { key: "confirmed", label: "Confirmed" }
];

function BalanceRow({ token }: { token: TokenBalance }) {
  const displayed = useAnimatedNumber(Number(token.balance), token.symbol === "SAUCE" ? 6 : 8);
  return (
    <div className="ledger-row">
      <span className="ledger-key">{token.symbol}</span>
      <span className="ledger-value balance">{displayed}</span>
    </div>
  );
}

export default function Home() {
  const [provider, setProvider] = useState<BrowserProvider | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [safeState, setSafeState] = useState<SafeState | null>(null);
  const [balances, setBalances] = useState<TokenBalance[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [amount, setAmount] = useState("1.0");
  const [status, setStatus] = useState<RebalanceStatus | null>(null);

  const [tokenIn, tokenOut] = getTreasuryTokens();

  let safeAddress: string | null = null;
  let configError: string | null = null;
  try {
    safeAddress = getSafeAddress();
  } catch (err) {
    configError = (err as Error).message;
  }

  async function handleConnect() {
    setError(null);
    setConnecting(true);
    try {
      const { provider: connectedProvider, account: connectedAccount } = await connectWallet();
      setProvider(connectedProvider);
      setAccount(connectedAccount);
      await loadSafeData(connectedProvider);
    } catch (err) {
      setError(
        err instanceof NoWalletError ? err.message : `Failed to connect: ${(err as Error).message}`
      );
    } finally {
      setConnecting(false);
    }
  }

  async function loadSafeData(activeProvider: BrowserProvider) {
    const [state, tokenBalances] = await Promise.all([
      getSafeState(activeProvider),
      getTreasuryBalances(activeProvider)
    ]);
    setSafeState(state);
    setBalances(tokenBalances);
  }

  async function handleRebalance() {
    if (!provider) return;
    setStatus(null);
    const signer = await provider.getSigner();
    await triggerRebalance(signer, amount, async (next) => {
      setStatus(next);
      if (next.stage === "confirmed") {
        await loadSafeData(provider);
      }
    });
  }

  const stageIndex = status ? STAGES.findIndex((s) => s.key === status.stage) : -1;
  const isRunning = status !== null && status.stage !== "confirmed" && status.stage !== "failed";

  return (
    <main className="page">
      <h1 className="mark">hedera-safe-swap</h1>
      <p className="tagline">
        A Safe multisig treasury on Hedera. Idle holdings sit here until an owner rebalances them
        through SaucerSwap — nothing moves without that call.
      </p>

      <div className="connect-row">
        {!account ? (
          <button className="btn" onClick={handleConnect} disabled={connecting || !!configError}>
            {connecting ? "Connecting…" : "Connect wallet"}
          </button>
        ) : (
          <span className="account">{account}</span>
        )}
      </div>

      {error && <p className="error-line">{error}</p>}
      {configError && <p className="error-line">{configError}</p>}

      <section className="ledger-section">
        <p className="section-label">Safe</p>
        {safeAddress && (
          <div className="ledger-row">
            <span className="ledger-key">Address</span>
            <span className="ledger-value">{safeAddress}</span>
          </div>
        )}
        {safeState && (
          <>
            <div className="ledger-row">
              <span className="ledger-key">Owners</span>
              <span className="ledger-value">{safeState.owners.join(", ")}</span>
            </div>
            <div className="ledger-row">
              <span className="ledger-key">Threshold</span>
              <span className="ledger-value">
                {safeState.threshold} of {safeState.owners.length}
              </span>
            </div>
            <div className="ledger-row">
              <span className="ledger-key">RebalanceModule</span>
              <span className="ledger-value">
                <span className={`status-dot ${safeState.moduleEnabled ? "on" : "off"}`} />
                {safeState.moduleEnabled ? "enabled" : "not enabled"}
              </span>
            </div>
          </>
        )}
      </section>

      <section className="ledger-section">
        <p className="section-label">Holdings</p>
        {balances ? (
          balances.map((token) => <BalanceRow key={token.address} token={token} />)
        ) : (
          <p className="ledger-key">Connect a wallet to load treasury balances.</p>
        )}
      </section>

      <section className="ledger-section">
        <p className="section-label">Rebalance</p>
        <div className="swap-form">
          <input
            className="swap-input"
            type="number"
            min="0"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={isRunning}
          />
          <span className="swap-direction">
            {tokenIn.symbol} → {tokenOut.symbol}
          </span>
          <button className="btn" onClick={handleRebalance} disabled={!account || isRunning}>
            {isRunning ? "Swapping…" : "Swap via SaucerSwap"}
          </button>
        </div>

        {status && (
          <>
            <div className="steps">
              {STAGES.map((stage, i) => (
                <span
                  key={stage.key}
                  className={`step ${status.stage === "failed" && i === stageIndex ? "error" : i < stageIndex ? "done" : i === stageIndex ? "active" : ""}`}
                >
                  {stage.label}
                </span>
              ))}
            </div>
            {status.error && <p className="error-line">{status.error}</p>}
            {status.txHash && (
              <p className="receipt">
                <a href={hashscanTxUrl(status.txHash)} target="_blank" rel="noreferrer">
                  {status.txHash}
                </a>
              </p>
            )}
          </>
        )}
      </section>

      <p className="hint">
        Reproduce this outside the browser with{" "}
        <code>packages/contracts/scripts/demo-rebalance.ts</code>.
      </p>
    </main>
  );
}
