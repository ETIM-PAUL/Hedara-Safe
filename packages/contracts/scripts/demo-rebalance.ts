import { ethers } from "hardhat";

/**
 * Phase 7: seed the deployed Safe with a real token and trigger a real rebalance through
 * RebalanceModule against SaucerSwap's live V1 router on Hedera testnet, producing the
 * gate-required verifiable testnet transaction.
 *
 * Pair used: WHBAR -> SAUCE, the deepest-liquidity pool on SaucerSwap testnet
 * (see https://test-api.saucerswap.finance/pools). Both are HTS tokens exposed through their
 * ERC20 facade at the long-zero EVM address of their token ID.
 *
 * Requires SAFE_ADDRESS and MODULE_ADDRESS env vars pointing at the Phase 4 deployment, and the
 * same operator credentials already used for deploy.ts.
 */

const WHBAR_HELPER = "0x000000000000000000000000000000000050a8a7"; // 0.0.5286055
const WHBAR_TOKEN = "0x0000000000000000000000000000000000003ad2"; // 0.0.15058
const SAUCE_TOKEN = "0x0000000000000000000000000000000000120f46"; // 0.0.1183558

const IHRC719_ABI = ["function associate() external returns (uint64 responseCode)"];
const WHBAR_HELPER_ABI = ["function deposit() external payable"];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)"
];

async function associate(signerOrSafeCall: (data: string) => Promise<void>, tokenAddress: string, label: string) {
  const iface = new ethers.Interface(IHRC719_ABI);
  const data = iface.encodeFunctionData("associate");
  console.log(`Associating ${label} (${tokenAddress})...`);
  await signerOrSafeCall(data);
}

async function main() {
  const [deployer] = await ethers.getSigners();

  const safeAddress = process.env.SAFE_ADDRESS;
  const moduleAddress = process.env.MODULE_ADDRESS;
  if (!safeAddress || !moduleAddress) {
    throw new Error("Set SAFE_ADDRESS and MODULE_ADDRESS env vars (from the Phase 4 deploy output)");
  }

  const safe = await ethers.getContractAt("Safe", safeAddress);
  const module = await ethers.getContractAt("RebalanceModule", moduleAddress);

  // --- 1. Deployer associates itself with WHBAR and SAUCE (needed to hold/transfer them) ---
  const directCall = async (to: string, data: string, value = 0n) => {
    const tx = await deployer.sendTransaction({ to, data, value });
    const receipt = await tx.wait();
    console.log(`  tx ${tx.hash} status=${receipt?.status}`);
  };

  await associate((data) => directCall(WHBAR_TOKEN, data), WHBAR_TOKEN, "deployer<->WHBAR");
  await associate((data) => directCall(SAUCE_TOKEN, data), SAUCE_TOKEN, "deployer<->SAUCE");

  // --- 2. Wrap 5 HBAR into WHBAR ---
  console.log("Wrapping 5 HBAR into WHBAR via WhbarHelper...");
  const whbarHelperIface = new ethers.Interface(WHBAR_HELPER_ABI);
  await directCall(WHBAR_HELPER, whbarHelperIface.encodeFunctionData("deposit"), ethers.parseEther("5"));

  const whbar = new ethers.Contract(WHBAR_TOKEN, ERC20_ABI, deployer);
  const deployerWhbarBalance = await whbar.balanceOf(deployer.address);
  console.log(`Deployer WHBAR balance: ${deployerWhbarBalance}`);

  // --- 3. Safe associates itself with WHBAR and SAUCE, via owner-authorized execTransaction ---
  const approvedHashSignature = ethers.concat([
    ethers.zeroPadValue(deployer.address, 32),
    ethers.ZeroHash,
    "0x01"
  ]);

  const safeCall = async (to: string, data: string) => {
    const nonce = await safe.nonce();
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
      approvedHashSignature
    );
    const receipt = await tx.wait();
    console.log(`  tx ${tx.hash} status=${receipt?.status} (nonce ${nonce})`);
  };

  await associate((data) => safeCall(WHBAR_TOKEN, data), WHBAR_TOKEN, "Safe<->WHBAR");
  await associate((data) => safeCall(SAUCE_TOKEN, data), SAUCE_TOKEN, "Safe<->SAUCE");

  // --- 4. Send some WHBAR from deployer into the Safe ---
  const amountIn = deployerWhbarBalance / 2n;
  console.log(`Transferring ${amountIn} WHBAR (tinybar units) into the Safe...`);
  const transferTx = await whbar.transfer(safeAddress, amountIn);
  await transferTx.wait();

  const safeWhbarBalance = await whbar.balanceOf(safeAddress);
  console.log(`Safe WHBAR balance: ${safeWhbarBalance}`);

  // --- 5. Trigger the real rebalance through the module ---
  const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 600;
  console.log(`Calling RebalanceModule.rebalance(WHBAR -> SAUCE, amountIn=${amountIn})...`);
  const rebalanceTx = await module.rebalance(WHBAR_TOKEN, SAUCE_TOKEN, amountIn, 1n, deadline);
  const rebalanceReceipt = await rebalanceTx.wait();
  console.log(`Rebalance tx: ${rebalanceTx.hash}`);
  console.log(`Status: ${rebalanceReceipt?.status === 1 ? "SUCCESS" : "FAILED"}`);

  const sauce = new ethers.Contract(SAUCE_TOKEN, ERC20_ABI, deployer);
  const safeSauceBalance = await sauce.balanceOf(safeAddress);
  console.log(`Safe SAUCE balance after rebalance: ${safeSauceBalance}`);

  console.log("\nHashscan link:");
  console.log(`https://hashscan.io/testnet/transaction/${rebalanceTx.hash}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
