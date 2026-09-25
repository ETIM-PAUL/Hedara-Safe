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

Safe deployment (Phase 4) — module enabled on the Safe:

- Safe: [`0x487f330a30E6c7101f86e598BE27a5d46C8B3589`](https://hashscan.io/testnet/contract/0x487f330a30E6c7101f86e598BE27a5d46C8B3589)
- RebalanceModule: [`0x27714cc6907e8EB771CCe77159111b19Aa2E9Efe`](https://hashscan.io/testnet/contract/0x27714cc6907e8EB771CCe77159111b19Aa2E9Efe)
- `enableModule` tx: [`0x7054822d2f421fc441d9bfeec9d7bd4bda2c5aeb5a3e337bc200ad4bf8c45678`](https://hashscan.io/testnet/transaction/0x7054822d2f421fc441d9bfeec9d7bd4bda2c5aeb5a3e337bc200ad4bf8c45678)
- Mirror node: `GET https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x7054822d2f421fc441d9bfeec9d7bd4bda2c5aeb5a3e337bc200ad4bf8c45678` → `status: 0x1` (SUCCESS)

Rebalance (Phase 7) — a real swap executed through the module against SaucerSwap's live V1
router, converting the Safe's WHBAR into SAUCE:

- Rebalance tx: [`0x432d5e6bf726905b5e108d84f6e06df836473b8f80f3d061b777c93f039f322e`](https://hashscan.io/testnet/transaction/0x432d5e6bf726905b5e108d84f6e06df836473b8f80f3d061b777c93f039f322e)
- Mirror node: `GET https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x432d5e6bf726905b5e108d84f6e06df836473b8f80f3d061b777c93f039f322e` → `status: 0x1` (SUCCESS)
- Result: Safe swapped 2.5 WHBAR for 1.37386050 SAUCE via the SaucerSwap V1 HBAR-SAUCE pool
- Reproduce with `packages/contracts/scripts/demo-rebalance.ts` — see script header for what it does (HTS association, WHBAR wrap, funding the Safe, then triggering the module)

## Reproducing the transaction

1. Complete Setup and Deploy steps above.
2. Ensure the Safe holds a small amount of a token pair with testnet liquidity on SaucerSwap.
3. From the frontend, connect as an owner and submit a rebalance with a second owner's
   confirmation (2-of-3 threshold).
4. The resulting swap transaction is queryable on Hashscan and via the Hedera mirror node REST API.

## License

MIT
