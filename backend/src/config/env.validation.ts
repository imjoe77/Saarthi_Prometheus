import { createPublicKey } from 'node:crypto';

import * as Joi from 'joi';

/**
 * Confirms the value is a parseable RSA public key.
 *
 * A `.required()` check alone is not enough: a truncated PEM or an accidentally
 * pasted private key would boot successfully and then reject every real token
 * with a 401 that looks like a client bug. Failing at startup instead surfaces
 * the real cause.
 *
 * Runs here, at config load, because that is the only point where the raw
 * environment is still available.
 */
const rsaPublicKey = () =>
  Joi.string().custom((value: unknown, helpers: Joi.CustomHelpers) => {
    if (typeof value !== 'string' || value.trim() === '') {
      return helpers.error('any.invalid');
    }

    try {
      // A PEM in a .env file arrives with literal `\n` escapes, so the encoded
      // and decoded forms must both be accepted here. `resolvePem` performs the
      // unescaping later; this is only the boot-time sanity check.
      const pem = value.replace(/\\n/g, '\n');
      const label = /^-----BEGIN ([A-Z0-9 ]+)-----/.exec(pem.trim())?.[1];

      if (!label || !label.includes('PUBLIC KEY')) {
        // `createPublicKey` happily accepts a PKCS#8 private key and derives the
        // public half from it, so a copy-pasted private key would pass. The
        // backend must never hold one; reject on the PEM label.
        return helpers.error('any.invalid');
      }

      const key = createPublicKey(pem);
      return key.asymmetricKeyType === 'rsa' ? value : helpers.error('any.invalid');
    } catch {
      return helpers.error('any.invalid');
    }
  }, 'RSA public key');

/**
 * Authoritative environment contract for the Prometheus backend.
 *
 * Everything the process needs to boot is declared here. A variable read
 * anywhere in the codebase but absent from this schema is a defect: it would
 * be unvalidated and untyped.
 */
