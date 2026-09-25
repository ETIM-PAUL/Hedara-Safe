import { expect } from "chai";
import { ethers } from "hardhat";

const PRICE_ID = "0x3728e591097635310e6341af53db8b7ee42da9b3a8d918f9463ce9cca886dfbd"; // HBAR/USD
const UPDATE_FEE_WEI = 1;
const VALID_TIME_PERIOD = 3600;

enum Comparison {
  Below,
  Above
}

describe("PriceGuardedRebalanceModule", () => {
  async function deployFixture() {
    const [deployer, owner, nonOwner] = await ethers.getSigners();

    const MockSafe = await ethers.getContractFactory("MockSafe");
    const mockSafe = await MockSafe.connect(owner).deploy();
    await mockSafe.waitForDeployment();

    const MockRouter = await ethers.getContractFactory("MockSaucerSwapRouter");
    const router = await MockRouter.deploy();
    await router.waitForDeployment();

    const MockPyth = await ethers.getContractFactory("MockPyth");
    const pyth = await MockPyth.deploy(VALID_TIME_PERIOD, UPDATE_FEE_WEI);
    await pyth.waitForDeployment();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const tokenIn = await MockERC20.deploy("Token In", "TIN");
    await tokenIn.waitForDeployment();
    const tokenOut = await MockERC20.deploy("Token Out", "TOUT");
    await tokenOut.waitForDeployment();

    const amountIn = ethers.parseEther("100");
    await tokenIn.mint(await mockSafe.getAddress(), amountIn);
    await tokenOut.mint(await router.getAddress(), amountIn);

    // Trigger condition: fire only when HBAR/USD price is at or below $0.08 (expo -8 -> 8_000_000).
    const triggerPrice = 8_000_000n;
    const triggerExpo = -8;

    const PriceGuardedRebalanceModule = await ethers.getContractFactory("PriceGuardedRebalanceModule");
    const module = await PriceGuardedRebalanceModule.deploy(
      await mockSafe.getAddress(),
      await router.getAddress(),
      await pyth.getAddress(),
      PRICE_ID,
      triggerPrice,
      triggerExpo,
      Comparison.Below,
      VALID_TIME_PERIOD
    );
    await module.waitForDeployment();
    await mockSafe.connect(owner).enableModule(await module.getAddress());

    const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 3600;

    async function buildUpdateData(price: bigint, expo = triggerExpo) {
      const publishTime = (await ethers.provider.getBlock("latest"))!.timestamp;
      const data = await pyth.createPriceFeedUpdateData(
        PRICE_ID,
        price,
        1, // conf
        expo,
        price, // emaPrice
        1, // emaConf
        publishTime,
        publishTime
      );
      return [data];
    }

    return {
      deployer,
      owner,
      nonOwner,
      mockSafe,
      router,
      pyth,
      tokenIn,
      tokenOut,
      module,
      amountIn,
      deadline,
      triggerPrice,
      triggerExpo,
      buildUpdateData
    };
  }

  it("deploys with the configured trigger", async () => {
    const { module, mockSafe, router, pyth, triggerPrice, triggerExpo } = await deployFixture();
    expect(await module.safe()).to.equal(await mockSafe.getAddress());
    expect(await module.router()).to.equal(await router.getAddress());
    expect(await module.pyth()).to.equal(await pyth.getAddress());
    expect(await module.triggerPrice()).to.equal(triggerPrice);
    expect(await module.triggerExpo()).to.equal(triggerExpo);
  });

  it("lets the Safe owner reconfigure the trigger", async () => {
    const { module, owner } = await deployFixture();
    await expect(module.connect(owner).setTrigger(5_000_000n, -8, Comparison.Above, 7200))
      .to.emit(module, "TriggerConfigured")
      .withArgs(5_000_000n, -8, Comparison.Above, 7200);
    expect(await module.triggerPrice()).to.equal(5_000_000n);
  });

  it("reverts with NotSafeOwner when a non-owner tries to reconfigure the trigger", async () => {
    const { module, nonOwner } = await deployFixture();
    await expect(module.connect(nonOwner).setTrigger(1n, -8, Comparison.Below, 60)).to.be.revertedWithCustomError(
      module,
      "NotSafeOwner"
    );
  });

  it("reverts with PriceConditionNotMet when the observed price doesn't satisfy the trigger", async () => {
    const { module, tokenIn, tokenOut, amountIn, deadline, buildUpdateData } = await deployFixture();
    // Trigger fires when price <= 8_000_000; feed price of 9_000_000 should not satisfy it.
    const updateData = await buildUpdateData(9_000_000n);
    const fee = await (await ethers.getContractAt("MockPyth", await module.pyth())).getUpdateFee(updateData);

    await expect(
      module.trigger(
        await tokenIn.getAddress(),
        await tokenOut.getAddress(),
        amountIn,
        1n,
        deadline,
        updateData,
        { value: fee }
      )
    ).to.be.revertedWithCustomError(module, "PriceConditionNotMet");
  });

  it("reverts with InsufficientFee when msg.value is below the Pyth update fee", async () => {
    const { module, tokenIn, tokenOut, amountIn, deadline, buildUpdateData } = await deployFixture();
    const updateData = await buildUpdateData(7_000_000n);

    await expect(
      module.trigger(
        await tokenIn.getAddress(),
        await tokenOut.getAddress(),
        amountIn,
        1n,
        deadline,
        updateData,
        { value: 0 }
      )
    ).to.be.revertedWithCustomError(module, "InsufficientFee");
  });

  it("executes the swap, emits Rebalanced with the observed price, and refunds excess fee when the condition holds", async () => {
    const { module, mockSafe, router, tokenIn, tokenOut, amountIn, deadline, buildUpdateData, deployer } =
      await deployFixture();
    // Price of 7_000_000 (<= 8_000_000 trigger) satisfies the Below condition.
    const updateData = await buildUpdateData(7_000_000n);
    const fee = await (await ethers.getContractAt("MockPyth", await module.pyth())).getUpdateFee(updateData);
    const overpay = fee + 1000n;

    const balanceBefore = await ethers.provider.getBalance(deployer.address);

    const tx = await module.trigger(
      await tokenIn.getAddress(),
      await tokenOut.getAddress(),
      amountIn,
      amountIn,
      deadline,
      updateData,
      { value: overpay }
    );
    const receipt = await tx.wait();

    await expect(tx)
      .to.emit(module, "Rebalanced")
      .withArgs(deployer.address, await tokenIn.getAddress(), await tokenOut.getAddress(), amountIn, amountIn, 7_000_000n, -8);

    expect(await tokenIn.balanceOf(await mockSafe.getAddress())).to.equal(0n);
    expect(await tokenOut.balanceOf(await mockSafe.getAddress())).to.equal(amountIn);

    // Confirm the overpaid fee was refunded: balance only dropped by fee + gas, not overpay + gas.
    const gasCost = receipt!.gasUsed * receipt!.gasPrice;
    const balanceAfter = await ethers.provider.getBalance(deployer.address);
    const spent = balanceBefore - balanceAfter;
    expect(spent).to.equal(gasCost + fee);
  });
});
