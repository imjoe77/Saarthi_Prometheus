import type { LogLevel } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * Typed, validated view of the process environment.
 *
 * This is the ONLY shape application code should read from. It prevents
 * `process.env.X` string/optional access from leaking into services, which is
 * what makes refactoring configuration safe later.
 */
export class AppConfig {
  readonly nodeEnv: 'development' | 'test' | 'production' | 'staging';
  readonly port: number;
  readonly host: string;
  readonly apiPrefix: string;
  readonly corsOrigins: string[];
  readonly logLevel: AppLogLevel;
  readonly swaggerEnabled: boolean;
  readonly databaseUrl: string;
  readonly databasePoolMax: number;
  readonly databaseConnectTimeoutMs: number;
  readonly databaseFailFast: boolean;
  readonly auth: AuthConfig;
  readonly marketData: MarketDataConfig;
  readonly copyTrading: CopyTradingConfig;
  readonly usdtPricing: UsdtPricingConfig;
  readonly liquidity: LiquidityConfig;
  readonly tokenomics: TokenomicsConfig;
  readonly treasury: TreasuryConfig;
  readonly blockchain: BlockchainConfig;
  readonly emberHub: EmberHubConfig;
  readonly emberStaking: EmberStakingConfig;
  readonly sentinel: SentinelConfig;
  /** How a wallet top-up is paid for (Module 03b). */
  readonly payments: PaymentsConfig;
  /** POST endpoint of a locally trained model for the trade-buddy widget; null = built-in knowledge base only. */
  readonly aiModelUrl: string | null;

  constructor(init: Partial<AppConfig>) {
    this.nodeEnv = init.nodeEnv ?? 'development';
    this.port = init.port ?? 3001;
    this.host = init.host ?? '0.0.0.0';
    this.apiPrefix = init.apiPrefix ?? 'api';
    this.corsOrigins = init.corsOrigins ?? [];
    this.logLevel = init.logLevel ?? 'log';
    this.swaggerEnabled = init.swaggerEnabled ?? true;
    this.databaseUrl = init.databaseUrl ?? '';
    this.databasePoolMax = init.databasePoolMax ?? 10;
    this.databaseConnectTimeoutMs = init.databaseConnectTimeoutMs ?? 10000;
    this.databaseFailFast = init.databaseFailFast ?? false;
    this.auth = init.auth ?? new AuthConfig({});
    this.marketData = init.marketData ?? new MarketDataConfig({});
    this.copyTrading = init.copyTrading ?? new CopyTradingConfig({});
    this.usdtPricing = init.usdtPricing ?? new UsdtPricingConfig({});
    this.liquidity = init.liquidity ?? new LiquidityConfig({});
    this.tokenomics = init.tokenomics ?? new TokenomicsConfig({});
    this.treasury = init.treasury ?? new TreasuryConfig({});
    this.blockchain = init.blockchain ?? new BlockchainConfig({});
    this.emberHub = init.emberHub ?? new EmberHubConfig({});
    this.emberStaking = init.emberStaking ?? new EmberStakingConfig({});
    this.sentinel = init.sentinel ?? new SentinelConfig({});
    this.payments = init.payments ?? new PaymentsConfig({});
    this.aiModelUrl = init.aiModelUrl ?? null;
  }

  get isProduction(): boolean {
    return this.nodeEnv === 'production';
  }

  /** Nest's own `LogLevel`, or undefined when logging is disabled entirely. */
  get nestLogLevel(): LogLevel | undefined {
    return this.logLevel === 'silent' ? undefined : this.logLevel;
  }

  /** Nest accepts '' to disable a global prefix. */
  get normalisedPrefix(): string {
    return this.apiPrefix.trim().replace(/^\/+|\/+$/g, '');
  }
}

function parseOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/**
 * Token verification settings (Module 02).
 *
 * Grouped into their own object rather than flattened onto {@link AppConfig}
 * so that "everything about how we check who the caller is" can be passed to a
 * single constructor and asserted in one place. The private key is
 * intentionally not represented here at all: this process cannot sign.
 */
export class AuthConfig {
  /** SPKI PEM, newline escapes resolved. Used to verify RS256 signatures. */
  readonly publicKey: string;
  readonly issuer: string;
  readonly audience: string;
  readonly tokenTtlSeconds: number;

  constructor(init: Partial<AuthConfig>) {
    this.publicKey = init.publicKey ?? '';
    this.issuer = init.issuer ?? 'prometheus-web';
    this.audience = init.audience ?? 'prometheus-api';
    this.tokenTtlSeconds = init.tokenTtlSeconds ?? 900;
  }
}

/**
 * Live market-data settings (Module 06c).
 *
 * `provider` chooses the source of quotes and bars. The default is `off`, which
 * means the live feed is disabled and the backend boots - and every automated
 * test passes - without any credentials. `fake` is the deterministic provider
 * the integration suites program. `alpaca` is the real public-market-data
 * source, intended for manual verification only; this process never calls any
 * Alpaca trading endpoint.
 *
 * Credentials are optional and server-side. They are never exported to the
 * browser, never logged and never required to boot.
 */
export class MarketDataConfig {
  readonly provider: MarketDataProviderKey;
  readonly alpacaApiKeyId: string;
  readonly alpacaApiSecretKey: string;

  constructor(init: Partial<MarketDataConfig>) {
    this.provider = init.provider ?? 'off';
    this.alpacaApiKeyId = init.alpacaApiKeyId ?? '';
    this.alpacaApiSecretKey = init.alpacaApiSecretKey ?? '';
  }
}

export type MarketDataProviderKey = 'off' | 'fake' | 'alpaca';

