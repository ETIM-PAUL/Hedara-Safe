# AGENTS.md

Guidance for AI coding agents extending this template.

## What this template is

A Gnosis Safe multisig on Hedera, extended with one Safe module (`RebalanceModule.sol`) that
swaps treasury assets via the SaucerSwap router. The Safe core contracts are unmodified upstream
Safe contracts — treat them as vendored, not as something to refactor.

## Where things live

- `packages/contracts/contracts/RebalanceModule.sol` — the only contract meant to be extended.
  This is where new triggers, new router integrations, or new swap conditions go.
- `packages/contracts/contracts/vendor/SafeImports.sol` — imports the unmodified
  `@safe-global/safe-contracts` `Safe` and `SafeProxyFactory` into Hardhat's compile graph (they
  live in `node_modules`, not this repo). Don't hand-edit the Safe core; if it needs an upgrade,
  bump the npm dependency and re-run the full test suite.
- `packages/contracts/contracts/mocks/` — test doubles (`MockSafe`, `MockERC20`,
  `MockSaucerSwapRouter`) used only by `test/`. Never referenced by `deploy.ts` or the frontend —
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
- `packages/frontend/lib/` — `wallet.ts` (EIP-1193 connect + Hedera testnet chain add/switch),
  `safe.ts` (Safe/treasury reads), `rebalance.ts` (the trigger + status flow). Keep contract
  calls in `lib/`, not inline in `app/page.tsx` — the page should stay presentation-only.
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
  (module not enabled, caller not an owner, slippage exceeded) before considering a module done.
- Update `template.json`'s `capabilities.ecosystemIntegrations` if a new external protocol is
  wired in.

## What NOT to do

- Don't remove or bypass the SaucerSwap integration to "simplify" the demo — it's the reason this
  template exists and clears the bounty's ecosystem-integration bar.
- Don't commit `.env` or any operator key material.
- Don't add speculative configuration (multi-chain support, arbitrary router allowlists, etc.)
  unless it's actually being used — keep the module scoped to what the README documents.

## Testing

Run `npm run test --workspace packages/contracts` before opening a PR against this template.
Contract changes without a passing test for both success and failure paths should be treated as
incomplete.
