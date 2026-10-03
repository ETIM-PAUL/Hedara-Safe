import { ethers } from "hardhat";

/**
 * Installs MajorityThresholdGuard on the existing Safe, so a below-majority threshold becomes
 * impossible on-chain rather than just refused by the frontend:
 *
 *   1. Deploys the guard (or reuses MAJORITY_GUARD_ADDRESS if set).
 *   2. If the Safe is already below a majority, raises the threshold to one first. Order matters:
 *      once the guard is set, every transaction that doesn't leave a majority reverts, so fixing
 *      the threshold first keeps the Safe fully usable.
 *   3. Sets the guard via a quorum-approved Safe transaction.
 *   4. Reads the guard back from the Safe's storage to confirm it's installed.
 *
 * Approvals come from the operator key and, when the threshold needs a second signer,
 * OWNER2_KEY — the same two keys deploy-multisig-rebalance.ts uses. Needs SAFE_ADDRESS.
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  const safeAddress = process.env.SAFE_ADDRESS;
  const owner2Key = process.env.OWNER2_KEY;
  if (!safeAddress) throw new Error("Set SAFE_ADDRESS in .env");

  // A raw ethers.Wallet gets no gas price injected by Hardhat — see deploy-multisig-rebalance.ts.
  const gasPrice = ((await ethers.provider.getFeeData()).gasPrice ?? 1_140_000_000_000n) * 2n;
  const owner2 = owner2Key ? new ethers.Wallet(owner2Key, ethers.provider) : null;

  const safe = await ethers.getContractAt("Safe", safeAddress);
  const owners = (await safe.getOwners()).map((o) => o.toLowerCase());
  const approvers = [deployer, ...(owner2 ? [owner2] : [])].filter((s) => owners.includes(s.address.toLowerCase()));
  if (approvers.length === 0) throw new Error("Neither the operator nor OWNER2 is an owner of this Safe.");

  const signaturesFor = (addresses: string[]) =>
    ethers.concat(
      [...addresses]
        .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))
        .map((a) => ethers.concat([ethers.zeroPadValue(a, 32), ethers.ZeroHash, "0x01"]))
    );

  /** Collects exactly as many approvals as the Safe's current threshold needs, then executes. */
  const execThroughSafe = async (data: string, label: string) => {
    const threshold = Number(await safe.getThreshold());
    if (approvers.length < threshold) {
      throw new Error(`${label}: needs ${threshold} approvals, but only ${approvers.length} owner key(s) available.`);
    }
    const signers = approvers.slice(0, threshold);
    const hash = await safe.getTransactionHash(safeAddress, 0, data, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, await safe.nonce());
    for (const s of signers.slice(1)) {
      await (await safe.connect(s).approveHash(hash, s === owner2 ? { gasPrice } : {})).wait();
    }
    const tx = await safe
      .connect(signers[0])
      .execTransaction(safeAddress, 0, data, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, signaturesFor(signers.map((s) => s.address)));
    const receipt = await tx.wait();
    console.log(`  ${label}: ${tx.hash} status=${receipt?.status}`);
    console.log(`  https://hashscan.io/testnet/transaction/${tx.hash}`);
    return tx.hash;
  };

  // --- 1. Guard ---
  let guardAddress = process.env.MAJORITY_GUARD_ADDRESS;
  if (!guardAddress) {
    const guard = await (await ethers.getContractFactory("MajorityThresholdGuard")).deploy();
    await guard.waitForDeployment();
    guardAddress = await guard.getAddress();
    console.log(`MajorityThresholdGuard deployed: ${guardAddress}`);
  } else {
    console.log(`Reusing MajorityThresholdGuard at ${guardAddress}`);
  }

  // --- 2. Restore a majority first, if needed ---
  const ownerCount = owners.length;
  const required = Math.floor(ownerCount / 2) + 1;
  const threshold = Number(await safe.getThreshold());
  console.log(`Safe is ${threshold} of ${ownerCount}; majority is ${required}.`);
  if (threshold < required) {
    await execThroughSafe(safe.interface.encodeFunctionData("changeThreshold", [required]), `changeThreshold(${required})`);
  }

  // --- 3. Set the guard ---
  await execThroughSafe(safe.interface.encodeFunctionData("setGuard", [guardAddress]), "setGuard");

  // --- 4. Read the guard back from the Safe's storage ---
  // No on-chain rejection demo here: simulating one would need owners to approveHash() a
  // below-majority change for real, leaving their signatures on a harmful transaction. The
  // rejection paths are covered by test/MajorityThresholdGuard.test.ts against a real Safe.
  const GUARD_SLOT = "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8";
  const stored = ethers.getAddress(ethers.dataSlice(await safe.getStorageAt(GUARD_SLOT, 1), 12));
  console.log(`Guard stored in Safe: ${stored} ${stored === ethers.getAddress(guardAddress) ? "(matches)" : "(MISMATCH)"}`);
  console.log(`Safe is now ${await safe.getThreshold()} of ${ownerCount}.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
