# Recipe: regression check for the finished template

## Goal

This is not a feature-build PRD — the template is finished. This recipe exists so
`hedera-harness run` can be used going forward as a regression check: confirm that install,
build, lint, tests, and the frontend's boot behavior all still hold after any future change to
`hedera-safe-swap`.

## What the template already does

- `packages/contracts/contracts/RebalanceModule.sol` — a Safe module that swaps treasury holdings
  through SaucerSwap's V1 router (`swapExactTokensForTokens`), gated to Safe owners.
- Deployed and enabled on Hedera testnet: Safe at `0x487f330a30E6c7101f86e598BE27a5d46C8B3589`,
  module at `0x27714cc6907e8EB771CCe77159111b19Aa2E9Efe` (see README.md for Hashscan links).
- A real rebalance (2.5 WHBAR → 1.37386050 SAUCE) executed and mirror-node-verified via
  `packages/contracts/scripts/demo-rebalance.ts` — also linked in README.md.
- `packages/frontend` — Next.js dashboard: wallet connect, Safe/treasury reads, and a rebalance
  trigger with live transaction status.

## Existing app (preserve)

- `RebalanceModule.sol`'s external interface (constructor args, `rebalance` signature) — do not
  change without updating the deployed contract references throughout the repo.
- The vendored Safe core (`contracts/vendor/SafeImports.sol`) — never hand-edited.
- `lib/safe.ts`'s static `process.env.NEXT_PUBLIC_X` references — a dynamic `process.env[name]`
  lookup breaks Next.js's client-bundle inlining silently (this bit the project once already; see
  AGENTS.md).

## Feature to implement

None by default. If this recipe is run with a real feature PRD swapped in, follow AGENTS.md's
conventions: one module = one responsibility, explicit slippage/deadline params on any fund-moving
function, and a passing test for both the happy path and at least one failure path before calling
a change done.

## Non-goals

- Do not switch the package manager away from npm.
- Do not remove or bypass the SaucerSwap integration.
- Do not commit secrets or `.env` files.

## Acceptance (deterministic)

1. `npm install` and `npm run build` succeed from a clean state.
2. `npm run lint` passes with zero errors.
3. `npm run test --workspace packages/contracts` passes (all 7 existing cases, plus any new ones).
4. The frontend boots and the home route renders real content — no unset-env-var error text
   visible (see `.harness/validators/playwright-smoke.yaml`).
