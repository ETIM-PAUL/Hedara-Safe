# hedera-safe-swap

A Gnosis Safe multisig treasury on Hedera, with a Safe module that rebalances idle treasury
holdings through [SaucerSwap](https://www.saucerswap.finance/) when triggered by an owner.

Removing the SaucerSwap integration removes the point of the template: without it this is just a
stock Safe deployment. The module is what makes idle multisig treasuries capital-efficient without
a manual off-chain swap step.

## What's here

- `packages/contracts` — Safe singleton + proxy factory, a `RebalanceModule` that calls the
  SaucerSwap router, and the Hardhat test suite.
- `packages/frontend` — Next.js app to connect a wallet, view the Safe's treasury, and trigger a
  rebalance as an owner.

## Prerequisites

- Node 20.18.3+
- A funded Hedera testnet account (testnet HBAR from the [Hedera Portal faucet](https://portal.hedera.com/))
- A wallet extension that supports Hedera testnet (HashPack or Blade)

## Setup

```bash
npm install
cp .env.example .env
# fill in HEDERA_OPERATOR_ID, HEDERA_OPERATOR_KEY, HEDERA_TESTNET_RPC_URL, SAUCERSWAP_ROUTER_ADDRESS
```

## Deploy contracts to Hedera testnet

```bash
npm run build --workspace packages/contracts
npx hardhat run packages/contracts/scripts/deploy.ts --network hedera-testnet
```

This deploys the Safe singleton, proxy factory, one Safe proxy, and the `RebalanceModule`, then
enables the module on the Safe. Copy the resulting Safe address into `NEXT_PUBLIC_SAFE_ADDRESS`.

## Run the frontend

```bash
npm run dev
```

Open http://localhost:3000, connect a wallet that's an owner on the deployed Safe, and trigger a
rebalance. The UI shows the resulting transaction with a Hashscan link once mirror-node confirmed.

## Architecture

```
Owner wallet(s)
      |
      v
  Gnosis Safe (2-of-3)  --enableModule-->  RebalanceModule
                                                  |
                                                  v
                                        SaucerSwap Router (Hedera testnet)
                                                  |
                                                  v
                                        Treasury asset swapped, balance updated
```

## Verified testnet transaction

_Filled in after Phase 7 of the build plan — a real rebalance transaction executed through the
module, linked via Hashscan / mirror node._

- Hashscan link: TBD
- Mirror node link: TBD

## Reproducing the transaction

1. Complete Setup and Deploy steps above.
2. Ensure the Safe holds a small amount of a token pair with testnet liquidity on SaucerSwap.
3. From the frontend, connect as an owner and submit a rebalance with a second owner's
   confirmation (2-of-3 threshold).
4. The resulting swap transaction is queryable on Hashscan and via the Hedera mirror node REST API.

## License

MIT
