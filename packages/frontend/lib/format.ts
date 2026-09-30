/** Every address shown in the UI goes through this — full addresses are noisy in a dense
 * ledger layout and don't help at a glance. Full value stays available via the `title` attribute
 * (hover) wherever this is rendered, for anyone who needs to copy/verify it exactly. */
export function shortenAddress(address: string): string {
  if (!address || address.length <= 14) return address;
  return `${address.slice(0, 6)}.....${address.slice(-4)}`;
}