export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production', 'staging')
    .default('development')
    .description('Runtime environment.'),

  PORT: Joi.number().port().default(3001).description('HTTP port to bind.'),

  HOST: Joi.string().hostname().default('0.0.0.0').description('Interface to bind.'),

  API_PREFIX: Joi.string()
    .allow('')
    .pattern(/^[a-z0-9-]*(\/[a-z0-9-]+)*$/i)
    .default('api')
    .description('Global route prefix. Empty string disables the prefix.'),

  CORS_ORIGINS: Joi.string()
    .default('http://localhost:3000')
    .description(
      'Comma-separated exact browser origins permitted to call the API. Wildcards are not supported by design.',
    ),

  LOG_LEVEL: Joi.string()
    .valid('error', 'warn', 'log', 'debug', 'verbose', 'silent')
    .default('log')
    .description('Minimum severity emitted by the Nest logger. "silent" disables logging.'),

  SWAGGER_ENABLED: Joi.boolean().default(true).description('Serve OpenAPI docs.'),

  DATABASE_URL: Joi.string()
    .uri({ scheme: [/postgres(ql)?/] })
    .required()
    .description('PostgreSQL connection string used by Prisma.'),

  DATABASE_POOL_MAX: Joi.number().integer().min(1).max(100).default(10),

  DATABASE_CONNECT_TIMEOUT_MS: Joi.number().integer().min(500).max(120000).default(10000),

  DATABASE_FAIL_FAST: Joi.boolean()
    .default(false)
    .description(
      'true: refuse to start when the database is unreachable (strict deploys). ' +
        'false (default): start anyway and let /health report the database as down, ' +
        'so liveness stays independent of a dependency the process can still serve.',
    ),

  // -------------------------------------------------------------------------
  // Authentication (Module 02)
  //
  // The backend verifies tokens and nothing more. It holds no OAuth client
  // credentials and no private signing key: Next.js signs, this service checks.
  // Only the PUBLIC key is declared here, which is what keeps the two roles
  // separable.
  // -------------------------------------------------------------------------

  AUTH_API_SIGNING_PUBLIC_KEY: rsaPublicKey()
    .required()
    .description(
      'RS256 public key (SPKI PEM) that verifies access tokens minted by the Next.js server.',
    ),

  AUTH_API_ISSUER: Joi.string()
    .default('prometheus-web')
    .description('Required value of the access token `iss` claim.'),

  AUTH_API_AUDIENCE: Joi.string()
    .default('prometheus-api')
    .description('Required value of the access token `aud` claim.'),

  AUTH_API_TOKEN_TTL_SECONDS: Joi.number()
    .integer()
    .min(60)
    .max(86400)
    .default(900)
    .description(
      'Access token lifetime. Informational here: expiry is enforced by the ' +
        '`exp` claim the signer sets, not by this service.',
    ),

  // -------------------------------------------------------------------------
  // RBAC email allowlists (Module 13)
  //
  // Who may sign in as an Expert Trader or Liquidity Provider. Each variable
  // is a comma-separated list of email addresses read by the backend at
  // request time; a matching address has the role granted on first use, and
  // any other address is refused when it asks for that role. EMPTY (the
  // default) means nobody may self-authorize the role - normal-user sign-in
  // is unaffected, and the admin queue / operator CLI remain available.
  // -------------------------------------------------------------------------

  EXPERT_TRADER_EMAILS: Joi.string()
    .allow('')
    .default('')
    .description('Comma-separated emails that may self-authorize EXPERT_TRADER. Empty disables self-authorization.'),

  LIQUIDITY_PROVIDER_EMAILS: Joi.string()
    .allow('')
    .default('')
    .description('Comma-separated emails that may self-authorize LIQUIDITY_PROVIDER. Empty disables self-authorization.'),

  // -------------------------------------------------------------------------
  // Live market data and paper trading (Module 06c)
  //
  // Module 06c shows real market prices but executes nothing real. `off` (the
  // default) disables the live feed entirely so the backend and every test
  // suite boot without credentials; `fake` is the deterministic provider the
  // integration tests configure; `alpaca` is the real provider, for manual
  // verification only. Alpaca credentials are optional and server-side.
  // -------------------------------------------------------------------------

  MARKET_DATA_PROVIDER: Joi.string()
    .valid('off', 'fake', 'alpaca')
    .default('off')
    .description('Source of live quotes and bars. "off" disables the feed.'),

  ALPACA_API_KEY_ID: Joi.string()
    .allow('')
    .default('')
    .description('Alpaca API key id for the market-data endpoints. Optional; tests never need it.'),

  ALPACA_API_SECRET_KEY: Joi.string()
    .allow('')
    .default('')
    .description('Alpaca API secret for the market-data endpoints. Optional; tests never need it.'),

  // -------------------------------------------------------------------------
  // Copy trading (Module 07)
  //
  // The engine is always available through its routes; these two only control
  // the background poll that consumes fills without a caller. The poll is off
  // under NODE_ENV=test (see `createAppConfig`) so an integration suite never
  // races a timer for the balances it is about to assert on.
  // -------------------------------------------------------------------------

  COPY_WORKER_ENABLED: Joi.boolean()
    .description(
      'Run the background copy worker. Defaults to true, except under NODE_ENV=test where it defaults to false.',
    ),

  COPY_WORKER_INTERVAL_MS: Joi.number()
    .integer()
    .min(250)
    .max(600000)
    .default(15000)
    .description('Milliseconds between copy worker passes.'),

  // -------------------------------------------------------------------------
  // Live USDT/INR pricing (Module 08 extension)
  //
  // The USDT exchange prices orders from real market data: CoinDCX's
  // USDT/INR order book for the execution price and CoinGecko's venue
  // tickers/aggregate for the savings reference. Credentials are optional and
  // server-side (the CoinGecko endpoints work anonymously at a lower rate
  // limit); they are never exported to the browser and never logged.
  //
  // `USDT_PRICING_PROVIDER` mirrors MARKET_DATA_PROVIDER's philosophy: `fake`
  // is the deterministic provider the automated suites run on (the default
  // under NODE_ENV=test, resolved in createAppConfig), `live` calls the real
  // providers. The configured fallback price is DISPLAY-ONLY and never
  // executes a buy or sell.
  // -------------------------------------------------------------------------

  USDT_PRICING_PROVIDER: Joi.string()
    .valid('live', 'fake')
    .optional()
    .description(
      'Source of USDT/INR pricing. Defaults to "fake" under NODE_ENV=test, otherwise "live".',
    ),

  COIN_GECKO_API: Joi.string()
    .allow('')
    .default('')
    .description(
      'CoinGecko demo API key (sent as x-cg-demo-api-key). Optional; the public endpoints work without it at a lower rate limit. Server-side only.',
    ),

  COINGECKO_BASE_URL: Joi.string()
    .uri({ scheme: ['https'] })
    .default('https://api.coingecko.com/api/v3')
    .description('CoinGecko API base URL. Override only for tests or a proxy.'),

  COINDCX_TICKER_URL: Joi.string()
    .uri({ scheme: ['https'] })
    .default('https://api.coindcx.com/exchange/ticker')
    .description('CoinDCX public ticker endpoint.'),

  COINDCX_ORDERBOOK_URL: Joi.string()
    .uri({ scheme: ['https'] })
    .default('https://public.coindcx.com/market_data/orderbook')
    .description('CoinDCX public order-book endpoint (query: pair=I-USDT_INR).'),

  USDT_FALLBACK_PRICE_INR: Joi.number()
    .positive()
    .precision(8)
    .optional()
    .description(
      'Configurable indicative USDT/INR price shown when live pricing is unavailable. DISPLAY ONLY - orders are never executed at this price. Requires periodic review against the real market.',
    ),

  USDT_PRICE_MAX_AGE_MS: Joi.number()
    .integer()
    .min(1000)
    .max(300000)
    .default(30000)
    .description('Maximum age of the CoinDCX execution price for it to count as live.'),

  USDT_REFERENCE_MAX_AGE_MS: Joi.number()
    .integer()
    .min(1000)
    .max(3600000)
    .default(900000)
    .description(
      'Maximum age of CoinGecko reference data (venue tickers / aggregate). Wider than the execution window because CoinGecko refreshes venue data on a minutes cadence - a verified provider behaviour, not a relaxation of execution freshness.',
    ),

  USDT_FETCH_TIMEOUT_MS: Joi.number()
    .integer()
    .min(100)
    .max(30000)
    .default(3000)
    .description('Timeout for each provider HTTP call.'),

  USDT_PRICE_CACHE_TTL_MS: Joi.number()
    .integer()
    .min(0)
    .max(60000)
    .default(5000)
    .description('In-memory TTL for a fetched market snapshot (protects provider rate limits).'),

  USDT_PRICE_SANITY_MAX_DEV_PCT: Joi.number()
    .min(1)
    .max(100)
    .default(20)
    .description(
      'Maximum allowed deviation (%) between the execution price and the sanity anchor (CoinGecko aggregate, else the configured fallback) before the data is rejected.',
    ),

  USDT_FAKE_PRICING_SCENARIO: Joi.string()
    .valid('live', 'stale', 'down', 'no-reference')
    .default('live')
    .description(
      'Test-only behaviour of the fake USDT pricing provider: live data, stale timestamps, provider outage, or missing reference data.',
    ),

  // -------------------------------------------------------------------------
  // Liquidity & order processing (Module 09)
  //
  // Simulated LPs pledge USDT liquidity, gated by an EMBER lock whose size
  // comes from configured slabs (approved 2026-10-18; see .env.example). When
  // `LIQUIDITY_EMBER_SLABS` is left empty - the deliberate off-switch - every
  // commitment mutation refuses to run (the endpoints answer 503 with
  // `liquidity_ember_slabs_not_configured`) and no EMBER can be locked. The
  // threshold below only powers shortfall detection and never moves money.
  // -------------------------------------------------------------------------

  LIQUIDITY_MIN_AVAILABLE_USDT: Joi.number()
    .min(0)
    .precision(6)
    .default(200000)
    .description(
      'Aggregate available USDT liquidity at or below which the system reports a shortfall and opens a top-up request. Detection only; it never moves funds.',
    ),

  LIQUIDITY_EMBER_SLABS: Joi.string()
    .allow('')
    .default('')
    .description(
      'JSON array of EMBER-locking slabs, e.g. [{"minUsdt":"100000","requiredEmber":"20000"}, ...]. Ascending minUsdt; requiredEmber is a flat lock for the matching slab. EMPTY (the default) disables all commitment endpoints (off-switch). Structure is validated at boot. Approved values ship in .env.example.',
    ),

  // -------------------------------------------------------------------------
  // EMBER tokenomics (Module 11)
  //
  // The burn/buyback allocation split. Defaults are the approved 60/40; the
  // two must sum to exactly 100 (checked in createAppConfig, which refuses to
  // boot otherwise - a split that does not cover the whole reference amount
  // would silently lose value). Percentages are integers: a fraction of a
  // percent has no meaning for an allocation rule.
  // -------------------------------------------------------------------------

  TOKENOMICS_DIRECT_BURN_PCT: Joi.number()
    .integer()
    .min(0)
    .max(100)
    .default(60)
    .description('Share of every reference amount allocated to direct burn. Must sum with the buyback share to 100.'),

  TOKENOMICS_BUYBACK_PCT: Joi.number()
    .integer()
    .min(0)
    .max(100)
    .default(40)
    .description('Share of every reference amount allocated to simulated buyback. Must sum with the direct-burn share to 100.'),

  // -------------------------------------------------------------------------
  // Treasury guardrails (Module 12)
  //
  // The approved demo monthly capacity for the platform treasury, in INR.
  // UNSET (the default) means the approved ₹30 crore demo value applies.
  // The summary converts it to USDT for display at USDT_FALLBACK_PRICE_INR
  // (display-only) and tracks utilization as reporting-only - nothing is
  // blocked. Set it only to replace the demo figure with another INR value.
  // -------------------------------------------------------------------------

  TREASURY_MONTHLY_CAPACITY_INR: Joi.number()
    .positive()
    .optional()
    .allow('')
    .description(
      'Approved demo monthly platform-treasury capacity in INR (default 300000000 = ₹30 crore). Converted to USDT for display at USDT_FALLBACK_PRICE_INR; tracking is reporting-only and blocks nothing.',
    ),

  // -------------------------------------------------------------------------
  // Blockchain layer (EMBER token)
  //
  // Disabled by default: the backend boots and every off-chain flow keeps
  // working with the chain off, and blockchain endpoints answer 503
  // BLOCKCHAIN_DISABLED until the contracts deployed from the blockchain/
  // workspace are wired in here. Private keys never travel to the frontend;
  // the supported key input for testnet is BLOCKCHAIN_SIGNER_KEY_FILE.
  // -------------------------------------------------------------------------

  BLOCKCHAIN_ENABLED: Joi.boolean().default(false).description('Enable the EMBER blockchain layer (contracts deployed and reachable).'),

  BLOCKCHAIN_NETWORK: Joi.string().default('local').description('Display label of the connected network (local / sepolia / ...).'),

  BLOCKCHAIN_CHAIN_ID: Joi.number().integer().min(0).default(31337).description('EVM chain id the backend expects to talk to.'),

  BLOCKCHAIN_RPC_URL: Joi.string().allow('').default('').description('HTTP(S) RPC endpoint of the EVM node.'),

  BLOCKCHAIN_TOKEN_ADDRESS: Joi.string().allow('').default('').description('Deployed EmberToken contract address. Required when BLOCKCHAIN_ENABLED is true.'),

  BLOCKCHAIN_TREASURY_ADDRESS: Joi.string().allow('').default('').description('Treasury EVM address that receives every mint and funds every burn. Required when BLOCKCHAIN_ENABLED is true.'),

  BLOCKCHAIN_EMBER_MAX_SUPPLY: Joi.number().positive().optional().allow('').description('Whole-EMBER lifetime cap recorded at deployment, for display and audit. The contract itself enforces the cap.'),

  BLOCKCHAIN_DEPLOYMENT_BLOCK: Joi.number().integer().min(0).default(0).description('Block at (or before) which the token contract was deployed; event scans start here.'),

  BLOCKCHAIN_CONFIRMATIONS: Joi.number().integer().min(0).max(100).default(1).description('Confirmations a mint/burn transaction must reach before it is treated as confirmed. The local node mines instantly, so 1 is the local default.'),

  BLOCKCHAIN_RECEIPT_TIMEOUT_MS: Joi.number().integer().min(1000).max(600000).default(60000).description('How long an orchestration request waits for a receipt before returning SUBMITTED (the request stays recoverable).'),

  BLOCKCHAIN_SIGNER_KEY_FILE: Joi.string().allow('').default('').description('Path to a server-side key file holding the minter private key (never a frontend value, never committed). Leave empty for local development accounts.'),

  BLOCKCHAIN_TREASURY_SIGNER_KEY_FILE: Joi.string().allow('').default('').description('Path to a server-side key file holding the treasury (burner) private key, used only to submit burnTreasury transactions. Never a frontend value.'),

  EMBER_MINT_MAX_AMOUNT: Joi.number().positive().optional().allow('').description('Owner-pending per-request mint ceiling in whole EMBER; unset disables the check.'),

  EMBER_MINT_MONTHLY_LIMIT: Joi.number().positive().optional().allow('').description('Owner-pending rolling monthly mint ceiling in whole EMBER; unset disables the check.')

  ,
  // -------------------------------------------------------------------------
  // Adaptive burn policy (owner-pending defaults).
  //
  // The baseline 60/40 is preserved. When reserve health (available / floor
  // basis) drops below the upper boundary the direct-burn share ramps down
  // linearly to the minimum by the lower boundary, which must stay strictly
  // above the fixed 30% reserve floor. All four knobs are env-configurable;
  // exact thresholds still need owner confirmation.
  // -------------------------------------------------------------------------

  TOKENOMICS_ADAPTIVE_SPLIT: Joi.boolean().default(true).description('Enable the adaptive 60/x direct-burn ramp driven by treasury reserve health. False pins the configured baseline split.'),

  TOKENOMICS_ADAPTIVE_HEALTH_UPPER_PCT: Joi.number().integer().min(1).max(100).default(45).description('Health percentage at or above which the baseline 60/40 applies.'),

  TOKENOMICS_ADAPTIVE_HEALTH_LOWER_PCT: Joi.number().integer().min(1).max(100).default(31).description('Health percentage at or below which the burn share reaches its minimum. Must stay above the 30% reserve floor.'),

  TOKENOMICS_ADAPTIVE_MIN_BURN_PCT: Joi.number().integer().min(0).max(100).default(40).description('Lowest direct-burn share the adaptive policy may dial down to.'),

  // -------------------------------------------------------------------------
  // EMBER Hub distribution
  // -------------------------------------------------------------------------

  EMBER_HUB_BASELINE_PRICE_INR: Joi.number().positive().precision(8).default(2.45).description('Configured baseline distribution price, INR per EMBER. Not a market observation; purchases are priced at exactly this value.'),

  EMBER_HUB_DAILY_EMBER_LIMIT: Joi.number().positive().precision(18).description('Per-user rolling daily purchase ceiling in EMBER. Owner-pending default applies when unset.'),

  EMBER_HUB_MONTHLY_EMBER_LIMIT: Joi.number().positive().precision(18).description('Per-user rolling monthly purchase ceiling in EMBER. Owner-pending default applies when unset.'),

  // -------------------------------------------------------------------------
  // Simulated EMBER staking
  // -------------------------------------------------------------------------

  EMBER_STAKING_APR_PERCENT: Joi.number().positive().precision(8).default(8.4).description('Simulation-only annual percentage rate for staking reward projections. Never minted or credited.'),

  EMBER_STAKING_LOCK_DAYS: Joi.number().integer().min(0).max(3650).default(30).description('Lock period in days for a staking position; unstake before expiry is refused. Owner-pending default.'),

  // -------------------------------------------------------------------------
  // Sentinel: price monitoring and automated voice alerts (Module 14)
  //
  // The voice provider is OFF by default: no credentials, no dialling, and a
  // triggered alert records a call job that fails honestly with the documented
  // reason (VOICE_PROVIDER_DISABLED) rather than pretending. `fake` is the
  // deterministic provider the automated suite and a first dev run use.
  // `twilio` dials real telephony and is only ever selected explicitly, with
  // all three credentials present (validated at boot, in createAppConfig).
  //
  // Credentials are server-side only, never logged, never exported.
  // -------------------------------------------------------------------------

  SENTINEL_VOICE_PROVIDER: Joi.string()
    .valid('off', 'fake', 'twilio')
    .default('off')
    .description('Voice-call source. "off" never dials; "fake" is the deterministic test provider; "twilio" is the real adapter.'),

  TWILIO_ACCOUNT_SID: Joi.string().allow('').default('').description('Twilio account SID. Required only when SENTINEL_VOICE_PROVIDER=twilio. Server-side only.'),

  TWILIO_AUTH_TOKEN: Joi.string().allow('').default('').description('Twilio auth token - verifies BOTH the outbound REST auth and the inbound webhook signature. Required only when SENTINEL_VOICE_PROVIDER=twilio. Server-side only.'),

  TWILIO_FROM_NUMBER: Joi.string().allow('').default('').description('Verified Twilio caller id in E.164 (e.g. +14155550123). Required only when SENTINEL_VOICE_PROVIDER=twilio.'),

  SENTINEL_WORKER_ENABLED: Joi.boolean().description('Run the monitor/caller workers. Defaults to true, except under NODE_ENV=test where it defaults to false.'),

  SENTINEL_WORKER_INTERVAL_MS: Joi.number().integer().min(1000).max(600000).default(20000).description('Milliseconds between Sentinel worker passes.'),

  SENTINEL_MAX_ACTIVE_ALERTS_PER_USER: Joi.number().integer().min(1).default(20).description('Abuse rail: most ACTIVE (non-terminal) alerts one user may hold.'),

  SENTINEL_MAX_CALLS_PER_USER_PER_DAY: Joi.number().integer().min(1).default(5).description('Abuse rail: most new voice calls one user may receive per rolling UTC day.'),

  SENTINEL_MAX_CALLS_PLATFORM_PER_DAY: Joi.number().integer().min(1).default(200).description('Abuse rail: most new voice calls the platform may dial per rolling UTC day.'),

  SENTINEL_CALL_MAX_ATTEMPTS: Joi.number().integer().min(1).max(10).default(3).description('Dial attempts per call job before it is recorded CALL_FAILED.'),

  SENTINEL_CALL_RETRY_MS: Joi.number().integer().min(0).default(60000).description('Delay before the next dial attempt of a retryable failed call.'),

  SENTINEL_VERIFICATION_CODE_TTL_MS: Joi.number().integer().min(60000).default(600000).description('Verification-code lifetime, milliseconds (min 1 minute).'),

  SENTINEL_VERIFICATION_MAX_ATTEMPTS: Joi.number().integer().min(1).default(5).description('Wrong-code guesses allowed before a verification window is closed and a new code is required.'),

  // -------------------------------------------------------------------------
  // Wallet top-ups (Module 03b)
  //
  // `simulated` (the default) credits a deposit without a payment provider, so
  // the platform is usable without any credentials. `razorpay` routes the
  // deposit through Razorpay's Orders API: the credit then happens only after
  // Razorpay confirms the payment, either through the checkout signature or
  // through the `payment.captured` webhook.
  //
  // Either way the credited amount is a real ledger movement, not a displayed
  // figure. Credentials are server-side only, never logged, never exported to
  // the browser - the browser receives the publishable key id and nothing else.
  // -------------------------------------------------------------------------

  PAYMENTS_PROVIDER: Joi.string()
    .valid('simulated', 'razorpay')
    .default('simulated')
    .description(
      'Payment rail for wallet top-ups. "simulated" credits the deposit immediately without a provider; "razorpay" takes the deposit through Razorpay Orders + checkout.',
    ),

  RAZORPAY_KEY_ID: Joi.string()
    .allow('')
    .default('')
    .description(
      'Razorpay publishable key id. Required only when PAYMENTS_PROVIDER=razorpay; it is handed to the browser because Razorpay\'s checkout script needs it. Server-side only.',
    ),

  RAZORPAY_KEY_SECRET: Joi.string()
    .allow('')
    .default('')
    .description(
      'Razorpay API key secret. Signs the checkout signature and authorises the Orders API. Required only when PAYMENTS_PROVIDER=razorpay. Never leaves the backend.',
    ),

  RAZORPAY_WEBHOOK_SECRET: Joi.string()
    .allow('')
    .default('')
    .description(
      'Razorpay webhook secret. Verifies the X-Razorpay-Signature header on inbound payment webhooks. Optional: without it the webhook route refuses every delivery.',
    ),

  PAYMENTS_MAX_DEPOSIT_INR: Joi.number()
    .positive()
    .precision(2)
    .default(500000)
    .description(
      'Largest single top-up accepted, in INR. An abuse rail on one request, not a cap on what a wallet may hold.',
    ),

  PAYMENTS_REQUEST_TIMEOUT_MS: Joi.number()
    .integer()
    .min(1000)
    .max(30000)
    .default(10000)
    .description('Timeout for each outbound payment-provider HTTP call.'),

  // -------------------------------------------------------------------------
  // AI trade-buddy (design-integration task)
  //
  // Optional POST endpoint of a locally trained model that answers the
  // widget's `{ query, elementContext, pageContext, history }` with
  // `{ concept, sections }`. Unset (or empty) means the built-in knowledge
  // base answers alone — a valid production configuration, not a degraded one.
  // -------------------------------------------------------------------------

  AI_MODEL_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .allow('')
    .default('')
    .description('POST endpoint of the local model behind /ai-doubt-solver. Empty = built-in knowledge base only. Server-side only.'),
});

