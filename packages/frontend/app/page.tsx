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
import {
  buildRebalanceProposal,
  buildAddOwnerProposal,
  buildRemoveOwnerProposal,
  minimumThreshold,
  thresholdPolicyError
} from "@/lib/multisig";
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
 * The topic-fetched "Proposals from other owners" list, shared by the Rebalance and Owners
 * sections — each just passes its own `useMultisigRebalance` instance, already filtered to the
 * proposal kinds that section cares about.
 */
function RecentProposalsCard({ guard }: { guard: ReturnType<typeof useMultisigRebalance> }) {
  if (!guard.hasProposalsTopic || guard.proposal) return null;
  return (
    <div className="ledger-card" style={{ marginTop: "1rem" }}>
      <div className="action-row" style={{ marginTop: 0 }}>
        <p className="section-label" style={{ margin: 0 }}>
          Proposals from other owners
        </p>
        <button
          className="btn btn-secondary"
          onClick={() => guard.refreshRecentProposals()}
          disabled={guard.recentProposalsLoading}
        >
          {guard.recentProposalsLoading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {guard.recentProposals.length === 0 ? (
        <p className="ledger-key">{guard.recentProposalsLoading ? "Loading…" : "None published yet."}</p>
      ) : (
        guard.recentProposals.map((p) => (
          <div className="ledger-row" key={p.topic.sequenceNumber}>
            <span className="ledger-key">
              #{p.topic.sequenceNumber} —{" "}
              {new Date(Number(p.topic.consensusTimestamp.split(".")[0]) * 1000).toLocaleString()}
            </span>
            <span className="ledger-value">
              <button className="btn btn-secondary" onClick={() => guard.loadProposal(p.topic.blob)}>
                Load
              </button>
            </span>
          </div>
        ))
      )}
    </div>
  );
}

/** The paste-box fallback, shared by both sections — shown when there's no active proposal. */
function PasteProposalBox({ guard }: { guard: ReturnType<typeof useMultisigRebalance> }) {
  if (guard.proposal) return null;
  return (
    <div className="swap-form" style={{ marginTop: "1rem" }}>
      <textarea
        className="swap-input"
        style={{ width: "100%", minHeight: "3rem" }}
        placeholder="Or paste a shared proposal to review and approve"
        value={guard.pasteInput}
        onChange={(e) => guard.setPasteInput(e.target.value)}
      />
      <button className="btn btn-secondary" onClick={() => guard.loadProposal(guard.pasteInput)}>
        Load proposal
      </button>
    </div>
  );
}

/**
 * The pending-proposal card, shared by the Rebalance and Owners sections — approvals, the stale
 * warning, and the Approve/Execute/Copy/Discard actions are identical regardless of what the
 * proposal actually does; only `summary` (the decoded-action-specific rows above them) differs.
 */
function ProposalCard({
  guard,
  threshold,
  isOwner,
  account,
  onApprove,
  onExecute,
  onCopy,
  summary,
  blockReason
}: {
  guard: ReturnType<typeof useMultisigRebalance>;
  threshold: number;
  isOwner: boolean;
  account: string | null;
  onApprove: () => void;
  onExecute: () => void;
  onCopy: () => void;
  summary: React.ReactNode;
  /** Set when this app's policy refuses the proposal — shown, and Approve/Execute disabled. */
  blockReason?: string | null;
}) {
  if (!guard.proposal || !guard.decoded) return null;
  const proposalMet = guard.approvals.length >= threshold;
  const blocked = guard.isStale || !!blockReason;

  return (
    <div className={`ledger-card${blocked ? " stale" : ""}`}>
      <p className="section-label">Pending proposal</p>
      {summary}
      <div className="ledger-row">
        <span className="ledger-key">Approvals</span>
        <span className="ledger-value">
          <span className={`status-dot ${proposalMet ? "on" : "off"}`} />
          {guard.approvals.length} of {threshold}
          {guard.approvals.length > 0 && (
            <>
              {" ("}
              {guard.approvals.map((o, i) => (
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

      {guard.isStale && (
        <div className="callout">
          <span className="status-dot off" />
          <span>
            {guard.isExpired ? "Deadline passed." : "Safe's nonce moved — stale."} Discard and propose
            again.
          </span>
        </div>
      )}

      {blockReason && (
        <div className="callout">
          <span className="status-dot off" />
          <span>{blockReason} Discard it and propose a majority threshold instead.</span>
        </div>
      )}

      <div className="action-row">
        <div className="action-row-primary">
          {isOwner && !guard.approvals.some((o) => o.toLowerCase() === account?.toLowerCase()) && (
            <button className="btn" onClick={onApprove} disabled={guard.isRunning || blocked}>
              Approve
            </button>
          )}
          <button className="btn" onClick={onExecute} disabled={guard.isRunning || !proposalMet || blocked}>
            Execute now
          </button>
        </div>
        <div className="action-row-secondary">
          <button className="btn btn-secondary" onClick={onCopy} disabled={guard.isRunning}>
            Copy proposal to share
          </button>
          <button className="btn btn-secondary" onClick={guard.reset} disabled={guard.isRunning}>
            Discard
          </button>
        </div>
      </div>
    </div>
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
  // null = follow the Safe's live threshold. A hardcoded default would silently lower the quorum
  // (e.g. 2-of-3 → 1-of-4) for any proposer who doesn't touch the field.
  const [newOwnerThreshold, setNewOwnerThreshold] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"safeswap" | "multisig" | "priceguard">("safeswap");

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

  const multisig = useMultisigRebalance({
    provider,
    owners: safeState?.owners ?? [],
    threshold: safeState?.threshold ?? 1,
    relevantKinds: ["rebalance"],
    onConfirmed: async () => {
      if (provider) await loadSafeData(provider);
    },
    setToast: showToast
  });

  const ownersProposal = useMultisigRebalance({
    provider,
    owners: safeState?.owners ?? [],
    threshold: safeState?.threshold ?? 1,
    relevantKinds: ["addOwner", "removeOwner"],
    onConfirmed: async () => {
      if (provider) await loadSafeData(provider);
    },
    setToast: showToast
  });

  /** Proposes adding `newOwnerAddress` at `newOwnerThreshold` — a real quorum-gated Safe
   * transaction (`addOwnerWithThreshold` is `SelfAuthorized`), not a solo action, except that at
   * threshold 1 "propose" and "approve" collapse into the same click since there's only one
   * owner to satisfy. */
  async function handleProposeAddOwner() {
    if (!provider || !safeState) return;
    if (!ethers.isAddress(newOwnerAddress)) {
      showToast("Enter a valid EVM address for the new owner.");
      return;
    }
    if (safeState.owners.some((o) => o.toLowerCase() === newOwnerAddress.toLowerCase())) {
      showToast("That address is already an owner.");
      return;
    }
    const ownersAfter = safeState.owners.length + 1;
    const min = minimumThreshold(ownersAfter);
    const nextThreshold = Number(newOwnerThreshold ?? defaultAddOwnerThreshold);
    if (!Number.isInteger(nextThreshold) || nextThreshold < min || nextThreshold > ownersAfter) {
      showToast(`With ${ownersAfter} owners the threshold must be between ${min} (a majority) and ${ownersAfter}.`);
      return;
    }
    const signer = await provider.getSigner();
    const built = await buildAddOwnerProposal(provider, newOwnerAddress, nextThreshold);
    await ownersProposal.propose(signer, built);
    setNewOwnerAddress("");
    setNewOwnerThreshold(null);
  }

  /** Proposes removing `ownerToRemove` with the threshold computed rather than asked for: the
   * current threshold, capped at the remaining owner count and raised to a majority if needed. */
  async function handleProposeRemoveOwner(ownerToRemove: string) {
    if (!provider || !safeState) return;
    const remaining = safeState.owners.length - 1;
    const nextThreshold = Math.max(minimumThreshold(remaining), Math.min(safeState.threshold, remaining));
    if (remaining < 1) {
      showToast("Can't remove the Safe's last owner.");
      return;
    }
    const signer = await provider.getSigner();
    const built = await buildRemoveOwnerProposal(provider, safeState.owners, ownerToRemove, nextThreshold);
    await ownersProposal.propose(signer, built);
  }

  async function handleOwnersApprove() {
    if (!provider) return;
    await ownersProposal.approve(await provider.getSigner());
  }

  async function handleOwnersExecute() {
    if (!provider) return;
    await ownersProposal.executeNow(await provider.getSigner());
  }

  async function handleOwnersCopy() {
    if (!ownersProposal.shareableBlob) return;
    try {
      await navigator.clipboard.writeText(ownersProposal.shareableBlob);
      showToast("Proposal copied — send it to the other owners to approve.");
    } catch {
      showToast("Couldn't access the clipboard — copy the text manually.");
    }
  }

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
    const built = await buildRebalanceProposal(provider, tokenIn.address, tokenOut.address, amountIn, min, deadline, slippageBps);
    await multisig.propose(signer, built);
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
  const defaultAddOwnerThreshold = safeState
    ? Math.max(safeState.threshold, minimumThreshold(safeState.owners.length + 1))
    : 1;
  const belowMajority = !!safeState && safeState.threshold < minimumThreshold(safeState.owners.length);
  const ownersPolicyError =
    ownersProposal.decoded && safeState
      ? thresholdPolicyError(ownersProposal.decoded, safeState.owners.length)
      : null;

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

      <div className="tabs">
        <button
          className={`tab${activeTab === "safeswap" ? " active" : ""}`}
          onClick={() => setActiveTab("safeswap")}
        >
          SafeSwap
        </button>
        <button
          className={`tab${activeTab === "multisig" ? " active" : ""}`}
          onClick={() => setActiveTab("multisig")}
        >
          MultiSig
        </button>
        {priceGuardAddress && (
          <button
            className={`tab${activeTab === "priceguard" ? " active" : ""}`}
            onClick={() => setActiveTab("priceguard")}
          >
            Price Guard
          </button>
        )}
      </div>

      {activeTab === "safeswap" && (
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
            <div className="ledger-row">
              <span className="ledger-key">Majority guard</span>
              <span className="ledger-value">
                <span className={`status-dot ${safeState.guard ? "on" : "off"}`} />
                {safeState.guard ? (
                  <a href={hashscanContractUrl(safeState.guard)} target="_blank" rel="noreferrer">
                    {shortenAddress(safeState.guard)}
                  </a>
                ) : (
                  "not set"
                )}
              </span>
            </div>
          </>
        )}
      </section>
      )}

      {activeTab === "multisig" && (
      <section className="ledger-section">
        <p className="section-label">Owners</p>
        <p className="section-desc">
          Adding or removing an owner changes who must sign, and can change the quorum itself —
          this goes through the same propose/approve/execute flow as a rebalance, never a single
          click.
        </p>

        {safeState && (
          <>
            {safeState.owners.map((o) => (
              <div className="ledger-row" key={o}>
                <span className="ledger-key" title={o}>
                  {shortenAddress(o)}
                  {o.toLowerCase() === account?.toLowerCase() && " (you)"}
                </span>
                <span className="ledger-value">
                  {/* No self-removal: an owner can't propose removing themselves, though other
                      owners can still propose removing them. */}
                  {isOwner && safeState.owners.length > 1 && o.toLowerCase() !== account?.toLowerCase() && (
                    <button
                      className="btn btn-secondary"
                      onClick={() => handleProposeRemoveOwner(o)}
                      disabled={ownersProposal.isRunning || !!ownersProposal.proposal}
                    >
                      Remove
                    </button>
                  )}
                </span>
              </div>
            ))}

            {isOwner && !ownersProposal.proposal && (
              <div className="swap-form" style={{ marginTop: "1rem" }}>
                <input
                  className="swap-input"
                  type="text"
                  placeholder="0x… new owner address"
                  value={newOwnerAddress}
                  onChange={(e) => setNewOwnerAddress(e.target.value)}
                  disabled={ownersProposal.isRunning}
                />
                <label className="slippage-control">
                  New threshold
                  <input
                    className="slippage-input"
                    type="number"
                    min={minimumThreshold(safeState.owners.length + 1)}
                    max={safeState.owners.length + 1}
                    value={newOwnerThreshold ?? String(defaultAddOwnerThreshold)}
                    onChange={(e) => setNewOwnerThreshold(e.target.value)}
                    disabled={ownersProposal.isRunning}
                  />
                </label>
                <button className="btn" onClick={handleProposeAddOwner} disabled={ownersProposal.isRunning}>
                  {ownersProposal.isRunning ? "Working…" : "Propose add owner"}
                </button>
              </div>
            )}

            {belowMajority && (
              <div className="callout">
                <span className="status-dot off" />
                <span>
                  This Safe is {safeState.threshold} of {safeState.owners.length}, below a majority.
                  Any owner change proposed here restores at least a majority (
                  {minimumThreshold(safeState.owners.length)} of {safeState.owners.length} today).
                </span>
              </div>
            )}
          </>
        )}

        <RecentProposalsCard guard={ownersProposal} />
        <PasteProposalBox guard={ownersProposal} />

        <ProposalCard
          guard={ownersProposal}
          threshold={threshold}
          isOwner={isOwner}
          account={account}
          onApprove={handleOwnersApprove}
          onExecute={handleOwnersExecute}
          onCopy={handleOwnersCopy}
          blockReason={ownersPolicyError}
          summary={
            ownersProposal.decoded && ownersProposal.decoded.kind !== "rebalance" && (
              <div className="ledger-row">
                <span className="ledger-key">{ownersProposal.decoded.kind === "addOwner" ? "Add" : "Remove"} owner</span>
                <span className="ledger-value" title={ownersProposal.decoded.owner}>
                  {shortenAddress(ownersProposal.decoded.owner)} — new threshold {ownersProposal.decoded.threshold}
                </span>
              </div>
            )
          }
        />

        <StatusTracker status={ownersProposal.status} />
      </section>
      )}

      {activeTab === "safeswap" && (
      <>
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
          Needs {threshold} of {safeState?.owners.length ?? 1} owner signatures
          {threshold > 1
            ? " — no single owner can move funds alone."
            : ". With one owner, add more in the MultiSig tab to require a quorum."}{" "}
          Propose, then Approve and Execute separately.
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

        <RecentProposalsCard guard={multisig} />
        <PasteProposalBox guard={multisig} />

        <ProposalCard
          guard={multisig}
          threshold={threshold}
          isOwner={isOwner}
          account={account}
          onApprove={handleApprove}
          onExecute={handleExecuteNow}
          onCopy={handleCopyProposal}
          summary={
            multisig.decoded &&
            multisig.decoded.kind === "rebalance" && (
              <>
                <div className="ledger-row">
                  <span className="ledger-key">Swap</span>
                  <span className="ledger-value">
                    {formatTokenAmount(multisig.decoded.tokenIn, multisig.decoded.amountIn)} → min{" "}
                    {formatTokenAmount(multisig.decoded.tokenOut, multisig.decoded.amountOutMin)}
                  </span>
                </div>
                {typeof multisig.proposal?.slippageBps === "number" && (
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
              </>
            )
          }
        />

        <StatusTracker status={multisig.status} />
      </section>
      </>
      )}

      {activeTab === "priceguard" && priceGuardAddress && (
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
          reproduceHint=""
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
