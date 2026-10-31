import { ethers, network } from "hardhat";

/**
 * Send gas money from the deployer to the minter and treasury signers so each
 * role can pay for its own transactions (mint / burn) on Sepolia.
 *
 * Read-only guardrails: refuses any network but sepolia, refuses to send when
 * the target is already above the threshold, and prints transaction hashes so
 * every transfer is auditable.
 *
 *   npm run fund:sepolia
 */

const GRANT = BigInt(ethers.parseEther(process.env.FUND_SIGNERS_AMOUNT_ETH ?? "0.02"));
const THRESHOLD = BigInt(ethers.parseEther(process.env.FUND_SIGNERS_THRESHOLD_ETH ?? "0.005"));

async function main(): Promise<void> {
  if (network.name !== "sepolia") {
    throw new Error(`Refusing to run on network '${network.name}' - this script is Sepolia-only.`);
  }
  const minterAddress = process.env.MINTER_ADDRESS?.trim();
  const treasuryAddress = process.env.TREASURY_ADDRESS?.trim();
  if (!minterAddress || !treasuryAddress) {
    throw new Error("MINTER_ADDRESS and TREASURY_ADDRESS are required (see blockchain/.env).");
  }

  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No deployer account configured (SEPOLIA_DEPLOYER_KEY_FILE).");

  const targets: Array<{ label: string; address: string }> = [
    { label: "minter", address: minterAddress },
    { label: "treasury", address: treasuryAddress },
  ];

  const deployerBalance = await ethers.provider.getBalance(deployer.address);
  console.log(`Deployer ${deployer.address} balance: ${ethers.formatEther(deployerBalance)} ETH`);

  for (const target of targets) {
    const balance = await ethers.provider.getBalance(target.address);
    console.log(`${target.label} ${target.address} balance: ${ethers.formatEther(balance)} ETH`);
    if (balance >= THRESHOLD) {
      console.log(`  -> already above threshold (${ethers.formatEther(THRESHOLD)} ETH), skipping`);
      continue;
    }
    if (deployerBalance < GRANT) {
      throw new Error(
        `Deployer balance ${ethers.formatEther(deployerBalance)} ETH is below one grant of ${ethers.formatEther(GRANT)} ETH. Fund the deployer first.`,
      );
    }
    const tx = await deployer.sendTransaction({ to: target.address, value: GRANT });
    console.log(`  -> sent ${ethers.formatEther(GRANT)} ETH, tx ${tx.hash}`);
    await tx.wait();
    console.log(`  -> confirmed in block ${(await ethers.provider.getTransactionReceipt(tx.hash))?.blockNumber}`);
  }
  console.log("Done.");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
