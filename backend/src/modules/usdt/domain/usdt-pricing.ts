import { Prisma } from '@prisma/client';

import { DomainException } from '../../../common/errors/domain.exception';

/**
 * MODULE 08 — pure pricing arithmetic for the USDT exchange.
 *
 * PRICES COME FROM THE MARKET, NOT FROM CONSTANTS. The execution price starts
 * as the volume-weighted average of the CoinDCX USDT/INR order book for the
 * requested quantity (BUY walks asks, SELL walks bids), and the reference price
 * is a fresh CoinGecko competitor figure. Zero Prometheus brokerage holds by
 * construction: this module multiplies the market price through and never adds
 * a spread, fee or markup of its own.
 *
 * BEST-PRICE GUARANTEE. Being markup-free is necessary but not sufficient:
 * Prometheus also promises the customer a visibly better price than the screen,
 * so the book VWAP is then capped (BUY) or floored (SELL) by the best
 * *executable* price any fresh reference venue reports, a clear
 * {@link MIN_MARKET_ADVANTAGE_INR} inside it - see
 * {@link applyBestPriceGuarantee}. The bound is rounded one paise away from
 * the venue (floor on a BUY, ceil on a SELL), so the two-decimal price the API
 * returns can never give a paisa of that margin back or round into the venue it
 * was measured against. The margin is a *floor* on the advantage rather than a
 * levy: a book already further from the market than the margin passes through
 * untouched. The guarantee can only move the price toward the customer, never
 * away, and it is skipped entirely when the result would leave the sanity band
 * around the independent anchor.
 *
 * ROUNDING. Real order-book prices carry many decimal places, so the exact
 * product `usdtAmount x price` is almost never representable at the INR scale.
 * The settlement amount is therefore rounded HALF_UP to two decimal places
 * (paise) - the granularity of the currency, not a fee: the same rule applies
 * in both directions and retains no value for Prometheus. A conversion that
 * rounds to below one paise is refused rather than charged, so a dust order
 * can never move a balance for nothing.
 *
 * SAVINGS = volume x (reference - execution) on a BUY and volume x (execution
 * - reference) on a SELL - signed so that positive always means "the customer
 * is better off than the reference for the same direction and quantity". The
 * metric is a reference-price comparison only: never cash, never revenue, and
 * never computed from stale or fallback data (the caller suppresses it there).
 */

/// The side of a USDT exchange order.
export type UsdtOrderSide = 'BUY' | 'SELL';

/**
 * Display precision for the pair. Storage is always NUMERIC(38,18);
 * these mirror `SEED_ASSETS` (USDT 6 places, INR 2) and are presentation only.
 */
export const USDT_DECIMALS = 6;
export const INR_DECIMALS = 2;

/** The smallest settlement amount that may move a wallet, in INR. */
export const MIN_SETTLEMENT_INR = new Prisma.Decimal('0.01');

/** One order-book level: a price and the quantity offered at it. */
export interface BookLevel {
  price: Prisma.Decimal;
  quantity: Prisma.Decimal;
}

export interface UsdtQuote {
  side: UsdtOrderSide;
  usdtAmount: Prisma.Decimal;
  inrAmount: Prisma.Decimal;
  prometheusPrice: Prisma.Decimal;
  referencePrice: Prisma.Decimal | null;
  savings: Prisma.Decimal | null;
}

export interface VwapResult {
  /** Volume-weighted price across the consumed levels; null when the book cannot fill the quantity. */
  vwap: Prisma.Decimal | null;
  /** True when the levels cover the whole requested quantity. */
  sufficient: boolean;
}

/** Rounds an INR figure HALF_UP to the paise. */
export function roundInr(value: Prisma.Decimal): Prisma.Decimal {
  return value.toDecimalPlaces(INR_DECIMALS, Prisma.Decimal.ROUND_HALF_UP);
}

/**
 * Walks best-first book levels to fill `usdtAmount` and returns the
 * volume-weighted average price of the consumed levels.
 *
 * Levels must already be sorted best-first for the side (lowest ask for a
 * BUY, highest bid for a SELL). Zero-quantity levels contribute nothing. The
 * result is sufficient only when the levels cover the whole quantity, because
 * pricing part of an order at a known price and the rest at an unknown one
 * would be pricing nothing at all.
 */
export function walkBookVwap(levels: readonly BookLevel[], usdtAmount: Prisma.Decimal): VwapResult {
  if (!usdtAmount.isFinite() || usdtAmount.lte(0)) {
    throw DomainException.badRequest('amount must be greater than zero.');
  }

  let remaining = usdtAmount;
  let totalCost = new Prisma.Decimal(0);
  let totalQty = new Prisma.Decimal(0);

  for (const level of levels) {
    if (remaining.lte(0)) break;
    if (!level.price.isFinite() || !level.quantity.isFinite()) continue;
    if (level.price.lte(0) || level.quantity.lte(0)) continue;

    const take = Prisma.Decimal.min(remaining, level.quantity);
    totalCost = totalCost.plus(take.times(level.price));
    totalQty = totalQty.plus(take);
    remaining = remaining.minus(take);
  }

  if (remaining.gt(0) || totalQty.lte(0)) {
    return { vwap: null, sufficient: false };
  }

  return { vwap: totalCost.div(totalQty), sufficient: true };
}

