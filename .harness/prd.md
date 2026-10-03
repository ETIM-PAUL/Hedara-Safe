# Recipe: regression check for the finished template

## Goal

This is not a feature-build PRD — the template is finished. This recipe exists so
`hedera-harness run` can be used going forward as a regression check: confirm that install,
build, lint, tests, and the frontend's boot behavior all still hold after any future change to
`hedera-safe-swap`.

## What the template already does

- `packages/contracts/contracts/RebalanceModule.sol` — a Safe module that swaps treasury holdings
  through SaucerSwap's V1 router (`swapExactTokensForTokens`). `rebalance()` is `onlySafe`
  (`msg.sender == address(safe)`), so it only runs via a quorum-approved Safe `execTransaction`.
  Current deployment: `0x13642c65E863CdEc489999cf92Ef45c82d9c4Ac4` on Safe
  `0x487f330a30E6c7101f86e598BE27a5d46C8B3589` (2-of-3).
- `packages/contracts/contracts/MajorityThresholdGuard.sol` — Safe transaction guard keeping the
  threshold at a strict majority of owners on-chain.
- `packages/contracts/contracts/PriceGuardedRebalanceModule.sol` — permissionless `trigger()`,
  executes only when HBAR/USD meets an owner-set condition. Oracle switchable at runtime between
  `ChainlinkPriceAdapter` and `SupraPriceAdapter` (`contracts/oracle/`).
- Real, mirror-node-verified testnet transactions for each path — single-owner rebalance,
  Chainlink trigger, combined Supra switch+trigger, and a 2-of-3 quorum rebalance (including a
  deliberate under-quorum attempt that reverts with `GS020`). All linked in README.md.
- HCS topic `0.0.10808809` relays proposals between owners (`create-proposals-topic.ts`,
  `packages/frontend/app/api/proposals/route.ts`).
- `packages/frontend` — Next.js dashboard in three tabs: **SafeSwap** (Safe/treasury reads and
  quorum-gated rebalance), **MultiSig** (quorum-gated owner add/remove), **Price Guard** (oracle
  preview, switch, and trigger).

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
3. `npm run test --workspace packages/contracts` passes (all 35 existing cases, plus any new ones).
4. The frontend boots and the home route renders real content — no unset-env-var error text
   visible (see `.harness/validators/playwright-smoke.yaml`).
