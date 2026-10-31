/**
 * MODULE 06c - the read-only live-market instrument catalogue.
 *
 * THE WHOLE UNIVERSE, IN CODE. Eight instruments, three of which trade a US
 * equities session and five of which trade crypto 24/7. This is where an
 * instrument is *defined*: its liquidity class, its venue, its price precision
 * and how fresh a quote must be to count as live. No provider and no user can
 * add to it - the module rejects anything outside this list before a provider
 * is ever consulted, which is what makes the eight symbols a closed set rather
 * than an accident of who happened to be seeded.
 *
 * NOT THE MODULE 06b CATALOGUE. 06b's market catalogue is three USDT quotes
 * (`BTCUSDT`, `ETHUSDT`, `SOLUSDT`) stored in `market_candles`, deliberately
 * separate from anything here. The six..eight symbols in this file are the
 * live universe; the overlap is thematic, not referential, and this module
 * never substitutes one spelling for another. `BTC/USD` is not `BTCUSDT`.
 *
 * NAVIGATING A CANDLE IS NOT NAVIGATING A QUOTE. A follower cannot `SELECT`
 * the latest market price from `market_candles` because candles are historical
 * and offline; `LiveDataService` is the only door to live prices, and it is
 * read-only by construction.
 */
export interface MarketInstrument {
  /** Canonical symbol as every API in this module spells it, e.g. `AAPL` or `BTC/USD`. */
  readonly symbol: string;
  /** Liquidity class. `STOCK` trades a regular US session; `CRYPTO` trades 24/7. */
  readonly kind: 'STOCK' | 'CRYPTO';
  /** Human display name, e.g. `Apple Inc.`. */
  readonly name: string;
  /** Primary venue label, informational only. */
  readonly venue: string;
  /**
   * Quote currency. Every live quote and every paper balance is denominated in
   * USD; kept as a field so the four-character fact travels with the instrument
   * instead of living in a comment.
   */
  readonly quoteCurrency: 'USD';
  /**
   * Decimal places a fill quantity may carry. Stocks are bought in share
   * fractions to 4 places here; crypto to the 8 places the 06b engine uses.
   */
  readonly quantityPrecision: number;
  /**
   * How old a quote may be before it stops counting as live. 60 s for equities
   * (whose REST feed is delayed and IEX-sourced), 30 s for crypto.
   */
  readonly staleAfterMs: number;
}

/** The eight supported instruments, in a stable display order. */
export const LIVE_INSTRUMENTS: readonly MarketInstrument[] = [
  {
    symbol: 'AAPL',
    kind: 'STOCK',
    name: 'Apple Inc.',
    venue: 'NASDAQ',
    quoteCurrency: 'USD',
    quantityPrecision: 4,
    staleAfterMs: 60_000,
  },
  {
    symbol: 'MSFT',
    kind: 'STOCK',
    name: 'Microsoft Corporation',
    venue: 'NASDAQ',
    quoteCurrency: 'USD',
    quantityPrecision: 4,
    staleAfterMs: 60_000,
  },
  {
    symbol: 'NVDA',
    kind: 'STOCK',
    name: 'NVIDIA Corporation',
    venue: 'NASDAQ',
    quoteCurrency: 'USD',
    quantityPrecision: 4,
    staleAfterMs: 60_000,
  },
  {
    symbol: 'TSLA',
    kind: 'STOCK',
    name: 'Tesla, Inc.',
    venue: 'NASDAQ',
    quoteCurrency: 'USD',
    quantityPrecision: 4,
    staleAfterMs: 60_000,
  },
  {
    symbol: 'AMZN',
    kind: 'STOCK',
    name: 'Amazon.com, Inc.',
    venue: 'NASDAQ',
    quoteCurrency: 'USD',
    quantityPrecision: 4,
    staleAfterMs: 60_000,
  },
  {
    symbol: 'BTC/USD',
    kind: 'CRYPTO',
    name: 'Bitcoin',
    venue: 'crypto',
    quoteCurrency: 'USD',
    quantityPrecision: 8,
    staleAfterMs: 30_000,
  },
  {
    symbol: 'ETH/USD',
    kind: 'CRYPTO',
    name: 'Ethereum',
    venue: 'crypto',
    quoteCurrency: 'USD',
    quantityPrecision: 8,
    staleAfterMs: 30_000,
  },
  {
    symbol: 'SOL/USD',
    kind: 'CRYPTO',
    name: 'Solana',
    venue: 'crypto',
    quoteCurrency: 'USD',
    quantityPrecision: 8,
    staleAfterMs: 30_000,
  },
] as const;

const bySymbol = new Map(LIVE_INSTRUMENTS.map((instrument) => [instrument.symbol, instrument]));

/** Whether `symbol` is one of the eight supported instruments. */
export function isSupportedInstrument(symbol: string): boolean {
  return bySymbol.has(symbol);
}

/**
 * The instrument for `symbol`, or null when it is not part of the universe.
 *
 * Case-sensitive on purpose: the canonical symbol is a contract between this
 * module and its consumers, and quietly uppercasing an alias would turn a
 * caller's typo into a different instrument. `BTC/usd` is not `BTC/USD`.
 */
export function findInstrument(symbol: string): MarketInstrument | null {
  return bySymbol.get(symbol) ?? null;
}