import { useEffect, useState } from "react";
import type { BrowserProvider } from "ethers";
import {
  getPriceGuardState,
  triggerPriceGuard,
  previewCondition,
  formatOraclePrice,
  type PriceGuardState,
  type OracleOption
} from "./priceGuard";
import type { TreasuryToken, TokenBalance } from "./safe";
import type { RebalanceStatus } from "./txStatus";

export interface SelectedOracleCondition {
  priceHuman: string;
  ageSeconds: number;
  conditionMet: boolean;
}

/**
 * Encapsulates one price-guard instance's state, direction toggle, oracle preview, and trigger
 * flow, kept separate from the presentational section component.
 */
export function usePriceGuard(params: {
  moduleAddress: string | null;
  provider: BrowserProvider | null;
  tokenA: TreasuryToken;
  tokenB: TreasuryToken;
  balances: TokenBalance[] | null;
  onConfirmed: () => Promise<void>;
  setToast: (message: string) => void;
}) {
  const { moduleAddress, provider, tokenA, tokenB, balances, onConfirmed, setToast } = params;

  const [state, setState] = useState<PriceGuardState | null>(null);
  const [reversed, setReversed] = useState(false);
  const [amount, setAmount] = useState("1.0");
  const [status, setStatus] = useState<RebalanceStatus | null>(null);
  const [selectedOracle, setSelectedOracle] = useState("");
  const [selectedOracleCondition, setSelectedOracleCondition] = useState<SelectedOracleCondition | null>(null);

  const tokenIn = reversed ? tokenB : tokenA;
  const tokenOut = reversed ? tokenA : tokenB;

  // Load (or clear) this guard's state whenever the connection or module changes.
  useEffect(() => {
    if (!provider || !moduleAddress) {
      setState(null);
      return;
    }
    let cancelled = false;
    getPriceGuardState(provider, moduleAddress)
      .then((s) => {
        if (!cancelled) setState(s);
      })
      .catch(() => {
        if (!cancelled) setState(null);
      });
    return () => {
      cancelled = true;
    };
  }, [provider, moduleAddress]);

  useEffect(() => {
    if (state && !selectedOracle) {
      setSelectedOracle(state.oracleAddress);
    }
  }, [state, selectedOracle]);

  // Re-preview whenever the selected oracle changes — the button needs to reflect what *that*
  // oracle would do, not just the currently-active one.
  useEffect(() => {
    if (!provider || !selectedOracle || !state) {
      setSelectedOracleCondition(null);
      return;
    }
    if (selectedOracle.toLowerCase() === state.oracleAddress.toLowerCase()) {
      setSelectedOracleCondition({
        priceHuman: formatOraclePrice(state.observedPrice, state.observedExpo),
        ageSeconds: state.observedAgeSeconds,
        conditionMet: state.conditionMet
      });
      return;
    }
    let cancelled = false;
    previewCondition(provider, selectedOracle, state.triggerPrice, state.triggerExpo, state.comparison)
      .then((preview) => {
        if (cancelled) return;
        setSelectedOracleCondition({
          priceHuman: formatOraclePrice(preview.price, preview.expo),
          ageSeconds: preview.ageSeconds,
          conditionMet: preview.conditionMet
        });
      })
      .catch(() => {
        if (!cancelled) setSelectedOracleCondition(null);
      });
    return () => {
      cancelled = true;
    };
  }, [provider, selectedOracle, state]);

  const isRunning = status !== null && status.stage !== "confirmed" && status.stage !== "failed";

  async function refresh() {
    if (!provider || !moduleAddress) return;
    try {
      setState(await getPriceGuardState(provider, moduleAddress));
    } catch {
      setState(null);
    }
  }

  async function handleTrigger() {
    if (!provider || !moduleAddress || !state) return;

    const requested = Number(amount);
    if (!Number.isFinite(requested) || requested <= 0) {
      setToast("Enter an amount greater than zero.");
      return;
    }

    const currentBalance = balances?.find((b) => b.address === tokenIn.address);
    const available = Number(currentBalance?.balance ?? "0");
    if (requested > available) {
      setToast(
        `Insufficient ${tokenIn.symbol} balance — the Safe holds ${currentBalance?.balance ?? "0"} ${tokenIn.symbol}.`
      );
      return;
    }

    if (!selectedOracleCondition?.conditionMet) {
      setToast("Price condition isn't met for the selected oracle — trigger would revert.");
      return;
    }

    setStatus(null);
    const signer = await provider.getSigner();
    await triggerPriceGuard(
      signer,
      moduleAddress,
      state.oracleAddress,
      selectedOracle,
      tokenIn,
      tokenOut,
      amount,
      async (next) => {
        setStatus(next);
        if (next.stage === "confirmed") {
          await onConfirmed();
          await refresh();
        }
      }
    );
  }

  return {
    state,
    reversed,
    setReversed,
    amount,
    setAmount,
    status,
    isRunning,
    tokenIn,
    tokenOut,
    selectedOracle,
    setSelectedOracle,
    selectedOracleCondition,
    handleTrigger
  };
}

export type { OracleOption };
