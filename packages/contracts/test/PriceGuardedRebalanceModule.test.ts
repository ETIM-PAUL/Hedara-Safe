import { expect } from "chai";
import { ethers } from "hardhat";

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

    const MockOracleAdapter = await ethers.getContractFactory("MockOracleAdapter");
    const oracle = await MockOracleAdapter.deploy();
    await oracle.waitForDeployment();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const tokenIn = await MockERC20.deploy("Token In", "TIN");
    await tokenIn.waitForDeployment();
    const tokenOut = await MockERC20.deploy("Token Out", "TOUT");
    await tokenOut.waitForDeployment();

    const amountIn = ethers.parseEther("100");
    await tokenIn.mint(await mockSafe.getAddress(), amountIn);
    await tokenOut.mint(await router.getAddress(), amountIn);

    // Trigger condition: fire only when price is at or below $0.08 (expo -8 -> 8_000_000).
    const triggerPrice = 8_000_000n;
    const triggerExpo = -8;
    const maxPriceAgeSeconds = 3600;

    const PriceGuardedRebalanceModule = await ethers.getContractFactory("PriceGuardedRebalanceModule");
    const module = await PriceGuardedRebalanceModule.deploy(
      await mockSafe.getAddress(),
      await router.getAddress(),
      await oracle.getAddress(),
      triggerPrice,
      triggerExpo,
      Comparison.Below,
      maxPriceAgeSeconds
    );
    await module.waitForDeployment();
    await mockSafe.connect(owner).enableModule(await module.getAddress());

    const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 3600;

    async function setOraclePrice(price: bigint, ageSeconds = 0) {
      const now = (await ethers.provider.getBlock("latest"))!.timestamp;
      await oracle.setPrice(price, triggerExpo, now - ageSeconds);
    }

    return {
      deployer,
      owner,
      nonOwner,
      mockSafe,
      router,
      oracle,
      tokenIn,
      tokenOut,
      module,
      amountIn,
      deadline,
      triggerPrice,
      triggerExpo,
      maxPriceAgeSeconds,
      setOraclePrice
    };
  }

  it("deploys with the configured oracle and trigger", async () => {
    const { module, mockSafe, router, oracle, triggerPrice, triggerExpo } = await deployFixture();
    expect(await module.safe()).to.equal(await mockSafe.getAddress());
    expect(await module.router()).to.equal(await router.getAddress());
    expect(await module.oracle()).to.equal(await oracle.getAddress());
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

  it("lets the Safe owner switch the active oracle", async () => {
    const { module, owner } = await deployFixture();
    const MockOracleAdapter = await ethers.getContractFactory("MockOracleAdapter");
    const newOracle = await MockOracleAdapter.deploy();
    await newOracle.waitForDeployment();
    const newOracleAddress = await newOracle.getAddress();

    await expect(module.connect(owner).setOracle(newOracleAddress))
      .to.emit(module, "OracleChanged")
      .withArgs(newOracleAddress);
    expect(await module.oracle()).to.equal(newOracleAddress);
  });

  it("reverts with NotSafeOwner when a non-owner tries to switch the oracle", async () => {
    const { module, nonOwner, oracle } = await deployFixture();
    await expect(module.connect(nonOwner).setOracle(await oracle.getAddress())).to.be.revertedWithCustomError(
      module,
      "NotSafeOwner"
    );
  });

  it("reverts with PriceConditionNotMet when the observed price doesn't satisfy the trigger", async () => {
    const { module, tokenIn, tokenOut, amountIn, deadline, setOraclePrice } = await deployFixture();
    await setOraclePrice(9_000_000n); // above the 8_000_000 Below trigger

    await expect(
      module.trigger(await tokenIn.getAddress(), await tokenOut.getAddress(), amountIn, 1n, deadline, [], {
        value: 0
      })
    ).to.be.revertedWithCustomError(module, "PriceConditionNotMet");
  });

  it("reverts with StalePrice when the oracle's price is older than maxPriceAgeSeconds", async () => {
    const { module, tokenIn, tokenOut, amountIn, deadline, setOraclePrice, maxPriceAgeSeconds } =
      await deployFixture();
    await setOraclePrice(7_000_000n, maxPriceAgeSeconds + 100); // satisfies price, but too old

    await expect(
      module.trigger(await tokenIn.getAddress(), await tokenOut.getAddress(), amountIn, 1n, deadline, [], {
        value: 0
      })
    ).to.be.revertedWithCustomError(module, "StalePrice");
  });

  it("reverts with InsufficientFee when msg.value is below what the oracle's refreshFee() requires", async () => {
    const { module, oracle, tokenIn, tokenOut, amountIn, deadline, setOraclePrice } = await deployFixture();
    await setOraclePrice(7_000_000n);
    await oracle.setRefreshFee(ethers.parseEther("0.01"));

    await expect(
      module.trigger(await tokenIn.getAddress(), await tokenOut.getAddress(), amountIn, 1n, deadline, [], {
        value: 0
      })
    ).to.be.revertedWithCustomError(module, "InsufficientFee");
  });

  it("executes the swap, emits Rebalanced with the observed price, and refunds excess fee when the condition holds", async () => {
    const { module, oracle, mockSafe, router, tokenIn, tokenOut, amountIn, deadline, setOraclePrice, deployer } =
      await deployFixture();
    await setOraclePrice(7_000_000n); // <= 8_000_000 trigger, satisfies Below
    const fee = ethers.parseEther("0.01");
    await oracle.setRefreshFee(fee);
    const overpay = fee + 1000n;

    const balanceBefore = await ethers.provider.getBalance(deployer.address);

    const tx = await module.trigger(
      await tokenIn.getAddress(),
      await tokenOut.getAddress(),
      amountIn,
      amountIn,
      deadline,
      [],
      { value: overpay }
    );
    const receipt = await tx.wait();

    await expect(tx)
      .to.emit(module, "Rebalanced")
      .withArgs(
        deployer.address,
        await tokenIn.getAddress(),
        await tokenOut.getAddress(),
        amountIn,
        amountIn,
        7_000_000n,
        -8
      );

    expect(await tokenIn.balanceOf(await mockSafe.getAddress())).to.equal(0n);
    expect(await tokenOut.balanceOf(await mockSafe.getAddress())).to.equal(amountIn);
    expect(await oracle.refreshCallCount()).to.equal(1n);

    // Confirm the overpaid fee was refunded: balance only dropped by fee + gas, not overpay + gas.
    const gasCost = receipt!.gasUsed * receipt!.gasPrice;
    const balanceAfter = await ethers.provider.getBalance(deployer.address);
    const spent = balanceBefore - balanceAfter;
    expect(spent).to.equal(gasCost + fee);
  });

  describe("switchOracleAndTrigger", () => {
    it("reverts with NotSafeOwner when a non-owner calls it", async () => {
      const { module, nonOwner, oracle, tokenIn, tokenOut, amountIn, deadline } = await deployFixture();
      await expect(
        module
          .connect(nonOwner)
          .switchOracleAndTrigger(
            await oracle.getAddress(),
            await tokenIn.getAddress(),
            await tokenOut.getAddress(),
            amountIn,
            1n,
            deadline,
            [],
            { value: 0 }
          )
      ).to.be.revertedWithCustomError(module, "NotSafeOwner");
    });

    it("switches the oracle and executes the swap in one call", async () => {
      const { module, owner, mockSafe, tokenIn, tokenOut, amountIn, deadline, triggerExpo } = await deployFixture();

      const MockOracleAdapter = await ethers.getContractFactory("MockOracleAdapter");
      const newOracle = await MockOracleAdapter.deploy();
      await newOracle.waitForDeployment();
      const newOracleAddress = await newOracle.getAddress();
      const now = (await ethers.provider.getBlock("latest"))!.timestamp;
      await newOracle.setPrice(6_000_000n, triggerExpo, now); // satisfies the <= 8_000_000 trigger

      const tx = await module
        .connect(owner)
        .switchOracleAndTrigger(
          newOracleAddress,
          await tokenIn.getAddress(),
          await tokenOut.getAddress(),
          amountIn,
          1n,
          deadline,
          [],
          { value: 0 }
        );

      await expect(tx).to.emit(module, "OracleChanged").withArgs(newOracleAddress);
      await expect(tx).to.emit(module, "Rebalanced");
      expect(await module.oracle()).to.equal(newOracleAddress);
      expect(await tokenOut.balanceOf(await mockSafe.getAddress())).to.equal(amountIn);
    });

    it("does not re-emit OracleChanged when the requested oracle is already active", async () => {
      const { module, owner, oracle, tokenIn, tokenOut, amountIn, deadline, setOraclePrice } = await deployFixture();
      await setOraclePrice(7_000_000n);

      const tx = await module
        .connect(owner)
        .switchOracleAndTrigger(
          await oracle.getAddress(),
          await tokenIn.getAddress(),
          await tokenOut.getAddress(),
          amountIn,
          1n,
          deadline,
          [],
          { value: 0 }
        );

      await expect(tx).to.not.emit(module, "OracleChanged");
      await expect(tx).to.emit(module, "Rebalanced");
    });
  });
});
