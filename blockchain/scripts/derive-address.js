/**
 * Derive the address for each 0x-hex key file passed as an argument.
 * Prints only addresses (public). Used by start-api-sepolia.ps1 to prove the
 * configured key files belong to the recorded minter/treasury addresses.
 *
 *   node scripts/derive-address.js <keyfile> [<keyfile> ...]
 */
const fs = require("fs");
const { Wallet } = require("ethers");

const out = process.argv.slice(2).map((file) => {
  const raw = fs.readFileSync(file, "utf8").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    console.error(`${file}: does not contain a bare 0x-hex private key`);
    process.exit(2);
  }
  return { file, address: new Wallet(raw).address };
});
console.log(JSON.stringify(out));
