"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ethers, type BrowserProvider } from "ethers";
import { connectWallet, disconnectWallet, onAccountsChanged, NoWalletError } from "@/lib/wallet";
import {
  getSafeState,
  getTreasuryBalances,
  getSafeAddress,
  getTreasuryTokens,
  type SafeState,
  type TokenBalance
} from "@/lib/safe";
import { triggerRebalance, getQuote, applySlippage, type Quote } from "@/lib/rebalance";
import { hashscanTxUrl, type RebalanceStatus, type RebalanceStage } from "@/lib/txStatus";
import {
  getPriceGuardAddress,
  getOracleOptions,
  oracleName,
  Comparison,
  type PriceGuardState
} from "@/lib/priceGuard";
import { usePriceGuard } from "@/lib/usePriceGuard";
import { useAnimatedNumber } from "@/lib/useAnimatedNumber";

const STAGES: { key: RebalanceStage; label: string }[] = [
  { key: "submitting", label: "Submitted" },
  { key: "pending", label: "Pending" },
  { key: "confirming", label: "Mirror node" },
  { key: "confirmed", label: "Confirmed" }
];

/** Push-model oracles are typically seconds to minutes old. Scale the unit to whichever reads
 * naturally. */
function formatAge(seconds: number): string {
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 5400) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 172800) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function BalanceRow({ token }: { token: TokenBalance }) {
  const displayed = useAnimatedNumber(Number(token.balance), token.symbol === "SAUCE" ? 6 : 8);
  return (
    <div className="ledger-row">
      <span className="ledger-key">{token.symbol}</span>
      <span className="ledger-value balance">{displayed}</span>
    </div>
  );
}

function StatusTracker({ status }: { status: RebalanceStatus | null }) {
  if (!status) return null;
  const stageIndex = STAGES.findIndex((s) => s.key === status.stage);
  return (
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
  );
}

/**
 * The price-guard section — shows PriceGuardedRebalanceModule's HBAR/USD condition, gated on
 * whichever adapter (Chainlink or Supra) is currently active, with an owner-only picker to
 * preview and switch between them.
 */
