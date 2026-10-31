import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import type { EmberToken } from "../typechain-types";

const UNIT = 10n ** 18n;
const MAX_SUPPLY = 100_000_000n * UNIT;
const INITIAL_ALLOCATION = 10_000_000n * UNIT;

interface FixtureResult {
  token: EmberToken;
  admin: SignerWithAddress;
  treasury: SignerWithAddress;
  minter: SignerWithAddress;
  user: SignerWithAddress;
}

describe("EmberToken", () => {
  async function deployFixture(): Promise<FixtureResult> {
    const [, admin, treasury, minter, user] = await ethers.getSigners();

    const factory = await ethers.getContractFactory("EmberToken", admin);
    const token = (await factory.deploy(
      admin.address,
      treasury.address,
      MAX_SUPPLY,
      INITIAL_ALLOCATION,
    )) as unknown as EmberToken;

    await token.connect(admin).grantRole(await token.MINTER_ROLE(), minter.address);
    await token.connect(admin).grantRole(await token.BURNER_ROLE(), treasury.address);

    return { token, admin, treasury, minter, user };
  }

  async function crossCapFixture(): Promise<FixtureResult> {
    const [, admin, treasury] = await ethers.getSigners();
    const factory = await ethers.getContractFactory("EmberToken", admin);
    const token = (await factory.deploy(
      admin.address,
      treasury.address,
      100n * UNIT,
      60n * UNIT,
    )) as unknown as EmberToken;
    await grantMinter(token, admin, treasury);
    await grantBurner(token, admin, treasury);
    const [ , , , user ] = await ethers.getSigners();
    return { token, admin, treasury, minter: treasury, user };
  }

  async function grantMinter(token: EmberToken, admin: SignerWithAddress, minter: SignerWithAddress) {
    await token.connect(admin).grantRole(await token.MINTER_ROLE(), minter.address);
  }

  async function grantBurner(token: EmberToken, admin: SignerWithAddress, burner: SignerWithAddress) {
    await token.connect(admin).grantRole(await token.BURNER_ROLE(), burner.address);
  }

  describe("metadata and deployment", () => {
    it("exposes the token name, symbol and 18 decimals", async () => {
      const { token } = await loadFixture(deployFixture);
      expect(await token.name()).to.equal("Ember");
      expect(await token.symbol()).to.equal("EMBER");
      expect(await token.decimals()).to.equal(18);
    });

    it("exposes the deployment-time cap that cannot be changed", async () => {
      const { token } = await loadFixture(deployFixture);
      expect(await token.maxSupply()).to.equal(MAX_SUPPLY);

      const snapshotId = await ethers.provider.send("evm_snapshot", []);
      const first = await token.maxSupply();
      await ethers.provider.send("evm_mine", []);
      await ethers.provider.send("evm_mine", []);
      const second = await token.maxSupply();
      await ethers.provider.send("evm_revert", [snapshotId]);

      expect(first).to.equal(second);
    });

    it("rejects a zero max supply", async () => {
      const [, admin, treasury] = await ethers.getSigners();
      const factory = await ethers.getContractFactory("EmberToken", admin);
      await expect(
        factory.deploy(admin.address, treasury.address, 0, 0),
      ).to.be.revertedWithCustomError(factory, "ZeroMaxSupply");
    });
  });

  describe("initial treasury allocation", () => {
    it("mints the initial allocation to the treasury only", async () => {
      const { token, treasury, admin } = await loadFixture(deployFixture);
      expect(await token.treasury()).to.equal(treasury.address);
      expect(await token.balanceOf(treasury.address)).to.equal(INITIAL_ALLOCATION);
      expect(await token.totalSupply()).to.equal(INITIAL_ALLOCATION);
      expect(await token.hasRole(await token.DEFAULT_ADMIN_ROLE(), admin.address)).to.equal(true);
    });

    it("rejects an initial allocation above the cap", async () => {
      const [, admin, treasury] = await ethers.getSigners();
      const factory = await ethers.getContractFactory("EmberToken", admin);
      await expect(
        factory.deploy(admin.address, treasury.address, 100n * UNIT, 101n * UNIT),
      ).to.be.revertedWithCustomError(factory, "InitialAllocationExceedsMaxSupply");
    });

    it("rejects a zero address admin or treasury", async () => {
      const [, admin, treasury] = await ethers.getSigners();
      const factory = await ethers.getContractFactory("EmberToken", admin);
      await expect(factory.deploy(ethers.ZeroAddress, treasury.address, MAX_SUPPLY, 0)).to.be.revertedWithCustomError(factory, "ZeroAddress");
      await expect(factory.deploy(admin.address, ethers.ZeroAddress, MAX_SUPPLY, 0)).to.be.revertedWithCustomError(factory, "ZeroAddress");
    });
  });

  describe("minting", () => {
    it("lets the minter mint to the treasury and emits the mint events", async () => {
      const { token, minter, treasury } = await loadFixture(deployFixture);
      const amount = 1_000n * UNIT;

      await expect(token.connect(minter).mint(treasury.address, amount))
        .to.emit(token, "TokensMinted")
        .withArgs(treasury.address, amount, INITIAL_ALLOCATION + amount)
        .and.to.emit(token, "Transfer")
        .withArgs(ethers.ZeroAddress, treasury.address, amount);

      expect(await token.balanceOf(treasury.address)).to.equal(INITIAL_ALLOCATION + amount);
      expect(await token.totalSupply()).to.equal(INITIAL_ALLOCATION + amount);
    });

    it("rejects minting to any address other than the treasury", async () => {
      const { token, minter, user } = await loadFixture(deployFixture);
      await expect(token.connect(minter).mint(user.address, UNIT)).to.be.revertedWithCustomError(
        token,
        "MintNotToTreasury",
      ).withArgs(user.address);
    });

    it("rejects minting from accounts without the minter role", async () => {
      const { token, admin, user } = await loadFixture(deployFixture);
      await expect(token.connect(user).mint(await token.treasury(), UNIT)).to.be.revertedWithCustomError(
        token,
        "AccessControlUnauthorizedAccount",
      ).withArgs(user.address, await token.MINTER_ROLE());
      await expect(token.connect(admin).mint(await token.treasury(), UNIT)).to.be.revertedWithCustomError(
        token,
        "AccessControlUnauthorizedAccount",
      ).withArgs(admin.address, await token.MINTER_ROLE());
    });

    it("treats a zero-amount mint as a no-op", async () => {
      const { token, minter } = await loadFixture(deployFixture);
      await token.connect(minter).mint(await token.treasury(), 0);
      expect(await token.totalSupply()).to.equal(INITIAL_ALLOCATION);
    });
  });

  describe("lifetime cap", () => {
    it("rejects a mint that would exceed the cap", async () => {
      const { token, minter } = await loadFixture(crossCapFixture);
      const over = 41n * UNIT;
      await expect(token.connect(minter).mint(await token.treasury(), over)).to.be.revertedWithCustomError(
        token,
        "MaxSupplyExceeded",
      );
      await expect(token.connect(minter).mint(await token.treasury(), 40n * UNIT)).to.emit(
        token,
        "TokensMinted",
      );
    });

    it("allows minting exactly up to the cap", async () => {
      const { token, minter } = await loadFixture(crossCapFixture);
      await token.connect(minter).mint(await token.treasury(), 40n * UNIT);
      expect(await token.totalSupply()).to.equal(100n * UNIT);
      await expect(token.connect(minter).mint(await token.treasury(), 1)).to.be.revertedWithCustomError(
        token,
        "MaxSupplyExceeded",
      );
    });
  });

  describe("burning", () => {
    it("lets the burner burn treasury-owned tokens only and emits the burn events", async () => {
      const { token, treasury } = await loadFixture(deployFixture);
      const amount = 2_500n * UNIT;

      await expect(token.connect(treasury).burnTreasury(amount))
        .to.emit(token, "TokensBurned")
        .withArgs(treasury.address, amount, INITIAL_ALLOCATION - amount)
        .and.to.emit(token, "Transfer")
        .withArgs(treasury.address, ethers.ZeroAddress, amount);

      expect(await token.balanceOf(treasury.address)).to.equal(INITIAL_ALLOCATION - amount);
      expect(await token.totalSupply()).to.equal(INITIAL_ALLOCATION - amount);
    });

    it("rejects burns from accounts without the burner role", async () => {
      const { token, admin, user } = await loadFixture(deployFixture);
      await expect(token.connect(user).burnTreasury(UNIT)).to.be.revertedWithCustomError(
        token,
        "AccessControlUnauthorizedAccount",
      ).withArgs(user.address, await token.BURNER_ROLE());
      await expect(token.connect(admin).burnTreasury(UNIT)).to.be.revertedWithCustomError(
        token,
        "AccessControlUnauthorizedAccount",
      ).withArgs(admin.address, await token.BURNER_ROLE());
    });

    it("burns from the treasury balance even when the burner is a different key", async () => {
      const { token, admin, minter, treasury, user } = await loadFixture(deployFixture);
      await token.connect(admin).grantRole(await token.BURNER_ROLE(), minter.address);

      const beforeTreasury = await token.balanceOf(treasury.address);
      const beforeBurner = await token.balanceOf(minter.address);

      await expect(token.connect(minter).burnTreasury(1_000n * UNIT))
        .to.emit(token, "TokensBurned")
        .withArgs(treasury.address, 1_000n * UNIT, INITIAL_ALLOCATION - 1000n * UNIT);

      expect(await token.balanceOf(treasury.address)).to.equal(beforeTreasury - 1000n * UNIT);
      expect(await token.balanceOf(minter.address)).to.equal(beforeBurner);
    });

    it("refuses to burn more than the treasury holds", async () => {
      const { token, treasury } = await loadFixture(deployFixture);
      const balance = await token.balanceOf(treasury.address);
      await expect(token.connect(treasury).burnTreasury(balance + UNIT)).to.be.revertedWithCustomError(
        token,
        "ERC20InsufficientBalance",
      ).withArgs(treasury.address, balance, balance + UNIT);
    });

    it("treats a zero-amount burn as a no-op", async () => {
      const { token, treasury } = await loadFixture(deployFixture);
      const before = await token.totalSupply();
      await token.connect(treasury).burnTreasury(0);
      expect(await token.totalSupply()).to.equal(before);
    });
  });

  describe("transfers and balances", () => {
    it("moves tokens user to user", async () => {
      const { token, treasury, user } = await loadFixture(deployFixture);
      await token.connect(treasury).transfer(user.address, 500n * UNIT);
      await token.connect(user).transfer(treasury.address, 100n * UNIT);

      expect(await token.balanceOf(user.address)).to.equal(400n * UNIT);
      expect(await token.balanceOf(treasury.address)).to.equal(INITIAL_ALLOCATION - 400n * UNIT);
      expect(await token.totalSupply()).to.equal(INITIAL_ALLOCATION);
    });

    it("rejects a transfer above the sender balance", async () => {
      const { token, treasury, user } = await loadFixture(deployFixture);
      await token.connect(treasury).transfer(user.address, 10n * UNIT);
      await expect(
        token.connect(user).transfer(treasury.address, 11n * UNIT),
      ).to.be.revertedWithCustomError(token, "ERC20InsufficientBalance");
    });

    it("supports approve and transferFrom", async () => {
      const { token, treasury, user } = await loadFixture(deployFixture);
      await token.connect(treasury).transfer(user.address, 100n * UNIT);
      await expect(token.connect(user).approve(treasury.address, 60n * UNIT))
        .to.emit(token, "Approval")
        .withArgs(user.address, treasury.address, 60n * UNIT);

      await token.connect(treasury).transferFrom(user.address, treasury.address, 60n * UNIT);
      expect(await token.balanceOf(user.address)).to.equal(40n * UNIT);
    });

    it("supports an unlimited allowance", async () => {
      const { token, treasury, user } = await loadFixture(deployFixture);
      await token.connect(treasury).transfer(user.address, 100n * UNIT);
      await token.connect(user).approve(treasury.address, ethers.MaxUint256);
      await token.connect(treasury).transferFrom(user.address, treasury.address, 100n * UNIT);
      expect(await token.allowance(user.address, treasury.address)).to.equal(ethers.MaxUint256);
      expect(await token.balanceOf(user.address)).to.equal(0n);
    });

    it("keeps users unable to create or destroy supply through transfers", async () => {
      const { token, treasury, user } = await loadFixture(deployFixture);
      await token.connect(treasury).transfer(user.address, 10n * UNIT);

      await token.connect(treasury).burnTreasury(2n * UNIT);
      expect(await token.balanceOf(user.address)).to.equal(10n * UNIT);
      expect(await token.totalSupply()).to.equal(INITIAL_ALLOCATION - 2n * UNIT);
    });
  });

  describe("treasury rotation", () => {
    it("lets only the admin rotate the treasury", async () => {
      const { token, admin, user, minter } = await loadFixture(deployFixture);

      await expect(token.connect(user).setTreasury(user.address)).to.be.revertedWithCustomError(
        token,
        "AccessControlUnauthorizedAccount",
      ).withArgs(user.address, await token.DEFAULT_ADMIN_ROLE());
      await expect(token.connect(admin).setTreasury(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        token,
        "ZeroAddress",
      );

      await expect(token.connect(admin).setTreasury(minter.address))
        .to.emit(token, "TreasuryUpdated")
        .withArgs(await token.treasury(), minter.address);

      expect(await token.treasury()).to.equal(minter.address);

      await expect(token.connect(minter).mint(user.address, UNIT)).to.be.revertedWithCustomError(
        token,
        "MintNotToTreasury",
      ).withArgs(user.address);
      await token.connect(minter).mint(minter.address, UNIT);
      expect(await token.balanceOf(minter.address)).to.equal(UNIT);
    });

    it("burns from the rotated treasury", async () => {
      const { token, admin, treasury, minter } = await loadFixture(deployFixture);
      await token.connect(admin).setTreasury(minter.address);
      await token.connect(admin).grantRole(await token.BURNER_ROLE(), minter.address);
      await token.connect(admin).grantRole(await token.MINTER_ROLE(), minter.address);
      await token.connect(minter).mint(minter.address, UNIT);

      await token.connect(minter).burnTreasury(UNIT);
      expect(await token.balanceOf(treasury.address)).to.equal(INITIAL_ALLOCATION);
      expect(await token.balanceOf(minter.address)).to.equal(0n);
    });
  });
});
