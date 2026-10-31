import {
  StrategyStatus,
  StrategyVisibility,
  UserStatus,
  type PrismaClient,
  type Strategy,
} from '@prisma/client';

import type { ImportReport } from '../market-data/importer/import-report';
import { reportFailed } from '../market-data/importer/import-report';
import { importMarketData, type ImportOptions } from '../market-data/importer/market-data-importer';
import { runSimulation, type SimulationRecord } from './persistence/simulation-store';
import { SIMULATION_RULES, findRule } from './rules/rule-catalog';

/**
 * MODULE 06b - everything the project ships as "the demo data", in one
 * idempotent function.
 *
 * SEPARATE FROM `prisma/seed.ts` ON PURPOSE. That file seeds Module 03's asset
 * catalogue and is frozen; a `market:seed` script beside it means a developer
 * can re-import 1,932 candles and recompute three curves without touching the
 * asset seed, and the two can run in either order because neither depends on the
 * other. The same reasoning that put the logic in `src/` applies here: it is
 * linted, typechecked and importable by the integration suite, rather than being
 * a script only `ts-node` ever sees.
 *
 * FOUR STEPS, IN THE ORDER THAT FAILS CLEAREST. Owner, then the three expert
 * strategies, then the candle import, then the simulations. If the dataset is
 * broken the strategies still exist and are still correct - they are just
 * unsimulated until the data is fixed - which is a better failure than three
 * curves over a window nobody can see.
 *
 * NOTHING HERE IS A STRATEGY A USER WROTE. The owner is a system account with no
 * sign-in identity, and every description says in its first sentence that the
 * curve is paper. A reader who never opens the schema should still be unable to
 * mistake these for anybody's real positions.
 */
export const SEED_OWNER_EMAIL = 'system@prometheus.local';

export interface ExpertStrategySeed {
  readonly ruleKey: string;
  readonly name: string;
  readonly description: string;
}

export const EXPERT_STRATEGIES: readonly ExpertStrategySeed[] = [
  {
    ruleKey: 'buyhold-btc',
    name: 'Buy and Hold BTC',
    description:
      'Paper simulation over Binance BTCUSDT daily candles: buys once on the first available ' +
      'day and never sells. Simulated trades only - no orders are placed and no money moves.',
  },
  {
    ruleKey: 'sma-cross-eth',
    name: 'SMA 20/50 Crossover ETH',
    description:
      'Paper simulation over Binance ETHUSDT daily candles: long while the 20-day average sits ' +
      'above the 50-day average, flat otherwise. Simulated trades only - no orders are placed ' +
      'and no money moves.',
  },
  {
    ruleKey: 'donchian-sol',
    name: 'Donchian 20/10 Breakout SOL',
    description:
      'Paper simulation over Binance SOLUSDT daily candles: enters on a 20-day high breakout and ' +
      'exits on a 10-day low breakdown. Simulated trades only - no orders are placed and no ' +
      'money moves.',
  },
];

export interface SeededStrategy {
  readonly seed: ExpertStrategySeed;
  readonly strategy: Strategy;
  readonly simulation: SimulationRecord | null;
}

export interface MarketSeedResult {
  readonly ownerId: string;
  readonly importReport: ImportReport;
  readonly strategies: readonly SeededStrategy[];
  readonly simulations: readonly SimulationRecord[];
}

export type MarketSeedOptions = ImportOptions;

async function upsertOwner(prisma: PrismaClient): Promise<string> {
  const owner = await prisma.user.upsert({
    where: { email: SEED_OWNER_EMAIL },
    create: { email: SEED_OWNER_EMAIL, status: UserStatus.ACTIVE },
    update: { status: UserStatus.ACTIVE },
  });
  return owner.id;
}

/**
 * Find or create one expert strategy by its fixed name.
 *
 * A lookup by exact name rather than a generated key: the names are constants in
 * this file, so re-running the seed must land on the row it wrote last time
 * instead of accumulating a second "Buy and Hold BTC" on every run. Keeping the
 * owner in the where clause also keeps the match inside this account, which is
 * what makes the case-insensitive unique index on `(owner_id, lower(name))`
 * unreachable rather than merely unlikely.
 */
async function upsertStrategy(
  prisma: PrismaClient,
  ownerId: string,
  seed: ExpertStrategySeed,
): Promise<Strategy> {
  const existing = await prisma.strategy.findFirst({
    where: { ownerId, name: seed.name },
    orderBy: { createdAt: 'asc' },
  });

  if (existing === null) {
    return prisma.strategy.create({
      data: {
        ownerId,
        name: seed.name,
        description: seed.description,
        visibility: StrategyVisibility.PUBLIC,
        status: StrategyStatus.ACTIVE,
      },
    });
  }

  return prisma.strategy.update({
    where: { id: existing.id },
    data: {
      description: seed.description,
      visibility: StrategyVisibility.PUBLIC,
      status: StrategyStatus.ACTIVE,
    },
  });
}

/**
 * Import the candle dataset, seed the three expert strategies and simulate each.
 *
 * A failed import is returned, not thrown: the report *is* the diagnosis, and a
 * caller that wanted an exception would only re-format it. Callers that must not
 * continue check {@link reportFailed}.
 */
export async function seedMarketData(
  prisma: PrismaClient,
  options: MarketSeedOptions = {},
): Promise<MarketSeedResult> {
  const ownerId = await upsertOwner(prisma);

  const found: SeededStrategy[] = [];
  for (const seed of EXPERT_STRATEGIES) {
    const strategy = await upsertStrategy(prisma, ownerId, seed);
    found.push({ seed, strategy, simulation: null });
  }

  const importReport = await importMarketData(prisma, options);
  if (reportFailed(importReport)) {
    return { ownerId, importReport, strategies: found, simulations: [] };
  }

  const strategies: SeededStrategy[] = [];
  const simulations: SimulationRecord[] = [];

  for (const entry of found) {
    const rule = findRule(entry.seed.ruleKey);
    if (rule === null) {
      throw new Error(
        `expert strategy '${entry.seed.name}' references rule '${entry.seed.ruleKey}', which is not in the catalogue`,
      );
    }
    const simulation = await runSimulation(prisma, entry.strategy.id, rule);
    strategies.push({ ...entry, simulation });
    simulations.push(simulation);
  }

  return { ownerId, importReport, strategies, simulations };
}

/** Rule keys with no seeded strategy - a new rule cannot be silently unshipped. */
export function unsimulatedRuleKeys(): string[] {
  const seeded = new Set(EXPERT_STRATEGIES.map((seed) => seed.ruleKey));
  return SIMULATION_RULES.map((rule) => rule.key).filter((key) => !seeded.has(key));
}
