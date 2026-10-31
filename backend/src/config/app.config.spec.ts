import { AppConfig, createAppConfig, TokenomicsConfig } from './app.config';

describe('createAppConfig', () => {
  it('maps a validated environment onto the typed config object', () => {
    const config = createAppConfig({
      NODE_ENV: 'test',
      PORT: 4001,
      HOST: '127.0.0.1',
      API_PREFIX: 'api/v1',
      CORS_ORIGINS: 'http://localhost:3000, https://app.prometheus.local',
      LOG_LEVEL: 'warn',
      SWAGGER_ENABLED: true,
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/prometheus',
      DATABASE_POOL_MAX: 5,
      DATABASE_CONNECT_TIMEOUT_MS: 1000,
    });

    expect(config).toBeInstanceOf(AppConfig);
    expect(config.nodeEnv).toBe('test');
    expect(config.port).toBe(4001);
    expect(config.corsOrigins).toEqual([
      'http://localhost:3000',
      'https://app.prometheus.local',
    ]);
    expect(config.logLevel).toBe('warn');
    expect(config.databasePoolMax).toBe(5);
    expect(config.isProduction).toBe(false);
  });

  it('falls back to safe defaults when the environment is empty', () => {
    const config = createAppConfig({});

    expect(config.nodeEnv).toBe('development');
    expect(config.port).toBe(3001);
    expect(config.corsOrigins).toEqual([]);
    expect(config.isProduction).toBe(false);
  });

  it('flags production so callers can tighten behaviour', () => {
    expect(createAppConfig({ NODE_ENV: 'production' }).isProduction).toBe(true);
    expect(createAppConfig({ NODE_ENV: 'staging' }).isProduction).toBe(false);
  });

  describe('normalisedPrefix', () => {
    it('returns the prefix without surrounding slashes', () => {
      expect(createAppConfig({ API_PREFIX: '/api/' }).normalisedPrefix).toBe('api');
    });

    it('returns an empty string when the prefix is explicitly disabled', () => {
      expect(createAppConfig({ API_PREFIX: '' }).normalisedPrefix).toBe('');
    });

    it('supports nested prefixes', () => {
      expect(createAppConfig({ API_PREFIX: 'api/v1' }).normalisedPrefix).toBe('api/v1');
    });
  });

  describe('corsOrigins parsing', () => {
    it('trims whitespace and drops empty segments', () => {
      const config = createAppConfig({
        CORS_ORIGINS: ' http://a.test , ,http://b.test ',
      });

      expect(config.corsOrigins).toEqual(['http://a.test', 'http://b.test']);
    });

    it('yields an empty list for an absent or blank value', () => {
      expect(createAppConfig({ CORS_ORIGINS: undefined }).corsOrigins).toEqual([]);
      expect(createAppConfig({ CORS_ORIGINS: '   ' }).corsOrigins).toEqual([]);
    });
  });

  it('never treats the string "false" as true for swaggerEnabled', () => {
    expect(createAppConfig({ SWAGGER_ENABLED: 'false' }).swaggerEnabled).toBe(false);
    expect(createAppConfig({ SWAGGER_ENABLED: 'true' }).swaggerEnabled).toBe(true);
  });

  it('falls back to log level when an unknown level slips through', () => {
    expect(createAppConfig({ LOG_LEVEL: 'gossip' }).logLevel).toBe('log');
  });
});

describe('TokenomicsConfig', () => {
  it('defaults to the approved 60/40 split', () => {
    expect(createAppConfig({}).tokenomics).toMatchObject({
      directBurnPct: 60,
      buybackPct: 40,
    });
  });

  it('accepts an explicit split that sums to 100', () => {
    const config = new TokenomicsConfig({ directBurnPct: 70, buybackPct: 30 });

    expect(config.directBurnPct).toBe(70);
    expect(config.buybackPct).toBe(30);
  });

  it('maps TOKENOMICS_* environment strings onto the configured split', () => {
    const config = createAppConfig({
      TOKENOMICS_DIRECT_BURN_PCT: '70',
      TOKENOMICS_BUYBACK_PCT: '30',
    });

    expect(config.tokenomics).toMatchObject({ directBurnPct: 70, buybackPct: 30 });
  });

  it('refuses a split that does not sum to 100 so no value can be lost or invented', () => {
    expect(() => new TokenomicsConfig({ directBurnPct: 60, buybackPct: 39 })).toThrow(
      /must sum to 100/,
    );
  });

  it('refuses fractional or out-of-range percentages', () => {
    expect(() => new TokenomicsConfig({ directBurnPct: 60.5, buybackPct: 39.5 })).toThrow(
      /integers between 0 and 100/,
    );
    expect(() => new TokenomicsConfig({ directBurnPct: -10, buybackPct: 110 })).toThrow(
      /integers between 0 and 100/,
    );
  });
});