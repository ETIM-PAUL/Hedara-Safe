import { expect } from "chai";
import { ethers } from "hardhat";

const PAIR_INDEX = 432; // HBAR_USD, per Supra's data feeds index

describe("SupraPriceAdapter", () => {
  async function deployFixture() {
    const nowMs = Date.now();

    const MockSupraStorage = await ethers.getContractFactory("MockSupraStorage");
    const storage = await MockSupraStorage.deploy(18, nowMs, 93_902_000_000_000_000n);
    await storage.waitForDeployment();

    const SupraPriceAdapter = await ethers.getContractFactory("SupraPriceAdapter");
    const adapter = await SupraPriceAdapter.deploy(await storage.getAddress(), PAIR_INDEX);
    await adapter.waitForDeployment();

    return { storage, adapter, nowMs };
  }

  it("converts Supra's 18-decimal unsigned price and millisecond timestamp correctly", async () => {
    const { adapter, nowMs } = await deployFixture();
    const [price, expo, publishTime] = await adapter.getPrice();
    expect(price).to.equal(93_902_000_000_000_000n);
    expect(expo).to.equal(-18);
    expect(publishTime).to.equal(Math.floor(nowMs / 1000));
  });

  it("reflects updates written to the underlying storage contract", async () => {
    const { storage, adapter } = await deployFixture();
    const newTimeMs = Date.now() + 100_000;
    await storage.set(newTimeMs, 94_000_000_000_000_000n);

    const [price, , publishTime] = await adapter.getPrice();
    expect(price).to.equal(94_000_000_000_000_000n);
    expect(publishTime).to.equal(Math.floor(newTimeMs / 1000));
  });

  it("refreshFee() is always zero and refresh() is a no-op", async () => {
    const { adapter } = await deployFixture();
    expect(await adapter.refreshFee([])).to.equal(0n);
    await expect(adapter.refresh([], { value: 0 })).to.not.be.reverted;
  });

  it("reverts with PriceOutOfRange when the stored price doesn't fit in int64", async () => {
    const MockSupraStorage = await ethers.getContractFactory("MockSupraStorage");
    const storage = await MockSupraStorage.deploy(18, Date.now(), 2n ** 70n);
    await storage.waitForDeployment();

    const SupraPriceAdapter = await ethers.getContractFactory("SupraPriceAdapter");
    const adapter = await SupraPriceAdapter.deploy(await storage.getAddress(), PAIR_INDEX);
    await adapter.waitForDeployment();

    await expect(adapter.getPrice()).to.be.revertedWithCustomError(adapter, "PriceOutOfRange");
  });
});
