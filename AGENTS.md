# AGENTS.md

Guidance for AI coding agents extending this template.

## What this template is

A Gnosis Safe multisig on Hedera, extended with one Safe module (`RebalanceModule.sol`) that
swaps treasury assets via the SaucerSwap router. The Safe core contracts are unmodified upstream
Safe contracts — treat them as vendored, not as something to refactor.

## Where things live

- `packages/contracts/contracts/RebalanceModule.sol` — the only contract meant to be extended.
  This is where new triggers, new router integrations, or new swap conditions go.
- `packages/contracts/contracts/safe/` — vendored Safe singleton + proxy factory. Do not modify.
  If a Safe upgrade is needed, replace the vendored version wholesale and re-run the full test
  suite, don't hand-edit.
- `packages/contracts/scripts/deploy.ts` — deployment sequence: Safe singleton → proxy factory →
  Safe proxy → RebalanceModule → enable module on Safe. Keep this order; the module can't be
  enabled before the Safe proxy exists.
- `packages/frontend/` — Next.js app. Wallet connection and Safe reads live in
  `lib/`; the rebalance trigger flow lives in the main page component.

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
