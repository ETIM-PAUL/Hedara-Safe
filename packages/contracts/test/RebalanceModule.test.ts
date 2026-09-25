import { expect } from "chai";
import { ethers } from "hardhat";

/**
 * Phase 6 scaffold. Fill in once the Safe deployment helpers (Phase 4) exist — this file
 * currently documents the required coverage rather than asserting against a live Safe/router.
 *
 * Required coverage per AGENTS.md:
 *  - happy path: owner-triggered rebalance executes a swap through the module
 *  - module not enabled on the Safe -> revert
 *  - caller is not a Safe owner -> revert (NotSafeOwner)
 *  - amountOutMin not met / router reverts -> revert (SwapFailed)
 *  - expired deadline -> revert (DeadlinePassed)
 */
describe("RebalanceModule", () => {
  it("deploys with the configured Safe and router addresses", async () => {
    const [deployer] = await ethers.getSigners();

    const MockSafe = await ethers.getContractFactory("MockSafe");
    const mockSafe = await MockSafe.deploy();
    await mockSafe.waitForDeployment();

    const RebalanceModule = await ethers.getContractFactory("RebalanceModule");
    const module = await RebalanceModule.deploy(
      await mockSafe.getAddress(),
      deployer.address // placeholder router address for this scaffold test
    );
    await module.waitForDeployment();

    expect(await module.safe()).to.equal(await mockSafe.getAddress());
  });

  it.skip("reverts with NotSafeOwner when a non-owner triggers a rebalance", async () => {
    // TODO(Phase 6): implement once MockSafe/MockRouter test doubles exist.
  });

  it.skip("executes a swap and emits Rebalanced on the happy path", async () => {
    // TODO(Phase 6): implement against a mock SaucerSwap router.
  });
});
