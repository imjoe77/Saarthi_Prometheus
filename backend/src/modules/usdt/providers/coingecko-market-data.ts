import { fetchJsonWithTimeout } from './http-fetch.util';
import {
  toEpochMs,
  toOptionalEpochMs,
  toOptionalPositiveDecimalString,
  toPositiveDecimalString,
} from './market-parsing';
import { UsdtProviderError, type CoinGeckoAggregate, type CompetitorVenue } from './usdt-pricing.types';

/**
 * MODULE 08 extension — CoinGecko as the reference and competitor source.
 *
 * TWO DIFFERENT FIGURES, NEVER CONFUSED. The aggregate
 * (`simple/price?ids=tether&vs_currencies=inr`) is CoinGecko's INR number for
 * tether - verified live to track USD/INR conversion (USDT and BTC both came
 * back at an inr/usd ratio of ~95.06), NOT an Indian exchange quote - so it
 * is exposed only as a labelled aggregate and never presented as a venue
 * price. The venue tickers
 * (`coins/tether/tickers?exchange_ids=wazirx,zebpay,bitbns,coindcx`) carry the
 * real USDT/INR last prices of individual Indian exchanges; stale-flagged or
 * missing entries are dropped rather than averaged in.
 *
 * The demo API key travels in the `x-cg-demo-api-key` header and nowhere
 * else: not in URLs, not in logs, not in error messages. It is optional -
 * these endpoints answer anonymously at a lower rate limit.
 */

/** The CoinGecko coin id for Tether. */
const TETHER_COIN_ID = 'tether';

/** Indian venues whose USDT/INR tickers are treated as comparable competitors. */
const INR_VENUE_EXCHANGE_IDS = ['wazirx', 'zebpay', 'bitbns', 'coindcx'];

export interface CoingeckoFetchOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
}

/** Fetches CoinGecko's INR aggregate price for tether. */
export async function fetchCoinGeckoAggregate(
  options: CoingeckoFetchOptions,
): Promise<CoinGeckoAggregate> {
  const url =
    `${options.baseUrl}/simple/price` +
    `?ids=${TETHER_COIN_ID}&vs_currencies=inr&include_last_updated_at=true`;
  const payload = await fetchJsonWithTimeout(url, 'coingecko_aggregate', {
    timeoutMs: options.timeoutMs,
    headers: coinGeckoHeaders(options.apiKey),
  });

  return parseCoinGeckoAggregate(payload);
}

/** Fetches the USDT/INR venue tickers for the watched Indian exchanges. */
export async function fetchCoinGeckoVenues(
  options: CoingeckoFetchOptions,
): Promise<CompetitorVenue[]> {
  const url =
    `${options.baseUrl}/coins/${TETHER_COIN_ID}/tickers` +
    `?exchange_ids=${INR_VENUE_EXCHANGE_IDS.join(',')}&depth=false`;
  const payload = await fetchJsonWithTimeout(url, 'coingecko_venues', {
    timeoutMs: options.timeoutMs,
    headers: coinGeckoHeaders(options.apiKey),
  });

  return parseCoinGeckoVenues(payload);
}

/** Validates the `simple/price` payload into a labelled aggregate figure. */
export function parseCoinGeckoAggregate(payload: unknown): CoinGeckoAggregate {
  const source = 'coingecko_aggregate';

  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new UsdtProviderError(source, 'response must be an object');
  }

  const tether = (payload as Record<string, unknown>)[TETHER_COIN_ID];
  if (tether === null || typeof tether !== 'object') {
    throw new UsdtProviderError(source, 'response is missing the tether entry');
  }

  const record = tether as Record<string, unknown>;
  return {
    priceInr: toPositiveDecimalString(record['inr'], 'inr', source),
    lastUpdatedAtMs: toEpochMs(record['last_updated_at'], 'last_updated_at', source),
  };
}

/**
 * Validates the `tickers` payload into competitor venue figures.
 *
 * Entries that are not USDT/INR, or whose price will not validate, are
 * skipped rather than failing the whole list - one broken venue must not
 * erase the others - but a structurally wrong payload still throws.
 */
export function parseCoinGeckoVenues(payload: unknown): CompetitorVenue[] {
  const source = 'coingecko_venues';

  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new UsdtProviderError(source, 'response must be an object');
  }

  const tickers = (payload as Record<string, unknown>)['tickers'];
  if (!Array.isArray(tickers)) {
    throw new UsdtProviderError(source, 'response is missing the tickers array');
  }

  const venues: CompetitorVenue[] = [];

  for (const raw of tickers) {
    if (raw === null || typeof raw !== 'object') continue;
    const ticker = raw as Record<string, unknown>;

    if (ticker['base'] !== 'USDT' || ticker['target'] !== 'INR') continue;

    const market = ticker['market'];
    const marketRecord =
      market !== null && typeof market === 'object' ? (market as Record<string, unknown>) : {};
    const venue =
      typeof marketRecord['name'] === 'string' && marketRecord['name'].trim() !== ''
        ? marketRecord['name']
        : typeof marketRecord['identifier'] === 'string'
          ? marketRecord['identifier']
          : null;

    if (!venue) continue;

    let lastPriceInr: string;
    try {
      lastPriceInr = toPositiveDecimalString(ticker['last'], 'last', source);
    } catch {
      continue;
    }

    venues.push({
      venue,
      lastPriceInr,
      lastTradedAtMs: toOptionalEpochMs(ticker['last_traded_at'], 'last_traded_at', source),
      fetchedAtMs: toOptionalEpochMs(ticker['last_fetch_at'], 'last_fetch_at', source),
      volume24h: toOptionalPositiveDecimalString(ticker['volume'], 'volume', source),
      staleFlag: ticker['is_stale'] === true,
      bidAskSpreadPct: toOptionalNonNegativeDecimalString(
        ticker['bid_ask_spread_percentage'],
        'bid_ask_spread_percentage',
        source,
      ),
    });
  }

  return venues;
}

function coinGeckoHeaders(apiKey: string): Record<string, string> {
  return apiKey.trim() === '' ? {} : { 'x-cg-demo-api-key': apiKey };
}

/** Validates an optional non-negative decimal (spreads may be zero). */
function toOptionalNonNegativeDecimalString(
  value: unknown,
  field: string,
  source: string,
): string | null {
  if (value === undefined || value === null || value === '') return null;
  try {
    return toPositiveDecimalString(value, field, source);
  } catch {
    // A zero spread is valid; a negative or non-numeric one is dropped.
    if (typeof value === 'number' && Number.isFinite(value) && value === 0) {
      return '0';
    }
    return null;
  }
}
