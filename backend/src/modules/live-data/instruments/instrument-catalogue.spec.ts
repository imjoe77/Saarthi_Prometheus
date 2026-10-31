import { findInstrument, isSupportedInstrument, LIVE_INSTRUMENTS } from './instrument-catalogue';

/**
 * MODULE 06c - the closed instrument universe.
 *
 * The eight symbols are a contract between this module and every consumer of a
 * live quote, so they are asserted by name rather than by count alone: adding a
 * ninth instrument or renaming `BTC/USD` must fail here, loudly, rather than
 * quietly widening what the API will accept.
 */
describe('instrument-catalogue', () => {
  const EXPECTED_SYMBOLS = [
    'AAPL',
    'MSFT',
    'NVDA',
    'TSLA',
    'AMZN',
    'BTC/USD',
    'ETH/USD',
    'SOL/USD',
  ];

  it('exposes exactly the eight supported instruments, in a stable order', () => {
    expect(LIVE_INSTRUMENTS.map((i) => i.symbol)).toEqual(EXPECTED_SYMBOLS);
    expect(LIVE_INSTRUMENTS).toHaveLength(8);
  });

  it('splits into five crypto and three equities', () => {
    const crypto = LIVE_INSTRUMENTS.filter((i) => i.kind === 'CRYPTO');
    const stock = LIVE_INSTRUMENTS.filter((i) => i.kind === 'STOCK');

    expect(crypto.map((i) => i.symbol)).toEqual(['BTC/USD', 'ETH/USD', 'SOL/USD']);
    expect(stock.map((i) => i.symbol)).toEqual(['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN']);
  });

  it('denominates every instrument in USD, because paper balances are USD', () => {
    for (const instrument of LIVE_INSTRUMENTS) {
      expect(instrument.quoteCurrency).toBe('USD');
    }
  });

  it('gives every instrument a venue, a display name and a precision', () => {
    for (const instrument of LIVE_INSTRUMENTS) {
      expect(instrument.name.length).toBeGreaterThan(0);
      expect(instrument.venue.length).toBeGreaterThan(0);
      expect(instrument.quantityPrecision).toBeGreaterThan(0);
      expect(instrument.staleAfterMs).toBeGreaterThan(0);
    }
  });

  it('makes crypto stricter about staleness than equities, as documented', () => {
    const stock = findInstrument('AAPL');
    const crypto = findInstrument('BTC/USD');

    expect(stock?.staleAfterMs).toBe(60_000);
    expect(crypto?.staleAfterMs).toBe(30_000);
  });

  it('lets crypto be traded to eight places and stocks to four', () => {
    expect(findInstrument('BTC/USD')?.quantityPrecision).toBe(8);
    expect(findInstrument('AAPL')?.quantityPrecision).toBe(4);
  });

  describe('findInstrument', () => {
    it('resolves every canonical symbol', () => {
      for (const symbol of EXPECTED_SYMBOLS) {
        expect(findInstrument(symbol)?.symbol).toBe(symbol);
      }
    });

    it('is case-sensitive, because the symbol is a contract and not a convenience', () => {
      expect(findInstrument('sol/usd')).toBeNull();
      expect(findInstrument('aapl')).toBeNull();
      expect(findInstrument('BTCusd')).toBeNull();
    });

    it('does not accept the Module 06b candle spellings, which are a different catalogue', () => {
      expect(findInstrument('BTCUSDT')).toBeNull();
      expect(findInstrument('ETHUSDT')).toBeNull();
      expect(findInstrument('SOLUSDT')).toBeNull();
    });

    it('rejects an empty, blank or invented symbol', () => {
      expect(findInstrument('')).toBeNull();
      expect(findInstrument('   ')).toBeNull();
      expect(findInstrument('DOGE/USD')).toBeNull();
      expect(findInstrument('AAPL.US')).toBeNull();
    });
  });

  describe('isSupportedInstrument', () => {
    it('agrees with findInstrument for every symbol in the universe', () => {
      for (const symbol of EXPECTED_SYMBOLS) {
        expect(isSupportedInstrument(symbol)).toBe(true);
      }
    });

    it('is false for anything outside the universe', () => {
      expect(isSupportedInstrument('DOGE/USD')).toBe(false);
      expect(isSupportedInstrument('NOPE')).toBe(false);
      expect(isSupportedInstrument('')).toBe(false);
      expect(isSupportedInstrument('aapl')).toBe(false);
    });
  });
});
