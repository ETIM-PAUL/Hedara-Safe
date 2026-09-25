import { ethers } from "hardhat";

/**
 * Deploys PriceGuardedRebalanceModule against the already-deployed Safe and enables it, then
 * triggers a real swap gated on Pyth's live HBAR/USD feed on Hedera testnet.
 *
 * Requires SAFE_ADDRESS env var. Router and Pyth addresses are Hedera testnet constants.
 */
const PYTH_TESTNET = "0xA2aa501b19aff244D90cc15a4Cf739D2725B5729";
const HBAR_USD_PRICE_ID = "0x3728e591097635310e6341af53db8b7ee42da9b3a8d918f9463ce9cca886dfbd";
const WHBAR_TOKEN = "0x0000000000000000000000000000000000003ad2";
const SAUCE_TOKEN = "0x0000000000000000000000000000000000120f46";

enum Comparison {
  Below,
  Above
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const safeAddress = process.env.SAFE_ADDRESS;
  const routerAddress = process.env.SAUCERSWAP_ROUTER_ADDRESS;
  if (!safeAddress || !routerAddress) {
    throw new Error("Set SAFE_ADDRESS and SAUCERSWAP_ROUTER_ADDRESS env vars");
  }

  // Trigger: fire only while HBAR/USD <= $0.081 (expo -8 -> 8_100_000). At time of writing the
  // live testnet feed reads ~$0.0806, so this condition genuinely holds rather than being
  // trivially permissive.
  const triggerPrice = 8_100_000n;
  const triggerExpo = -8;
  // Pyth's Hermes API now requires an API key to fetch fresh off-chain updates (a recent
  // platform change) — we didn't wire one up, so this demo reads whatever price is already
  // stored on the testnet Pyth contract rather than pushing a new one. maxPriceAgeSeconds is set
  // generously to accommodate that; a production deployment should push fresh updates and use a
  // tight staleness window instead. See README for the real constraint this works around.
  const maxPriceAgeSeconds = 5_000_000;

  console.log("Deploying PriceGuardedRebalanceModule...");
  const Module = await ethers.getContractFactory("PriceGuardedRebalanceModule");
  const module = await Module.deploy(
    safeAddress,
    routerAddress,
    PYTH_TESTNET,
    HBAR_USD_PRICE_ID,
    triggerPrice,
    triggerExpo,
    Comparison.Below,
    maxPriceAgeSeconds
  );
  await module.waitForDeployment();
  const moduleAddress = await module.getAddress();
  console.log(`PriceGuardedRebalanceModule deployed to ${moduleAddress}`);

  const safe = await ethers.getContractAt("Safe", safeAddress);
  const approvedHashSignature = ethers.concat([
    ethers.zeroPadValue(deployer.address, 32),
    ethers.ZeroHash,
    "0x01"
  ]);

  const enableModuleData = safe.interface.encodeFunctionData("enableModule", [moduleAddress]);
  const enableTx = await safe.execTransaction(
    safeAddress,
    0,
    enableModuleData,
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

  // --- Trigger it for real ---
  const whbar = new ethers.Contract(
    WHBAR_TOKEN,
    ["function balanceOf(address) view returns (uint256)"],
    deployer
  );
  const safeWhbarBalance = await whbar.balanceOf(safeAddress);
  console.log(`Safe WHBAR balance: ${safeWhbarBalance}`);
  if (safeWhbarBalance === 0n) {
    throw new Error("Safe holds no WHBAR — fund it first (see demo-rebalance.ts)");
  }

  const amountIn = safeWhbarBalance;
  const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 600;

  console.log("Calling trigger() with empty priceUpdateData (reads existing on-chain price)...");
  const tx = await module.trigger(WHBAR_TOKEN, SAUCE_TOKEN, amountIn, 1n, deadline, [], { value: 0 });
  const receipt = await tx.wait();
  console.log(`Trigger tx: ${tx.hash}`);
  console.log(`Status: ${receipt?.status === 1 ? "SUCCESS" : "FAILED"}`);
  console.log(`\nHashscan link: https://hashscan.io/testnet/transaction/${tx.hash}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