/**
 * Live USDT/INR pricing settings (Module 08 extension).
 *
 * `provider` chooses the pricing source: `live` (CoinDCX + CoinGecko) or
 * `fake` (the deterministic provider the automated suites run on). The
 * default resolves to `fake` under NODE_ENV=test and `live` otherwise,
 * mirroring how the copy worker is off under test - a suite that suddenly
 * needed network access would be a suite that fails offline.
 *
 * `fallbackPriceInr` is DISPLAY-ONLY: a quote served from it is labelled
 * `fallback` and carries no savings figure, and buy/sell refuse to execute
 * when live pricing is unavailable rather than settling at this price. It is
 * a configured value, not a market observation, and requires periodic review.
 *
 * The CoinGecko key is optional, server-side, and never logged or exported.
 */
export class UsdtPricingConfig {
  readonly provider: UsdtPricingProviderKey;
  readonly coinGeckoApiKey: string;
  readonly coinGeckoBaseUrl: string;
  readonly coindcxTickerUrl: string;
  readonly coindcxOrderbookUrl: string;
  readonly fallbackPriceInr: string | null;
  readonly maxAgeMs: number;
  readonly referenceMaxAgeMs: number;
  readonly fetchTimeoutMs: number;
  readonly cacheTtlMs: number;
  readonly sanityMaxDevPct: number;
  readonly fakeScenario: UsdtFakePricingScenario;

  constructor(init: Partial<UsdtPricingConfig>) {
    this.provider = init.provider ?? 'live';
    this.coinGeckoApiKey = init.coinGeckoApiKey ?? '';
    this.coinGeckoBaseUrl = init.coinGeckoBaseUrl ?? 'https://api.coingecko.com/api/v3';
    this.coindcxTickerUrl = init.coindcxTickerUrl ?? 'https://api.coindcx.com/exchange/ticker';
    this.coindcxOrderbookUrl =
      init.coindcxOrderbookUrl ?? 'https://public.coindcx.com/market_data/orderbook';
    this.fallbackPriceInr = init.fallbackPriceInr ?? null;
    this.maxAgeMs = init.maxAgeMs ?? 30000;
    this.referenceMaxAgeMs = init.referenceMaxAgeMs ?? 900000;
    this.fetchTimeoutMs = init.fetchTimeoutMs ?? 3000;
    this.cacheTtlMs = init.cacheTtlMs ?? 5000;
    this.sanityMaxDevPct = init.sanityMaxDevPct ?? 20;
    this.fakeScenario = init.fakeScenario ?? 'live';
  }
}

export type UsdtPricingProviderKey = 'live' | 'fake';

export type UsdtFakePricingScenario = 'live' | 'stale' | 'down' | 'no-reference';

/**
 * One configured EMBER-locking slab (Module 09).
 *
 * A commitment at or above `minUsdt` (and below the next slab's threshold)
 * requires a FLAT lock of `requiredEmber`. Both values are canonical Decimal
 * strings so downstream arithmetic never touches floats.
 */
export interface EmberLiquiditySlab {
  readonly minUsdt: string;
  readonly requiredEmber: string;
}

/**
 * Simulated liquidity-provider settings (Module 09).
 *
 * `emberSlabs` is EMPTY until the business approves concrete thresholds, and
 * an empty list disables every commitment mutation: the liquidity service
 * refuses creates, increases and reductions with a configuration error rather
 * than inventing a locking requirement. `minAvailableUsdt` only powers
 * shortfall detection and never moves funds.
 */
export class LiquidityConfig {
  readonly minAvailableUsdt: string;
  readonly emberSlabs: readonly EmberLiquiditySlab[];

  constructor(init: Partial<LiquidityConfig>) {
    this.minAvailableUsdt = init.minAvailableUsdt ?? '200000';
    this.emberSlabs = init.emberSlabs ?? [];
  }
}

/**
 * EMBER burn/buyback allocation split (Module 11).
 *
 * Defaults are the approved 60% direct burn / 40% buyback. The two shares
 * MUST sum to exactly 100: a split that covers less than the whole reference
 * amount would silently lose value, and one that covers more would promise
 * funds that do not exist, so both are the same bug - the constructor refuses
 * to construct. Percentages are integers, because a fraction of a percent has
 * no meaning for an allocation rule.
 */
export class TokenomicsConfig {
  readonly directBurnPct: number;
  readonly buybackPct: number;
  readonly adaptiveSplit: boolean;
  readonly adaptiveUpperHealthPct: number;
  readonly adaptiveLowerHealthPct: number;
  readonly adaptiveMinBurnPct: number;

