import {
  parseCoindcxBookSide,
  toEpochMs,
  toOptionalEpochMs,
  toPositiveDecimalString,
} from './market-parsing';
import { fetchJsonWithTimeout } from './http-fetch.util';
import { UsdtProviderError, type CoindcxExecution } from './usdt-pricing.types';

/**
 * MODULE 08 extension — CoinDCX as the execution-price source.
 *
 * The order book (`public.coindcx.com/market_data/orderbook?pair=I-USDT_INR`)
 * is the source of truth for what a customer could actually transact at:
 * BUY prices walk the asks, SELL prices walk the bids, and both are
 * volume-weighted for the requested quantity upstream in the domain layer.
 * The ticker (`api.coindcx.com/exchange/ticker`) is fetched opportunistically
 * for cross-reference metadata; its absence never invalidates the book.
 *
 * Both endpoints are public and key-free. Timestamps differ in unit - the
 * book reports milliseconds, the ticker seconds - and both are normalised to
 * epoch milliseconds by the shared parsers.
 */

/** The CoinDCX market symbol and internal pair for USDT/INR. */
export const COINDCX_USDT_INR_MARKET = 'USDTINR';
export const COINDCX_USDT_INR_PAIR = 'I-USDT_INR';

export interface CoindcxFetchOptions {
  tickerUrl: string;
  orderbookUrl: string;
  timeoutMs: number;
}

/** The validated USDTINR entry of a CoinDCX ticker array. */
export interface CoindcxTickerQuote {
  bid: string;
  ask: string;
  last: string;
  timestampMs: number;
}

/** Fetches and validates the CoinDCX execution book plus its optional ticker. */
export async function fetchCoindcxExecution(options: CoindcxFetchOptions): Promise<CoindcxExecution> {
  const bookUrl = appendQuery(options.orderbookUrl, 'pair', COINDCX_USDT_INR_PAIR);
  const bookPayload = await fetchJsonWithTimeout(bookUrl, 'coindcx_orderbook', {
    timeoutMs: options.timeoutMs,
  });
  const execution = parseCoindcxOrderBook(bookPayload);

  // The ticker is metadata, not the execution source: a ticker outage leaves
  // the book fully usable, so its failure is swallowed into a null field.
  const ticker = await fetchUsdtInrTickerOrNull(options);
  if (ticker) {
    execution.tickerTimestampMs = ticker.timestampMs;
    execution.tickerLast = ticker.last;
  }

  return execution;
}

async function fetchUsdtInrTickerOrNull(options: CoindcxFetchOptions): Promise<CoindcxTickerQuote | null> {
  try {
    const tickerPayload = await fetchJsonWithTimeout(options.tickerUrl, 'coindcx_ticker', {
      timeoutMs: options.timeoutMs,
    });
    return parseCoindcxUsdtInrTicker(tickerPayload);
  } catch {
    return null;
  }
}

/** Validates a raw CoinDCX order-book payload into a {@link CoindcxExecution}. */
export function parseCoindcxOrderBook(payload: unknown): CoindcxExecution {
  const source = 'coindcx_orderbook';

  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new UsdtProviderError(source, 'response must be an object');
  }

  const record = payload as Record<string, unknown>;
  const bookTimestampMs = toEpochMs(record['timestamp'], 'timestamp', source);
  const askLevels = parseCoindcxBookSide(record['asks'], 'asks', source);
  const bidLevels = parseCoindcxBookSide(record['bids'], 'bids', source);

  return {
    bookTimestampMs,
    bestAsk: askLevels[0]?.price ?? null,
    bestBid: bidLevels[0]?.price ?? null,
    askLevels,
    bidLevels,
    tickerTimestampMs: null,
    tickerLast: null,
  };
}

/** Validates the USDTINR entry of a CoinDCX ticker array; null when absent. */
export function parseCoindcxUsdtInrTicker(payload: unknown): CoindcxTickerQuote | null {
  const source = 'coindcx_ticker';

  if (!Array.isArray(payload)) {
    throw new UsdtProviderError(source, 'response must be an array');
  }

  const items: unknown[] = payload;
  const entry = items.find(
    (item) =>
      item !== null &&
      typeof item === 'object' &&
      (item as Record<string, unknown>)['market'] === COINDCX_USDT_INR_MARKET,
  );

  if (!entry) return null;

  const record = entry as Record<string, unknown>;
  return {
    bid: toPositiveDecimalString(record['bid'], 'bid', source),
    ask: toPositiveDecimalString(record['ask'], 'ask', source),
    last: toPositiveDecimalString(record['last_price'], 'last_price', source),
    timestampMs: toOptionalEpochMs(record['timestamp'], 'timestamp', source) ?? 0,
  };
}

function appendQuery(url: string, key: string, value: string): string {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}${key}=${encodeURIComponent(value)}`;
}
