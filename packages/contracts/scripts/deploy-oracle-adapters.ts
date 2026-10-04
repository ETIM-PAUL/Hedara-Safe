import { ethers } from "hardhat";
import { getDeployer } from "./lib/getDeployer";

/**
 * Deploys the Chainlink and Supra oracle adapters, a fresh PriceGuardedRebalanceModule wired to
 * Chainlink initially, enables it on the Safe, triggers a real swap through it, then switches
 * the module to Supra AND triggers again in one signed call (switchOracleAndTrigger) — proving
 * the combined owner convenience path works, not just the two-step version.
 *
 * Requires SAFE_ADDRESS and SAUCERSWAP_ROUTER_ADDRESS env vars.
 */
const CHAINLINK_HBAR_USD = "0x59bC155EB6c6C415fE43255aF66EcF0523c92B4a";
const SUPRA_STORAGE = "0x6Cd59830AAD978446e6cc7f6cc173aF7656Fb917";
const SUPRA_HBAR_USD_PAIR_INDEX = 432;
const WHBAR_TOKEN = "0x0000000000000000000000000000000000003ad2";
const SAUCE_TOKEN = "0x0000000000000000000000000000000000120f46";

enum Comparison {
  Below,
  Above
}

async function main() {
  const deployer = await getDeployer();
  const safeAddress = process.env.SAFE_ADDRESS;
  const routerAddress = process.env.SAUCERSWAP_ROUTER_ADDRESS;
  if (!safeAddress || !routerAddress) {
    throw new Error("Set SAFE_ADDRESS and SAUCERSWAP_ROUTER_ADDRESS env vars");
  }

  console.log("Deploying oracle adapters...");
  const ChainlinkPriceAdapter = await ethers.getContractFactory("ChainlinkPriceAdapter");
  const chainlinkAdapter = await ChainlinkPriceAdapter.deploy(CHAINLINK_HBAR_USD);
  await chainlinkAdapter.waitForDeployment();
  console.log(`ChainlinkPriceAdapter: ${await chainlinkAdapter.getAddress()}`);

  const SupraPriceAdapter = await ethers.getContractFactory("SupraPriceAdapter");
  const supraAdapter = await SupraPriceAdapter.deploy(SUPRA_STORAGE, SUPRA_HBAR_USD_PAIR_INDEX);
  await supraAdapter.waitForDeployment();
  console.log(`SupraPriceAdapter: ${await supraAdapter.getAddress()}`);

  // Trigger: HBAR/USD <= $0.10 — comfortably above current live price (~$0.094) regardless of
  // which oracle reads it, since normalize() reconciles Chainlink's 8-decimal and Supra's
  // 18-decimal feeds against this same trigger.
  const triggerPrice = 10_000_000n; // $0.10 at expo -8
  const triggerExpo = -8;
  // Both are push-model, but "fresh" isn't the same cadence for both on testnet: Supra updates
  // roughly every 20-30s, while Chainlink's testnet feed heartbeat is much coarser (an hour or
  // more between updates has been observed live). A tight window that's fine for Supra reverts
  // with StalePrice against Chainlink — this bit us for real. 24h comfortably covers both without
  // being meaningfully weaker as a guard (mainnet feeds update far more reliably than testnet).
  const maxPriceAgeSeconds = 86400;

  console.log("\nDeploying PriceGuardedRebalanceModule (starting on Chainlink)...");
  const Module = await ethers.getContractFactory("PriceGuardedRebalanceModule");
  const module = await Module.deploy(
    safeAddress,
    routerAddress,
    await chainlinkAdapter.getAddress(),
    triggerPrice,
    triggerExpo,
    Comparison.Below,
    maxPriceAgeSeconds
  );
  await module.waitForDeployment();
  const moduleAddress = await module.getAddress();
  console.log(`PriceGuardedRebalanceModule: ${moduleAddress}`);

  const safe = await ethers.getContractAt("Safe", safeAddress);
  const approvedHashSignature = ethers.concat([
    ethers.zeroPadValue(deployer.address, 32),
    ethers.ZeroHash,
    "0x01"
  ]);
  const enableTx = await safe.execTransaction(
    safeAddress,
    0,
    safe.interface.encodeFunctionData("enableModule", [moduleAddress]),
    0,
    0,
    0,
    0,
    ethers.ZeroAddress,
    ethers.ZeroAddress,
    approvedHashSignature
  );
  await enableTx.wait();
  console.log(`Module enabled on Safe (tx: ${enableTx.hash})`);

  const whbar = new ethers.Contract(
    WHBAR_TOKEN,
    ["function balanceOf(address) view returns (uint256)"],
    deployer
  );

  // --- Trigger #1: plain permissionless trigger(), via Chainlink (the oracle set at deploy) ---
  console.log("\n=== Trigger #1: trigger() via Chainlink (live, fresh, no update data needed) ===");
  let safeBalance = await whbar.balanceOf(safeAddress);
  let amountIn = safeBalance / 4n;
  let deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 1800;
  let tx = await module.trigger(WHBAR_TOKEN, SAUCE_TOKEN, amountIn, 1n, deadline, [], { value: 0 });
  let receipt = await tx.wait();
  console.log(`tx: ${tx.hash} — status: ${receipt?.status === 1 ? "SUCCESS" : "FAILED"}`);
  console.log(`https://hashscan.io/testnet/transaction/${tx.hash}`);

  // --- Trigger #2: switchOracleAndTrigger(), one signed call does both the switch and the swap ---
  console.log("\n=== Trigger #2: switchOracleAndTrigger() -> Supra, in one signed transaction ===");
  safeBalance = await whbar.balanceOf(safeAddress);
  amountIn = safeBalance / 3n;
  deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 1800;
  tx = await module.switchOracleAndTrigger(
    await supraAdapter.getAddress(),
    WHBAR_TOKEN,
    SAUCE_TOKEN,
    amountIn,
    1n,
    deadline,
    [],
    { value: 0 }
  );
  receipt = await tx.wait();
  console.log(`tx: ${tx.hash} — status: ${receipt?.status === 1 ? "SUCCESS" : "FAILED"}`);
  console.log(`Active oracle is now: ${await module.oracle()}`);
  console.log(`https://hashscan.io/testnet/transaction/${tx.hash}`);

  console.log("\n--- Summary ---");
  console.log(`ChainlinkPriceAdapter:  ${await chainlinkAdapter.getAddress()}`);
  console.log(`SupraPriceAdapter:      ${await supraAdapter.getAddress()}`);
  console.log(`PriceGuardedRebalanceModule: ${moduleAddress}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
