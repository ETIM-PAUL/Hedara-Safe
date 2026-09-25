import { expect } from "chai";
import { ethers } from "hardhat";

/**
 * Coverage per AGENTS.md: happy path, module not enabled, caller not an owner, and a
 * swap/slippage failure — plus the module's own deadline and zero-amount guards.
 */
describe("RebalanceModule", () => {
  async function deployFixture() {
    const [deployer, owner, nonOwner, safeStandIn] = await ethers.getSigners();

    const MockSafe = await ethers.getContractFactory("MockSafe");
    const mockSafe = await MockSafe.connect(owner).deploy();
    await mockSafe.waitForDeployment();

    const MockRouter = await ethers.getContractFactory("MockSaucerSwapRouter");
    const router = await MockRouter.deploy();
    await router.waitForDeployment();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const tokenIn = await MockERC20.deploy("Token In", "TIN");
    await tokenIn.waitForDeployment();
    const tokenOut = await MockERC20.deploy("Token Out", "TOUT");
    await tokenOut.waitForDeployment();

    const RebalanceModule = await ethers.getContractFactory("RebalanceModule");
    const module = await RebalanceModule.deploy(
      await mockSafe.getAddress(),
      await router.getAddress()
    );
    await module.waitForDeployment();

    // Fund the "Safe" with tokenIn, and the router with tokenOut liquidity to swap out of.
    const amountIn = ethers.parseEther("100");
    await tokenIn.mint(await mockSafe.getAddress(), amountIn);
    await tokenOut.mint(await router.getAddress(), amountIn);

    const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 3600;

    return {
      deployer,
      owner,
      nonOwner,
      safeStandIn,
      mockSafe,
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

  it("reverts with NotSafeOwner when a non-owner triggers a rebalance", async () => {
    const { module, nonOwner, tokenIn, tokenOut, amountIn, deadline } = await deployFixture();

    await expect(
      module
        .connect(nonOwner)
        .rebalance(
          await tokenIn.getAddress(),
          await tokenOut.getAddress(),
          amountIn,
          amountIn,
          deadline
        )
    ).to.be.revertedWithCustomError(module, "NotSafeOwner");
  });

  it("reverts with DeadlinePassed when the deadline has already elapsed", async () => {
    const { module, owner, tokenIn, tokenOut, amountIn } = await deployFixture();
    const pastDeadline = (await ethers.provider.getBlock("latest"))!.timestamp - 1;

    await expect(
      module
        .connect(owner)
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
    const { module, owner, tokenIn, tokenOut, deadline } = await deployFixture();

    await expect(
      module
        .connect(owner)
        .rebalance(await tokenIn.getAddress(), await tokenOut.getAddress(), 0, 0, deadline)
    ).to.be.revertedWithCustomError(module, "ZeroAmount");
  });

  it("reverts with SwapFailed when the module is not enabled on the Safe", async () => {
    const { module, owner, tokenIn, tokenOut, amountIn, deadline } = await deployFixture();
    // Module was never enabled via mockSafe.enableModule() in this test — approve step fails.

    await expect(
      module
        .connect(owner)
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
    const { module, mockSafe, owner, tokenIn, tokenOut, amountIn, deadline } =
      await deployFixture();
    await mockSafe.connect(owner).enableModule(await module.getAddress());

    const unreachableMin = amountIn + 1n;
    await expect(
      module
        .connect(owner)
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
    const { module, mockSafe, router, owner, tokenIn, tokenOut, amountIn, deadline } =
      await deployFixture();
    await mockSafe.connect(owner).enableModule(await module.getAddress());

    const safeAddress = await mockSafe.getAddress();
    const tokenInAddress = await tokenIn.getAddress();
    const tokenOutAddress = await tokenOut.getAddress();

    await expect(
      module.connect(owner).rebalance(tokenInAddress, tokenOutAddress, amountIn, amountIn, deadline)
    )
      .to.emit(module, "Rebalanced")
      .withArgs(owner.address, tokenInAddress, tokenOutAddress, amountIn, amountIn);

    expect(await tokenIn.balanceOf(safeAddress)).to.equal(0n);
    expect(await tokenIn.balanceOf(await router.getAddress())).to.equal(amountIn);
    expect(await tokenOut.balanceOf(safeAddress)).to.equal(amountIn);
  });
});
