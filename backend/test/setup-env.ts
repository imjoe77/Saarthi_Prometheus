/**
 * Test environment defaults.
 *
 * Loaded before every Jest test file (see `setupFilesAfterEnv` in
 * jest.config.js). Sets the minimum viable environment so unit and integration
 * tests boot without a local `.env`, while still exercising the real
 * validation path in `src/config/env.validation.ts`.
 *
 * DATABASE_URL must stay a syntactically valid PostgreSQL URL: it is required
 * by the schema, and tests should exercise that requirement rather than bypass
 * it. It points at a port that is intentionally not expected to answer unless
 * the developer is running the docker-compose database - which is why the
 * database-specific assertions live in their own test file.
 */
import { generateKeyPairSync } from 'node:crypto';

process.env['NODE_ENV'] = 'test';
process.env['PORT'] = '3001';
process.env['HOST'] = '127.0.0.1';
process.env['API_PREFIX'] = 'api';
process.env['LOG_LEVEL'] = 'silent';
process.env['SWAGGER_ENABLED'] = 'false';
process.env['CORS_ORIGINS'] = 'http://localhost:3000';
process.env['DATABASE_URL'] =
  process.env['DATABASE_URL'] ??
  'postgresql://prometheus:prometheus_dev_password@localhost:5432/prometheus?schema=public';
process.env['DATABASE_CONNECT_TIMEOUT_MS'] = '2000';
process.env['DATABASE_FAIL_FAST'] = 'false';

// Module 02 requires a token signing public key to boot. Generating an ephemeral
// pair here means auth tests exercise the real Joi validation and the real
// verifier rather than a stubbed one, and no test key is ever committed.
// `test/auth-test-keys.ts` reads these back for the suites that must sign.
if (!process.env['AUTH_API_SIGNING_PUBLIC_KEY']) {
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  process.env['AUTH_API_SIGNING_PUBLIC_KEY'] = pair.publicKey;
  process.env['AUTH_API_SIGNING_PRIVATE_KEY'] = pair.privateKey;
}

process.env['AUTH_API_ISSUER'] ??= 'prometheus-web';
process.env['AUTH_API_AUDIENCE'] ??= 'prometheus-api';

// Module 13 RBAC test fixture: strategy-creation endpoints now require
// EXPERT_TRADER (or PLATFORM_ADMIN). Frozen pre-RBAC suites call
// POST /api/strategies without managing roles, so every authenticated test
// caller receives EXPERT_TRADER in resolveIdentity while NODE_ENV==='test'.
// Production is hard-gated on NODE_ENV==='test' in auth.service.ts, so this
// env var alone can never grant a role outside tests. Suites that assert
// 403-forbidden for non-experts must revoke the role first (see rbac.e2e).
process.env['RBAC_TEST_DEFAULT_ROLES'] ??= 'EXPERT_TRADER';

// Module 03b: the payments rail under test. The simulated rail credits the
// wallet immediately without an external provider, so the suite proves the
// credit and the ledger without reaching the internet. The Razorpay rail is
// selected by flipping this and supplying keys - never by a stub.
process.env['PAYMENTS_PROVIDER'] ??= 'simulated';

jest.setTimeout(15_000);

// Suites that exercise failure paths assert on behaviour, not log output. Each
// such suite silences its own logger with a spy; doing it globally here would
// also hide genuinely useful output from the e2e suite, which boots the real
// application and applies LOG_LEVEL through its own bootstrap path.
export {};