import { readFileSync } from "node:fs";
import { join } from "node:path";

import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";

// Load blockchain/.env when present (git-ignored). Never required: every
// value can also arrive as a process environment variable.
try {
  process.loadEnvFile?.(join(__dirname, ".env"));
} catch {
  // No .env - fine.
}

const sepoliaRpcUrl = process.env.SEPOLIA_RPC_URL ?? "";

/**
 * The deployer key is read from a key FILE outside the repository
 * (SEPOLIA_DEPLOYER_KEY_FILE) or, less preferably, from the process
 * environment. A malformed key fails loudly here rather than half-way
 * through a deployment.
 */
function resolveDeployerKey(): string {
  const inline = process.env.SEPOLIA_DEPLOYER_PRIVATE_KEY?.trim();
  if (inline) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(inline)) {
      throw new Error("SEPOLIA_DEPLOYER_PRIVATE_KEY must be 0x followed by 64 hex characters.");
    }
    return inline;
  }
  const keyFile = process.env.SEPOLIA_DEPLOYER_KEY_FILE?.trim();
  if (!keyFile) return "";
  const raw = readFileSync(keyFile, "utf8").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(`The key file '${keyFile}' must contain a single 0x-prefixed 64-hex-char private key.`);
  }
  return raw;
}

const sepoliaDeployerKey = resolveDeployerKey();

const config: HardhatUserConfig = {
  solidity: "0.8.28",
  networks: {
    hardhat: {},
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
    },
    sepolia: {
      url: sepoliaRpcUrl,
      chainId: 11155111,
      accounts: sepoliaDeployerKey ? [sepoliaDeployerKey] : [],
    },
    // Deliberately no mainnet entry: this configuration cannot deploy to
    // Ethereum mainnet, only to the in-process/localhost chains or Sepolia.
  },
};

export default config;
