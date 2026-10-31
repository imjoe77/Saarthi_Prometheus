import type { BarTimeframe, LiveBar, LiveQuote } from '../market-data-provider.port';

/**
 * MODULE 06c - decode Alpaca REST payloads into this module's canonical types.
 *
 * A NORMALIZER ACCEPTS THE SHAPE THE PROVIDER REALLY SENDS, which is why it is
 * a pure function with a unit test instead of a cast inside the provider: the
 * two market-data families the module reads - equities and crypto - share a
 * *schema* but differ enough (a map of quotes vs a list of bars, with a few
 * optional per-bar fields) that a single decoder with tests is worth more than
 * two ad-hoc `as` casts.
 *
 * THE OUTPUT IS EXACTLY WHAT THE SOURCE SAID. Every price travels as a decimal
 * string so a downstream `Decimal` starts from the digits the source printed,
 * not from a binary double. Unknown or malformed payloads yield an empty list -
 * absence, never a thrown shape - so a changed upstream field turns into "no
 * quote right now" instead of a 500.
 */

interface AlpacaLatestQuotesPayload {
  quotes?: Record<string, { t?: number | string; ap?: number | string | null; bp?: number | string | null }>;
}

/**
 * Decodes the `latest quotes` response shared by the equities and crypto
 * endpoints (`/v2/stocks/quotes/latest` and `/v1beta3/crypto/us/latest/quotes`).
 *
 * Both endpoints return the same envelope: `{ quotes: { SYMBOL: { t, ap, bp } } }`,
 * where `ap`/`bp` are the ask and bid and `t` is an epoch-millis timestamp. A
 * quote with neither price is dropped; a symbol the request ignored produces no
 * entry at all.
 */
export function normalizeLatestQuotes(payload: unknown): LiveQuote[] {
  const envelope = payload as AlpacaLatestQuotesPayload;
  const rawQuotes = envelope?.quotes;
  if (!rawQuotes) {
    return [];
  }

  const quotes: LiveQuote[] = [];
  for (const [symbol, quote] of Object.entries(rawQuotes)) {
    const bid = optionalNumberString(quote?.bp);
    const ask = optionalNumberString(quote?.ap);
    if (bid === undefined && ask === undefined) {
      continue;
    }
    quotes.push({
      symbol,
      bid,
      ask,
      asOf: epochToIso(quote?.t),
    });
  }
  return quotes;
}

interface AlpacaRawBar {
  t?: number | string;
  o?: number | string;
  h?: number | string;
  l?: number | string;
  c?: number | string;
  v?: number | string;
  s?: string;
}

interface AlpacaBarsPayload {
  bars?: AlpacaRawBar[] | Record<string, AlpacaRawBar[] | null> | null;
}

/**
 * Decodes the `bars` response shared by the equities and crypto endpoints
 * (`/v2/stocks/{symbol}/bars` and `/v1beta3/crypto/us/bars`).
 *
 * THE ENVELOPE IS A MAP, NOT A LIST. Both endpoints answer
 * `{ bars: { SYMBOL: [ ... ] } }`, keyed by the requested symbol. The equities
 * route echoes a single top-level `symbol` alongside the map; the crypto route
 * does not. A legacy list payload is still accepted so a future upstream
 * reshape degrades to "no bars" rather than to a thrown shape.
 *
 * `symbol` and `timeframe` are supplied by the caller and only a per-bar `s`
 * overrides the symbol, because neither is carried inside the bar itself. A bar
 * without an open timestamp or a close price cannot be a bar and is dropped.
 * A key whose value is `null` means "no bars for that symbol" - absence, not an
 * error, so it decodes to nothing.
 */
export function normalizeBars(payload: unknown, symbol: string, timeframe: BarTimeframe): LiveBar[] {
  const envelope = payload as AlpacaBarsPayload;
  const rawBars = flattenBars(envelope?.bars, symbol);
  if (rawBars === null) {
    return [];
  }

  const bars: LiveBar[] = [];
  for (const bar of rawBars.bars) {
    const time = epochToIso(bar?.t);
    const open = bar?.o;
    const close = bar?.c;
    if (time === '' || open === undefined || close === undefined) {
      continue;
    }
    bars.push({
      // A per-bar `s` is the upstream's own spelling; otherwise the matched map
      // key carries the canonical casing, which beats echoing back however the
      // caller happened to type the request.
      symbol: bar.s ?? rawBars.symbol,
      timeframe,
      time,
      open: toDecimalString(open),
      high: toDecimalString(bar.h),
      low: toDecimalString(bar.l),
      close: toDecimalString(close),
      volume: bar.v === undefined ? '0' : toDecimalString(bar.v),
    });
  }
  return bars.sort((a, b) => a.time.localeCompare(b.time));
}

/**
 * Collapses either payload shape to one flat bar list, with the symbol the
 * source used for it.
 *
 * Alpaca keys the bars map by the symbol it answered for, which is the request
 * symbol with any casing the upstream prefers. The requested symbol is matched
 * case-insensitively, so `btc/usd` finds `BTC/USD`; when the map holds exactly
 * one entry it is taken outright, because a single-symbol route has nothing else
 * it could mean. A legacy bare list carries no key, so the caller's symbol is
 * the only one available for it.
 */
function flattenBars(
  bars: AlpacaBarsPayload['bars'],
  symbol: string,
): { bars: AlpacaRawBar[]; symbol: string } | null {
  if (bars == null) {
    return null;
  }
  if (Array.isArray(bars)) {
    return { bars, symbol };
  }
  if (typeof bars !== 'object') {
    return null;
  }

  const entries = Object.entries(bars);
  if (entries.length === 0) {
    return { bars: [], symbol };
  }

  const wanted = symbol.trim().toLowerCase();
  const exact = entries.find(([key]) => key.trim().toLowerCase() === wanted);
  const [key, value] = exact ?? (entries.length === 1 ? entries[0]! : [undefined, undefined]);
  if (key === undefined || value == null) {
    return { bars: [], symbol };
  }
  return { bars: Array.isArray(value) ? value : [], symbol: key };
}

function optionalNumberString(value: number | string | null | undefined): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return toDecimalString(value);
}

/**
 * Renders an epoch numeric value (seconds or milliseconds, both appear in
 * Alpaca responses) or an already-ISO string as RFC 3339 UTC. Returns empty
 * string when the value is not a usable timestamp.
 */
function epochToIso(value: number | string | undefined): string {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? '' : new Date(parsed).toISOString();
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '';
  }
  const ms = value > 1_000_000_000_000 ? value : value * 1000; // s vs ms
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

function toDecimalString(value: number | string | undefined | null): string {
  if (value === undefined || value === null) {
    return '0';
  }
  return typeof value === 'number' ? String(value) : value;
}