/**
 * Converts a USDT quantity at an execution price into the INR settlement
 * amount, rounded HALF_UP to the paise.
 *
 * Refuses (rather than rounds) a conversion below one paise: `0.000001 USDT`
 * at any realistic price is a fraction of a paise, and charging it would move
 * a balance by an amount no quote ever showed.
 */
export function settlementAmount(usdtAmount: Prisma.Decimal, executionPrice: Prisma.Decimal): Prisma.Decimal {
  assertPositiveDecimal(usdtAmount, 'amount');
  assertPositiveDecimal(executionPrice, 'price');

  const inrAmount = roundInr(usdtAmount.times(executionPrice));

  if (inrAmount.lt(MIN_SETTLEMENT_INR)) {
    throw DomainException.badRequest(
      `The INR settlement amount (${inrAmount.toFixed()}) rounds below the minimum of ${MIN_SETTLEMENT_INR.toFixed(INR_DECIMALS)} INR.`,
    );
  }

  return inrAmount;
}

/**
 * Signed reference-price savings for the same direction and quantity.
 *
 * BUY: what the customer would have paid at the reference, minus what they
 * actually pay at the execution price. SELL: what they receive at the
 * execution price, minus what the reference would have paid. Positive always
 * means better off than the reference; null when no fresh reference exists
 * (the caller must not invent one).
 */
export function computeSavings(
  side: UsdtOrderSide,
  usdtAmount: Prisma.Decimal,
  executionPrice: Prisma.Decimal,
  referencePrice: Prisma.Decimal,
): Prisma.Decimal {
  assertPositiveDecimal(usdtAmount, 'amount');
  assertPositiveDecimal(executionPrice, 'price');
  assertPositiveDecimal(referencePrice, 'reference price');

  const difference = side === 'BUY' ? referencePrice.minus(executionPrice) : executionPrice.minus(referencePrice);
  return roundInr(usdtAmount.times(difference));
}

/**
 * True when `price` sits within `maxDevPct` percent of the sanity anchor.
 *
 * The anchor is the CoinGecko aggregate (or, failing that, the configured
 * fallback): both are independent of CoinDCX, so a mis-parsed or wildly wrong
 * execution price cannot pass unnoticed just because it is self-consistent.
 */
export function isWithinSanityBand(
  price: Prisma.Decimal,
  anchor: Prisma.Decimal,
  maxDevPct: number,
): boolean {
  if (!price.isFinite() || !anchor.isFinite() || anchor.lte(0) || price.lte(0)) {
    return false;
  }

  const deviationPct = price.minus(anchor).abs().div(anchor).times(100);
  return deviationPct.lte(new Prisma.Decimal(maxDevPct));
}

/**
 * Widest venue bid/ask spread the derivation below will trust, in percent.
 *
 * CoinGecko reports `bid_ask_spread_percentage` per ticker; above this figure
 * the number stops describing a tradeable pair and starts describing a broken
 * one, so the venue's raw last price is used instead of inventing an executable
 * price from it.
 */
export const MAX_DERIVABLE_SPREAD_PCT = new Prisma.Decimal('5');

/** How a venue's displayed price was derived - shown next to it, never hidden. */
export type VenuePriceBasis = 'derived_from_spread' | 'last_price';

export interface VenueExecutablePrice {
  venue: string;
  price: Prisma.Decimal;
  basis: VenuePriceBasis;
}

/**
 * The price a customer could actually transact at on a reference venue, for
 * the side we are pricing.
 *
 * A venue's `last` is a trade print, not an offer: on a BUY the customer pays
 * the ask (half a spread above the print), on a SELL they receive the bid (half
 * a spread below it). CoinGecko's own `bid_ask_spread_percentage` supplies the
 * width - `(ask - bid) / mid` - so half of it, applied to `last`, recovers the
 * offer to within the print's own lag. Where no spread is reported (ZebPay) or
 * it is implausible, the raw last price is returned and flagged
 * `last_price`: a print is a *floor* on a venue's ask and a *ceiling* on its
 * bid, so using it keeps the guarantee conservative rather than generous.
 *
 * Never estimated upward: nothing here can make a venue look cheaper than it
 * is, which would weaken the very guarantee it feeds.
 */
export function venueExecutablePrice(
  side: UsdtOrderSide,
  venue: string,
  lastPrice: Prisma.Decimal,
  bidAskSpreadPct: Prisma.Decimal | null,
): VenueExecutablePrice {
  assertPositiveDecimal(lastPrice, `${venue} last price`);

  const derivable =
    bidAskSpreadPct !== null &&
    bidAskSpreadPct.isFinite() &&
    bidAskSpreadPct.gte(0) &&
    bidAskSpreadPct.lte(MAX_DERIVABLE_SPREAD_PCT);

  if (!derivable) {
    return { venue, price: lastPrice, basis: 'last_price' };
  }

  const halfSpread = bidAskSpreadPct.div(200);
  const price =
    side === 'BUY' ? lastPrice.times(new Prisma.Decimal(1).plus(halfSpread)) : lastPrice.times(new Prisma.Decimal(1).minus(halfSpread));

  return { venue, price, basis: 'derived_from_spread' };
}

