import { generateKeyPairSync } from 'node:crypto';

/**
 * Ephemeral RS256 keypair for the test suites.
 *
 * Generated fresh per test file rather than checked in, for two reasons: a
 * committed test key is a key that eventually escapes the repository, and a
 * per-file key means a test that signs its own tokens cannot accidentally pass
 * against a key the verifier happens to share with the signer.
 *
 * Both halves are written into the environment so the real application - booted
 * through the real Joi validation - sees a valid configuration. No test bypasses
 * production code paths to inject a verifier.
 *
 * A developer-supplied pair from `.env` wins, so a token signed by the actual
 * frontend keypair can be exercised locally. Only a *complete* pair is reused:
 * half of a pair is worse than none, because a public key without its private
 * half cannot sign, and the tests would silently fall back to the generated pair
 * while the application verified against the external one.
 */
const generated = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const externalPublic = process.env['AUTH_API_SIGNING_PUBLIC_KEY'];
const externalPrivate = process.env['AUTH_API_SIGNING_PRIVATE_KEY'];
export const USING_EXTERNAL_KEY: boolean = Boolean(externalPublic && externalPrivate);

export const TEST_PUBLIC_KEY: string = USING_EXTERNAL_KEY
  ? (externalPublic as string)
  : generated.publicKey;

export const TEST_PRIVATE_KEY: string = USING_EXTERNAL_KEY
  ? (externalPrivate as string)
  : generated.privateKey;

process.env['AUTH_API_SIGNING_PUBLIC_KEY'] = TEST_PUBLIC_KEY;
process.env['AUTH_API_SIGNING_PRIVATE_KEY'] = TEST_PRIVATE_KEY;
process.env['AUTH_API_ISSUER'] ??= 'prometheus-web';
process.env['AUTH_API_AUDIENCE'] ??= 'prometheus-api';

/** A second, unrelated key: any token signed with it must be refused. */
export const UNTRUSTED_KEYPAIR = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});