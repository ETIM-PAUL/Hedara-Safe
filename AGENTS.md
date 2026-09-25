# AGENTS.md

Guidance for AI coding agents extending this template.

## What this template is

A Gnosis Safe multisig on Hedera, extended with two Safe modules:

- `RebalanceModule.sol` — owner-triggered swap via the SaucerSwap router.
- `PriceGuardedRebalanceModule.sol` — permissionless to call, but only executes when a live price
  condition (configured by the Safe owner) holds. The oracle backing it is swappable at runtime
  between any deployed `IPriceOracleAdapter` — Chainlink and Supra adapters exist under
  `contracts/oracle/`. `setOracle()` switches it alone; `switchOracleAndTrigger()` switches and
  fires a trigger in one signed transaction (both owner-only — see why in "What NOT to do").

The Safe core contracts are unmodified upstream Safe contracts — treat them as vendored, not as
something to refactor.

## Where things live

- `packages/contracts/contracts/RebalanceModule.sol` — owner-only manual swap trigger.
- `packages/contracts/contracts/PriceGuardedRebalanceModule.sol` — permissionless, price-gated
  swap trigger. Reads its oracle only through `IPriceOracleAdapter` — never import a specific
  oracle SDK (Pyth, Chainlink, Supra) directly in this file. Uses `viaIR` (see the `overrides`
  entry in `hardhat.config.ts`) — its `trigger()` function has enough locals to hit "stack too
  deep" otherwise. That override is scoped to this one file specifically because the vendored
  Safe contracts' inline assembly isn't marked memory-safe and fails to compile under `viaIR`
  globally — don't turn `viaIR` on project-wide.
- `packages/contracts/contracts/oracle/` — `IPriceOracleAdapter.sol` (the interface every adapter
  implements: `getPrice()`, `refreshFee()`, `refresh()`) and the two real adapters (Chainlink,
  Supra — Pyth was removed, see below). Adding a new oracle means writing one more adapter here,
  not touching `PriceGuardedRebalanceModule.sol`. Two conventions every adapter follows, both
  there for a reason: `refreshFee()` and `refresh()` are separate calls (not one call returning a
  fee) so the module can send exactly the required fee and keep the rest for refunding the caller
  — combining them caused a real bug (the module forwarded the caller's entire `msg.value` into
  the adapter with nothing left to refund, and the refund reverted). And every adapter converts
  its oracle's native price format into signed `int64`/`int32 expo`/seconds-since-epoch before
  returning, regardless of what the real oracle uses on the wire — Supra's `time` is Unix
  *milliseconds* and its `price` is *unsigned*, both silently wrong if forwarded as-is.
  `maxPriceAgeSeconds` on the module is shared across whatever oracle is active — don't assume
  "push-model" means "always fresh within seconds": Chainlink's real testnet heartbeat is far
  coarser than Supra's, and a window tight enough for one tripped `StalePrice` against the other
  in practice. `86400` (24h) is the current default for exactly this reason.
- `packages/contracts/contracts/vendor/SafeImports.sol` — imports the unmodified
  `@safe-global/safe-contracts` `Safe` and `SafeProxyFactory` into Hardhat's compile graph (they
  live in `node_modules`, not this repo). Don't hand-edit the Safe core; if it needs an upgrade,
  bump the npm dependency and re-run the full test suite.
- `packages/contracts/contracts/mocks/` — test doubles (`MockSafe`, `MockERC20`,
  `MockSaucerSwapRouter`, `MockOracleAdapter` for module-level tests, `MockChainlinkAggregator`,
  `MockSupraStorage`) used only by `test/`. Never referenced by a deploy script or the frontend —
  if a mock leaks into a non-test file, that's a bug.
- `packages/contracts/scripts/deploy.ts` — deployment sequence: Safe singleton → `SafeProxyFactory`
  → Safe proxy → `RebalanceModule` → enable module on Safe. Keep this order; the module can't be
  enabled before the Safe proxy exists. `enableModule` only runs automatically for a 1-of-1,
  deployer-owned Safe (`SAFE_OWNERS`/`SAFE_THRESHOLD` unset) — a real multi-owner Safe needs that
  step submitted separately once enough owner signatures are collected.