export interface BestPriceGuarantee {
  /** The price the customer may be charged: the book VWAP, or better. */
  price: Prisma.Decimal;
  /** True when a venue beat the book and the price moved toward the customer. */
  applied: boolean;
  /** The venue whose offer the price was measured against; null when not applied. */
  matchedVenue: string | null;
  /** That venue's offer before the advantage and paise rounding; null when not applied. */
  matchedPrice: Prisma.Decimal | null;
}

/**
 * Minimum gap, in rupees, Prometheus insists on between its price and the best
 * venue on screen - the "always at least ₹1.50 better than the market" rule.
 *
 * It is a *minimum*: when the book is already more than that clear of every
 * venue, the book wins untouched, because charging a customer more than the
 * market to look generous would be absurd. It only ever binds when the book is
 * within the margin of the market (or worse than it), where the price is moved
 * to {@link MIN_MARKET_ADVANTAGE_INR} clear of the best offer.
 */
export const MIN_MARKET_ADVANTAGE_INR = new Prisma.Decimal('1.50');

/**
 * Caps (BUY) or floors (SELL) the book VWAP so Prometheus sits a clear
 * {@link MIN_MARKET_ADVANTAGE_INR} inside the best offer on the screen.
 *
 * This is the whole "Prometheus is never the expensive row" promise in one
 * function. A BUY takes the minimum of the book VWAP and every venue's ask less
 * the margin; a SELL takes the maximum of the book VWAP and every venue's bid
 * plus the same margin. The bound is then rounded one paise *away from the
 * venue* (floor on a BUY, ceil on a SELL) because the API renders the price at
 * two decimals: a HALF_UP rounding could otherwise give back a paisa of the
 * margin and leave the gap short of it.
 *
 * The margin is a floor on the advantage, never a levy: a book already further
 * from the market than this passes through unchanged, so the customer keeps any
 * better price the depth actually offered.
 *
 * With no venues the book VWAP passes through untouched - absent data is never
 * a reason to invent a better price, and never a reason to show a worse one.
 */
export function applyBestPriceGuarantee(
  side: UsdtOrderSide,
  bookPrice: Prisma.Decimal,
  venues: readonly VenueExecutablePrice[],
  minimumAdvantageInr: Prisma.Decimal = MIN_MARKET_ADVANTAGE_INR,
): BestPriceGuarantee {
  assertPositiveDecimal(bookPrice, 'book price');
  if (venues.length === 0) {
    return { price: bookPrice, applied: false, matchedVenue: null, matchedPrice: null };
  }

  let best: VenueExecutablePrice | null = null;
  for (const candidate of venues) {
    if (best === null) {
      best = candidate;
      continue;
    }
    const better = side === 'BUY' ? candidate.price.lt(best.price) : candidate.price.gt(best.price);
    if (better) best = candidate;
  }
  if (best === null) {
    return { price: bookPrice, applied: false, matchedVenue: null, matchedPrice: null };
  }

  const bound =
    side === 'BUY'
      ? best.price
          .minus(minimumAdvantageInr)
          .toDecimalPlaces(INR_DECIMALS, Prisma.Decimal.ROUND_FLOOR)
      : best.price
          .plus(minimumAdvantageInr)
          .toDecimalPlaces(INR_DECIMALS, Prisma.Decimal.ROUND_CEIL);

  const improved = side === 'BUY' ? bound.lt(bookPrice) : bound.gt(bookPrice);
  if (!improved) {
    return { price: bookPrice, applied: false, matchedVenue: null, matchedPrice: null };
  }

  return { price: bound, applied: true, matchedVenue: best.venue, matchedPrice: best.price };
}


/**
 * Prices a USDT amount at the supplied market prices.
 *
 * Pure: amounts are validated by the caller at the USDT scale (Module 03's
 * `normaliseAmount`), and this function adds the pair's own rules - the
 * settlement rounding, the minimum settlement, and a null-safe reference.
 * A null referencePrice yields a null savings: no comparable data means no
 * claimed saving, never a fabricated one.
 */
export function quoteUsdt(
  side: UsdtOrderSide,
  usdtAmount: Prisma.Decimal,
  executionPrice: Prisma.Decimal,
  referencePrice: Prisma.Decimal | null,
): UsdtQuote {
  assertPositiveDecimal(usdtAmount, 'amount');
  assertPositiveDecimal(executionPrice, 'price');

  const inrAmount = settlementAmount(usdtAmount, executionPrice);
  const savings =
    referencePrice === null ? null : computeSavings(side, usdtAmount, executionPrice, referencePrice);

  return {
    side,
    usdtAmount,
    inrAmount,
    prometheusPrice: executionPrice,
    referencePrice,
    savings,
  };
}

function assertPositiveDecimal(value: Prisma.Decimal, label: string): void {
  if (!value.isFinite() || value.lte(0)) {
    throw DomainException.badRequest(`${label} must be greater than zero.`);
  }
}
