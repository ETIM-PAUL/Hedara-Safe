"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ethers, type BrowserProvider } from "ethers";
import { connectWallet, disconnectWallet, onAccountsChanged, tryReconnectWallet, NoWalletError } from "@/lib/wallet";
import {
  getSafeState,
  getTreasuryBalances,
  getSafeAddress,
  getTreasuryTokens,
  getReadOnlyProvider,
  type SafeState,
  type TokenBalance,
  type TreasuryToken
} from "@/lib/safe";
import { getQuote, applySlippage, DEADLINE_WINDOW_SECONDS, type Quote } from "@/lib/rebalance";
import { addOwner } from "@/lib/multisig";
import { useMultisigRebalance } from "@/lib/useMultisigRebalance";
import { hashscanTxUrl, hashscanContractUrl, type RebalanceStatus, type RebalanceStage } from "@/lib/txStatus";
import { shortenAddress } from "@/lib/format";
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
        <span className="ledger-value">
          <a href={hashscanContractUrl(address)} target="_blank" rel="noreferrer">
            {address}
          </a>
        </span>
      </div>
      {state ? (
        <>
          <div className="ledger-row">
            <span className="ledger-key">Active oracle</span>
            <span className="ledger-value" title={state.oracleAddress}>
              {oracleName(state.oracleAddress, oracleOptions)}
            </span>
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
  const [reversed, setReversed] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [slippagePct, setSlippagePct] = useState("1");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [newOwnerAddress, setNewOwnerAddress] = useState("");
  const [ownerStatus, setOwnerStatus] = useState<RebalanceStatus | null>(null);

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

  // Restore the wallet connection after a page refresh, if the wallet already has this origin
  // authorized — otherwise every reload drops back to "Connect wallet" even though the wallet
  // itself never actually disconnected.
  useEffect(() => {
    tryReconnectWallet().then((result) => {
      if (!result) return;
      setProvider(result.provider);
      setAccount(result.account);
      loadSafeData(result.provider);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  async function loadSafeData(activeProvider: ethers.Provider) {
    const [state, tokenBalances] = await Promise.all([
      getSafeState(activeProvider),
      getTreasuryBalances(activeProvider)
    ]);
    setSafeState(state);
    setBalances(tokenBalances);
  }

  // Owners, threshold, and balances are public on-chain state — read them on load via a
  // read-only RPC provider rather than waiting for "Connect wallet". Without this, the page
  // briefly showed stale fallback numbers (e.g. "1 of 1" from `safeState?.threshold ?? 1`) that
  // looked like real state before a wallet connection populated the real values.
  useEffect(() => {
    if (!safeAddress) return;
    loadSafeData(getReadOnlyProvider()).catch(() => {
      // Public RPC hiccup — the "Connect wallet" flow will retry with the wallet's own provider.
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [safeAddress]);

  function resetConnection() {
    setProvider(null);
    setAccount(null);
    setSafeState(null);
    setBalances(null);
    multisig.reset();
  }

  async function handleDisconnect() {
    await disconnectWallet();
    resetConnection();
  }

  /** Owner 1 uses this twice, while the Safe is still 1-of-N, to reach the target 2-of-3: the
   * first call adds a 2nd owner and keeps the threshold at 1; the second adds the 3rd owner and
   * raises the threshold to 2 in the same call — both still doable solo, since the new threshold
   * only takes effect once that call has already executed. See AGENTS.md for why. */
  async function handleAddOwner() {
    if (!provider || !safeState) return;
    if (!ethers.isAddress(newOwnerAddress)) {
      showToast("Enter a valid EVM address for the new owner.");
      return;
    }
    if (safeState.owners.some((o) => o.toLowerCase() === newOwnerAddress.toLowerCase())) {
      showToast("That address is already an owner.");
      return;
    }
    const nextThreshold = safeState.owners.length === 1 ? 1 : 2;
    setOwnerStatus(null);
    const signer = await provider.getSigner();
    await addOwner(signer, newOwnerAddress, nextThreshold, async (next) => {
      setOwnerStatus(next);
      if (next.stage === "confirmed") {
        setNewOwnerAddress("");
        await loadSafeData(provider);
      }
    });
  }

  const multisig = useMultisigRebalance({
    provider,
    owners: safeState?.owners ?? [],
    threshold: safeState?.threshold ?? 1,
    onConfirmed: async () => {
      if (provider) await loadSafeData(provider);
    },
    setToast: showToast
  });

  function tokenByAddress(address: string): TreasuryToken | undefined {
    return [tokenA, tokenB].find((t) => t.address.toLowerCase() === address.toLowerCase());
  }

  function formatTokenAmount(address: string, raw: bigint): string {
    const token = tokenByAddress(address);
    return token ? `${ethers.formatUnits(raw, token.decimals)} ${token.symbol}` : raw.toString();
  }

  async function handlePropose() {
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

    if (!quote) {
      showToast("Waiting for a live quote — try again in a moment.");
      return;
    }

    const signer = await provider.getSigner();
    const amountIn = ethers.parseUnits(amount, tokenIn.decimals);
    const min = applySlippage(quote.amountOut, slippageBps);
    const deadline = Math.floor(Date.now() / 1000) + DEADLINE_WINDOW_SECONDS;
    await multisig.propose(signer, tokenIn.address, tokenOut.address, amountIn, min, deadline, slippageBps);
  }

  async function handleApprove() {
    if (!provider) return;
    await multisig.approve(await provider.getSigner());
  }

  async function handleExecuteNow() {
    if (!provider) return;
    await multisig.executeNow(await provider.getSigner());
  }

  async function handleCopyProposal() {
    if (!multisig.shareableBlob) return;
    try {
      await navigator.clipboard.writeText(multisig.shareableBlob);
      showToast("Proposal copied — send it to the other owners to approve.");
    } catch {
      showToast("Couldn't access the clipboard — copy the text manually.");
    }
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

  const isOwner = !!account && !!safeState?.owners.some((o) => o.toLowerCase() === account.toLowerCase());
  const threshold = safeState?.threshold ?? 1;
  const proposalMet = multisig.approvals.length >= threshold;

  return (
    <main className="page">
      <h1 className="mark">hedera-safe-swap</h1>
      <p className="tagline">
        A Safe multisig treasury on Hedera. Funds move only through owner-approved SaucerSwap
        swaps.
      </p>

      <div className="connect-row">
        {!account ? (
          <button className="btn" onClick={handleConnect} disabled={connecting || !!configError}>
            {connecting ? "Connecting…" : "Connect wallet"}
          </button>
        ) : (
          <>
            <span className="account" title={account}>
              {shortenAddress(account)}
            </span>
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
            <span className="ledger-value">
              <a href={hashscanContractUrl(safeAddress)} target="_blank" rel="noreferrer">
                {safeAddress}
              </a>
            </span>
          </div>
        )}
        {safeState && (
          <>
            <div className="ledger-row">
              <span className="ledger-key">Owners</span>
              <span className="ledger-value">
                {safeState.owners.map((o, i) => (
                  <span key={o}>
                    {i > 0 && ", "}
                    <span title={o}>{shortenAddress(o)}</span>
                  </span>
                ))}
              </span>
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

            {isOwner && safeState.threshold === 1 && safeState.owners.length < 3 && (
              <div className="swap-form" style={{ marginTop: "1rem" }}>
                <input
                  className="swap-input"
                  type="text"
                  placeholder="0x… new owner address"
                  value={newOwnerAddress}
                  onChange={(e) => setNewOwnerAddress(e.target.value)}
                  disabled={ownerStatus !== null && ownerStatus.stage !== "confirmed" && ownerStatus.stage !== "failed"}
                />
                <button
                  className="btn"
                  onClick={handleAddOwner}
                  disabled={
                    ownerStatus !== null && ownerStatus.stage !== "confirmed" && ownerStatus.stage !== "failed"
                  }
                >
                  Add owner ({safeState.owners.length}/3)
                </button>
              </div>
            )}
            {isOwner && safeState.threshold === 1 && safeState.owners.length < 3 && (
              <p className="hint" style={{ marginTop: "0.5rem" }}>
                {safeState.owners.length === 1
                  ? "Adds owner 2, threshold stays 1-of-2."
                  : "Adds owner 3 and raises the threshold to 2-of-3."}
              </p>
            )}
            <StatusTracker status={ownerStatus} />
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
        <p className="section-desc">
          Needs {threshold} of {safeState?.owners.length ?? 1} owner signatures — no single owner
          can move funds alone. Propose, then Approve and Execute separately.
        </p>
        <div className="swap-form">
          <input
            className="swap-input"
            type="number"
            min="0"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={multisig.isRunning}
          />
          <span className="swap-direction">
            {tokenIn.symbol}
            <button
              type="button"
              className="direction-toggle"
              onClick={() => setReversed((r) => !r)}
              disabled={multisig.isRunning}
              aria-label="Reverse swap direction"
            >
              ⇄
            </button>
            {tokenOut.symbol}
          </span>
          <button className="btn" onClick={handlePropose} disabled={!account || multisig.isRunning}>
            {multisig.isRunning ? "Working…" : "Propose rebalance"}
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
              disabled={multisig.isRunning}
            />
            %
          </label>
        </div>
        {amountOutMin !== null && quote && (
          <p className="quote-min">
            Minimum received: {ethers.formatUnits(amountOutMin, tokenOut.decimals)} {tokenOut.symbol}
          </p>
        )}

        {threshold > 1 && !multisig.proposal && (
          <div className="swap-form" style={{ marginTop: "1rem" }}>
            <textarea
              className="swap-input"
              style={{ width: "100%", minHeight: "3rem" }}
              placeholder="Paste a shared proposal to review and approve"
              value={multisig.pasteInput}
              onChange={(e) => multisig.setPasteInput(e.target.value)}
            />
            <button className="btn btn-secondary" onClick={() => multisig.loadProposal(multisig.pasteInput)}>
              Load proposal
            </button>
          </div>
        )}

        {multisig.proposal && multisig.decoded && (
          <div className={`ledger-card${multisig.isStale ? " stale" : ""}`}>
            <p className="section-label">Pending proposal</p>
            <div className="ledger-row">
              <span className="ledger-key">Swap</span>
              <span className="ledger-value">
                {formatTokenAmount(multisig.decoded.tokenIn, multisig.decoded.amountIn)} → min{" "}
                {formatTokenAmount(multisig.decoded.tokenOut, multisig.decoded.amountOutMin)}
              </span>
            </div>
            {typeof multisig.proposal.slippageBps === "number" && (
              <div className="ledger-row">
                <span className="ledger-key">Slippage used</span>
                <span className="ledger-value">{(multisig.proposal.slippageBps / 100).toFixed(2)}%</span>
              </div>
            )}
            <div className="ledger-row">
              <span className="ledger-key">Deadline</span>
              <span className="ledger-value">
                {new Date(multisig.decoded.deadline * 1000).toLocaleString()}
                {multisig.isExpired ? " — passed" : ""}
              </span>
            </div>
            <div className="ledger-row">
              <span className="ledger-key">Approvals</span>
              <span className="ledger-value">
                <span className={`status-dot ${proposalMet ? "on" : "off"}`} />
                {multisig.approvals.length} of {threshold}
                {multisig.approvals.length > 0 && (
                  <>
                    {" ("}
                    {multisig.approvals.map((o, i) => (
                      <span key={o}>
                        {i > 0 && ", "}
                        <span title={o}>{shortenAddress(o)}</span>
                      </span>
                    ))}
                    {")"}
                  </>
                )}
              </span>
            </div>

            {multisig.isStale && (
              <div className="callout">
                <span className="status-dot off" />
                <span>
                  {multisig.isExpired ? "Deadline passed." : "Safe's nonce moved — stale."} Discard
                  and propose again.
                </span>
              </div>
            )}

            <div className="action-row">
              <div className="action-row-primary">
                {isOwner && !multisig.approvals.some((o) => o.toLowerCase() === account?.toLowerCase()) && (
                  <button className="btn" onClick={handleApprove} disabled={multisig.isRunning || multisig.isStale}>
                    Approve
                  </button>
                )}
                <button
                  className="btn"
                  onClick={handleExecuteNow}
                  disabled={multisig.isRunning || !proposalMet || multisig.isStale}
                >
                  Execute now
                </button>
              </div>
              <div className="action-row-secondary">
                <button className="btn btn-secondary" onClick={handleCopyProposal} disabled={multisig.isRunning}>
                  Copy proposal to share
                </button>
                <button className="btn btn-secondary" onClick={multisig.reset} disabled={multisig.isRunning}>
                  Discard
                </button>
              </div>
            </div>
          </div>
        )}

        <StatusTracker status={multisig.status} />
      </section>

      {priceGuardAddress && (
        <PriceGuardSection
          title="Price Guard (HBAR/USD)"
          description="Permissionless — executes only if HBAR/USD meets the condition below. WHBAR tracks HBAR 1:1; SAUCE isn't gated."
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