  constructor(init: Partial<TokenomicsConfig>) {
    this.directBurnPct = init.directBurnPct ?? 60;
    this.buybackPct = init.buybackPct ?? 40;
    this.adaptiveSplit = init.adaptiveSplit ?? true;
    this.adaptiveUpperHealthPct = init.adaptiveUpperHealthPct ?? 45;
    this.adaptiveLowerHealthPct = init.adaptiveLowerHealthPct ?? 31;
    this.adaptiveMinBurnPct = init.adaptiveMinBurnPct ?? 40;

    const valid = (value: number): boolean => Number.isInteger(value) && value >= 0 && value <= 100;
    if (!valid(this.directBurnPct) || !valid(this.buybackPct)) {
      throw new Error(
        'TOKENOMICS_DIRECT_BURN_PCT and TOKENOMICS_BUYBACK_PCT must be integers between 0 and 100.',
      );
    }
    if (this.directBurnPct + this.buybackPct !== 100) {
      throw new Error(
        `TOKENOMICS_DIRECT_BURN_PCT (${this.directBurnPct}) and TOKENOMICS_BUYBACK_PCT (${this.buybackPct}) must sum to 100.`,
      );
    }

    if (!valid(this.adaptiveUpperHealthPct) || this.adaptiveUpperHealthPct < 0) {
      throw new Error('TOKENOMICS_ADAPTIVE_HEALTH_UPPER_PCT must be an integer between 0 and 100.');
    }
    if (!valid(this.adaptiveLowerHealthPct) || this.adaptiveLowerHealthPct < 0) {
      throw new Error('TOKENOMICS_ADAPTIVE_HEALTH_LOWER_PCT must be an integer between 0 and 100.');
    }
    if (!valid(this.adaptiveMinBurnPct) || this.adaptiveMinBurnPct < 0) {
      throw new Error('TOKENOMICS_ADAPTIVE_MIN_BURN_PCT must be an integer between 0 and 100.');
    }
    if (this.adaptiveLowerHealthPct <= 30) {
      throw new Error(
        'TOKENOMICS_ADAPTIVE_HEALTH_LOWER_PCT must stay strictly above the fixed 30% reserve floor expressed as a health percentage.',
      );
    }
    if (this.adaptiveUpperHealthPct <= this.adaptiveLowerHealthPct) {
      throw new Error(
        'TOKENOMICS_ADAPTIVE_HEALTH_UPPER_PCT must be strictly greater than TOKENOMICS_ADAPTIVE_HEALTH_LOWER_PCT.',
      );
    }
    if (this.adaptiveMinBurnPct > this.directBurnPct) {
      throw new Error(
        'TOKENOMICS_ADAPTIVE_MIN_BURN_PCT must not exceed the configured baseline direct-burn percentage; the baseline is the most protective state the policy can dial DOWN from.',
      );
    }
  }
}

/**
 * Treasury guardrail settings (Module 12).
 *
 * `monthlyCapacityInr` is the platform's approved monthly operating capacity
 * for the treasury, in INR. The owner approved an explicitly demo value of
 * ₹30 crore ({@link DEFAULT_MONTHLY_CAPACITY_INR}); the summary converts it
 * to a USDT display ceiling at the configured display-only
 * `USDT_FALLBACK_PRICE_INR` and reports utilization tracking as
 * reporting-only - no treasury USDT spending operation exists that enforces
 * the capacity, so nothing claims spending is blocked. A missing display
 * rate reports an unavailable conversion rather than an invented one.
 *
 * The 30% EMBER reserve floor percentage is deliberately NOT part of this
 * config. It is policy-approved code (treasury-policy.ts) over an
 * owner-approved ledger-derived base; a configurable percentage would put a
 * protected-floor rule in an env file where no operator should be able to
 * silently retune it.
 */
export const DEFAULT_MONTHLY_CAPACITY_INR = '300000000';

export class TreasuryConfig {
  readonly monthlyCapacityInr: string | null;

  constructor(init: Partial<TreasuryConfig>) {
    this.monthlyCapacityInr = init.monthlyCapacityInr ?? DEFAULT_MONTHLY_CAPACITY_INR;
  }
}

/**
 * Blockchain layer settings (EMBER token).
 *
 * `enabled` is FALSE by default: the process boots, every existing off-chain
 * flow still works, and every blockchain endpoint answers 503
 * BLOCKCHAIN_DISABLED until an operator deploys the contracts
 * (`blockchain/`) and explicitly flips this on. Private keys are server-side
 * only: `minterPrivateKeyFile` is the supported way to hand the process a
 * key without putting it in environment variables or shell history, and
 * drift to the hardhat node accounts is deliberately permitted for local
 * development only.
 *
 * `minterMaxAmount` / `minterMonthlyLimit` are owner-pending defaults (none
 * of the source material defines them); null disables that particular check.
 */
export class BlockchainConfig {
  readonly enabled: boolean;
  readonly network: string;
  readonly chainId: number;
  readonly rpcUrl: string;
  readonly tokenAddress: string;
  readonly treasuryAddress: string;
  readonly maxSupplyWhole: string | null;
  readonly deploymentBlock: number;
  readonly confirmations: number;
  readonly receiptTimeoutMs: number;
  readonly minterPrivateKeyFile: string;
  readonly treasurySignerPrivateKeyFile: string;
  readonly minterMaxAmount: string | null;
  readonly minterMonthlyLimit: string | null;

  constructor(init: Partial<BlockchainConfig>) {
    this.enabled = init.enabled ?? false;
    this.network = init.network ?? 'local';
    this.chainId = init.chainId ?? 31337;
    this.rpcUrl = init.rpcUrl ?? '';
    this.tokenAddress = init.tokenAddress ?? '';
    this.treasuryAddress = init.treasuryAddress ?? '';
    this.maxSupplyWhole = init.maxSupplyWhole ?? null;
    this.deploymentBlock = init.deploymentBlock ?? 0;
    this.confirmations = init.confirmations ?? 1;
    this.receiptTimeoutMs = init.receiptTimeoutMs ?? 60000;
    this.minterPrivateKeyFile = init.minterPrivateKeyFile ?? '';
    this.treasurySignerPrivateKeyFile = init.treasurySignerPrivateKeyFile ?? '';
    this.minterMaxAmount = init.minterMaxAmount ?? null;
    this.minterMonthlyLimit = init.minterMonthlyLimit ?? null;

    if (!Number.isInteger(this.chainId) || this.chainId < 0) {
      throw new Error('BLOCKCHAIN_CHAIN_ID must be a non-negative integer.');
    }
    if (!Number.isInteger(this.deploymentBlock) || this.deploymentBlock < 0) {
      throw new Error('BLOCKCHAIN_DEPLOYMENT_BLOCK must be a non-negative integer.');
    }
    if (!Number.isInteger(this.confirmations) || this.confirmations < 0 || this.confirmations > 100) {
      throw new Error('BLOCKCHAIN_CONFIRMATIONS must be an integer between 0 and 100.');
    }
    if (this.enabled && !isValidEvmAddress(this.tokenAddress)) {
      throw new Error('BLOCKCHAIN_TOKEN_ADDRESS must be a valid EVM address when BLOCKCHAIN_ENABLED is true.');
    }
    if (this.enabled && !isValidEvmAddress(this.treasuryAddress)) {
      throw new Error('BLOCKCHAIN_TREASURY_ADDRESS must be a valid EVM address when BLOCKCHAIN_ENABLED is true.');
    }
  }
}

