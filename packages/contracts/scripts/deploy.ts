import { ethers } from "hardhat";
import { getDeployer } from "./lib/getDeployer";

/**
 * Deploy sequence: Safe singleton -> proxy factory -> Safe proxy -> RebalanceModule -> enable
 * module on the Safe. See AGENTS.md before reordering these steps.
 *
 * Owners default to a single deployer-owned Safe (threshold 1) for testnet demo purposes. Set
 * SAFE_OWNERS (comma-separated addresses) and SAFE_THRESHOLD to configure a real multi-owner
 * Safe — in that case enableModule needs a threshold of owner signatures collected out of band,
 * so this script only auto-enables the module when the deployer is the Safe's sole owner.
 */
async function main() {
  const deployer = await getDeployer();
  console.log(`Deploying from ${deployer.address}`);

  const routerAddress = process.env.SAUCERSWAP_ROUTER_ADDRESS;
  if (!routerAddress) {
    throw new Error("SAUCERSWAP_ROUTER_ADDRESS is not set in .env");
  }

  const owners = process.env.SAFE_OWNERS
    ? process.env.SAFE_OWNERS.split(",").map((addr) => addr.trim())
    : [deployer.address];
  const threshold = process.env.SAFE_THRESHOLD
    ? Number(process.env.SAFE_THRESHOLD)
    : Math.min(2, owners.length);

  console.log(`Safe config: ${owners.length} owner(s), threshold ${threshold}`);

  // 1. Safe singleton
  const Safe = await ethers.getContractFactory("Safe");
  const singleton = await Safe.deploy();
  await singleton.waitForDeployment();
  const singletonAddress = await singleton.getAddress();
  console.log(`Safe singleton deployed to ${singletonAddress}`);

  // 2. Proxy factory
  const SafeProxyFactory = await ethers.getContractFactory("SafeProxyFactory");
  const factory = await SafeProxyFactory.deploy();
  await factory.waitForDeployment();
  console.log(`SafeProxyFactory deployed to ${await factory.getAddress()}`);

  // 3. Safe proxy, initialized via setup() in the same creation call
  const setupData = singleton.interface.encodeFunctionData("setup", [
    owners,
    threshold,
    ethers.ZeroAddress, // to (no delegatecall on setup)
    "0x", // data
    ethers.ZeroAddress, // fallbackHandler
    ethers.ZeroAddress, // paymentToken
    0, // payment
    ethers.ZeroAddress // paymentReceiver
  ]);
  const saltNonce = BigInt(Date.now());

  const safeAddress: string = await factory.createProxyWithNonce.staticCall(
    singletonAddress,
    setupData,
    saltNonce
  );
  const proxyTx = await factory.createProxyWithNonce(singletonAddress, setupData, saltNonce);
  await proxyTx.wait();
  console.log(`Safe proxy deployed to ${safeAddress}`);

  const safe = await ethers.getContractAt("Safe", safeAddress);

  // 4. RebalanceModule, scoped to this Safe and the configured router
  const RebalanceModule = await ethers.getContractFactory("RebalanceModule");
  const module = await RebalanceModule.deploy(safeAddress, routerAddress);
  await module.waitForDeployment();
  const moduleAddress = await module.getAddress();
  console.log(`RebalanceModule deployed to ${moduleAddress}`);

  // 5. Enable the module — only automatic when the deployer is the Safe's sole owner.
  const deployerIsSoleOwner =
    owners.length === 1 && owners[0].toLowerCase() === deployer.address.toLowerCase();

  if (deployerIsSoleOwner && threshold === 1) {
    const enableModuleData = safe.interface.encodeFunctionData("enableModule", [moduleAddress]);

    const txHash = await safe.getTransactionHash(
      safeAddress,
      0,
      enableModuleData,
      0, // Operation.Call
      0, // safeTxGas
      0, // baseGas
      0, // gasPrice
      ethers.ZeroAddress, // gasToken
      ethers.ZeroAddress, // refundReceiver
      await safe.nonce()
    );

    // Single-owner "approved hash" signature: msg.sender == owner satisfies checkNSignatures
    // without a separate ECDSA signing step (see Safe.sol checkNSignatures, v == 1 branch).
    const approvedHashSignature = ethers.concat([
      ethers.zeroPadValue(deployer.address, 32),
      ethers.ZeroHash,
      "0x01"
    ]);

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
    console.log(`RebalanceModule enabled on Safe (tx: ${enableTx.hash})`);
  } else {
    console.log(
      "Multi-owner Safe detected — enableModule was NOT called automatically. " +
        `Collect ${threshold} owner signature(s) over an execTransaction targeting the Safe ` +
        `itself with calldata enableModule(${moduleAddress}), then submit it.`
    );
  }

  console.log("\nCopy this into .env:");
  console.log(`NEXT_PUBLIC_SAFE_ADDRESS=${safeAddress}`);
  console.log(`NEXT_PUBLIC_MODULE_ADDRESS=${moduleAddress}`);
  console.log(`SAFE_ADDRESS=${safeAddress}`);
  console.log(`MODULE_ADDRESS=${moduleAddress}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
