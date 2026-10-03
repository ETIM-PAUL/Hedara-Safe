# AGENTS.md

Guidance for AI coding agents extending this template.

## What this template is

A Gnosis Safe multisig on Hedera, extended with two Safe modules:

- `RebalanceModule.sol` — Safe-quorum-triggered swap via the SaucerSwap router. `rebalance()`
  requires `msg.sender == address(safe)` (the `onlySafe` modifier) — it does **not** accept a call
  from any single owner's own account, however many owners exist or whatever the threshold is set
  to. The only way to call it is a Safe `execTransaction` targeting the module, which already
  means the Safe's configured signature threshold was met. See [Multisig: adding owners and
  quorum-gated rebalances](README.md#multisig-adding-owners-and-quorum-gated-rebalances) in the
  README for the full mechanics (owner growth, proposal sharing, signature aggregation) — this is
  a deliberate divergence from `PriceGuardedRebalanceModule`'s owner/permissionless gating, not an
  oversight; see why below.
- `PriceGuardedRebalanceModule.sol` — permissionless to call, but only executes when a live price
  condition (configured by the Safe owner) holds. The oracle backing it is swappable at runtime
  between any deployed `IPriceOracleAdapter` — Chainlink and Supra adapters exist under
  `contracts/oracle/`. `setOracle()` switches it alone; `switchOracleAndTrigger()` switches and
  fires a trigger in one signed transaction (both owner-only — see why in "What NOT to do").

The module is gated on **HBAR/USD**, switchable at runtime between Chainlink and Supra. WHBAR
tracks HBAR 1:1, so HBAR/USD is a correct stand-in for the WHBAR side of a WHBAR↔SAUCE swap; it
doesn't price SAUCE itself. A pair whose other leg isn't USD-pegged would need a real
pair-denominated feed instead — check both providers' actual feed coverage on the target network
before assuming HBAR/USD-style proxying is good enough.

The Safe core contracts are unmodified upstream Safe contracts — treat them as vendored, not as
something to refactor.

## Where things live

- `packages/contracts/contracts/RebalanceModule.sol` — Safe-only manual swap trigger (see above).
  The `Rebalanced` event's `triggeredBy` field is always `address(safe)` now, not an individual
  owner's address — the Safe itself is the caller by construction, so there's no other value it
  could meaningfully carry; don't try to thread an "actual executor" through here without adding
  real signature-recovery logic, since `tx.origin` is not a trustworthy substitute (a relayer could
  submit on an owner's behalf).
- `packages/contracts/contracts/PriceGuardedRebalanceModule.sol` — permissionless, price-gated
  swap trigger. Reads its oracle only through `IPriceOracleAdapter` — never import a specific
  oracle SDK (Pyth, Chainlink, Supra) directly in this file. Uses `viaIR` (see the `overrides`
  entry in `hardhat.config.ts`) — its `trigger()` function has enough locals to hit "stack too
  deep" otherwise. That override is scoped to this one file specifically because the vendored
  Safe contracts' inline assembly isn't marked memory-safe and fails to compile under `viaIR`
  globally — don't turn `viaIR` on project-wide.
- `packages/contracts/contracts/MajorityThresholdGuard.sol` — Safe transaction guard (installed via
  `setGuard`, Safe's own extension point — the vendored core is untouched) that reverts any
  `execTransaction` leaving `threshold < owners / 2 + 1`. It checks the Safe's state *after*
  execution instead of decoding calldata, so new ways of changing owners (batches, `swapOwner`)
  are covered without a selector list. Two limits to respect: Safe 1.4.1 doesn't guard
  `execTransactionFromModule`, so never give a module the ability to change owners or threshold;
  and a guard that always reverts would brick the Safe (the removal transaction is checked too) —
  any change here needs `test/MajorityThresholdGuard.test.ts` to keep passing, especially the
  removal and below-majority-lockdown cases. Installed by `scripts/deploy-majority-guard.ts`, which
  restores a majority *before* setting the guard.
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
  if a mock leaks into a non-test file, that's a bug. `RebalanceModule.test.ts`'s happy-path tests
  impersonate `MockSafe`'s own address (`hardhat_impersonateAccount` + `hardhat_setBalance`) to
  simulate a call arriving with `msg.sender == address(safe)`, rather than adding real Safe
  signature-verification logic to the mock — that's what a real Safe already does, so testing it
  again in the mock would just be testing the mock.
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
- `packages/contracts/scripts/deploy-multisig-rebalance.ts` — deploys a fresh `RebalanceModule`
  (required: the old deployed one still has `onlySafeOwner` bytecode and would revert if called
  via `execTransaction`), grows the Safe to 3 owners, raises the threshold to 2-of-3, and proves a
  real quorum-gated rebalance — including a deliberate premature-execution attempt with only 1 of
  2 required approvals, which must revert. Needs `OWNER2_ADDRESS`/`OWNER2_KEY`/`OWNER3_ADDRESS` in
  `.env` (two funded throwaway testnet accounts) — this is the one script in this repo that needs
  more than the single operator key, since proving a quorum requires genuinely different signers.
- `packages/contracts/scripts/create-proposals-topic.ts` — the one script that uses the native
  `@hashgraph/sdk` instead of Hardhat/ethers, because creating an HCS topic has no EVM/JSON-RPC
  equivalent. One-time setup for the proposal relay (see below) — run once, save the printed topic
  ID into `.env`.
- `packages/frontend/lib/` — `wallet.ts` (EIP-1193 connect/disconnect + Hedera testnet chain
  add/switch), `safe.ts` (Safe/treasury reads — kept read-only by convention; anything that sends
  a Safe transaction lives in `multisig.ts` instead), `rebalance.ts` (SaucerSwap quote/slippage
  helpers only now — `RebalanceModule`'s old single-owner trigger function was removed from here
  when `rebalance()` became Safe-only; see `multisig.ts`), `multisig.ts` (the generalized
  propose/approve/execute machinery every quorum-gated Safe action goes through — a rebalance
  and an owner add/remove alike. A `SafeProposal` is tagged with a `kind`
  (`"rebalance" | "addOwner" | "removeOwner"`); `buildRebalanceProposal()`,
  `buildAddOwnerProposal()`, and `buildRemoveOwnerProposal()` each build the exact `(to, data,
  nonce)` tuple for their kind — `buildRemoveOwnerProposal()` additionally computes `prevOwner`
  from the Safe's current owner list, since `Safe.removeOwner` needs the owner immediately before
  the target in its internal linked list (`getOwners()`'s order, so `owners[i - 1]`, or the
  sentinel `0x1` for index 0). From there every kind shares the same `getApprovals()`,
  `approveProposal()`, and `executeProposal()`, which get owners' `approveHash()` on-chain,
  aggregate their approved-hash signatures once threshold is met, and submit `execTransaction`;
  see the README's "Multisig" section for why this exists and how proposals travel between owners
  without a backend. There is no standalone single-owner `addOwner()` anymore; growing or
  shrinking the owner set always goes through this same propose/approve/execute path, even at
  threshold 1. `minimumThreshold()`/`thresholdPolicyError()` hold the app's quorum policy — every
  owner change must leave a strict majority (`floor(owners / 2) + 1`). On-chain,
  `MajorityThresholdGuard.sol` enforces the same rule; the app-side check is there for a clear
  message before anyone signs. Keep the two formulas identical. Check loaded proposals against it,
  not just the propose form, since a blob from HCS or a paste never went through the form. Don't add a fourth proposal kind here without also deciding deliberately whether it
  needs `onlySafe`-style quorum gating at all — see "Conventions" below),
  `useMultisigRebalance.ts` (the hook each proposal-kind section's UI state machine is built
  from — building/loading a proposal, tracking approvals, executing. Takes a `relevantKinds:
  ProposalKind[]` so the frontend can run two independent instances off the same hook — one for
  the SafeSwap tab's rebalance proposals, one for the MultiSig tab's owner add/remove proposals —
  each with its own pending-proposal state, filtering the shared HCS topic to only the kinds it
  cares about. `propose()` takes an already-built `SafeProposal` (call one of the `build*Proposal`
  functions above first) rather than raw parameters, so it doesn't need to know which kind it's
  handling. Approving and executing are always two separate calls, even when an approval happens
  to meet the threshold — don't reintroduce auto-chaining approve straight into execute; a wallet
  confirmation for "approve" should never silently become a second confirmation that moves
  treasury funds or changes who controls the Safe), `hcs.ts` (reads: plain mirror
  node fetches, public, no key. Writes: POSTs to `app/api/proposals/route.ts`, since there's no way
  to submit an HCS message from a browser wallet — see "Proposal relay via HCS" in the README for
  why, including why this isn't available as a Solidity precompile today despite HTS having one),
  `priceGuard.ts` (`PriceGuardedRebalanceModule` state + trigger — `triggerPriceGuard()`
  picks `trigger()` vs. `switchOracleAndTrigger()` automatically based on whether the selected
  oracle differs from the active one, and `getOracleOptions()` is driven entirely by which
  `NEXT_PUBLIC_*_ADAPTER_ADDRESS` vars are set, not hardcoded), `usePriceGuard.ts` (the hook the
  guard section is built from — state fetch, direction toggle, oracle preview, trigger handler;
  kept separate from `PriceGuardSection` so a second guard instance could be added without
  duplicating this logic, if one is ever needed),
  `txStatus.ts` (shared status-stage type and mirror-node polling every trigger flow uses — add new
  trigger flows on top of this rather than duplicating the polling loop). Keep contract calls in
  `lib/`, not inline in `app/page.tsx` — the page should stay presentation-only.
  Every `NEXT_PUBLIC_*` var must be read as a static `process.env.NEXT_PUBLIC_X` expression
  (not `process.env[name]`) — Next.js can only inline a dynamic lookup like that on the server,
  not into the browser bundle, so it silently becomes `undefined` client-side. This bit us once;
  don't reintroduce it.
- `packages/frontend/app/page.tsx` — presentation only, split into three tabs under the connect
  row: **SafeSwap** (Safe info, holdings, rebalance), **MultiSig** (owner add/remove), and
  **Price Guard** (rendered only when `NEXT_PUBLIC_PRICE_GUARD_MODULE_ADDRESS` is set). Tabs only
  switch what's rendered; every hook (`useMultisigRebalance` ×2, `usePriceGuard`) is called
  unconditionally at the top of the component, so a pending proposal in one tab survives
  switching to another. Don't move a hook inside a tab's conditional block. `ProposalCard`,
  `RecentProposalsCard`, and `PasteProposalBox` are shared by both quorum tabs; add a new
  proposal kind's UI by passing a different `summary`, not by copying the card.
- `packages/frontend/.eslintrc.json` — `next/core-web-vitals`. Without it, `next lint` drops into
  an interactive setup prompt and exits non-zero, which fails `npm run lint` on any fresh
  scaffold. Keep it committed.
- `packages/frontend/next.config.mjs` — loads the monorepo-root `.env` via `dotenv`, since Next
  only auto-loads `.env` files from its own package directory. Required for `NEXT_PUBLIC_*` vars
  to reach the client bundle at all. The same `dotenv.config()` call is also what makes
  `HEDERA_OPERATOR_ID`/`HEDERA_OPERATOR_KEY` available to `app/api/proposals/route.ts` — no new
  env var needed for the HCS relay, it just reads the same operator credentials already used
  everywhere else in this repo.
- `packages/frontend/app/api/proposals/route.ts` — the only server-side route in this app, and the
  only place it holds a private key (the testnet operator's, reused — never a new credential,
  never `NEXT_PUBLIC_*`). Submits a proposal blob to the HCS topic from `create-proposals-topic.ts`
  on behalf of whoever proposed it. Must declare `export const runtime = "nodejs"` — `@hashgraph/sdk`
  doesn't work on Next's Edge runtime, which is otherwise the App Router default for route
  handlers. This route only ever posts data; it has no way to authorize a Safe transaction, so it
  being down or misconfigured degrades the UI to the copy/paste fallback, nothing more.

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
- Decide deliberately between `onlySafeOwner` (`safe.isOwner(msg.sender)` — any single owner acts
  alone, regardless of threshold) and `onlySafe` (`msg.sender == address(safe)` — requires a real
  quorum-approved `execTransaction`) for any new owner-gated function; don't default to whichever
  is less code. `RebalanceModule` uses `onlySafe` because moving treasury funds should require the
  Safe's actual signature threshold. `PriceGuardedRebalanceModule` uses `onlySafeOwner` for
  `setOracle()`/`switchOracleAndTrigger()` because the price condition is what's supposed to be the
  safety property, not who calls it — adding a quorum requirement there would slow down a module
  designed to be fast and permissionless without making it any safer.

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
- Don't build an off-chain/limit-order path through SaucerSwap V3's order-book reactor for the
  Safe. Checked directly against the reactor's deployed bytecode
  (`0x5707B946EE64bD750A587261Ce36ec7024F3088B`) — it contains no EIP-1271 magic value
  (`0x1626ba7e`) and no `isValidSignature` selector in either form, so it cannot verify a Safe's
  authorization at all, only a raw ECDSA signature from a real private key. This isn't a "not
  built yet"; it's "cannot be built against this contract as it exists today." Re-verify against
  the live bytecode before revisiting, in case SaucerSwap ships a new reactor version.
- Don't call HCS (`submitMessage`, `createTopic`, etc.) directly from Solidity, expecting a
  precompile the way HTS has one at `0x167`. [HIP-1208](https://github.com/hiero-ledger/hiero-improvement-proposals/pull/1208)
  proposes exactly that and is still in Draft, effectively stagnant since December 2025 — not
  deployed anywhere. HCS reads are a plain mirror-node fetch (see `lib/hcs.ts`); HCS writes need
  the native Hedera SDK with a real account key, which is why `app/api/proposals/route.ts` exists
  as the one server-side piece in this app. Re-check HIP-1208's status before assuming this has
  changed.

## Testing

Run `npm run test --workspace packages/contracts` before opening a PR against this template.
Contract changes without a passing test for both success and failure paths should be treated as
incomplete.

## `packages/contracts/package.json` lists `@nomicfoundation/hardhat-toolbox`'s full peer-dependency tree explicitly — don't trim it

`hardhat-toolbox` doesn't bundle its sub-plugins (`hardhat-ethers`, `hardhat-chai-matchers`,
`hardhat-verify`, `hardhat-ignition-ethers`, `typechain`, `ts-node`, `ethers`, etc.) — it only
peer-requires them. A plain `npm install` auto-installs missing peers (npm 7+ default), which is
why this worked for months of local development without anyone declaring them. It silently breaks
the moment anyone installs with `--legacy-peer-deps` — which is exactly what
`create-scaffold-hbar`'s own scaffolding flow does by default. A real fresh scaffold against this
repo failed at `hardhat compile` with `HH801` (missing `ts-node`, then — after adding that — a
second `HH801` for the rest of the toolbox's peers, then a third for
`hardhat-ignition-ethers`'s own transitive peers `hardhat-ignition`/`ignition-core`). Caught and
fixed by actually scaffolding fresh copies of this exact repo via `npm create scaffold-hbar --
--template <owner>/<repo> --yes` and running `npm run build` on them — not by reasoning about it.
If you add a new Hardhat plugin, check its `peerDependencies` and declare every one of them here
explicitly, then verify with a genuinely fresh scaffold + install before assuming it's fine.
