# Feature brief: Safe deployment + module wiring

## Goal

Complete the TODO in `packages/contracts/scripts/deploy.ts`: deploy the Gnosis
Safe singleton and proxy factory from `@safe-global/safe-contracts`, deploy one
Safe proxy configured with the owners/threshold from `template.json`'s
`defaults` block (2-of-3), then deploy `RebalanceModule` pointing at that Safe
and the configured SaucerSwap router, and enable the module on the Safe.

## Who it is for

Developers scaffolding a Safe multisig treasury on Hedera via
`npm create scaffold-hbar@latest --template <org>/hedera-safe-swap`.

## Existing app (preserve)

- `packages/contracts/contracts/RebalanceModule.sol` — do not change its
  external interface (constructor args, `rebalance` signature).
- `packages/contracts/contracts/interfaces/ISafe.sol` and
  `ISaucerSwapRouter.sol` — minimal interfaces, keep them minimal.
- `packages/frontend` — Next.js scaffold, out of scope for this increment.
- `AGENTS.md` conventions: one module = one responsibility, no unbounded
  swaps, don't touch vendored Safe core contracts by hand.

## Feature to implement

In `packages/contracts/scripts/deploy.ts`, replace the Phase 4 TODO with:

1. Deploy `GnosisSafe` singleton and `GnosisSafeProxyFactory` from
   `@safe-global/safe-contracts`.
2. Build Safe `setup` calldata for a 2-of-3 owner configuration (owners can be
   read from an `SAFE_OWNERS` env var, comma-separated addresses, falling back
   to `[deployer]` repeated for local testing).
3. Deploy the Safe proxy via the factory.
4. Deploy `RebalanceModule` with the new Safe's address and
   `SAUCERSWAP_ROUTER_ADDRESS`.
5. Enable the module on the Safe (owner-signed `enableModule` call — for a
   single deployer-owned test Safe this can execute directly; document that a
   multi-owner Safe requires a threshold of signatures instead).
6. Log the Safe address and module address clearly so they can be copied into
   `.env` as `NEXT_PUBLIC_SAFE_ADDRESS`.

## Non-goals

- Do not switch the package manager away from npm.
- Do not modify `RebalanceModule.sol`'s external interface.
- Do not commit secrets or `.env` files.
- Do not touch `packages/frontend` in this increment.

## Acceptance (deterministic)

1. `npm run build` (root) still passes — contracts compile, frontend builds.
2. `npm run test --workspace packages/contracts` still passes, including the
   existing `RebalanceModule` deployment test.
3. `deploy.ts` no longer contains the Phase 4 TODO comment block.
4. No `.env` or secret material is committed.
