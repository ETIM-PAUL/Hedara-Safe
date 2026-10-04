import { ethers, network } from "hardhat";
import { getDeployer } from "./lib/getDeployer";
import { createProposalsTopic } from "./lib/proposalsTopic";
import { writeEnv } from "./lib/envFile";

/**
 * One-command setup: everything that needs the operator key, ending with the frontend's .env
 * filled in.
 *
 *   1. Safe singleton -> proxy factory -> Safe proxy (see AGENTS.md before reordering).
 *   2. RebalanceModule for this Safe, enabled.
 *   3. PriceGuardedRebalanceModule for this Safe (HBAR/USD <= $0.10, starting on Chainlink),
 *      enabled. The Chainlink/Supra adapters are stateless and Safe-agnostic, so the ones in
 *      .env (defaults in .env.example) are reused; they're deployed fresh only if unset.
 *   4. MajorityThresholdGuard installed — also stateless, reused from MAJORITY_GUARD_ADDRESS.
 *   5. An HCS topic for this Safe's proposals (one per Safe: proposals don't name their Safe, so a
 *      shared topic would mix every Safe's proposals into one list).
 *   6. All resulting addresses and the topic ID written into the repo-root .env.
 *
 * Owners default to a single deployer-owned Safe (threshold 1). With SAFE_OWNERS/SAFE_THRESHOLD
 * set, enabling modules and setting the guard need owner signatures collected out of band, so
 * those steps are printed instead of executed. On the local `hardhat` network, steps 5-6 are
 * skipped so a test run never touches your real .env or Hedera.
 */
const CHAINLINK_HBAR_USD = "0x59bC155EB6c6C415fE43255aF66EcF0523c92B4a";
const SUPRA_STORAGE = "0x6Cd59830AAD978446e6cc7f6cc173aF7656Fb917";
const SUPRA_HBAR_USD_PAIR_INDEX = 432;

// HBAR/USD <= $0.10, 24h freshness window: Chainlink's testnet heartbeat can exceed an hour (see
// deploy-oracle-adapters.ts and README's "A real lesson" note on StalePrice).
const TRIGGER_PRICE = 10_000_000n;
const TRIGGER_EXPO = -8;
const COMPARISON_BELOW = 0;
const MAX_PRICE_AGE_SECONDS = 86400;

