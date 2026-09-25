import { ethers } from "hardhat";

/**
 * Deploy sequence: Safe singleton -> proxy factory -> Safe proxy -> RebalanceModule -> enable
 * module on the Safe. See AGENTS.md before reordering these steps.
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Deploying from ${deployer.address}`);

  const routerAddress = process.env.SAUCERSWAP_ROUTER_ADDRESS;
  if (!routerAddress) {
    throw new Error("SAUCERSWAP_ROUTER_ADDRESS is not set in .env");
  }

  // TODO(Phase 4): deploy Safe singleton + GnosisSafeProxyFactory from @safe-global/safe-contracts,
  // then deploy a proxy configured with the owners/threshold from template.json defaults.
  // const safeSingleton = await ethers.deployContract("GnosisSafe");
  // const proxyFactory = await ethers.deployContract("GnosisSafeProxyFactory");
  // const safeProxy = ... (see Safe docs for setup calldata)

  const safeAddress = process.env.NEXT_PUBLIC_SAFE_ADDRESS;
  if (!safeAddress) {
    throw new Error(
      "NEXT_PUBLIC_SAFE_ADDRESS is not set — deploy the Safe proxy first (see Phase 4 TODO above)"
    );
  }

  const RebalanceModule = await ethers.getContractFactory("RebalanceModule");
  const module = await RebalanceModule.deploy(safeAddress, routerAddress);
  await module.waitForDeployment();

  console.log(`RebalanceModule deployed to ${await module.getAddress()}`);
  console.log(
    "Next: call safe.enableModule() from an owner-signed Safe transaction to activate it."
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
