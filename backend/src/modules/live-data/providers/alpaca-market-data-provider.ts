import { Inject, Injectable, Logger } from '@nestjs/common';

import { APP_CONFIG, type AppConfig } from '../../../config/config.module';
import type { MarketInstrument } from '../instruments/instrument-catalogue';
import type {
  BarTimeframe,
  LiveBar,
  LiveQuote,
  MarketDataProvider,
} from './market-data-provider.port';
import { normalizeBars, normalizeLatestQuotes } from './alpaca/alpaca-normalizers';

/**
 * HOW MUCH FURTHER THAN THE BAR COUNT TO LOOK BACK, FOR EQUITIES, BY TIMEFRAME.
 *
 * A trading day is not a calendar day. Weekends, market holidays and the
 * overnight session all fall inside a naive `count * timeframe` window, so a
 * request for 60 one-minute bars would look back 60 minutes and, on a Saturday,
 * find an empty window - "no bars" when the real answer is "no trading". The
 * slack is a multiple of the bar's own timeframe, largest for the shortest
 * bars, because a minute bar has to cross whole weekends and a daily bar only
 * has to cross holidays. The multiples are deliberately loose rather than an
 * exchange schedule, so a holiday shortens a week without any code here needing
 * to know which one; `limit` is what actually bounds the answer.
 */
const EQUITY_WINDOW_SLACK: Record<BarTimeframe, number> = {
  '1m': 5 * 24 * 3,
  '5m': 5 * 24,
  '15m': 5 * 8,
  '1h': 5 * 2,
  '1d': 2,
};

function equityWindowSlackMs(timeframe: BarTimeframe): number {
  return EQUITY_WINDOW_SLACK[timeframe] * timeframeStepMs(timeframe);
}

/**
 * MODULE 06c - the real public-market-data provider: Alpaca Data.
 *
 * WHAT IT IS. Alpaca's free `alpaca.data` plan serves US equities through the
 * IEX feed and real-time US-settled crypto, up to 200 requests per minute. It
 * uses Alpaca's *market-data* API and nothing else: this provider never calls
 * an order, position or account endpoint, and no credentials it reads can ever
 * leak a broker action into this application. Paper execution stays wholly on
 * this repo's side of the wire.
 *
 * UNCONFIGURED IS DISABLED. With no key pair (the default), every read returns
 * `null`/`[]` without touching the network: a deployment that sets
 * `MARKET_DATA_PROVIDER=alpaca` but forgets the keys is a deployment with an
 * empty feed, not a crashing one. Each key is optional so a single-credential
 * player can still see quotes for the family their key covers.
 *
 * HONEST FAILURE, NEVER A LIAR. A non-2xx response, a network error or a
 * timeout is treated as "no data right now" - `null` for quotes, `[]` for
 * bars - because any of those means the market's answer is not knowable, which
 * is exactly the state a caller must distinguish from "the feed is fine". The
 * caller (the service or the paper engine) decides what absence means, so this
 * provider never has to invent a price it did not see.
 *
 * THE IEX CONSTRAINT IS A FEATURE, NOT A HIDDEN LIMITATION. The free plan
 * serves only the IEX feed and refuses `feed=sip`, and it is 15 minutes
 * delayed for equities; crypto is real time. The provider requests `feed=iex`
 * for equities explicitly so the response cannot silently degrade to a feed
 * the account does not have.
 */
@Injectable()
export class AlpacaMarketDataProvider implements MarketDataProvider {
  readonly mode = 'alpaca' as const;

  private readonly logger = new Logger(AlpacaMarketDataProvider.name);

  private readonly baseUrl = 'https://data.alpaca.markets';
  private readonly requestTimeoutMs = 5_000;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /**
   * The `at` argument is part of the provider contract but Alpaca's latest-quote
   * endpoint has no as-of parameter: it always answers "now", so the timestamp
   * the service passes is deliberately unused here rather than silently
   * pretending the observation was taken at a chosen instant.
   */
  async latestQuote(instrument: MarketInstrument): Promise<LiveQuote | null> {
    const quote = await this.fetchLatestQuote(instrument);
    if (!quote) {
      return null;
    }
    return quote;
  }