- `packages/contracts/scripts/demo-rebalance.ts` — seeds a deployed Safe with real testnet tokens
  and triggers an actual rebalance. Read this before touching HTS token interactions: Hedera
  requires explicit association (`IHRC719.associate()`) before _any_ account — including the
  Safe itself — can hold a given token; a plain ERC20 `transfer` into an unassociated account
  reverts with no useful message. This isn't optional ERC20 ceremony, it's a Hedera-specific
  precondition every new token pair needs.
- `packages/contracts/scripts/deploy-oracle-adapters.ts` — the deploy script: both adapters, a
  fresh `PriceGuardedRebalanceModule`, a plain `trigger()` via Chainlink, then a combined
  `switchOracleAndTrigger()` to Supra — one signed transaction doing both the switch and the swap.
  Decode the resulting receipt's logs if you need to confirm that (see README's proof section for
  exactly how) rather than trusting the script's own console output.
- `packages/frontend/lib/` — `wallet.ts` (EIP-1193 connect/disconnect + Hedera testnet chain
  add/switch), `safe.ts` (Safe/treasury reads), `rebalance.ts` (`RebalanceModule` trigger, quotes,
  slippage), `priceGuard.ts` (`PriceGuardedRebalanceModule` state + trigger — `triggerPriceGuard()`
  picks `trigger()` vs. `switchOracleAndTrigger()` automatically based on whether the selected
  oracle differs from the active one, and `getOracleOptions()` is driven entirely by which
  `NEXT_PUBLIC_*_ADAPTER_ADDRESS` vars are set, not hardcoded), `txStatus.ts` (shared status-stage
  type and mirror-node polling both trigger flows use — add new trigger flows on top of this
  rather than duplicating the polling loop). Keep contract calls in `lib/`, not inline in
  `app/page.tsx` — the page should stay presentation-only.
  Every `NEXT_PUBLIC_*` var must be read as a static `process.env.NEXT_PUBLIC_X` expression
  (not `process.env[name]`) — Next.js can only inline a dynamic lookup like that on the server,
  not into the browser bundle, so it silently becomes `undefined` client-side. This bit us once;
  don't reintroduce it.
- `packages/frontend/next.config.mjs` — loads the monorepo-root `.env` via `dotenv`, since Next
  only auto-loads `.env` files from its own package directory. Required for `NEXT_PUBLIC_*` vars
  to reach the client bundle at all.

## Conventions when adding a new module type

- One module = one responsibility. Don't bolt a second integration onto `RebalanceModule`; add a
  new module contract instead, following the same `execTransactionFromModule` pattern.
- Every module function that moves funds must take explicit slippage and deadline parameters —
  no unbounded swaps.
- Add a corresponding Hardhat test covering both the happy path and at least one failure path
  (module not enabled, caller not an owner / condition not met, slippage exceeded) before
  considering a module done.
- If a module needs a permissionless trigger (anyone can call it, not just an owner), the guard
  condition itself must be what's checked on-chain — never rely on "well-behaved callers." See
  `PriceGuardedRebalanceModule`'s price check for the pattern.
- If a permissionless function reads from configurable external state (like which oracle is
  active), never let the caller supply that state themselves — only an authenticated party
  (here, the Safe owner) may change it. `trigger()` takes no oracle argument for exactly this
  reason: a caller-supplied oracle address could point at a contract that always reports the
  condition as met.

## What NOT to do

- Don't remove or bypass the SaucerSwap integration, or either oracle integration, to "simplify"
  the demo — they're the reason this template exists and clear the bounty's ecosystem-integration
  bar.
- Don't have `PriceGuardedRebalanceModule.sol` import a specific oracle SDK directly — that's what
  `IPriceOracleAdapter` and `contracts/oracle/` are for. A module that only speaks one oracle
  can't be switched at runtime, which defeats the point of `setOracle()`.
- Don't commit `.env` or any operator key material.
- Don't add speculative configuration (multi-chain support, arbitrary router allowlists, etc.)
  unless it's actually being used — keep the module scoped to what the README documents.

## Testing

Run `npm run test --workspace packages/contracts` before opening a PR against this template.
Contract changes without a passing test for both success and failure paths should be treated as
incomplete.