const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

function isValidEvmAddress(value: string): boolean {
  return EVM_ADDRESS_PATTERN.test(value);
}

/**
 * EMBER Hub distribution settings.
 *
 * `baselinePriceInr` is the configured distribution price (INR per EMBER),
 * not a market observation. Purchases are funded with USDT converted at the
 * same central display-only USDT rate the treasury uses - labelled as such
 * in the API. The daily/monthly per-user EMBER limits are owner-pending
 * defaults; null disables that limit.
 */
export const DEFAULT_EMBER_BASELINE_PRICE_INR = '2.45';
export const DEFAULT_EMBER_HUB_DAILY_LIMIT = '10000';
export const DEFAULT_EMBER_HUB_MONTHLY_LIMIT = '100000';

export class EmberHubConfig {
  readonly baselinePriceInr: string;
  readonly dailyEmberLimit: string | null;
  readonly monthlyEmberLimit: string | null;

  constructor(init: Partial<EmberHubConfig>) {
    this.baselinePriceInr = init.baselinePriceInr ?? DEFAULT_EMBER_BASELINE_PRICE_INR;
    this.dailyEmberLimit = init.dailyEmberLimit ?? DEFAULT_EMBER_HUB_DAILY_LIMIT;
    this.monthlyEmberLimit = init.monthlyEmberLimit ?? DEFAULT_EMBER_HUB_MONTHLY_LIMIT;

    try {
      const price = new Prisma.Decimal(this.baselinePriceInr);
      if (!price.isPositive()) {
        throw new Error('EMBER_HUB_BASELINE_PRICE_INR must be greater than zero.');
      }
    } catch {
      throw new Error('EMBER_HUB_BASELINE_PRICE_INR must be a decimal number.');
    }
    for (const limit of [this.dailyEmberLimit, this.monthlyEmberLimit]) {
      if (limit !== null && !(new Prisma.Decimal(limit)).gt(0)) {
        throw new Error('EMBER_HUB_DAILY_EMBER_LIMIT and EMBER_HUB_MONTHLY_EMBER_LIMIT must be greater than zero when set.');
      }
    }
  }
}

/**
 * Simulated EMBER staking settings.
 *
 * These are the OWNER-PENDING economic assumptions behind the simulation
 * only. The APR and lock period stay configurable until approved; the
 * simulated reward stream never mints, never credits a wallet and never
 * changes on-chain supply. The default APR mirrors the value the existing
 * dashboard mock shows (8.4%).
 */
export const DEFAULT_EMBER_STAKING_APR_PERCENT = '8.4';
export const DEFAULT_EMBER_STAKING_LOCK_DAYS = 30;

export class EmberStakingConfig {
  readonly aprPercent: string;
  readonly lockDays: number;

  constructor(init: Partial<EmberStakingConfig>) {
    this.aprPercent = init.aprPercent ?? DEFAULT_EMBER_STAKING_APR_PERCENT;
    this.lockDays = init.lockDays ?? DEFAULT_EMBER_STAKING_LOCK_DAYS;

    try {
      const apr = new Prisma.Decimal(this.aprPercent);
      if (!apr.isPositive()) {
        throw new Error('EMBER_STAKING_APR_PERCENT must be greater than zero.');
      }
    } catch {
      throw new Error('EMBER_STAKING_APR_PERCENT must be a decimal number.');
    }
    if (!Number.isInteger(this.lockDays) || this.lockDays < 0 || this.lockDays > 3650) {
      throw new Error('EMBER_STAKING_LOCK_DAYS must be an integer between 0 and 3650.');
    }
  }
}

/**
 * Copy-trading engine settings (Module 07).
 *
 * The worker consumes committed expert fills for every follow on a timer. It
 * defaults to ON outside tests and to OFF under `NODE_ENV=test`, because a
 * background process that moves balances on its own schedule makes an
 * integration suite's outcome depend on when the suite happened to run. The
 * synchronous `POST /copy/follows/:strategyId/sync` route is what tests drive
 * instead - it runs exactly the same code, once, in the caller's request.
 *
 * The interval is a poll, not an event: `PaperExecutionPort` exposes an
 * ordered read over fills, and a durable cursor means a missed tick costs
 * nothing except the latency of the next one.
 */
export class CopyTradingConfig {
  readonly workerEnabled: boolean;
  readonly workerIntervalMs: number;

  constructor(init: Partial<CopyTradingConfig>) {
    this.workerEnabled = init.workerEnabled ?? true;
    this.workerIntervalMs = init.workerIntervalMs ?? 15000;
  }
}

/**
 * Voice-call provider keys (Module 14). `off` (the default) never dials: a
 * triggered alert's call job is recorded and then fails honestly with a
 * documented reason. `fake` is the deterministic provider the automated suite
 * programs. `twilio` is the real adapter, selected only when the environment
 * explicitly asks for it - selecting `twilio` without credentials is a boot
 * stop, not a first-call surprise.
 */
export type SentinelVoiceProviderKey = 'off' | 'fake' | 'twilio';

/**
 * Sentinel settings (Module 14).
 *
 * The monitor worker is a poll over `sentinel_alerts`, keyed by `(status,
 * expires_at)`; it is off under NODE_ENV=test by the same convention as the
 * copy worker, and the synchronous `POST /sentinel/run-once` route is what
 * the automated suites drive instead.
 *
 * All limits here are ABUSE rails, not business rules: the max active alerts
 * per user, the daily call budget for one user and for the platform, the
 * retry budget per call and its retry delay are defaults an operator may
 * tune; Sentinel refuses a configuration whose retry budget is zero because
 * a call job with no attempts can never complete.
 */
