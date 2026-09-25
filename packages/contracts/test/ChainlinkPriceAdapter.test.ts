import { expect } from "chai";
import { ethers } from "hardhat";

describe("ChainlinkPriceAdapter", () => {
  async function deployFixture() {
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;

    const MockChainlinkAggregator = await ethers.getContractFactory("MockChainlinkAggregator");
    const feed = await MockChainlinkAggregator.deploy(9_403_916n, 8, now);
    await feed.waitForDeployment();

    const ChainlinkPriceAdapter = await ethers.getContractFactory("ChainlinkPriceAdapter");
    const adapter = await ChainlinkPriceAdapter.deploy(await feed.getAddress());
    await adapter.waitForDeployment();

    return { feed, adapter, now };
  }

  it("translates decimals into a negative expo and passes the price through unchanged", async () => {
    const { adapter, now } = await deployFixture();
    const [price, expo, publishTime] = await adapter.getPrice();
    expect(price).to.equal(9_403_916n);
    expect(expo).to.equal(-8);
    expect(publishTime).to.equal(now);
  });

  it("reflects updates written to the underlying feed", async () => {
    const { feed, adapter } = await deployFixture();
    const newTime = (await ethers.provider.getBlock("latest"))!.timestamp + 100;
    await feed.set(9_500_000n, newTime);

    const [price, , publishTime] = await adapter.getPrice();
    expect(price).to.equal(9_500_000n);
    expect(publishTime).to.equal(newTime);
  });

  it("refreshFee() is always zero and refresh() is a no-op", async () => {
    const { adapter } = await deployFixture();
    expect(await adapter.refreshFee([])).to.equal(0n);
    await expect(adapter.refresh([], { value: 0 })).to.not.be.reverted;
  });

  it("reverts with PriceOutOfRange when the feed's answer doesn't fit in int64", async () => {
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    const MockChainlinkAggregator = await ethers.getContractFactory("MockChainlinkAggregator");
    const feed = await MockChainlinkAggregator.deploy(2n ** 70n, 8, now);
    await feed.waitForDeployment();

    const ChainlinkPriceAdapter = await ethers.getContractFactory("ChainlinkPriceAdapter");
    const adapter = await ChainlinkPriceAdapter.deploy(await feed.getAddress());
    await adapter.waitForDeployment();

    await expect(adapter.getPrice()).to.be.revertedWithCustomError(adapter, "PriceOutOfRange");
  });
});
