import { ethers } from "hardhat";
import { getDeployer } from "./lib/getDeployer";

/**
 * Seeds a freshly deployed Safe with a real token and triggers a real rebalance through
 * RebalanceModule against SaucerSwap's live V1 router on Hedera testnet.
 *
 * Pair used: WHBAR -> SAUCE, the deepest-liquidity pool on SaucerSwap testnet
 * (see https://test-api.saucerswap.finance/pools). Both are HTS tokens exposed through their
 * ERC20 facade at the long-zero EVM address of their token ID.
 *
 * Requires SAFE_ADDRESS and MODULE_ADDRESS env vars from deploy.ts's output, and the same operator
 * credentials. Meant for that fresh 1-of-1, deployer-owned Safe: every Safe call here carries the
 * deployer's signature alone. On a multi-owner Safe, use the frontend's quorum flow instead.
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

async function associate(
  signerOrSafeCall: (data: string) => Promise<void>,
  tokenAddress: string,
  label: string
) {
  const iface = new ethers.Interface(IHRC719_ABI);
  const data = iface.encodeFunctionData("associate");
  console.log(`Associating ${label} (${tokenAddress})...`);
  await signerOrSafeCall(data);
}

async function main() {
  const deployer = await getDeployer();

  const safeAddress = process.env.SAFE_ADDRESS;
  const moduleAddress = process.env.MODULE_ADDRESS;
  if (!safeAddress || !moduleAddress) {
    throw new Error(
      "Set SAFE_ADDRESS and MODULE_ADDRESS env vars (from deploy.ts's output)"
    );
  }

  const safe = await ethers.getContractAt("Safe", safeAddress);
  const threshold = await safe.getThreshold();
  if (threshold !== 1n || !(await safe.isOwner(deployer.address))) {
    throw new Error(
      `This script signs as the deployer alone, so it needs a 1-of-1 Safe owned by ${deployer.address} ` +
        `(this one is ${threshold}-of-${(await safe.getOwners()).length}). Use the frontend's quorum flow instead.`
    );
  }
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
  await directCall(
    WHBAR_HELPER,
    whbarHelperIface.encodeFunctionData("deposit"),
    ethers.parseEther("5")
  );

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
    return tx.hash;
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
  // rebalance() is onlySafe, so it's called through the Safe's own execTransaction — the same
  // path a quorum-approved proposal takes in the frontend, here with this 1-of-1 Safe's only owner.
  // Swaps half of what was sent in, so the Safe ends up holding both tokens and the frontend can
  // rebalance in either direction straight away.
  const swapAmount = amountIn / 2n;
  const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 600;
  console.log(`Calling RebalanceModule.rebalance(WHBAR -> SAUCE, amountIn=${swapAmount}) via the Safe...`);
  const rebalanceData = module.interface.encodeFunctionData("rebalance", [
    WHBAR_TOKEN,
    SAUCE_TOKEN,
    swapAmount,
    1n,
    deadline
  ]);
  const rebalanceTxHash = await safeCall(moduleAddress, rebalanceData);

  const sauce = new ethers.Contract(SAUCE_TOKEN, ERC20_ABI, deployer);
  const safeSauceBalance = await sauce.balanceOf(safeAddress);
  console.log(`Safe balances after rebalance: ${await whbar.balanceOf(safeAddress)} WHBAR, ${safeSauceBalance} SAUCE`);

  console.log("\nHashscan link:");
  console.log(`https://hashscan.io/testnet/transaction/${rebalanceTxHash}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