export class SentinelConfig {
  readonly voiceProvider: SentinelVoiceProviderKey;
  readonly twilioAccountSid: string;
  readonly twilioAuthToken: string;
  readonly twilioFromNumber: string;
  readonly workerEnabled: boolean;
  readonly workerIntervalMs: number;
  readonly maxActiveAlertsPerUser: number;
  readonly maxCallsPerUserPerDay: number;
  readonly maxCallsPlatformPerDay: number;
  readonly callMaxAttempts: number;
  readonly callRetryDelayMs: number;
  readonly verificationCodeTtlMs: number;
  readonly verificationMaxAttempts: number;

  constructor(init: Partial<SentinelConfig>) {
    this.voiceProvider = init.voiceProvider ?? 'off';
    this.twilioAccountSid = init.twilioAccountSid ?? '';
    this.twilioAuthToken = init.twilioAuthToken ?? '';
    this.twilioFromNumber = init.twilioFromNumber ?? '';
    this.workerEnabled = init.workerEnabled ?? true;
    this.workerIntervalMs = init.workerIntervalMs ?? 20_000;
    this.maxActiveAlertsPerUser = init.maxActiveAlertsPerUser ?? 20;
    this.maxCallsPerUserPerDay = init.maxCallsPerUserPerDay ?? 5;
    this.maxCallsPlatformPerDay = init.maxCallsPlatformPerDay ?? 200;
    this.callMaxAttempts = init.callMaxAttempts ?? 3;

    if (this.voiceProvider === 'twilio' && (!this.twilioAccountSid || !this.twilioAuthToken || !this.twilioFromNumber)) {
      throw new Error(
        'SENTINEL_VOICE_PROVIDER=twilio requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER.',
      );
    }

    this.callRetryDelayMs = init.callRetryDelayMs ?? 60_000;
    this.verificationCodeTtlMs = init.verificationCodeTtlMs ?? 10 * 60_000;
    this.verificationMaxAttempts = init.verificationMaxAttempts ?? 5;

    if (!Number.isInteger(this.callMaxAttempts) || this.callMaxAttempts < 1 || this.callMaxAttempts > 10) {
      throw new Error('SENTINEL_CALL_MAX_ATTEMPTS must be an integer between 1 and 10.');
    }
    if (!Number.isInteger(this.callRetryDelayMs) || this.callRetryDelayMs < 0) {
      throw new Error('SENTINEL_CALL_RETRY_MS must be a non-negative integer of milliseconds.');
    }
    if (!Number.isInteger(this.maxActiveAlertsPerUser) || this.maxActiveAlertsPerUser < 1) {
      throw new Error('SENTINEL_MAX_ACTIVE_ALERTS_PER_USER must be a positive integer.');
    }
    if (!Number.isInteger(this.maxCallsPerUserPerDay) || this.maxCallsPerUserPerDay < 1) {
      throw new Error('SENTINEL_MAX_CALLS_PER_USER_PER_DAY must be a positive integer.');
    }
    if (!Number.isInteger(this.maxCallsPlatformPerDay) || this.maxCallsPlatformPerDay < 1) {
      throw new Error('SENTINEL_MAX_CALLS_PLATFORM_PER_DAY must be a positive integer.');
    }
    if (!Number.isInteger(this.verificationCodeTtlMs) || this.verificationCodeTtlMs < 60_000) {
      throw new Error('SENTINEL_VERIFICATION_CODE_TTL_MS must be at least 60000 (1 minute).');
    }
    if (!Number.isInteger(this.verificationMaxAttempts) || this.verificationMaxAttempts < 1) {
      throw new Error('SENTINEL_VERIFICATION_MAX_ATTEMPTS must be a positive integer.');
    }
  }
}

/**
 * Which rail a wallet top-up is paid for on (Module 03b).
 *
 * `simulated` - the default - settles the deposit without a payment provider:
 * the amount is credited to the ledger immediately, as if the money had arrived.
 * `razorpay` routes the deposit through Razorpay's Orders API instead, so the
 * money is only credited once Razorpay confirms the payment.
 *
 * The distinction is about the PAYMENT RAIL, not about whether the money is
 * real. Either way the credit is a genuine `transactions` row, so the balance
 * the user then spends is ledger truth and not a display figure.
 */
export type PaymentsProviderKey = 'simulated' | 'razorpay';

/**
 * Payment-rail settings (Module 03b).
 *
 * The Razorpay credentials are optional and server-side. They are required
 * only when `provider` is `razorpay`, and the refusal happens at boot rather
 * than at the first deposit: a deployment that selected Razorpay without keys
 * would otherwise answer every top-up with a provider error at the worst
 * possible moment.
 *
 * `maxDepositInr` is an abuse rail on a single top-up, not a policy about what a
 * user may hold. It exists so a mistyped amount (an extra zero, a pasted
 * salary slip) cannot mint an unbounded balance.
 */
export class PaymentsConfig {
  readonly provider: PaymentsProviderKey;
  readonly razorpayKeyId: string;
  readonly razorpayKeySecret: string;
  readonly razorpayWebhookSecret: string;
  readonly maxDepositInr: string;
  readonly requestTimeoutMs: number;

  constructor(init: Partial<PaymentsConfig>) {
    this.provider = init.provider ?? 'simulated';
    this.razorpayKeyId = init.razorpayKeyId ?? '';
    this.razorpayKeySecret = init.razorpayKeySecret ?? '';
    this.razorpayWebhookSecret = init.razorpayWebhookSecret ?? '';
    this.maxDepositInr = init.maxDepositInr ?? '500000';
    this.requestTimeoutMs = init.requestTimeoutMs ?? 10000;

    if (this.provider === 'razorpay' && (!this.razorpayKeyId || !this.razorpayKeySecret)) {
      throw new Error(
        'PAYMENTS_PROVIDER=razorpay requires RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.',
      );
    }
  }
}

