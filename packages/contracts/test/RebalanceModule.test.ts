import { expect } from "chai";
import { ethers } from "hardhat";

/**
 * Coverage per AGENTS.md: happy path, module not enabled, caller not the Safe itself, and a
 * swap/slippage failure — plus the module's own deadline and zero-amount guards.
 *
 * `rebalance()` requires msg.sender == address(safe) — a quorum-approved Safe transaction, not
 * any single owner calling directly (see RebalanceModule.sol's `onlySafe` modifier). Tests that
 * exercise the happy path impersonate the MockSafe's address to simulate that; the rejection test
 * calls the module directly from an owner's own EOA instead.
 */
describe("RebalanceModule", () => {
  async function deployFixture() {
    const [deployer, owner, nonOwner, safeStandIn] = await ethers.getSigners();

    const MockSafe = await ethers.getContractFactory("MockSafe");
    const mockSafe = await MockSafe.connect(owner).deploy();
    await mockSafe.waitForDeployment();
    const safeAddress = await mockSafe.getAddress();

    const MockRouter = await ethers.getContractFactory("MockSaucerSwapRouter");
    const router = await MockRouter.deploy();
    await router.waitForDeployment();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const tokenIn = await MockERC20.deploy("Token In", "TIN");
    await tokenIn.waitForDeployment();
    const tokenOut = await MockERC20.deploy("Token Out", "TOUT");
    await tokenOut.waitForDeployment();

    const RebalanceModule = await ethers.getContractFactory("RebalanceModule");
    const module = await RebalanceModule.deploy(safeAddress, await router.getAddress());
    await module.waitForDeployment();

    // Fund the "Safe" with tokenIn, and the router with tokenOut liquidity to swap out of.
    const amountIn = ethers.parseEther("100");
    await tokenIn.mint(safeAddress, amountIn);
    await tokenOut.mint(await router.getAddress(), amountIn);

    const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 3600;

    // Impersonates the MockSafe's own address so a call appears to come from the Safe itself —
    // exactly what `onlySafe` checks for, mirroring a real quorum-approved execTransaction
    // without needing to replicate Safe's signature verification in the mock.
    await ethers.provider.send("hardhat_impersonateAccount", [safeAddress]);
    await ethers.provider.send("hardhat_setBalance", [safeAddress, "0x56BC75E2D63100000"]); // 100 ETH
    const asSafe = await ethers.getSigner(safeAddress);

    return {
      deployer,
      owner,
      nonOwner,
      safeStandIn,
      mockSafe,
      safeAddress,
      asSafe,
      router,
      tokenIn,
      tokenOut,
      module,
      amountIn,
      deadline
    };
  }

  it("deploys with the configured Safe and router addresses", async () => {
    const { mockSafe, router, module } = await deployFixture();
    expect(await module.safe()).to.equal(await mockSafe.getAddress());
    expect(await module.router()).to.equal(await router.getAddress());
  });

  it("reverts with NotSafe when called directly by an owner instead of via the Safe", async () => {
    const { module, owner, nonOwner, tokenIn, tokenOut, amountIn, deadline } =
      await deployFixture();

    for (const caller of [owner, nonOwner]) {
      await expect(
        module
          .connect(caller)
          .rebalance(
            await tokenIn.getAddress(),
            await tokenOut.getAddress(),
            amountIn,
            amountIn,
            deadline
          )
      ).to.be.revertedWithCustomError(module, "NotSafe");
    }
  });

  it("reverts with DeadlinePassed when the deadline has already elapsed", async () => {
    const { module, asSafe, tokenIn, tokenOut, amountIn } = await deployFixture();
    const pastDeadline = (await ethers.provider.getBlock("latest"))!.timestamp - 1;

    await expect(
      module
        .connect(asSafe)
        .rebalance(
          await tokenIn.getAddress(),
          await tokenOut.getAddress(),
          amountIn,
          amountIn,
          pastDeadline
        )
    ).to.be.revertedWithCustomError(module, "DeadlinePassed");
  });

  it("reverts with ZeroAmount when amountIn is zero", async () => {
    const { module, asSafe, tokenIn, tokenOut, deadline } = await deployFixture();

    await expect(
      module
        .connect(asSafe)
        .rebalance(await tokenIn.getAddress(), await tokenOut.getAddress(), 0, 0, deadline)
    ).to.be.revertedWithCustomError(module, "ZeroAmount");
  });

  it("reverts with SwapFailed when the module is not enabled on the Safe", async () => {
    const { module, asSafe, tokenIn, tokenOut, amountIn, deadline } = await deployFixture();
    // Module was never enabled via mockSafe.enableModule() in this test — approve step fails.

    await expect(
      module
        .connect(asSafe)
        .rebalance(
          await tokenIn.getAddress(),
          await tokenOut.getAddress(),
          amountIn,
          amountIn,
          deadline
        )
    ).to.be.revertedWith("MockSafe: module not enabled");
  });

  it("reverts when amountOutMin exceeds what the router can deliver (slippage/liquidity failure)", async () => {
    const { module, mockSafe, owner, asSafe, tokenIn, tokenOut, amountIn, deadline } =
      await deployFixture();
    await mockSafe.connect(owner).enableModule(await module.getAddress());

    const unreachableMin = amountIn + 1n;
    await expect(
      module
        .connect(asSafe)
        .rebalance(
          await tokenIn.getAddress(),
          await tokenOut.getAddress(),
          amountIn,
          unreachableMin,
          deadline
        )
    ).to.be.reverted;
  });

  it("executes a swap and emits Rebalanced on the happy path", async () => {
    const { module, mockSafe, safeAddress, asSafe, router, owner, tokenIn, tokenOut, amountIn, deadline } =
      await deployFixture();
    await mockSafe.connect(owner).enableModule(await module.getAddress());

    const tokenInAddress = await tokenIn.getAddress();
    const tokenOutAddress = await tokenOut.getAddress();

    await expect(
      module.connect(asSafe).rebalance(tokenInAddress, tokenOutAddress, amountIn, amountIn, deadline)
    )
      .to.emit(module, "Rebalanced")
      .withArgs(safeAddress, tokenInAddress, tokenOutAddress, amountIn, amountIn);

    expect(await tokenIn.balanceOf(safeAddress)).to.equal(0n);
    expect(await tokenIn.balanceOf(await router.getAddress())).to.equal(amountIn);
    expect(await tokenOut.balanceOf(safeAddress)).to.equal(amountIn);
  });
});
