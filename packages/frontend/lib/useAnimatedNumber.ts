import { useEffect, useRef, useState } from "react";

/**
 * Tweens a displayed number toward `target` whenever it changes — the one deliberate motion
 * on this page, reserved for the moment a rebalance actually changes a treasury balance.
 */
export function useAnimatedNumber(target: number, decimals: number, durationMs = 700): string {
  const [displayed, setDisplayed] = useState(target);
  const fromRef = useRef(target);
  const frameRef = useRef<number>();

  useEffect(() => {
    const from = fromRef.current;
    const to = target;
    if (from === to) return;

    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (prefersReducedMotion) {
      setDisplayed(to);
      fromRef.current = to;
      return;
    }

    const start = performance.now();
    const step = (now: number) => {
      const progress = Math.min((now - start) / durationMs, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplayed(from + (to - from) * eased);
      if (progress < 1) {
        frameRef.current = requestAnimationFrame(step);
      } else {
        fromRef.current = to;
      }
    };
    frameRef.current = requestAnimationFrame(step);

    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  return displayed.toFixed(decimals);
}
