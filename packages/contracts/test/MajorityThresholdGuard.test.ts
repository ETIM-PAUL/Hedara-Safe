import { expect } from "chai";
import { ethers } from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * Runs against a real Safe 1.4.1 (singleton + proxy), not MockSafe: the guard's whole job is
 * reacting to the Safe's own execTransaction flow, so mocking the Safe would only test the mock.
 */
describe("MajorityThresholdGuard", () => {
  async function deploySafe(ownerCount: number, threshold: number) {
    const signers = await ethers.getSigners();
    const owners = signers.slice(0, ownerCount);
    const outsider = signers[9];

    const singleton = await (await ethers.getContractFactory("Safe")).deploy();
    const factory = await (await ethers.getContractFactory("SafeProxyFactory")).deploy();
    const setup = singleton.interface.encodeFunctionData("setup", [
      await Promise.all(owners.map((o) => o.getAddress())),
      threshold,
      ethers.ZeroAddress,
      "0x",
      ethers.ZeroAddress,
      ethers.ZeroAddress,
      0,
      ethers.ZeroAddress
    ]);
    const proxyAddress = await factory.createProxyWithNonce.staticCall(await singleton.getAddress(), setup, 0);
    await factory.createProxyWithNonce(await singleton.getAddress(), setup, 0);
    const safe = await ethers.getContractAt("Safe", proxyAddress);

    const guard = await (await ethers.getContractFactory("MajorityThresholdGuard")).deploy();
    return { safe, guard, owners, outsider };
  }

  type SafeContract = Awaited<ReturnType<typeof deploySafe>>["safe"];

  /** Approved-hash signatures (v=1): the first approver submits, the rest approveHash() first. */
  async function exec(safe: SafeContract, approvers: HardhatEthersSigner[], data: string, to?: string) {
    const target = to ?? (await safe.getAddress());
    const hash = await safe.getTransactionHash(target, 0, data, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, await safe.nonce());
    for (const a of approvers.slice(1)) await safe.connect(a).approveHash(hash);
    const addrs = await Promise.all(approvers.map((a) => a.getAddress()));
    addrs.sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
    const sigs = ethers.concat(addrs.map((a) => ethers.concat([ethers.zeroPadValue(a, 32), ethers.ZeroHash, "0x01"])));
    return safe.connect(approvers[0]).execTransaction(target, 0, data, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, sigs);
  }

  const call = (safe: SafeContract, fn: string, args: unknown[]) => safe.interface.encodeFunctionData(fn, args);

  it("reports the Safe Guard interface, so setGuard accepts it", async () => {
    const { guard } = await deploySafe(1, 1);
    expect(await guard.supportsInterface("0xe6d7a83a")).to.equal(true);
    expect(await guard.supportsInterface("0x01ffc9a7")).to.equal(true);
    expect(await guard.supportsInterface("0xdeadbeef")).to.equal(false);
  });

  it("allows owner changes that keep a majority", async () => {
    const { safe, guard, owners, outsider } = await deploySafe(3, 2);
    await exec(safe, owners.slice(0, 2), call(safe, "setGuard", [await guard.getAddress()]));

    await exec(safe, owners.slice(0, 2), call(safe, "addOwnerWithThreshold", [await outsider.getAddress(), 3]));
    expect(await safe.getThreshold()).to.equal(3n);
    expect((await safe.getOwners()).length).to.equal(4);
  });

  it("reverts adding an owner below a majority (2 of 4)", async () => {
    const { safe, guard, owners, outsider } = await deploySafe(3, 2);
    await exec(safe, owners.slice(0, 2), call(safe, "setGuard", [await guard.getAddress()]));

    await expect(exec(safe, owners.slice(0, 2), call(safe, "addOwnerWithThreshold", [await outsider.getAddress(), 2])))
      .to.be.revertedWithCustomError(guard, "ThresholdBelowMajority")
      .withArgs(2, 4, 3);
    expect((await safe.getOwners()).length).to.equal(3);
  });

  it("reverts lowering the threshold below a majority (1 of 3)", async () => {
    const { safe, guard, owners } = await deploySafe(3, 2);
    await exec(safe, owners.slice(0, 2), call(safe, "setGuard", [await guard.getAddress()]));

    await expect(exec(safe, owners.slice(0, 2), call(safe, "changeThreshold", [1])))
      .to.be.revertedWithCustomError(guard, "ThresholdBelowMajority")
      .withArgs(1, 3, 2);
    expect(await safe.getThreshold()).to.equal(2n);
  });

  it("reverts removing an owner when the remaining threshold isn't a majority", async () => {
    const { safe, guard, owners } = await deploySafe(4, 3);
    await exec(safe, owners.slice(0, 3), call(safe, "setGuard", [await guard.getAddress()]));
    const target = await owners[3].getAddress();
    const prev = await owners[2].getAddress();

    await expect(exec(safe, owners.slice(0, 3), call(safe, "removeOwner", [prev, target, 1])))
      .to.be.revertedWithCustomError(guard, "ThresholdBelowMajority")
      .withArgs(1, 3, 2);
    await exec(safe, owners.slice(0, 3), call(safe, "removeOwner", [prev, target, 2]));
    expect(await safe.getOwners()).to.not.include(target);
  });

  it("locks a below-majority Safe to transactions that restore a majority", async () => {
    const { safe, guard, owners } = await deploySafe(3, 1);
    // setGuard itself isn't checked (Safe reads the guard before executing), so it can be installed
    // on a Safe that is already below a majority — after which only a fix can execute.
    await exec(safe, owners.slice(0, 1), call(safe, "setGuard", [await guard.getAddress()]));

    const owner2 = await owners[1].getAddress();
    await expect(exec(safe, owners.slice(0, 1), "0x", owner2)).to.be.revertedWithCustomError(
      guard,
      "ThresholdBelowMajority"
    );
    await exec(safe, owners.slice(0, 1), call(safe, "changeThreshold", [2]));
    await exec(safe, owners.slice(0, 2), "0x", owner2);
    expect(await safe.getThreshold()).to.equal(2n);
  });

  it("can be removed by the Safe's quorum while a majority holds", async () => {
    const { safe, guard, owners } = await deploySafe(3, 2);
    await exec(safe, owners.slice(0, 2), call(safe, "setGuard", [await guard.getAddress()]));
    await exec(safe, owners.slice(0, 2), call(safe, "setGuard", [ethers.ZeroAddress]));

    // With the guard gone, the Safe accepts any threshold again.
    await exec(safe, owners.slice(0, 2), call(safe, "changeThreshold", [1]));
    expect(await safe.getThreshold()).to.equal(1n);
  });

  it("reverts rather than passing when the caller isn't a Safe", async () => {
    const { guard, owners } = await deploySafe(1, 1);
    // A plain account has no getOwners()/getThreshold(); the guard must fail closed, not pass.
    await expect(guard.connect(owners[0]).checkAfterExecution(ethers.ZeroHash, true)).to.be.reverted;
  });
});