  async bars(instrument: MarketInstrument, timeframe: BarTimeframe, limit: number, at: Date): Promise<LiveBar[]> {
    const url = this.barsUrl(instrument, timeframe, limit, at);
    const payload = await this.getJson(url, instrument.symbol);
    if (payload === null) {
      return [];
    }
    return normalizeBars(payload, instrument.symbol, timeframe);
  }

  private async fetchLatestQuote(instrument: MarketInstrument): Promise<LiveQuote | null> {
    const url = this.latestQuoteUrl(instrument);
    const payload = await this.getJson(url, instrument.symbol);
    if (payload === null) {
      return null;
    }
    const quotes = normalizeLatestQuotes(payload);
    return quotes[0] ?? null;
  }

  private latestQuoteUrl(instrument: MarketInstrument): string {
    if (instrument.kind === 'CRYPTO') {
      // Alpaca relocated crypto from `v1beta1` to `v1beta3`, and the
      // latest-quote route is `latest/quotes` there - not `quotes/latest`,
      // which answers 404 on this host.
      return `${this.baseUrl}/v1beta3/crypto/us/latest/quotes?symbols=${encodeURIComponent(instrument.symbol)}`;
    }
    return `${this.baseUrl}/v2/stocks/quotes/latest?symbols=${encodeURIComponent(instrument.symbol)}&feed=iex`;
  }

  /**
   * BOTH FAMILIES NEED AN EXPLICIT WINDOW, for different reasons.
   *
   * The crypto route rejects a request with no `start`. The equities route
   * accepts one, but answers `{ bars: null }` without it - an empty 200 that
   * looks like "no history" rather than "no window". Deriving `start` from the
   * requested count and timeframe gives both routes the window they need, and
   * gives this provider one rule instead of two to keep straight.
   *
   * THE EQUITIES WINDOW IS WIDER THAN `count * timeframe`, because equities do
   * not trade continuously: a minute bar has to reach back across weekends and
   * the overnight session to find trading, which a crypto window never does.
   * See `EQUITY_WINDOW_SLACK`.
   */
  private barsUrl(instrument: MarketInstrument, timeframe: BarTimeframe, limit: number, at: Date): string {
    const tf = toAlpacaTimeframe(timeframe);
    const slackMs =
      instrument.kind === 'CRYPTO' ? timeframeStepMs(timeframe) : equityWindowSlackMs(timeframe);
    const start = new Date(at.getTime() - limit * slackMs).toISOString();
    if (instrument.kind === 'CRYPTO') {
      return `${this.baseUrl}/v1beta3/crypto/us/bars?symbols=${encodeURIComponent(
        instrument.symbol,
      )}&timeframe=${tf}&limit=${limit}&start=${start}`;
    }
    return `${this.baseUrl}/v2/stocks/${encodeURIComponent(
      instrument.symbol,
    )}/bars?timeframe=${tf}&limit=${limit}&feed=iex&start=${start}`;
  }

  private async getJson(url: string, symbol: string): Promise<unknown> {
    if (!this.config.marketData.alpacaApiKeyId) {
      return null;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const response = await globalThis.fetch(url, {
        headers: {
          accept: 'application/json',
          'APCA-API-KEY-ID': this.config.marketData.alpacaApiKeyId,
          'APCA-API-SECRET-KEY': this.config.marketData.alpacaApiSecretKey,
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        this.logger.warn(`Alpaca responded ${response.status} for ${symbol}; treating as no data.`);
        return null;
      }
      return (await response.json()) as unknown;
    } catch (error: unknown) {
      const cause = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Alpaca read failed for ${symbol}: ${cause}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

function toAlpacaTimeframe(timeframe: BarTimeframe): string {
  switch (timeframe) {
    case '1m':
      return '1Min';
    case '5m':
      return '5Min';
    case '15m':
      return '15Min';
    case '1h':
      return '1Hour';
    case '1d':
      return '1Day';
  }
}

function timeframeStepMs(timeframe: BarTimeframe): number {
  switch (timeframe) {
    case '1m':
      return 60_000;
    case '5m':
      return 5 * 60_000;
    case '15m':
      return 15 * 60_000;
    case '1h':
      return 60 * 60_000;
    case '1d':
      return 24 * 60 * 60_000;
  }
}