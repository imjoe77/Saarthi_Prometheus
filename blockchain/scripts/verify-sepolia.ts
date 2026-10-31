import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { artifacts, ethers, network } from "hardhat";

/**
 * Read-only Sepolia verification for the EmberToken deployment.
 *
 * Performs ONLY queries: eth_chainId, eth_getCode, eth_call (state reads,
 * role checks, permission simulations). It never signs, never broadcasts,
 * never writes a file. Safe to run before the deployer is even funded for
 * every check that does not need the deployment record's transaction.
 *
 *   npm run verify:sepolia
 */

const EXPECTED_CHAIN_ID = 11155111;

interface DeploymentRecord {
  network: string;
  chainId: number;
  tokenAddress: string;
  deployer: string;
  admin: string;
  treasuryAddress: string;
  minterAddress: string;
  burnerAddress: string | null;
  maxSupplyWhole: string;
  initialTreasuryAllocationWhole: string;
  txHash: string | null;
  blockNumber: number | null;
}

type Check = { name: string; pass: boolean; detail: string };

const checks: Check[] = [];
function check(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} - ${detail}`);
}

function zeroRange(hexNoPrefix: string, start: number, length: number): string {
  const from = start * 2;
  const to = (start + length) * 2;
  return hexNoPrefix.slice(0, from) + "0".repeat((to - from)) + hexNoPrefix.slice(to);
}

async function main(): Promise<void> {
  const { chainId } = await ethers.provider.getNetwork();
  console.log(`Network '${network.name}', connected chain id ${chainId}`);

  if (network.name !== "sepolia") {
    throw new Error(`Refusing to run: this script verifies the Sepolia deployment (got network '${network.name}').`);
  }
  check("connected chain id", Number(chainId) === EXPECTED_CHAIN_ID, `expected ${EXPECTED_CHAIN_ID}, got ${chainId}`);
  if (Number(chainId) !== EXPECTED_CHAIN_ID) return;

  const recordPath = join(__dirname, "..", "deployments", "sepolia.json");
  if (!existsSync(recordPath)) {
    check("deployment record", false, `missing ${recordPath} - run npm run deploy:sepolia first`);
    return;
  }
  const record = JSON.parse(readFileSync(recordPath, "utf8")) as DeploymentRecord;
  check(
    "deployment record network/chain",
    record.network === "sepolia" && record.chainId === EXPECTED_CHAIN_ID,
    `network=${record.network} chainId=${record.chainId}`,
  );
  check(
    "deployment record tx/block",
    Boolean(record.txHash) && typeof record.blockNumber === "number" && record.blockNumber >= 1,
    `tx=${record.txHash ?? "null"} block=${record.blockNumber ?? "null"}`,
  );

  const token = ethers.getAddress(record.tokenAddress);
  const provider = ethers.provider;

  // --- 1. Bytecode present -----------------------------------------------
  const onChainCode = await provider.getCode(token);
  check("contract bytecode present", onChainCode !== "0x", `${onChainCode === "0x" ? "NO CODE at" : `${((onChainCode.length - 2) / 2)} bytes at`} ${token}`);

  // --- 2. Bytecode equals the compiled artifact (immutables accounted for) ---
  const artifact = await artifacts.readArtifact("EmberToken");
  const buildInfo = await artifacts.getBuildInfo("contracts/EmberToken.sol:EmberToken");
  const immutableReferences =
    buildInfo?.output.contracts["contracts/EmberToken.sol"]?.["EmberToken"].evm.deployedBytecode
      .immutableReferences;
  const expectedNoPrefix = artifact.deployedBytecode.slice(2);
  const actualNoPrefix = onChainCode.slice(2);

  if (onChainCode === "0x") {
    check("bytecode matches compiled artifact", false, "no bytecode to compare");
  } else if (!immutableReferences || Object.keys(immutableReferences).length === 0) {
    check("bytecode matches compiled artifact", false, "build-info immutableReferences missing - run npx hardhat compile --force");
  } else {
    let expected = expectedNoPrefix;
    let actual = actualNoPrefix;
    let immutableValuesOk = true;
    const maxSupplyWei = BigInt(record.maxSupplyWhole) * 10n ** 18n;
    const seen = new Set<string>();
    for (const refs of Object.values(immutableReferences)) {
      for (const ref of refs) {
        const key = `${ref.start}:${ref.length}`;
        if (seen.has(key)) continue;
        seen.add(key);
        // Read the immutable's value out of the deployed code before zeroing.
        const actualValue = BigInt(`0x${actualNoPrefix.slice(ref.start * 2, (ref.start + ref.length) * 2) || "0"}`);
        if (ref.length === 32 && actualValue !== maxSupplyWei) immutableValuesOk = false;
        expected = zeroRange(expected, ref.start, ref.length);
        actual = zeroRange(actual, ref.start, ref.length);
      }
    }
    check(
      "immutable maxSupply embedded correctly",
      immutableValuesOk,
      `on-chain maxSupply bytes == ${record.maxSupplyWhole} EMBER`,
    );
    check(
      "runtime bytecode == compiled artifact",
      expected.length === actual.length && expected === actual,
      expected === actual
        ? "identical after normalizing immutables"
        : `mismatch (expected ${expected.length / 2} bytes, actual ${actual.length / 2} bytes)`,
    );
  }

  // --- 3. State reads ------------------------------------------------------
  const artifactAbi = artifact.abi;
  const ember = new ethers.Contract(token, artifactAbi, provider);
  const [name, symbol, decimals, maxSupply, treasuryOnChain, totalSupply, treasuryBalance] = await Promise.all([
    ember.name(),
    ember.symbol(),
    ember.decimals(),
    ember.maxSupply(),
    ember.treasury(),
    ember.totalSupply(),
    ember.balanceOf(record.treasuryAddress),
  ]);
  check("ERC-20 metadata", name === "Ember" && symbol === "EMBER" && Number(decimals) === 18, `${name}/${symbol}/${decimals}`);
  check(
    "maxSupply matches record",
    maxSupply === BigInt(record.maxSupplyWhole) * 10n ** 18n,
    `${ethers.formatEther(maxSupply)} EMBER`,
  );
  check(
    "treasury matches record",
    ethers.getAddress(treasuryOnChain) === ethers.getAddress(record.treasuryAddress),
    treasuryOnChain,
  );
  check(
    "cap invariant: totalSupply <= maxSupply",
    totalSupply <= maxSupply,
    `supply ${ethers.formatEther(totalSupply)} / cap ${ethers.formatEther(maxSupply)}`,
  );
  check(
    "invariant: all supply held by treasury",
    treasuryBalance === totalSupply,
    `treasury ${ethers.formatEther(treasuryBalance)} == supply ${ethers.formatEther(totalSupply)}`,
  );

  // --- 4. Permissions (eth_call reads) -------------------------------------
  const DEFAULT_ADMIN = ethers.ZeroHash;
  const MINTER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("MINTER_ROLE"));
  const BURNER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("BURNER_ROLE"));
  const stranger = "0x000000000000000000000000000000000000dEaD";

  const [adminIsAdmin, minterRole, burnerRole, treasuryIsMinter, deployerIsMinter, deployerIsBurner, strangerMinter, strangerBurner] =
    await Promise.all([
      ember.hasRole(DEFAULT_ADMIN, record.admin),
      ember.hasRole(MINTER_ROLE, record.minterAddress),
      ember.hasRole(BURNER_ROLE, record.burnerAddress ?? record.treasuryAddress),
      ember.hasRole(MINTER_ROLE, record.treasuryAddress),
      ember.hasRole(MINTER_ROLE, record.deployer),
      ember.hasRole(BURNER_ROLE, record.deployer),
      ember.hasRole(MINTER_ROLE, stranger),
      ember.hasRole(BURNER_ROLE, stranger),
    ]);
  check("DEFAULT_ADMIN_ROLE held by record admin", adminIsAdmin === true, record.admin);
  check("MINTER_ROLE held by record minter", minterRole === true, record.minterAddress);
  check("BURNER_ROLE held by record burner", burnerRole === true, record.burnerAddress ?? record.treasuryAddress);
  check(
    "role separation",
    treasuryIsMinter === false && deployerIsMinter === false && deployerIsBurner === false && strangerMinter === false && strangerBurner === false,
    "treasury/deployer/stranger hold no mint or burn role they should not",
  );

  // --- 5. Permission simulations (eth_call, nothing broadcast) -------------
  const smallAmount = ethers.parseEther("1");
  const iface = new ethers.Interface(artifactAbi);
  const calldataMint = iface.encodeFunctionData("mint", [record.treasuryAddress, smallAmount]);
  const calldataBurn = iface.encodeFunctionData("burnTreasury", [smallAmount]);
  const calldataOverCap = iface.encodeFunctionData("mint", [
    record.treasuryAddress,
    BigInt(record.maxSupplyWhole) * 10n ** 18n + 1n,
  ]);

  async function callReverts(data: string, from: string): Promise<boolean> {
    try {
      await provider.call({ to: token, data, from });
      return false;
    } catch {
      return true;
    }
  }
  async function callSucceeds(data: string, from: string): Promise<boolean> {
    try {
      await provider.call({ to: token, data, from });
      return true;
    } catch {
      return false;
    }
  }

  const [mintByStranger, mintByTreasury, burnByStranger, burnByMinter, mintByMinterOk, burnByTreasuryOk, overCapReverts] =
    await Promise.all([
      callReverts(calldataMint, stranger),
      callReverts(calldataMint, record.treasuryAddress),
      callReverts(calldataBurn, stranger),
      callReverts(calldataBurn, record.minterAddress),
      callSucceeds(calldataMint, record.minterAddress),
      callSucceeds(calldataBurn, record.burnerAddress ?? record.treasuryAddress),
      callReverts(calldataOverCap, record.minterAddress),
    ]);
  check("mint simulated from stranger reverts", mintByStranger, "unauthorized caller refused");
  check("mint simulated from treasury (non-minter) reverts", mintByTreasury, "role gate refused");
  check("burn simulated from stranger reverts", burnByStranger, "unauthorized caller refused");
  check("burn simulated from minter (non-burner) reverts", burnByMinter, "role gate refused");
  check("mint simulation from minter succeeds", mintByMinterOk === true, "minter capability works");
  check("burn simulation from burner succeeds", burnByTreasuryOk === true, "burner capability works");
  check("cap guard simulation reverts", overCapReverts, "mint past maxSupply refused");

  // --- Report ---------------------------------------------------------------
  console.log("\nExplorer links:");
  console.log(`  contract: https://sepolia.etherscan.io/address/${token}`);
  if (record.txHash) console.log(`  deploy tx: https://sepolia.etherscan.io/tx/${record.txHash}`);

  const failed = checks.filter((entry) => !entry.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
  if (failed.length > 0) {
    process.exitCode = 1;
    for (const entry of failed) console.log(`  FAILED: ${entry.name} - ${entry.detail}`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
