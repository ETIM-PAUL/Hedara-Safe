import { ethers } from "hardhat";
import { getDeployer } from "./lib/getDeployer";

/**
 * Proves the 2-of-3 multisig rebalance flow on real testnet, end to end:
 *
 *   1. Deploys a fresh `RebalanceModule` — required because `rebalance()` now only accepts calls
 *      from the Safe itself (see AGENTS.md), which the already-deployed module (old bytecode,
 *      `onlySafeOwner`) does not support. Enables it on the Safe.
 *   2. Owner 1 (the deployer) adds owner 2 at 2-of-2 — a majority of two owners, as
 *      MajorityThresholdGuard requires.
 *   3. Owners 1 and 2 add owner 3, keeping the threshold at 2 — giving 2-of-3.
 *   4. Builds a real rebalance proposal (WHBAR -> SAUCE) and gets owner 1's approval on-chain via
 *      `approveHash()`.
 *   5. Deliberately tries to execute with only that one approval — proves the quorum is actually
 *      enforced, not just configured — and expects a revert.
 *   6. Gets owner 2's approval (a genuinely different signer, different private key) via its own
 *      `approveHash()` call.
 *   7. Executes with both approvals aggregated into one `execTransaction` call — the real
 *      quorum-gated swap.
 *
 * Idempotent: every Safe-changing step is routed through `execThroughSafe()`, which checks the
 * Safe's *current* threshold and collects exactly enough approvals for it — so re-running after a
 * partial failure (this took two attempts in practice; see the gas-price note below) does the
 * right thing whether the Safe is still 1-of-1, mid-way at 2-of-2, or already at the final 2-of-3.
 *
 * Requires SAFE_ADDRESS (the Safe from deploy.ts) and SAUCERSWAP_ROUTER_ADDRESS from .env, plus
 * OWNER2_ADDRESS/OWNER2_KEY and OWNER3_ADDRESS — two throwaway testnet accounts funded with a
 * small amount of HBAR (Hedera auto-creates the account on first transfer in). Owner 3 only ever
 * needs to be *added* here, never to sign anything, so no OWNER3_KEY is read — keep one around in
 * .env anyway if you plan to have it actively approve something later. The Safe must already hold
 * some WHBAR — run demo-rebalance.ts first if it doesn't.
 */

const WHBAR_TOKEN = "0x0000000000000000000000000000000000003ad2"; // 0.0.15058
const SAUCE_TOKEN = "0x0000000000000000000000000000000000120f46"; // 0.0.1183558

function approvedHashSignature(owner: string): string {
  return ethers.concat([ethers.zeroPadValue(owner, 32), ethers.ZeroHash, "0x01"]);
}

function buildSignatures(approvers: string[]): string {
  const sorted = [...approvers].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
  return ethers.concat(sorted.map(approvedHashSignature));
}