/**
 * Log severities accepted in configuration.
 *
 * `'silent'` is not a Nest `LogLevel` but is supported here because the test
 * suite needs a fully quiet process; the bootstrap converts it by disabling the
 * logger outright rather than filtering every call site.
 */
export const SUPPORTED_LOG_LEVELS = ['error', 'warn', 'log', 'debug', 'verbose', 'silent'] as const;
export type AppLogLevel = (typeof SUPPORTED_LOG_LEVELS)[number];

function parseLogLevel(raw: string | undefined): AppLogLevel {
  return SUPPORTED_LOG_LEVELS.includes(raw as AppLogLevel) ? (raw as AppLogLevel) : 'log';
}

/**
 * Maps a raw (already Joi-validated) environment record onto {@link AppConfig}.
 *
 * Joi has coerced and typed the values by this point, so this function performs
 * structural mapping only. Kept pure so it is directly unit-testable without
 * booting Nest.
 */
export function createAppConfig(raw: Readonly<Record<string, unknown>>): AppConfig {
  return new AppConfig({
    nodeEnv: raw['NODE_ENV'] as AppConfig['nodeEnv'] | undefined,
    port: toInt(raw['PORT'], 3001),
    host: raw['HOST'] as string | undefined,
    apiPrefix: raw['API_PREFIX'] as string | undefined,
    corsOrigins: parseOrigins(raw['CORS_ORIGINS'] as string | undefined),
    logLevel: parseLogLevel(raw['LOG_LEVEL'] as string | undefined),
    swaggerEnabled: parseBoolean(raw['SWAGGER_ENABLED'], true),
    databaseUrl: raw['DATABASE_URL'] as string | undefined,
    databasePoolMax: toInt(raw['DATABASE_POOL_MAX'], 10),
    databaseConnectTimeoutMs: toInt(raw['DATABASE_CONNECT_TIMEOUT_MS'], 10000),
    databaseFailFast: parseBoolean(raw['DATABASE_FAIL_FAST'], false),
    marketData: new MarketDataConfig({
      provider: (raw['MARKET_DATA_PROVIDER'] as MarketDataProviderKey | undefined) ?? 'off',
      alpacaApiKeyId: (raw['ALPACA_API_KEY_ID'] as string | undefined) ?? '',
      alpacaApiSecretKey: (raw['ALPACA_API_SECRET_KEY'] as string | undefined) ?? '',
    }),
    copyTrading: new CopyTradingConfig({
      // Explicit wins; otherwise the worker is off exactly where a background
      // timer would make results non-deterministic.
      workerEnabled: parseBoolean(raw['COPY_WORKER_ENABLED'], (raw['NODE_ENV'] as string) !== 'test'),
      workerIntervalMs: toInt(raw['COPY_WORKER_INTERVAL_MS'], 15000),
    }),
    usdtPricing: new UsdtPricingConfig({
      // Explicit wins; otherwise the fake provider is used under test so the
      // suites never depend on network access to CoinDCX or CoinGecko.
      provider:
        (raw['USDT_PRICING_PROVIDER'] as UsdtPricingProviderKey | undefined) ??
        ((raw['NODE_ENV'] as string) === 'test' ? 'fake' : 'live'),
      coinGeckoApiKey: (raw['COIN_GECKO_API'] as string | undefined) ?? '',
      coinGeckoBaseUrl: (raw['COINGECKO_BASE_URL'] as string | undefined) ?? undefined,
      coindcxTickerUrl: (raw['COINDCX_TICKER_URL'] as string | undefined) ?? undefined,
      coindcxOrderbookUrl: (raw['COINDCX_ORDERBOOK_URL'] as string | undefined) ?? undefined,
      fallbackPriceInr: resolvePositivePrice(raw['USDT_FALLBACK_PRICE_INR']),
      maxAgeMs: toInt(raw['USDT_PRICE_MAX_AGE_MS'], 30000),
      referenceMaxAgeMs: toInt(raw['USDT_REFERENCE_MAX_AGE_MS'], 900000),
      fetchTimeoutMs: toInt(raw['USDT_FETCH_TIMEOUT_MS'], 3000),
      cacheTtlMs: toInt(raw['USDT_PRICE_CACHE_TTL_MS'], 5000),
      sanityMaxDevPct: toInt(raw['USDT_PRICE_SANITY_MAX_DEV_PCT'], 20),
      fakeScenario: (raw['USDT_FAKE_PRICING_SCENARIO'] as UsdtFakePricingScenario | undefined) ?? 'live',
    }),
    liquidity: new LiquidityConfig({
      minAvailableUsdt: resolveNonNegativeAmount(raw['LIQUIDITY_MIN_AVAILABLE_USDT'], '200000'),
      emberSlabs: parseEmberSlabs(raw['LIQUIDITY_EMBER_SLABS']),
    }),
    tokenomics: new TokenomicsConfig({
      directBurnPct: toInt(raw['TOKENOMICS_DIRECT_BURN_PCT'], 60),
      buybackPct: toInt(raw['TOKENOMICS_BUYBACK_PCT'], 40),
      adaptiveSplit: parseBoolean(raw['TOKENOMICS_ADAPTIVE_SPLIT'], true),
      adaptiveUpperHealthPct: toInt(raw['TOKENOMICS_ADAPTIVE_HEALTH_UPPER_PCT'], 45),
      adaptiveLowerHealthPct: toInt(raw['TOKENOMICS_ADAPTIVE_HEALTH_LOWER_PCT'], 31),
      adaptiveMinBurnPct: toInt(raw['TOKENOMICS_ADAPTIVE_MIN_BURN_PCT'], 40),
    }),
    treasury: new TreasuryConfig({
      monthlyCapacityInr: resolveOptionalPositiveAmount(raw['TREASURY_MONTHLY_CAPACITY_INR']),
    }),
    blockchain: new BlockchainConfig({
      enabled: parseBoolean(raw['BLOCKCHAIN_ENABLED'], false),
      network: (raw['BLOCKCHAIN_NETWORK'] as string | undefined) ?? 'local',
      chainId: toInt(raw['BLOCKCHAIN_CHAIN_ID'], 31337),
      rpcUrl: (raw['BLOCKCHAIN_RPC_URL'] as string | undefined) ?? '',
      tokenAddress: (raw['BLOCKCHAIN_TOKEN_ADDRESS'] as string | undefined) ?? '',
      treasuryAddress: (raw['BLOCKCHAIN_TREASURY_ADDRESS'] as string | undefined) ?? '',
      maxSupplyWhole: resolveOptionalPositiveAmount(raw['BLOCKCHAIN_EMBER_MAX_SUPPLY']),
      deploymentBlock: toInt(raw['BLOCKCHAIN_DEPLOYMENT_BLOCK'], 0),
      confirmations: toInt(raw['BLOCKCHAIN_CONFIRMATIONS'], 1),
      receiptTimeoutMs: toInt(raw['BLOCKCHAIN_RECEIPT_TIMEOUT_MS'], 60000),
      minterPrivateKeyFile: (raw['BLOCKCHAIN_SIGNER_KEY_FILE'] as string | undefined) ?? '',
      treasurySignerPrivateKeyFile: (raw['BLOCKCHAIN_TREASURY_SIGNER_KEY_FILE'] as string | undefined) ?? '',
      minterMaxAmount: resolveOptionalPositiveAmount(raw['EMBER_MINT_MAX_AMOUNT']),
      minterMonthlyLimit: resolveOptionalPositiveAmount(raw['EMBER_MINT_MONTHLY_LIMIT']),
    }),
    emberHub: new EmberHubConfig({
      baselinePriceInr: (raw['EMBER_HUB_BASELINE_PRICE_INR'] as string | undefined) ?? DEFAULT_EMBER_BASELINE_PRICE_INR,
      dailyEmberLimit: resolveOptionalPositiveAmount(raw['EMBER_HUB_DAILY_EMBER_LIMIT']) ?? DEFAULT_EMBER_HUB_DAILY_LIMIT,
      monthlyEmberLimit: resolveOptionalPositiveAmount(raw['EMBER_HUB_MONTHLY_EMBER_LIMIT']) ?? DEFAULT_EMBER_HUB_MONTHLY_LIMIT,
    }),
    emberStaking: new EmberStakingConfig({
      aprPercent: (raw['EMBER_STAKING_APR_PERCENT'] as string | undefined) ?? DEFAULT_EMBER_STAKING_APR_PERCENT,
      lockDays: toInt(raw['EMBER_STAKING_LOCK_DAYS'], DEFAULT_EMBER_STAKING_LOCK_DAYS),
    }),
    auth: new AuthConfig({
      publicKey: resolvePem(raw['AUTH_API_SIGNING_PUBLIC_KEY'] as string | undefined),
      issuer: raw['AUTH_API_ISSUER'] as string | undefined,
      audience: raw['AUTH_API_AUDIENCE'] as string | undefined,
      tokenTtlSeconds: toInt(raw['AUTH_API_TOKEN_TTL_SECONDS'], 900),
    }),
    sentinel: new SentinelConfig({
      voiceProvider:
        (raw['SENTINEL_VOICE_PROVIDER'] as SentinelVoiceProviderKey | undefined) ?? 'off',
      twilioAccountSid: (raw['TWILIO_ACCOUNT_SID'] as string | undefined) ?? '',
      twilioAuthToken: (raw['TWILIO_AUTH_TOKEN'] as string | undefined) ?? '',
      twilioFromNumber: (raw['TWILIO_FROM_NUMBER'] as string | undefined) ?? '',
      // Explicit wins; otherwise the worker is off exactly where a background
      // timer would make results non-deterministic - the copy worker's rule.
      workerEnabled: parseBoolean(raw['SENTINEL_WORKER_ENABLED'], (raw['NODE_ENV'] as string) !== 'test'),
      workerIntervalMs: toInt(raw['SENTINEL_WORKER_INTERVAL_MS'], 20_000),
      maxActiveAlertsPerUser: toInt(raw['SENTINEL_MAX_ACTIVE_ALERTS_PER_USER'], 20),
      maxCallsPerUserPerDay: toInt(raw['SENTINEL_MAX_CALLS_PER_USER_PER_DAY'], 5),
      maxCallsPlatformPerDay: toInt(raw['SENTINEL_MAX_CALLS_PLATFORM_PER_DAY'], 200),
      callMaxAttempts: toInt(raw['SENTINEL_CALL_MAX_ATTEMPTS'], 3),
      callRetryDelayMs: toInt(raw['SENTINEL_CALL_RETRY_MS'], 60_000),
      verificationCodeTtlMs: toInt(raw['SENTINEL_VERIFICATION_CODE_TTL_MS'], 10 * 60_000),
      verificationMaxAttempts: toInt(raw['SENTINEL_VERIFICATION_MAX_ATTEMPTS'], 5),
    }),
    payments: new PaymentsConfig({
      provider: (raw['PAYMENTS_PROVIDER'] as PaymentsProviderKey | undefined) ?? 'simulated',
      razorpayKeyId: (raw['RAZORPAY_KEY_ID'] as string | undefined) ?? '',
      razorpayKeySecret: (raw['RAZORPAY_KEY_SECRET'] as string | undefined) ?? '',
      razorpayWebhookSecret: (raw['RAZORPAY_WEBHOOK_SECRET'] as string | undefined) ?? '',
      maxDepositInr: resolvePositiveAmount(raw['PAYMENTS_MAX_DEPOSIT_INR'], '500000'),
      requestTimeoutMs: toInt(raw['PAYMENTS_REQUEST_TIMEOUT_MS'], 10000),
    }),
    // Empty string is the common "unset" form in a copied .env line; it means
    // no model configured, not a URL of "".
    aiModelUrl: (raw['AI_MODEL_URL'] as string | undefined)?.trim() || null,
  });
}