function PriceGuardSection({
  title,
  description,
  address,
  isOwner,
  hasAccount,
  guard,
  oracleOptions,
  showOraclePicker,
  formatTrigger,
  formatObserved,
  reproduceHint
}: {
  title: string;
  description: string;
  address: string;
  isOwner: boolean;
  hasAccount: boolean;
  guard: ReturnType<typeof usePriceGuard>;
  oracleOptions: { name: string; address: string }[];
  showOraclePicker: boolean;
  formatTrigger: (state: PriceGuardState) => string;
  formatObserved: (priceHuman: string) => string;
  reproduceHint: string;
}) {
  const { state, selectedOracleCondition } = guard;
  const isSwitching =
    !!state && guard.selectedOracle.toLowerCase() !== state.oracleAddress.toLowerCase();

  return (
    <section className="ledger-section">
      <p className="section-label">{title}</p>
      <p className="section-desc">{description}</p>
      <div className="ledger-row">
        <span className="ledger-key">Address</span>
        <span className="ledger-value">{address}</span>
      </div>
      {state ? (
        <>
          <div className="ledger-row">
            <span className="ledger-key">Active oracle</span>
            <span className="ledger-value">{oracleName(state.oracleAddress, oracleOptions)}</span>
          </div>
          <div className="ledger-row">
            <span className="ledger-key">Condition</span>
            <span className="ledger-value">{formatTrigger(state)}</span>
          </div>

          {isOwner && showOraclePicker ? (
            <div className="ledger-row">
              <span className="ledger-key">Trigger with</span>
              <select
                className="swap-input"
                style={{ width: "auto" }}
                value={guard.selectedOracle}
                onChange={(e) => guard.setSelectedOracle(e.target.value)}
                disabled={guard.isRunning}
              >
                {oracleOptions.map((o) => (
                  <option key={o.address} value={o.address}>
                    {o.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {selectedOracleCondition && (
            <>
              <div className="ledger-row">
                <span className="ledger-key">Observed</span>
                <span className="ledger-value">
                  {formatObserved(selectedOracleCondition.priceHuman)} (
                  {formatAge(selectedOracleCondition.ageSeconds)} old)
                </span>
              </div>
              <div className="ledger-row">
                <span className="ledger-key">Status</span>
                <span className="ledger-value">
                  <span className={`status-dot ${selectedOracleCondition.conditionMet ? "on" : "off"}`} />
                  {selectedOracleCondition.conditionMet ? "condition met" : "condition not met"}
                </span>
              </div>
            </>
          )}
        </>
      ) : (
        <p className="ledger-key">Connect a wallet to load this guard&apos;s live state.</p>
      )}

      <div className="swap-form" style={{ marginTop: "1rem" }}>
        <input
          className="swap-input"
          type="number"
          min="0"
          step="0.01"
          value={guard.amount}
          onChange={(e) => guard.setAmount(e.target.value)}
          disabled={guard.isRunning}
        />
        <span className="swap-direction">
          {guard.tokenIn.symbol}
          <button
            type="button"
            className="direction-toggle"
            onClick={() => guard.setReversed((r) => !r)}
            disabled={guard.isRunning}
            aria-label="Reverse swap direction"
          >
            ⇄
          </button>
          {guard.tokenOut.symbol}
        </span>
        <button
          className="btn"
          onClick={guard.handleTrigger}
          disabled={!hasAccount || guard.isRunning || !selectedOracleCondition?.conditionMet}
        >
          {guard.isRunning
            ? "Triggering…"
            : isSwitching
              ? `Make ${oracleName(guard.selectedOracle, oracleOptions)} active & trigger`
              : "Fire trigger"}
        </button>
      </div>
      {isSwitching && (
        <p className="hint" style={{ marginTop: "0.5rem" }}>
          One signature: sets {oracleName(guard.selectedOracle, oracleOptions)} as the active
          oracle and fires the trigger.
        </p>
      )}

      <StatusTracker status={guard.status} />

      <p className="hint" style={{ marginTop: "0.75rem" }}>
        {reproduceHint}
      </p>
    </section>
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
  const [reversed, setReversed] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [slippagePct, setSlippagePct] = useState("1");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);

  function showToast(message: string) {
    setToast(message);
  }

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  const providerRef = useRef<BrowserProvider | null>(null);
  useEffect(() => {
    providerRef.current = provider;
  }, [provider]);

  useEffect(() => {
    const unsubscribe = onAccountsChanged((accounts) => {
      if (accounts.length === 0) {
        // The wallet itself disconnected (or the account was locked/removed) — follow suit.
        resetConnection();
      } else {
        setAccount(accounts[0]);
        if (providerRef.current) {
          loadSafeData(providerRef.current);
        }
      }
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // getTreasuryTokens() returns fresh object literals every call — memoized so tokenIn/tokenOut
  // keep a stable identity across renders. Without this, the quote effect below (which depends
  // on tokenIn/tokenOut by reference and calls setQuote internally) re-triggers itself every
  // render in an infinite loop: this bit us for real, showing as a permanently flickering quote.
  const [tokenA, tokenB] = useMemo(() => getTreasuryTokens(), []);
  const tokenIn = reversed ? tokenB : tokenA;
  const tokenOut = reversed ? tokenA : tokenB;

  useEffect(() => {
    if (!provider || !amount || Number(amount) <= 0) {
      setQuote(null);
      setQuoteError(null);
      return;
    }
    let cancelled = false;
    setQuoteLoading(true);
    setQuoteError(null);
    const timer = setTimeout(async () => {
      try {
        const result = await getQuote(provider, tokenIn, tokenOut, amount);
        if (!cancelled) setQuote(result);
      } catch (err) {
        if (!cancelled) {
          setQuote(null);
          setQuoteError("No route/liquidity for this pair right now.");
        }
      } finally {
        if (!cancelled) setQuoteLoading(false);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [provider, amount, tokenIn, tokenOut]);

  const slippageBps = Math.round((Number(slippagePct) || 0) * 100);
  const amountOutMin = quote ? applySlippage(quote.amountOut, slippageBps) : null;

  let safeAddress: string | null = null;
  let configError: string | null = null;
  try {
    safeAddress = getSafeAddress();
  } catch (err) {
    configError = (err as Error).message;
  }

  let priceGuardAddress: string | null = null;
  try {
    priceGuardAddress = getPriceGuardAddress();
  } catch {
    // Price-guarded module is optional — its section just doesn't render if unset.
  }

  const oracleOptions = useMemo(() => getOracleOptions(), []);

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

  function resetConnection() {
    setProvider(null);
    setAccount(null);
    setSafeState(null);
    setBalances(null);
    setStatus(null);
  }

  async function handleDisconnect() {
    await disconnectWallet();
    resetConnection();
  }

  async function handleRebalance() {
    if (!provider) return;

    const requested = Number(amount);
    if (!Number.isFinite(requested) || requested <= 0) {
      showToast("Enter an amount greater than zero.");
      return;
    }

    const currentBalance = balances?.find((b) => b.address === tokenIn.address);
    const available = Number(currentBalance?.balance ?? "0");
    if (requested > available) {
      showToast(
        `Insufficient ${tokenIn.symbol} balance — the Safe holds ${currentBalance?.balance ?? "0"} ${tokenIn.symbol}.`
      );
      return;
    }

    setStatus(null);
    const signer = await provider.getSigner();
    await triggerRebalance(
      signer,
      tokenIn,
      tokenOut,
      amount,
      async (next) => {
        setStatus(next);
        if (next.stage === "confirmed") {
          await loadSafeData(provider);
        }
      },
      slippageBps
    );
  }

  const priceGuard = usePriceGuard({
    moduleAddress: priceGuardAddress,
    provider,
    tokenA,
    tokenB,
    balances,
    onConfirmed: async () => {
      if (provider) await loadSafeData(provider);
    },
    setToast: showToast
  });

  const isRunning = status !== null && status.stage !== "confirmed" && status.stage !== "failed";
  const isOwner = !!account && !!safeState?.owners.some((o) => o.toLowerCase() === account.toLowerCase());

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
          <>
            <span className="account">{account}</span>
            <button className="btn btn-secondary" onClick={handleDisconnect}>
              Disconnect
            </button>
          </>
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
        <p className="section-desc">Owner-only, works any time — no price condition to satisfy.</p>
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
            {tokenIn.symbol}
            <button
              type="button"
              className="direction-toggle"
              onClick={() => setReversed((r) => !r)}
              disabled={isRunning}
              aria-label="Reverse swap direction"
            >
              ⇄
            </button>
            {tokenOut.symbol}
          </span>
          <button className="btn" onClick={handleRebalance} disabled={!account || isRunning}>
            {isRunning ? "Swapping…" : "Swap via SaucerSwap"}
          </button>
        </div>

        <div className="quote-row">
          <span className="quote-line">
            {quoteLoading
              ? "Fetching quote…"
              : quote
                ? `≈ ${quote.amountOutHuman} ${tokenOut.symbol}`
                : quoteError
                  ? quoteError
                  : "—"}
          </span>
          <label className="slippage-control">
            Slippage
            <input
              className="slippage-input"
              type="number"
              min="0"
              max="50"
              step="0.1"
              value={slippagePct}
              onChange={(e) => setSlippagePct(e.target.value)}
              disabled={isRunning}
            />
            %
          </label>
        </div>
        {amountOutMin !== null && quote && (
          <p className="quote-min">
            Minimum received: {ethers.formatUnits(amountOutMin, tokenOut.decimals)} {tokenOut.symbol}
          </p>
        )}

        <StatusTracker status={status} />
      </section>

      {priceGuardAddress && (
        <PriceGuardSection
          title="Price Guard (HBAR/USD)"
          description="Permissionless — anyone can call it, but it only executes if HBAR/USD (not SAUCE) meets the condition below. WHBAR tracks HBAR 1:1, so this gates the WHBAR side of the swap."
          address={priceGuardAddress}
          isOwner={isOwner}
          hasAccount={!!account}
          guard={priceGuard}
          oracleOptions={oracleOptions}
          showOraclePicker={oracleOptions.length > 1}
          formatTrigger={(s) =>
            `WHBAR ${s.comparison === Comparison.Below ? "≤" : "≥"} $${(Number(s.triggerPrice) * 10 ** s.triggerExpo).toFixed(6)}`
          }
          formatObserved={(priceHuman) => `$${priceHuman}`}
          reproduceHint="Reproduce with packages/contracts/scripts/deploy-oracle-adapters.ts."
        />
      )}

      {toast && (
        <div className="toast" role="alert">
          {toast}
        </div>
      )}
    </main>
  );
}
