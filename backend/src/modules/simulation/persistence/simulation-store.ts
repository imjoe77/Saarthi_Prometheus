import type { Prisma } from '@prisma/client';
import type { PrismaClient, StrategyDailyBalance, StrategyFill } from '@prisma/client';

import { toIsoDay, fromIsoDay } from '../../market-data/domain/day-window';
import { simulate, type SimulationOptions } from '../engine/simulation-engine';
import type { SimulationRule } from '../rules/simulation-rule';

/**
 * MODULE 06b - reading the candle window and writing what a rule computed over
 * it.
 *
 * THE TRANSACTION IS REPLACE-ALL, AND THAT IS THE WHOLE POLICY. There is one
 * simulation per strategy, so a re-run deletes the previous curve and its fills
 * and daily balances in the same transaction that writes the new ones. A
 * half-written curve would be the worst possible state for this module: the Risk
 * Engine would measure a series the schema still describes as complete, and a
 * gap in it would read as a missing day of history rather than an interrupted
 * write. Either the previous curve or the new one is visible, never both and
 * never neither.
 *
 * WHY NOT KEEP THE OLD RUN. Run history needs a key of its own, a rule for
 * deciding which run Module 06 should measure, and a reason to compare two - and
 * nothing compares two today. Storing one curve and replacing it keeps the read
 * path free of a "latest" predicate that could silently disagree with itself.
 *
 * THE CANDLE QUERY IS THE ONLY MARKET-DATA READ OUTSIDE THE IMPORTER. It takes
 * the whole window for one symbol, ascending, and asks for exactly the two
 * columns the engine uses. Loading high, low, volume and the source filename
 * for a simulation would be four columns of memory nobody reads.
 */
export interface SimulationRecord {
  readonly strategyId: string;
  readonly ruleKey: string;
  readonly ruleVersion: number;
  readonly symbol: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly initialCash: Prisma.Decimal;
  readonly feeRate: Prisma.Decimal;
  readonly dayCount: number;
  readonly fillCount: number;
  readonly computedAt: Date;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly total: number;
}

function toRecord(row: {
  strategyId: string;
  ruleKey: string;
  ruleVersion: number;
  symbol: string;
  windowStart: Date;
  windowEnd: Date;
  initialCash: Prisma.Decimal;
  feeRate: Prisma.Decimal;
  dayCount: number;
  fillCount: number;
  computedAt: Date;
}): SimulationRecord {
  return {
    strategyId: row.strategyId,
    ruleKey: row.ruleKey,
    ruleVersion: row.ruleVersion,
    symbol: row.symbol,
    windowStart: toIsoDay(row.windowStart),
    windowEnd: toIsoDay(row.windowEnd),
    initialCash: row.initialCash,
    feeRate: row.feeRate,
    dayCount: row.dayCount,
    fillCount: row.fillCount,
    computedAt: row.computedAt,
  };
}

/**
 * Compute one rule over its symbol's whole history and store the result.
 *
 * The candle load happens before the transaction opens, so the write is short
 * and holds no lock while 1,932 rows are read. An empty window is a `404` rather
 * than an empty curve: "this symbol has no data" is a fact about the dataset,
 * and writing a zero-day simulation would record it as if a rule had produced
 * nothing.
 */
export async function runSimulation(
  prisma: PrismaClient,
  strategyId: string,
  rule: SimulationRule,
  options: SimulationOptions = {},
): Promise<SimulationRecord> {
  const candles = await prisma.marketCandle.findMany({
    where: { symbol: rule.symbol },
    orderBy: { day: 'asc' },
    select: { day: true, open: true, close: true },
  });

  if (candles.length === 0) {
    throw new Error(
      `rule '${rule.key}' needs candles for ${rule.symbol}, and the market data window has none`,
    );
  }

  const result = simulate(
    rule,
    candles.map((candle) => ({
      day: toIsoDay(candle.day),
      open: candle.open,
      close: candle.close,
    })),
    options,
  );

  return prisma.$transaction(async (tx) => {
    await tx.strategySimulation.deleteMany({ where: { strategyId } });

    await tx.strategySimulation.create({
      data: {
        strategyId,
        ruleKey: rule.key,
        ruleVersion: rule.version,
        symbol: result.symbol,
        windowStart: fromIsoDay(result.windowStart),
        windowEnd: fromIsoDay(result.windowEnd),
        initialCash: result.initialCash,
        feeRate: result.feeRate,
        dayCount: result.dayCount,
        fillCount: result.fills.length,
      },
    });

    if (result.fills.length > 0) {
      await tx.strategyFill.createMany({
        data: result.fills.map((fill) => ({
          simulationId: strategyId,
          sequenceNo: fill.sequenceNo,
          fillDay: fromIsoDay(fill.fillDay),
          side: fill.side,
          symbol: result.symbol,
          quantity: fill.quantity,
          price: fill.price,
          gross: fill.gross,
          fee: fill.fee,
          cashAfter: fill.cashAfter,
          note: fill.note,
        })),
      });
    }

    if (result.balances.length > 0) {
      await tx.strategyDailyBalance.createMany({
        data: result.balances.map((balance) => ({
          simulationId: strategyId,
          day: fromIsoDay(balance.day),
          cash: balance.cash,
          positionQty: balance.positionQty,
          positionValue: balance.positionValue,
          value: balance.value,
        })),
      });
    }

    return {
      strategyId,
      ruleKey: rule.key,
      ruleVersion: rule.version,
      symbol: result.symbol,
      windowStart: result.windowStart,
      windowEnd: result.windowEnd,
      initialCash: result.initialCash,
      feeRate: result.feeRate,
      dayCount: result.dayCount,
      fillCount: result.fills.length,
      computedAt: new Date(),
    };
  });
}

export async function findSimulation(
  prisma: PrismaClient,
  strategyId: string,
): Promise<SimulationRecord | null> {
  const row = await prisma.strategySimulation.findUnique({ where: { strategyId } });
  return row === null ? null : toRecord(row);
}

export async function pageFills(
  prisma: PrismaClient,
  strategyId: string,
  page: number,
  limit: number,
): Promise<Page<StrategyFill>> {
  const where = { simulationId: strategyId };
  const [items, total] = await Promise.all([
    prisma.strategyFill.findMany({
      where,
      orderBy: { sequenceNo: 'asc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.strategyFill.count({ where }),
  ]);
  return { items, total };
}

export async function pageBalances(
  prisma: PrismaClient,
  strategyId: string,
  page: number,
  limit: number,
): Promise<Page<StrategyDailyBalance>> {
  const where = { simulationId: strategyId };
  const [items, total] = await Promise.all([
    prisma.strategyDailyBalance.findMany({
      where,
      orderBy: { day: 'asc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.strategyDailyBalance.count({ where }),
  ]);
  return { items, total };
}
