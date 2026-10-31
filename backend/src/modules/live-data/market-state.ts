/**
 * MODULE 06c - whether an instrument's market is open right now.
 *
 * COMPUTED, NOT QUERIED. There is deliberately no call to any provider's clock
 * endpoint: the decision the module needs - could a market order fill *right
 * now* - is a settlement rule, not a feed fact, and computing it locally keeps
 * this module independent of a network call whose only purpose would be to
 * reproduce a wall clock.
 *
 * THE RULE IS DELIBERATELY CONSERVATIVE. A `STOCK` fill is permitted only
 * within the regular US cash session, 09:30-16:00 America/New_York, Monday to
 * Friday, with no intraday halts and no allowance for pre/post-market hours -
 * even though an exchange feed may quote them. Approving a fill in a period the
 * rule says nothing about would be the classic configuration error of assuming
 * the feed's honesty, so the rule defaults to CLOSED outside the window it
 * states. The 09:30-16:00 window is a stated, documented assumption; when a
 * future module wants exchange-triggered precision it can add a finer source,
 * but this file is where the default lives.
 *
 * CRYPTO TRADES 24/7, so `CRYPTO` is always OPEN by definition.
 */
export const US_EQUITY_MARKET_TIME_ZONE = 'America/New_York';

export const US_EQUITY_OPEN_MINUTE = 9 * 60 + 30; // 09:30
export const US_EQUITY_CLOSE_MINUTE = 16 * 60; // 16:00

export type MarketState = 'OPEN' | 'CLOSED';

export type InstrumentKind = 'STOCK' | 'CRYPTO';

const WEEKDAY_BY_NAME = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export interface ZonedClock {
  /** 0 = Sunday .. 6 = Saturday, in the target time zone. */
  readonly weekday: number;
  /** Minutes since midnight in the target time zone. */
  readonly minutes: number;
}

/**
 * Reads the wall clock of `timeZone` for `at`, without building a date string.
 *
 * `Intl.DateTimeFormat#formatToParts` is the only Date API that reliably
 * answers "what time is it in New York" without the caller reimplementing DST
 * transitions. `hourCycle: 'h23'` is used instead of `hour12: false` because
 * the `hour12` form has rendered `24` for local midnight in some V8 versions.
 */
export function zonedClock(at: Date, timeZone: string = US_EQUITY_MARKET_TIME_ZONE): ZonedClock {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);

  const values = new Map(parts.map((part) => [part.type, part.value]));
  const weekdayName = values.get('weekday') ?? '';
  const hour = Number(values.get('hour') ?? '0');
  const minute = Number(values.get('minute') ?? '0');

  return {
    weekday: Math.max(0, WEEKDAY_BY_NAME.indexOf(weekdayName as (typeof WEEKDAY_BY_NAME)[number])),
    minutes: hour * 60 + minute,
  };
}

export function isMarketOpen(
  kind: InstrumentKind,
  at: Date,
  timeZone: string = US_EQUITY_MARKET_TIME_ZONE,
): MarketState {
  if (kind === 'CRYPTO') {
    return 'OPEN';
  }

  const { weekday, minutes } = zonedClock(at, timeZone);
  const weekdayOpen = weekday >= 1 && weekday <= 5;

  if (!weekdayOpen) {
    return 'CLOSED';
  }

  return minutes >= US_EQUITY_OPEN_MINUTE && minutes < US_EQUITY_CLOSE_MINUTE ? 'OPEN' : 'CLOSED';
}