async function main() {
  const deployer = await getDeployer();
  const isLocal = network.name === "hardhat";
  const operatorId = process.env.HEDERA_OPERATOR_ID;
  // Checked before deploying anything, so a placeholder ID can't fail the run halfway through.
  if (!isLocal && !/^0\.0\.\d+$/.test(operatorId ?? "")) {
    throw new Error(
      `HEDERA_OPERATOR_ID in .env must be your account ID like 0.0.12345 (got "${operatorId ?? ""}") — ` +
        "it's needed to create this Safe's HCS proposals topic."
    );
  }
  console.log(`Deploying from ${deployer.address} on ${network.name}`);

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

  // --- 1. Safe ---
  const Safe = await ethers.getContractFactory("Safe");
  const singleton = await Safe.deploy();
  await singleton.waitForDeployment();
  const singletonAddress = await singleton.getAddress();
  console.log(`Safe singleton deployed to ${singletonAddress}`);

  const SafeProxyFactory = await ethers.getContractFactory("SafeProxyFactory");
  const factory = await SafeProxyFactory.deploy();
  await factory.waitForDeployment();
  console.log(`SafeProxyFactory deployed to ${await factory.getAddress()}`);

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
  const safeAddress: string = await factory.createProxyWithNonce.staticCall(singletonAddress, setupData, saltNonce);
  await (await factory.createProxyWithNonce(singletonAddress, setupData, saltNonce)).wait();
  console.log(`Safe proxy deployed to ${safeAddress}`);
  const safe = await ethers.getContractAt("Safe", safeAddress);

  const deployerIsSoleOwner =
    owners.length === 1 && owners[0].toLowerCase() === deployer.address.toLowerCase() && threshold === 1;

  /** Runs a call on the Safe itself — automatically for a deployer-owned 1-of-1 Safe (the
   * "approved hash" signature: msg.sender == owner, see Safe.checkNSignatures' v == 1 branch),
   * otherwise printed for the owners to submit. */
  const execOnSafe = async (data: string, label: string) => {
    if (!deployerIsSoleOwner) {
      console.log(
        `  ${label}: NOT executed (multi-owner Safe). Collect ${threshold} owner signature(s) over an ` +
          `execTransaction to the Safe itself with calldata ${data}.`
      );
      return;
    }
    const signature = ethers.concat([ethers.zeroPadValue(deployer.address, 32), ethers.ZeroHash, "0x01"]);
    const tx = await safe.execTransaction(
      safeAddress,
      0,
      data,
      0,
      0,
      0,
      0,
      ethers.ZeroAddress,
      ethers.ZeroAddress,
      signature
    );
    await tx.wait();
    console.log(`  ${label} (tx: ${tx.hash})`);
  };

  /** Reuses a stateless contract from .env when it exists on this network, else deploys one. */
  const reuseOrDeploy = async (envValue: string | undefined, label: string, deploy: () => Promise<string>) => {
    if (envValue && (await ethers.provider.getCode(envValue)) !== "0x") {
      console.log(`${label}: reusing ${envValue}`);
      return envValue;
    }
    const address = await deploy();
    console.log(`${label}: deployed to ${address}`);
    return address;
  };
  const deployContract = async (name: string, ...args: unknown[]) => {
    const contract = await (await ethers.getContractFactory(name)).deploy(...args);
    await contract.waitForDeployment();
    return contract.getAddress();
  };

  // --- 2. RebalanceModule ---
  const moduleAddress = await deployContract("RebalanceModule", safeAddress, routerAddress);
  console.log(`RebalanceModule deployed to ${moduleAddress}`);
  await execOnSafe(safe.interface.encodeFunctionData("enableModule", [moduleAddress]), "RebalanceModule enabled");

  // --- 3. Price guard ---
  const chainlinkAdapter = await reuseOrDeploy(process.env.NEXT_PUBLIC_CHAINLINK_ADAPTER_ADDRESS, "ChainlinkPriceAdapter", () =>
    deployContract("ChainlinkPriceAdapter", CHAINLINK_HBAR_USD)
  );
  const supraAdapter = await reuseOrDeploy(process.env.NEXT_PUBLIC_SUPRA_ADAPTER_ADDRESS, "SupraPriceAdapter", () =>
    deployContract("SupraPriceAdapter", SUPRA_STORAGE, SUPRA_HBAR_USD_PAIR_INDEX)
  );
  const priceGuardAddress = await deployContract(
    "PriceGuardedRebalanceModule",
    safeAddress,
    routerAddress,
    chainlinkAdapter,
    TRIGGER_PRICE,
    TRIGGER_EXPO,
    COMPARISON_BELOW,
    MAX_PRICE_AGE_SECONDS
  );
  console.log(`PriceGuardedRebalanceModule deployed to ${priceGuardAddress}`);
  await execOnSafe(safe.interface.encodeFunctionData("enableModule", [priceGuardAddress]), "PriceGuardedRebalanceModule enabled");

  // --- 4. Majority guard (1-of-1 is a majority, so the Safe stays fully usable) ---
  const guardAddress = await reuseOrDeploy(process.env.MAJORITY_GUARD_ADDRESS, "MajorityThresholdGuard", () =>
    deployContract("MajorityThresholdGuard")
  );
  await execOnSafe(safe.interface.encodeFunctionData("setGuard", [guardAddress]), "MajorityThresholdGuard set");

  const values: Record<string, string> = {
    NEXT_PUBLIC_SAFE_ADDRESS: safeAddress,
    NEXT_PUBLIC_MODULE_ADDRESS: moduleAddress,
    NEXT_PUBLIC_PRICE_GUARD_MODULE_ADDRESS: priceGuardAddress,
    NEXT_PUBLIC_CHAINLINK_ADAPTER_ADDRESS: chainlinkAdapter,
    NEXT_PUBLIC_SUPRA_ADAPTER_ADDRESS: supraAdapter,
    MAJORITY_GUARD_ADDRESS: guardAddress
  };

  if (isLocal) {
    console.log("\nLocal hardhat network: skipped the HCS topic and left .env untouched. Values:");
    for (const [k, v] of Object.entries(values)) console.log(`${k}=${v}`);
    return;
  }

  // --- 5. HCS topic for this Safe's proposals ---
  const topicId = await createProposalsTopic(
    operatorId!,
    process.env.HEDERA_OPERATOR_KEY!,
    `hedera-safe-swap proposals for Safe ${safeAddress}`
  );
  values.NEXT_PUBLIC_PROPOSALS_TOPIC_ID = topicId;
  console.log(`HCS proposals topic: https://hashscan.io/testnet/topic/${topicId}`);

  // --- 6. Write .env ---
  const { path, replaced } = writeEnv(values);
  console.log(`\nWrote to ${path}:`);
  for (const [k, v] of Object.entries(values)) console.log(`  ${k}=${v}`);
  if (Object.keys(replaced).length) {
    console.log("Replaced previous values (kept here so they're not lost):");
    for (const [k, v] of Object.entries(replaced)) console.log(`  ${k} was ${v}`);
  }
  console.log("\nNext: fund the Safe (README → Fund the Safe), then `npm run dev`.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
