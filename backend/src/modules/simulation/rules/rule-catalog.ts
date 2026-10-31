import { Prisma } from '@prisma/client';

import type { Desire, SimulationRule } from './simulation-rule';

/**
 * MODULE 06b - the three rules the seeded strategies run, written out in full.
 *
 * EVERY ASSUMPTION IS STATED, BECAUSE NONE OF THEM IS A FACT. The dataset
 * carries no fees, no slippage and no borrow cost, so the engine's fee rate is
 * an input these rules do not choose and the seed records alongside each
 * simulation. What the rules *do* choose is the signal itself, and each one is
 * deliberately the most defensible reading of its own idea rather than a tuned
 * variant: a demonstration curve that has been fitted to the period it is drawn
 * over would teach the opposite of what an equity curve is for.
 *
 * LOOK-AHEAD BIAS IS THE ONE THING EVERY RULE HERE IS BUILT AROUND. `desire(t)`
 * reads closes through `t` and nothing later; the engine fills at the next
 * open. Reading `t + 1` would be knowing tomorrow's close before trading
 * tomorrow's open, and it would flatter every curve by an amount nobody could
 * ever collect.
 */

function requireAt(closes: readonly Prisma.Decimal[], index: number): Prisma.Decimal {
  const value = closes[index];
  if (value === undefined) {
    throw new Error(
      `rule read closes[${index}] outside a window of ${closes.length} - the engine must ` +
        'only call desire() for indices it has loaded',
    );
  }
  return value;
}

/** Simple average of the `period` closes ending at (and including) `end`. */
function simpleAverage(
  closes: readonly Prisma.Decimal[],
  end: number,
  period: number,
): Prisma.Decimal {
  let sum = new Prisma.Decimal(0);
  for (let index = end - period + 1; index <= end; index += 1) {
    sum = sum.plus(requireAt(closes, index));
  }
  return sum.div(period);
}

function rollingMax(closes: readonly Prisma.Decimal[], from: number, to: number): Prisma.Decimal {
  let result = requireAt(closes, from);
  for (let index = from + 1; index <= to; index += 1) {
    result = Prisma.Decimal.max(result, requireAt(closes, index));
  }
  return result;
}

function rollingMin(closes: readonly Prisma.Decimal[], from: number, to: number): Prisma.Decimal {
  let result = requireAt(closes, from);
  for (let index = from + 1; index <= to; index += 1) {
    result = Prisma.Decimal.min(result, requireAt(closes, index));
  }
  return result;
}

const BUYHOLD_BTC: SimulationRule = {
  key: 'buyhold-btc',
  version: 1,
  symbol: 'BTCUSDT',
  enterNote: 'initial_allocation',
  exitNote: 'never_exits',
  /**
   * Buy everything on the first fillable day and never form an exit opinion.
   *
   * Day 1's close is the first close a signal can be computed from, so `t = 0`
   * is what puts the order in for day 2's open - the earliest this dataset lets
   * anybody be long. Every later day answers `hold` rather than `long`: the
   * distinction is what proves the rule has no exit, because a rule that kept
   * answering `long` would be relying on the engine to ignore it.
   */
  desire(_closes: readonly Prisma.Decimal[], t: number): Desire {
    return t === 0 ? 'long' : 'hold';
  },
};

const SMA_CROSS_ETH: SimulationRule = {
  key: 'sma-cross-eth',
  version: 1,
  symbol: 'ETHUSDT',
  enterNote: 'sma_cross_up',
  exitNote: 'sma_cross_down',
  /**
   * 20-day average above the 50-day average means be long; otherwise be out.
   *
   * The first possible opinion needs 50 closes, which is day 50 (`t = 49`). The
   * 49 days before it answer `hold`, not `flat`: with no opinion yet, a rule
   * that said `flat` would be instructing the engine to close a position it
   * could not have opened, and `hold` is the honest answer to "too early to
   * know".
   *
   * Equal averages are `flat`. A crossover that has not crossed is not a signal,
   * and treating equality as a buy would make the rule fire on a coincidence of
   * rounding.
   */
  desire(closes: readonly Prisma.Decimal[], t: number): Desire {
    const SLOW_PERIOD = 50;
    if (t + 1 < SLOW_PERIOD) {
      return 'hold';
    }

    const fast = simpleAverage(closes, t, 20);
    const slow = simpleAverage(closes, t, SLOW_PERIOD);
    return fast.gt(slow) ? 'long' : 'flat';
  },
};

const DONCHIAN_SOL: SimulationRule = {
  key: 'donchian-sol',
  version: 1,
  symbol: 'SOLUSDT',
  enterNote: 'donchian_breakout_up',
  exitNote: 'donchian_breakout_down',
  /**
   * A 20-day ceiling break opens the position; a 10-day floor break closes it.
   *
   * The two windows are different lengths on purpose: a 20-day entry needs a
   * meaningful stretch of consolidation to break out of, while a 10-day exit
   * gets the position out quickly once it turns. Both are the usual reading of
   * a Donchian channel rather than a tuned pair - the exit being *tighter* than
   * the entry is the point of the strategy, not an optimisation of it.
   *
   * Before day 20 there is no 20-day window to compare against, so the rule
   * answers `hold`. After that, neither firing also answers `hold`: the rule
   * has no opinion today, which is not the same as instructing an exit.
   *
   * The two conditions cannot both be true. The 10-day window is contained in
   * the 20-day one, so `max(20) >= min(10)`; a close above `max(20)` is
   * therefore above `min(10)` and cannot also be below it. Checking the entry
   * first is deterministic and cannot shadow an exit.
   */
  desire(closes: readonly Prisma.Decimal[], t: number): Desire {
    const ENTER_PERIOD = 20;
    const EXIT_PERIOD = 10;
    if (t < ENTER_PERIOD) {
      return 'hold';
    }

    const current = requireAt(closes, t);
    if (current.gt(rollingMax(closes, t - ENTER_PERIOD, t - 1))) {
      return 'long';
    }

    if (current.lt(rollingMin(closes, t - EXIT_PERIOD, t - 1))) {
      return 'flat';
    }

    return 'hold';
  },
};

/**
 * Every rule this project ships, in catalogue order.
 *
 * The array is the catalogue: `rule-catalog` lookups are by key, and the seed
 * walks this list to create exactly the strategies that have a rule. A rule
 * that is not in this list cannot be run, and a strategy that has no rule here
 * simply has no simulation - which is what the read API reports as 404 rather
 * than inventing.
 */
export const SIMULATION_RULES: readonly SimulationRule[] = [
  BUYHOLD_BTC,
  SMA_CROSS_ETH,
  DONCHIAN_SOL,
];

const BY_KEY = new Map(SIMULATION_RULES.map((rule) => [rule.key, rule]));

export function findRule(key: string): SimulationRule | null {
  return BY_KEY.get(key) ?? null;
}

export function ruleKeys(): string[] {
  return SIMULATION_RULES.map((rule) => rule.key);
}
