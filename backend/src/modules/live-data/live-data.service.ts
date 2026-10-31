import { HttpStatus, Inject, Injectable } from '@nestjs/common';

import { ERROR_CODES } from '../../common/constants/error-codes';
import { DomainException } from '../../common/errors/domain.exception';
import { findInstrument, LIVE_INSTRUMENTS, type MarketInstrument } from './instruments/instrument-catalogue';
import { isMarketOpen } from './market-state';
import {
  isQuoteAbsent,
  MARKET_DATA_PROVIDER,
  type BarTimeframe,
  type MarketDataProvider,
} from './providers/market-data-provider.port';
import { InstrumentDto } from './dto/instrument.dto';
import { QuoteDto } from './dto/quote.dto';
import { BarDto } from './dto/bar.dto';
import { BarsDto } from './dto/bars.dto';
import { FeedStatusDto } from './dto/feed-status.dto';

/** How long a cached bar list stays usable, in ms. */
const BARS_CACHE_TTL_MS = 30_000;

/**
 * MODULE 06c - the live market data service.
 *
 * THE THIN INTERPRETER. The providers are dumb pipes; every rule about what a
 * quote means lives here or in a pure helper this service imports. The
 * service's three concerns:
 *
 *  - SESSION AND FRESHNESS. `marketState` comes from the pure session rule and
 *    is reported even when there is no quote, because "the market is open and
 *    has said nothing" is different from "the market is closed". `stale` is
 *    computed against the instrument's own threshold, so the same service
 *    treats a 45-second-old stock quote as live and a 35-second-old crypto
 *    quote as stale without quoting the rule twice.
 *
 *  - ABSENCE IS A VALUE. A known symbol whose feed says nothing answers 200
 *    with `available: false` - never 404 (the symbol exists) and never an
 *    exception (nothing was malformed). Only `off` and an unknown symbol have
 *    distinct stories: `off` for *bars* is documented as a 503 because a chart
 *    with no possible content is a broken screen telling the user nothing,
 *    while a quote the page can simply report as absent stays a 200.
 *
 *  - ONE PLACE TO LABEL FICTION. `isDemo` is true exactly when the provider is
 *    the deterministic fake, copied onto every response that could be mistaken
 *    for real observations.
 */
@Injectable()
export class LiveDataService {
  private readonly barsCache = new Map<string, { bars: BarDto[]; fetchedAt: number }>();

  constructor(
    @Inject(MARKET_DATA_PROVIDER) private readonly provider: MarketDataProvider,
  ) {}

  instruments(): InstrumentDto[] {
    return LIVE_INSTRUMENTS.map((instrument) => InstrumentDto.from(instrument));
  }

  instrument(symbol: string): MarketInstrument {
    const instrument = findInstrument(symbol);
    if (!instrument) {
      throw DomainException.notFound('Instrument', symbol);
    }
    return instrument;
  }

  status(): FeedStatusDto {
    return FeedStatusDto.from(this.provider.mode);
  }

  async quote(symbol: string, at: Date): Promise<QuoteDto> {
    const instrument = this.instrument(symbol);
    const marketState = isMarketOpen(instrument.kind, at);
    const isDemo = this.provider.mode === 'fake';

    const raw = await this.provider.latestQuote(instrument, new Date());
    if (!raw) {
      return emptyQuote(symbol, this.provider.mode, marketState, isDemo);
    }
    if (isQuoteAbsent(raw)) {
      return emptyQuote(symbol, this.provider.mode, marketState, isDemo);
    }

    // STALENESS AND AVAILABILITY ARE TWO DIFFERENT FACTS.
    //
    // A quote older than the freshness threshold is stale, but it is still the
    // last price the market printed - after Friday's close a stock's quote is
    // Friday's close, and that is the real answer to "what is this worth". The
    // DTO documents both (`stale` alongside present prices), so `available`
    // reports whether the feed produced a price at all and `stale` reports how
    // old it is. Folding one into the other, as this once did, turned every
    // market-close snapshot into "no data" and could not be told apart from a
    // feed that had genuinely said nothing.
    const asOfMs = Date.parse(raw.asOf);
    const stale = Number.isNaN(asOfMs) ? true : at.getTime() - asOfMs > instrument.staleAfterMs;

    return {
      symbol,
      provider: this.provider.mode,
      available: true,
      price: midpoint(raw.bid, raw.ask) ?? null,
      bid: raw.bid ?? null,
      ask: raw.ask ?? null,
      asOf: raw.asOf,
      stale,
      marketState,
      isDemo,
    };
  }

  async bars(symbol: string, timeframe: BarTimeframe, limit: number, at: Date): Promise<BarsDto> {
    const instrument = this.instrument(symbol);

    if (this.provider.mode === 'off') {
      throw new DomainException(
        ERROR_CODES.SERVICE_UNAVAILABLE,
        'Live market data is disabled. Set MARKET_DATA_PROVIDER to enable the feed.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const isDemo = this.provider.mode === 'fake';
    const cacheKey = `${symbol}|${timeframe}|${limit}`;
    const cached = this.barsCache.get(cacheKey);
    if (cached && at.getTime() - cached.fetchedAt <= BARS_CACHE_TTL_MS) {
      return BarsDto.from(cached.bars, isDemo);
    }

    const liveBars = await this.provider.bars(instrument, timeframe, limit, at);
    const bars = liveBars.map((bar) => BarDto.from(bar));

    if (this.provider.mode === 'alpaca') {
      this.barsCache.set(cacheKey, { bars, fetchedAt: at.getTime() });
    }

    return BarsDto.from(bars, isDemo);
  }
}

function emptyQuote(
  symbol: string,
  provider: QuoteDto['provider'],
  marketState: QuoteDto['marketState'],
  isDemo: boolean,
): QuoteDto {
  return {
    symbol,
    provider,
    available: false,
    price: null,
    bid: null,
    ask: null,
    asOf: null,
    stale: false,
    marketState,
    isDemo,
  };
}

function midpoint(bid: string | undefined, ask: string | undefined): string | undefined {
  if (bid && ask) {
    const mid = (Number(bid) + Number(ask)) / 2;
    return String(mid);
  }
  return bid ?? ask;
}