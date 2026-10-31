import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ethers, network } from "hardhat";

const UNIT = 10n ** 18n;

interface NetworkDefaults {
  maxSupplyWhole: string;
  initialTreasuryAllocationWhole: string;
  treasuryIndex: number | null;
  minterIndex: number | null;
}

const NETWORK_DEFAULTS: Record<string, NetworkDefaults | null> = {
  hardhat: defaultLocalDefaults(),
  localhost: defaultLocalDefaults(),
  sepolia: null,
};

function defaultLocalDefaults(): NetworkDefaults {
  return {
    maxSupplyWhole: "100000000",
    initialTreasuryAllocationWhole: "10000000",
    treasuryIndex: 1,
    minterIndex: 2,
  };
}

function wholeToWei(whole: string): bigint {
  return BigInt(whole) * UNIT;
}

async function main() {
  const { chainId } = await ethers.provider.getNetwork();
  const isTestnet = network.name === "sepolia";
  const defaults = NETWORK_DEFAULTS[network.name] ?? defaultLocalDefaults();

  const treasuryConfigured = process.env.TREASURY_ADDRESS?.trim();
  const minterConfigured = process.env.MINTER_ADDRESS?.trim();
  const maxSupplyConfigured = process.env.MAX_SUPPLY_EMBER?.trim();
  const initialConfigured = process.env.INITIAL_TREASURY_ALLOCATION_EMBER?.trim();

  if (isTestnet) {
    for (const [name, value] of [
      ["TREASURY_ADDRESS", treasuryConfigured],
      ["MINTER_ADDRESS", minterConfigured],
      ["MAX_SUPPLY_EMBER", maxSupplyConfigured],
      ["INITIAL_TREASURY_ALLOCATION_EMBER", initialConfigured],
    ] as const) {
      if (!value) throw new Error(`${name} is required to deploy to ${network.name}.`);
    }
  }

  const maxSupplyWhole = maxSupplyConfigured ?? defaults.maxSupplyWhole;
  const initialWhole = initialConfigured ?? defaults.initialTreasuryAllocationWhole;
  const maxSupplyWei = wholeToWei(maxSupplyWhole);
  const initialWei = wholeToWei(initialWhole);

  if (initialWei > maxSupplyWei) {
    throw new Error(
      `INITIAL_TREASURY_ALLOCATION_EMBER (${initialWhole}) exceeds MAX_SUPPLY_EMBER (${maxSupplyWhole}).`,
    );
  }

  const signers = await ethers.getSigners();
  const deployer = signers[0];
  if (!deployer) {
    throw new Error(
      `No deployer account is configured for '${network.name}'. ` +
        `Set SEPOLIA_DEPLOYER_KEY_FILE (key file outside the repository) or SEPOLIA_DEPLOYER_PRIVATE_KEY for sepolia.`,
    );
  }

  const treasuryAddress =
    treasuryConfigured ??
    (defaults.treasuryIndex === null ? undefined : signers[defaults.treasuryIndex]?.address);

  const minterAddress =
    minterConfigured ??
    (defaults.minterIndex === null ? undefined : signers[defaults.minterIndex]?.address);

  if (!treasuryAddress) throw new Error("TREASURY_ADDRESS is required for this network.");
  if (!minterAddress) throw new Error("MINTER_ADDRESS is required for this network.");

  const EmberTokenFactory = await ethers.getContractFactory("EmberToken", deployer);
  const token = await EmberTokenFactory.deploy(
    deployer.address,
    treasuryAddress,
    maxSupplyWei,
    initialWei,
  );
  await token.waitForDeployment();

  await (await token.grantRole(await token.MINTER_ROLE(), minterAddress)).wait(1);
  const burnerAddress = process.env.BURNER_ADDRESS?.trim() ?? treasuryAddress;
  if (burnerAddress) {
    await (await token.grantRole(await token.BURNER_ROLE(), burnerAddress)).wait(1);
  }

  const address = await token.getAddress();
  const deploymentTx = token.deploymentTransaction();
  let blockNumber: number | null = null;
  if (deploymentTx) {
    const receipt = await deploymentTx.wait();
    blockNumber = receipt !== null ? receipt.blockNumber : null;
  }

  const deployment = {
    network: network.name,
    chainId: Number(chainId),
    tokenAddress: address,
    deployer: deployer.address,
    admin: deployer.address,
    treasuryAddress,
    minterAddress,
    burnerAddress: burnerAddress ?? null,
    maxSupplyWhole,
    initialTreasuryAllocationWhole: initialWhole,
    mintedAt: new Date().toISOString(),
    txHash: deploymentTx?.hash ?? null,
    blockNumber,
    backendEnv: {
      BLOCKCHAIN_ENABLED: "true",
      BLOCKCHAIN_NETWORK: network.name,
      BLOCKCHAIN_CHAIN_ID: String(Number(chainId)),
      BLOCKCHAIN_RPC_URL: isTestnet
        ? "<set to your testnet RPC endpoint>"
        : "http://127.0.0.1:8545",
      BLOCKCHAIN_TOKEN_ADDRESS: address,
      BLOCKCHAIN_TREASURY_ADDRESS: treasuryAddress,
      EMBER_MINT_MAX_SUPPLY: maxSupplyWhole,
    },
  };

  const dir = join(__dirname, "..", "deployments");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${network.name}.json`);
  writeFileSync(file, JSON.stringify(deployment, null, 2) + "\n");

  console.log(`EmberToken deployed at ${address} (network ${network.name}, chain ${chainId})`);
  console.log(`Deployment record written to ${file}`);
  console.log("Backend environment lines:");
  for (const [key, value] of Object.entries(deployment.backendEnv)) {
    console.log(`  ${key}=${value}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