/**
 * A human-readable multi-line summary of every environment problem.
 *
 * Nest's default error for a Joi failure prints `error.details` as a raw JSON
 * blob. A misconfigured environment is one of the most common reasons a
 * service refuses to boot, so the message is deliberately explicit about which
 * variable is wrong and why.
 */
export function formatEnvValidationError(details: Joi.ValidationError['details']): string {
  const lines = details.map((detail) => {
    const field = detail.path.length > 0 ? detail.path.join('.') : '(root)';
    const hint = detail.context?.['hint'] ? ` (${String(detail.context['hint'])})` : '';
    return `  - ${field}: ${detail.message}${hint}`;
  });

  return [
    'Invalid environment configuration. Prometheus cannot start.',
    '',
    ...lines,
    '',
    'Fix the variables above in your .env file, or copy .env.example as a starting point.',
  ].join('\n');
}

/**
 * Validates a raw environment record and returns the coerced result.
 *
 * Throws a descriptive error rather than returning a partial object: booting
 * with a half-valid configuration produces failures later that are far harder
 * to diagnose than a refusal to start.
 *
 * Note on unknown keys: they are tolerated (Joi's default) because the process
 * environment is shared with the shell, the CI runner and the orchestrator, so
 * rejecting everything undeclared would make the service unbootable in
 * practice. Required-key checks still catch the failure mode that actually
 * matters - a misspelled mandatory variable such as DATABASE_URL.
 */
export function validateEnvironment(raw: Record<string, unknown>): Record<string, unknown> {
  // Joi's return type is intentionally loose (`value` is `any`). Narrowing it
  // here means the rest of the application never has to handle `any`.
  const outcome = envValidationSchema.validate(raw, {
    abortEarly: false,
    allowUnknown: true,
    convert: true,
  }) as { value?: Record<string, unknown>; error?: Joi.ValidationError };

  if (outcome.error) {
    throw new Error(formatEnvValidationError(outcome.error.details));
  }

  return outcome.value ?? raw;
}