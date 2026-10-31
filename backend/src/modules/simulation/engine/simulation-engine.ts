import { Prisma } from '@prisma/client';

import type { Desire, SimulationRule } from '../rules/simulation-rule';

/**
 * MODULE 06b - the deterministic paper-trading engine.
 *
 * ONE RULE, THREE INPUTS, NO RANDOMNESS. A rule, an ordered series of candles
 * and two constants (starting cash and a fee rate) determine every fill and
 * every balance exactly. There is no clock, no random seed and no floating
 * point: money is `Decimal` end to end, so running the same simulation twice -
 * or on another machine, or in 2030 - produces byte-identical rows. That is the
 * whole requirement for a curve the Risk Engine will later measure.
 *
 * THE TIMING CONTRACT, in one sentence: a decision made at the close of day `t`
 * executes at the open of day `t + 1`, and only if day `t + 1` exists. Trading
 * the close you just decided on is impossible, and trading an open you have
 * already seen is not trading - so the engine fills strictly one step behind
 * the signal and refuses to fill where there is no next candle at all.
 *
 * NOTHING HERE IS A TRADE. Every number is paper cash denominated in paper
 * USDT. The schema, the response DTOs and this comment all say so because the
 * one thing this module must never do is look like a record of something that
 * happened to anybody.
 *
 * PRECISION, stated once and enforced by the two helpers below:
 *  - Quantity is truncated to 8 decimal places *before* any arithmetic uses it.
 *    Eight is the native precision of the source prices; a fraction finer than
 *    that cannot be bought, so keeping it would let a fee be computed on units
 *    that do not exist.
 *  - Cash is rounded to 18 decimal places after every fill, half-up. NUMERIC is
 *    exact, so the rounding is a choice about the shape of the ledger rather
 *    than a loss - and it is what keeps `value = cash + position_value` true in
 *    the database instead of true within an epsilon.
 *  - Fees are rounded to 18 places before they are deducted, for the same
 *    reason: the deduction and the stored fee must be the same number.
 */
const QUANTITY_DECIMAL_PLACES = 8;
const MONEY_DECIMAL_PLACES = 18;

/** Paper starting balance for every seeded simulation: 100,000 USDT. */
export const DEFAULT_INITIAL_CASH = new Prisma.Decimal('100000');

/**
 * The assumed taker fee: 0.1 % of notional.
 *
 * AN ASSUMPTION, NOT A MEASUREMENT. The dataset has no fee column and Binance
 * fees depend on tier and membership, so this is a stated constant the seed
 * stores on every simulation row. It is deliberately round rather than fitted to
 * anything, because a fee picked to make a curve look better would be the same
 * sin as a tuned rule.
 */
export const DEFAULT_FEE_RATE = new Prisma.Decimal('0.001');

/** Round to the ledger's 18 places, half-up - the shape every stored money value has. */
export function roundMoney(value: Prisma.Decimal): Prisma.Decimal {
  return new Prisma.Decimal(value.toFixed(MONEY_DECIMAL_PLACES, Prisma.Decimal.ROUND_HALF_UP));
}

/** Drop everything past the 8 places a source price can express, toward zero. */
export function truncateQuantity(value: Prisma.Decimal): Prisma.Decimal {
  return new Prisma.Decimal(value.toFixed(QUANTITY_DECIMAL_PLACES, Prisma.Decimal.ROUND_DOWN));
}

/** The slice of a candle this engine actually uses: enough to fill and to mark. */
export interface SimulationCandle {
  /** UTC calendar day the bar covers. */
  readonly day: string;
  /** The price every decision made on the previous day executes against. */
  readonly open: Prisma.Decimal;
  /** The price every balance is marked at. */
  readonly close: Prisma.Decimal;
}

export interface SimulatedFill {
  /** 1-based, assigned in chronological order. */
  readonly sequenceNo: number;
  /** The day the fill executed on - always the day after the signal. */
  readonly fillDay: string;
  readonly side: 'BUY' | 'SELL';
  readonly quantity: Prisma.Decimal;
  readonly price: Prisma.Decimal;
  readonly gross: Prisma.Decimal;
  readonly fee: Prisma.Decimal;
  readonly cashAfter: Prisma.Decimal;
  readonly note: string;
}

export interface SimulatedDayBalance {
  readonly day: string;
  readonly cash: Prisma.Decimal;
  readonly positionQty: Prisma.Decimal;
  readonly positionValue: Prisma.Decimal;
  readonly value: Prisma.Decimal;
}