async function main() {
  const deployer = await getDeployer();

  const safeAddress = process.env.SAFE_ADDRESS;
  const routerAddress = process.env.SAUCERSWAP_ROUTER_ADDRESS;
  const owner2Address = process.env.OWNER2_ADDRESS;
  const owner2Key = process.env.OWNER2_KEY;
  const owner3Address = process.env.OWNER3_ADDRESS;
  if (!safeAddress || !routerAddress || !owner2Address || !owner2Key || !owner3Address) {
    throw new Error(
      "Set SAFE_ADDRESS, SAUCERSWAP_ROUTER_ADDRESS, OWNER2_ADDRESS, OWNER2_KEY, OWNER3_ADDRESS in .env"
    );
  }

  // Hardhat's own signers (from `accounts` in hardhat.config.ts) get a working gas price
  // injected automatically by the hardhat-ethers provider; a manually-constructed ethers.Wallet
  // does not, and ethers' default gas estimation comes back below Hashio's configured minimum
  // ("Gas price '218' is below configured minimum gas price '1140000000000'") — so this wallet's
  // transactions need an explicit gasPrice.
  const gasPrice = ((await ethers.provider.getFeeData()).gasPrice ?? 1_140_000_000_000n) * 2n;
  const owner2 = new ethers.Wallet(owner2Key, ethers.provider);

  // getContractAt binds to `deployer` by default; a separate instance is needed for owner2's
  // approveHash() call to actually come from its own key, not the deployer's.
  const safe = await ethers.getContractAt("Safe", safeAddress);
  const safeAsOwner2 = await ethers.getContractAt("Safe", safeAddress, owner2);

  /** Submits `to`/`data` as a real Safe transaction, collecting exactly as many approvals as the
   * Safe's *current* threshold requires — 1 (owner 1 alone) while still 1-of-N, or 2 (owner 1 +
   * owner 2) once the quorum is live. This is what makes every call below work regardless of
   * which point in the owner-growth sequence the Safe is currently at. */
  const execThroughSafe = async (to: string, data: string) => {
    const threshold = Number(await safe.getThreshold());
    const nonce = await safe.nonce();
    const hash = await safe.getTransactionHash(to, 0, data, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, nonce);

    const approve1 = await safe.approveHash(hash);
    await approve1.wait();

    const approvers = [deployer.address];
    if (threshold > 1) {
      const approve2 = await safeAsOwner2.approveHash(hash, { gasPrice });
      await approve2.wait();
      approvers.push(owner2Address);
    }

    const tx = await safe.execTransaction(
      to,
      0,
      data,
      0,
      0,
      0,
      0,
      ethers.ZeroAddress,
      ethers.ZeroAddress,
      buildSignatures(approvers)
    );
    const receipt = await tx.wait();
    console.log(`  tx ${tx.hash} status=${receipt?.status} (nonce ${nonce}, threshold ${threshold})`);
    return tx.hash;
  };

  // --- 1. Deploy the quorum-gated RebalanceModule and enable it ---
  const RebalanceModule = await ethers.getContractFactory("RebalanceModule");
  const module = await RebalanceModule.deploy(safeAddress, routerAddress);
  await module.waitForDeployment();
  const moduleAddress = await module.getAddress();
  console.log(`New RebalanceModule deployed: ${moduleAddress}`);

  console.log("Enabling new module on the Safe...");
  await execThroughSafe(safeAddress, safe.interface.encodeFunctionData("enableModule", [moduleAddress]));

  // --- 2 & 3. Owner 1 adds owner 2 (threshold -> 2), then owner 3 (threshold stays 2) ---
  let owners: string[] = await safe.getOwners();

  if (!owners.some((o) => o.toLowerCase() === owner2Address.toLowerCase())) {
    console.log(`Adding owner 2 (${owner2Address}) at 2-of-2...`);
    await execThroughSafe(safeAddress, safe.interface.encodeFunctionData("addOwnerWithThreshold", [owner2Address, 2]));
  } else {
    console.log(`Owner 2 (${owner2Address}) already present — skipping.`);
  }

  owners = await safe.getOwners();
  if (!owners.some((o) => o.toLowerCase() === owner3Address.toLowerCase())) {
    console.log(`Adding owner 3 (${owner3Address}), threshold stays 2 (2-of-3)...`);
    await execThroughSafe(safeAddress, safe.interface.encodeFunctionData("addOwnerWithThreshold", [owner3Address, 2]));
  } else {
    console.log(`Owner 3 (${owner3Address}) already present — skipping.`);
  }

  owners = await safe.getOwners();
  const threshold: bigint = await safe.getThreshold();
  console.log(`Safe now has ${owners.length} owners, threshold ${threshold}: ${owners.join(", ")}`);

  // --- 4. Build a real rebalance proposal: a small WHBAR -> SAUCE swap ---
  const amountIn = ethers.parseUnits("0.5", 8); // WHBAR, 8 decimals
  const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 3600;
  const rebalanceData = module.interface.encodeFunctionData("rebalance", [
    WHBAR_TOKEN,
    SAUCE_TOKEN,
    amountIn,
    1n, // amountOutMin — loose on purpose, matches demo-rebalance.ts's convention for this proof
    deadline
  ]);
  const nonce = await safe.nonce();
  const txHash = await safe.getTransactionHash(
    moduleAddress,
    0,
    rebalanceData,
    0,
    0,
    0,
    0,
    ethers.ZeroAddress,
    ethers.ZeroAddress,
    nonce
  );
  console.log(`\nRebalance proposal hash: ${txHash}`);

  // --- Owner 1 approves ---
  console.log("Owner 1 approving...");
  const approve1Tx = await safe.approveHash(txHash);
  await approve1Tx.wait();
  console.log(`  tx ${approve1Tx.hash}`);

  // --- Deliberately try to execute with only 1 of 2 required approvals — must revert ---
  console.log("\nAttempting execution with only 1 of 2 required approvals (expected to revert)...");
  try {
    const prematureTx = await safe.execTransaction(
      moduleAddress,
      0,
      rebalanceData,
      0,
      0,
      0,
      0,
      ethers.ZeroAddress,
      ethers.ZeroAddress,
      buildSignatures([deployer.address])
    );
    await prematureTx.wait();
    console.log("  UNEXPECTED: this succeeded — quorum was not actually enforced!");
    process.exitCode = 1;
    return;
  } catch (error) {
    console.log(`  Reverted as expected: ${(error as Error).message.slice(0, 200)}`);
  }

  // --- Owner 2 approves (a genuinely different signer) ---
  console.log("\nOwner 2 approving...");
  const approve2Tx = await safeAsOwner2.approveHash(txHash, { gasPrice });
  await approve2Tx.wait();
  console.log(`  tx ${approve2Tx.hash}`);

  // --- Execute with both approvals — the real quorum-gated swap ---
  console.log("\nExecuting with 2 of 2 required approvals...");
  const execTx = await safe.execTransaction(
    moduleAddress,
    0,
    rebalanceData,
    0,
    0,
    0,
    0,
    ethers.ZeroAddress,
    ethers.ZeroAddress,
    buildSignatures([deployer.address, owner2Address])
  );
  const execReceipt = await execTx.wait();
  console.log(`Execute tx: ${execTx.hash}`);
  console.log(`Status: ${execReceipt?.status === 1 ? "SUCCESS" : "FAILED"}`);

  console.log("\nHashscan links:");
  console.log(`https://hashscan.io/testnet/transaction/${execTx.hash}`);

  console.log("\nCopy this into .env:");
  console.log(`NEXT_PUBLIC_MODULE_ADDRESS=${moduleAddress}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
