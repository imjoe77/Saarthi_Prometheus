/**
 * Generates the RS256 keypair used to sign Prometheus API access tokens.
 *
 *   node scripts/generate-auth-keys.mjs [--write]
 *
 * By default the script refuses to print anything and instead writes the two
 * values into the environment files they belong to. This is not fussiness: a
 * private key printed to a terminal ends up in shell history, scrollback, a
 * screen share, a copied paste and, often enough, a CI log. The whole point of
 * RS256 here is that the private half never leaves the frontend, and printing it
 * is the easiest way to lose that property.
 *
 * `--write` needs confirmation unless `--yes` is also passed, because it edits
 * real configuration.
 *
 * Why RS256 rather than a shared secret: Next.js signs, NestJS verifies. Giving
 * the backend only the public key means a compromised backend can check that a
 * token was legitimately issued but cannot mint one.
 */
import { generateKeyPairSync } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const TARGETS = [
  { file: resolve(ROOT, '.env.local'), key: 'AUTH_API_SIGNING_PRIVATE_KEY', secret: true },
  { file: resolve(ROOT, 'backend/.env'), key: 'AUTH_API_SIGNING_PUBLIC_KEY', secret: false },
];

const args = new Set(process.argv.slice(2));
const write = args.has('--write');
const assumeYes = args.has('--yes');

/** .env parsers reject literal newlines, so the PEMs travel as one-line escapes. */
const toEnvValue = (pem) => pem.replace(/\r?\n/g, '\\n');

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

function upsertEnvVariable(file, key, value) {
  const line = `${key}="${value}"`;
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';

  // Replace an existing assignment in place so the file keeps its ordering and
  // its comments; otherwise append.
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  if (pattern.test(existing)) {
    writeFileSync(file, existing.replace(pattern, line), 'utf8');
    return 'updated';
  }

  const separator = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  appendFileSync(file, `${separator}\n# --- Module 02: RS256 token signing ---\n${line}\n`, 'utf8');
  return 'added';
}

if (!write) {
  console.log('Module 02 keypair generated. Nothing printed, nothing written.');
  console.log('');
  console.log('Re-run with --write to place the values into the environment files:');
  console.log('  node scripts/generate-auth-keys.mjs --write --yes');
  console.log('');
  console.log('It will set:');
  for (const target of TARGETS) {
    console.log(`  ${target.key} -> ${target.file.replace(ROOT, '.')}`);
  }
  console.log('');
  console.log('Rotate for real by deleting both variables first, then re-running.');
  process.exit(0);
}

if (!assumeYes) {
  console.log('This will overwrite the signing key in both environment files.');
  console.log('Anyone holding the current private key loses access, and the backend');
  console.log('must receive the new public key or it will reject every token.');
  console.log('');
  console.log('Re-run with --yes to proceed.');
  process.exit(1);
}

for (const target of TARGETS) {
  const pem = target.secret ? privateKey : publicKey;
  const outcome = upsertEnvVariable(target.file, target.key, toEnvValue(pem));
  console.log(`${outcome.padEnd(8)} ${target.key} -> ${target.file.replace(ROOT, '.')}`);
}

console.log('');
console.log('Done. The private key is in .env.local only; confirm both files are gitignored.');