export interface SimulationResult {
  readonly symbol: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly initialCash: Prisma.Decimal;
  readonly feeRate: Prisma.Decimal;
  readonly dayCount: number;
  readonly fills: readonly SimulatedFill[];
  readonly balances: readonly SimulatedDayBalance[];
}

export interface SimulationOptions {
  readonly initialCash?: Prisma.Decimal;
  readonly feeRate?: Prisma.Decimal;
}

type PendingOrder = { readonly kind: 'buy' } | { readonly kind: 'sell' } | null;

function requireCandle(
  candles: readonly SimulationCandle[],
  index: number,
): SimulationCandle {
  const candle = candles[index];
  if (candle === undefined) {
    throw new Error(
      `simulation read candles[${index}] outside a series of ${candles.length} - the engine ` +
        'must only step through indices it has loaded',
    );
  }
  return candle;
}

/**
 * Run one rule over one series of candles and produce every fill and every
 * daily balance.
 *
 * The loop walks the window once. At each day it (1) executes the order the
 * *previous* day's opinion produced, (2) marks the position at this day's close
 * and records the balance, then (3) forms today's opinion for tomorrow. That
 * order is the timing contract expressed as code: the balance for a day always
 * reflects a fill made at that day's open and never one that will be made at the
 * next day's open.
 *
 * An empty series is a programming error rather than a result - there is no
 * window, so there is nothing to report and no honest `windowStart`.
 */
export function simulate(
  rule: SimulationRule,
  candles: readonly SimulationCandle[],
  options: SimulationOptions = {},
): SimulationResult {
  if (candles.length === 0) {
    throw new Error(`cannot simulate rule '${rule.key}' over an empty candle series`);
  }

  const initialCash = roundMoney(options.initialCash ?? DEFAULT_INITIAL_CASH);
  const feeRate = options.feeRate ?? DEFAULT_FEE_RATE;
  const onePlusFee = new Prisma.Decimal(1).plus(feeRate);

  const closes = candles.map((candle) => candle.close);
  const fills: SimulatedFill[] = [];
  const balances: SimulatedDayBalance[] = [];

  let cash = initialCash;
  let quantity = new Prisma.Decimal(0);
  let pending: PendingOrder = null;

  for (let t = 0; t < candles.length; t += 1) {
    const candle = requireCandle(candles, t);

    if (pending?.kind === 'buy') {
      // All-in: the largest whole position the cash can fund *including* the
      // fee, so the ledger can never go negative by an amount of rounding.
      const affordable = truncateQuantity(cash.dividedBy(onePlusFee).dividedBy(candle.open));
      if (affordable.gt(0)) {
        const gross = affordable.times(candle.open);
        const fee = roundMoney(gross.times(feeRate));
        const nextCash = roundMoney(cash.minus(gross).minus(fee));
        if (!nextCash.lt(0)) {
          cash = nextCash;
          quantity = affordable;
          fills.push({
            sequenceNo: fills.length + 1,
            fillDay: candle.day,
            side: 'BUY',
            quantity: affordable,
            price: candle.open,
            gross,
            fee,
            cashAfter: cash,
            note: rule.enterNote,
          });
        }
      }
    } else if (pending?.kind === 'sell' && quantity.gt(0)) {
      const gross = quantity.times(candle.open);
      const fee = roundMoney(gross.times(feeRate));
      cash = roundMoney(cash.plus(gross).minus(fee));
      fills.push({
        sequenceNo: fills.length + 1,
        fillDay: candle.day,
        side: 'SELL',
        quantity,
        price: candle.open,
        gross,
        fee,
        cashAfter: cash,
        note: rule.exitNote,
      });
      quantity = new Prisma.Decimal(0);
    }
    pending = null;

    const positionValue = roundMoney(quantity.times(candle.close));
    const value = roundMoney(cash.plus(positionValue));
    balances.push({
      day: candle.day,
      cash,
      positionQty: quantity,
      positionValue,
      value,
    });

    // The last day has no open to execute against, so its opinion is never
    // formed: a signal nobody can act on would be a fill the window does not
    // contain.
    if (t === candles.length - 1) {
      break;
    }

    const desire: Desire = rule.desire(closes, t);
    if (desire === 'long' && quantity.lte(0)) {
      pending = { kind: 'buy' };
    } else if (desire === 'flat' && quantity.gt(0)) {
      pending = { kind: 'sell' };
    }
  }

  const first = requireCandle(candles, 0);
  const last = requireCandle(candles, candles.length - 1);

  return {
    symbol: rule.symbol,
    windowStart: first.day,
    windowEnd: last.day,
    initialCash,
    feeRate,
    dayCount: balances.length,
    fills,
    balances,
  };
}
