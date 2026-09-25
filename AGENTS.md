# AGENTS.md

Guidance for AI coding agents extending this template.

## What this template is

A Gnosis Safe multisig on Hedera, extended with two Safe modules:

- `RebalanceModule.sol` — owner-triggered swap via the SaucerSwap router.
- `PriceGuardedRebalanceModule.sol` — permissionless to call, but only executes when a live Pyth
  price condition (configured by the Safe owner) holds.

The Safe core contracts are unmodified upstream Safe contracts — treat them as vendored, not as
something to refactor.

## Where things live

- `packages/contracts/contracts/RebalanceModule.sol` — owner-only manual swap trigger.
- `packages/contracts/contracts/PriceGuardedRebalanceModule.sol` — permissionless, price-gated
  swap trigger. Uses `viaIR` (see the `overrides` entry in `hardhat.config.ts`) — its `trigger()`
  function has enough locals to hit "stack too deep" otherwise. That override is scoped to this
  one file specifically because the vendored Safe contracts' inline assembly isn't marked
  memory-safe and fails to compile under `viaIR` globally — don't turn `viaIR` on project-wide.
- `packages/contracts/contracts/vendor/SafeImports.sol` — imports the unmodified
  `@safe-global/safe-contracts` `Safe` and `SafeProxyFactory` into Hardhat's compile graph (they
  live in `node_modules`, not this repo). Don't hand-edit the Safe core; if it needs an upgrade,
  bump the npm dependency and re-run the full test suite.
- `packages/contracts/contracts/mocks/` — test doubles (`MockSafe`, `MockERC20`,
  `MockSaucerSwapRouter`, plus `PythImports.sol` pulling in the Pyth SDK's own `MockPyth`) used
  only by `test/`. Never referenced by a deploy script or the frontend — if a mock leaks into a
  non-test file, that's a bug.
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
- `packages/contracts/scripts/deploy-price-guard.ts` — deploys `PriceGuardedRebalanceModule` and
  fires a real trigger. Calls `trigger()` with an empty `priceUpdateData` array because Pyth's
  Hermes API now requires an API key we haven't wired up — that's a real, supported Pyth code
  path (reads whatever price is already on-chain rather than pushing a fresh one), not a
  workaround to hide. See README's "Known limitation" note before changing this script's
  `maxPriceAgeSeconds` — it's deliberately generous to tolerate a stale testnet feed, and should
  not be copied as-is into anything resembling production.
- `packages/frontend/lib/` — `wallet.ts` (EIP-1193 connect/disconnect + Hedera testnet chain
  add/switch), `safe.ts` (Safe/treasury reads), `rebalance.ts` (`RebalanceModule` trigger, quotes,
  slippage), `priceGuard.ts` (`PriceGuardedRebalanceModule` trigger + live condition state),
  `txStatus.ts` (shared status-stage type and mirror-node polling both trigger flows use — add
  new trigger flows on top of this rather than duplicating the polling loop). Keep contract calls
  in `lib/`, not inline in `app/page.tsx` — the page should stay presentation-only.
  Every `NEXT_PUBLIC_*` var must be read as a static `process.env.NEXT_PUBLIC_X` expression
  (not `process.env[name]`) — Next.js can only inline a dynamic lookup like that on the server,
  not into the browser bundle, so it silently becomes `undefined` client-side. This bit us once;
  don't reintroduce it.
- `PYTH_HERMES_API_KEY` (if ever wired up) must never be read from a `NEXT_PUBLIC_*` var — it
  would ship in the browser bundle, visible to every visitor. If the frontend needs fresh Pyth
  update data, fetch it from a server-side Next.js API route that holds the key, not directly
  from the browser.
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

## What NOT to do

- Don't remove or bypass the SaucerSwap or Pyth integrations to "simplify" the demo — they're the
  reason this template exists and clear the bounty's ecosystem-integration bar.
- Don't commit `.env` or any operator key material.
- Don't add speculative configuration (multi-chain support, arbitrary router allowlists, etc.)
  unless it's actually being used — keep the module scoped to what the README documents.

## Testing

Run `npm run test --workspace packages/contracts` before opening a PR against this template.
Contract changes without a passing test for both success and failure paths should be treated as
incomplete.
