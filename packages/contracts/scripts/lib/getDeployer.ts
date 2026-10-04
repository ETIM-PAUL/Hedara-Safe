import { ethers } from "hardhat";

/** The operator account every script deploys and signs from. Hardhat only configures it when
 * HEDERA_OPERATOR_KEY is set, so without this check a missing .env surfaces as an opaque
 * "Cannot read properties of undefined (reading 'address')". */
export async function getDeployer() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    throw new Error(
      "No operator account: HEDERA_OPERATOR_KEY isn't set. From the repo root run `cp .env.example .env`, " +
        "then fill in HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY (an ECDSA key funded from the Hedera Portal faucet)."
    );
  }
  return deployer;
}