/**
 * Restores real newlines in a PEM supplied as a single-line environment value.
 *
 * `.env` files cannot hold a literal multi-line value, so the key travels as
 * `-----BEGIN ...-----\nMIb...\n-----END ...-----`. jose needs an actual PEM,
 * not the escaped form, and a missing PEM would otherwise surface as an opaque
 * "Invalid Compact JWS" at the first request rather than at boot.
 */
export function resolvePem(raw: string | undefined): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  if (trimmed.includes('-----BEGIN')) {
    // Tolerate a stray trailing quote from a hand-edited .env.
    const unwrapped = trimmed.replace(/^"+|"+$/g, '');
    return unwrapped.includes('\\n') ? unwrapped.replace(/\\n/g, '\n') : unwrapped;
  }
  return '';
}

function toInt(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Reads an optional positive price for the USDT fallback.
 *
 * Joi has already validated the value as a positive number when present; this
 * narrows it to a canonical string (or null when unset) so the rest of the
 * application never handles a float for a monetary figure.
 */
function resolvePositivePrice(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return new Prisma.Decimal(parsed).toString();
}

/**
 * Reads an optional non-negative monetary amount (Module 09 threshold).
 *
 * Falls back to the supplied default when unset and canonicalises to a
 * Decimal string, keeping floats out of the rest of the application.
 */
function resolveNonNegativeAmount(value: unknown, fallback: string): string {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return new Prisma.Decimal(parsed).toString();
}

/**
 * Reads an optional positive capacity amount (Module 12).
 *
 * Unset or empty yields null - "capacity not configured" - rather than a
 * default, because inventing a monthly limit would invent a policy the
 * approved plan does not define. Joi has already rejected non-positive or
 * non-numeric values when present.
 */
function resolveOptionalPositiveAmount(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return new Prisma.Decimal(parsed).toString();
}

/**
 * Reads a positive monetary ceiling, falling back when unset (Module 03b).
 *
 * Unlike {@link resolveOptionalPositiveAmount} an unset value is not "no
 * ceiling" but a configured default, because a top-up rail without a ceiling
 * would let a mistyped amount mint an unbounded balance.
 */
function resolvePositiveAmount(value: unknown, fallback: string): string {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return new Prisma.Decimal(parsed).toString();
}

/**
 * Parses and structurally validates `LIQUIDITY_EMBER_SLABS` (Module 09).
 *
 * The value is a JSON array of `{ minUsdt, requiredEmber }` entries. Empty or
 * unset yields an empty list, which the liquidity service treats as "slabs not
 * configured" and uses to refuse commitment mutations. A malformed value
 * throws at boot: a locking rule that silently parsed to "no slabs" would be a
 * locking rule nobody can see is missing.
 */
export function parseEmberSlabs(raw: unknown): EmberLiquiditySlab[] {
  if (raw === undefined || raw === null || raw === '') return [];

  const text = typeof raw === 'string' ? raw.trim() : JSON.stringify(raw);
  if (text === '') return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('LIQUIDITY_EMBER_SLABS must be a JSON array of { minUsdt, requiredEmber } entries.');
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('LIQUIDITY_EMBER_SLABS must be a non-empty JSON array when set.');
  }

  const slabs: EmberLiquiditySlab[] = parsed.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`LIQUIDITY_EMBER_SLABS[${index}] must be an object.`);
    }
    const record = entry as Record<string, unknown>;
    const minUsdt = toCanonicalDecimal(record['minUsdt'], `LIQUIDITY_EMBER_SLABS[${index}].minUsdt`);
    const requiredEmber = toCanonicalDecimal(
      record['requiredEmber'],
      `LIQUIDITY_EMBER_SLABS[${index}].requiredEmber`,
    );

    if (new Prisma.Decimal(minUsdt).isNegative()) {
      throw new Error(`LIQUIDITY_EMBER_SLABS[${index}].minUsdt must not be negative.`);
    }
    if (new Prisma.Decimal(requiredEmber).isNegative()) {
      throw new Error(`LIQUIDITY_EMBER_SLABS[${index}].requiredEmber must not be negative.`);
    }

    return { minUsdt, requiredEmber };
  });

  for (let index = 1; index < slabs.length; index += 1) {
    const previous = slabs[index - 1];
    const current = slabs[index];
    if (!previous || !current) continue;
    if (!new Prisma.Decimal(current.minUsdt).greaterThan(previous.minUsdt)) {
      throw new Error('LIQUIDITY_EMBER_SLABS minUsdt values must be strictly ascending.');
    }
    if (new Prisma.Decimal(current.requiredEmber).lessThan(previous.requiredEmber)) {
      throw new Error('LIQUIDITY_EMBER_SLABS requiredEmber values must be non-decreasing.');
    }
  }

  return slabs;
}

function toCanonicalDecimal(value: unknown, label: string): string {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(`${label} must be a decimal string or number.`);
  }
  const text = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new Error(`${label} must be a non-negative decimal.`);
  }
  return new Prisma.Decimal(text).toString();
}

/**
 * Reads a boolean the way both Joi output and a raw process environment
 * present it. Guards against the classic `"false"` being truthy bug.
 */
function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return fallback;
}