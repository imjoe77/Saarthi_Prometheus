import { PrismaClient } from '@prisma/client';

import { reportFailed, summariseReport } from '../src/modules/market-data/importer/import-report';
import { seedMarketData } from '../src/modules/simulation/market-seed';

/**
 * `npm run market:seed` entry point.
 *
 * Deliberately thin, and deliberately *not* `prisma/seed.ts`: that file seeds the
 * asset catalogue and is frozen, while this one imports 1,932 historical candles
 * and recomputes three simulations. Keeping them apart means either can be run
 * without the other, in either order, and neither can break the other by being
 * edited.
 *
 * Exit code is the contract. A report with a fatal finding prints every finding
 * and exits 1, because a partially imported dataset that a script called
 * successful is exactly the state the next developer will not suspect.
 *
 * `--dry-run` parses and validates the whole dataset and writes nothing, which
 * is how the importer is checked against the committed files without a database
 * migration in the way.
 */
async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const dataDirArgument = process.argv.find((argument) => argument.startsWith('--data-dir='));
  const dataDir =
    dataDirArgument === undefined ? undefined : dataDirArgument.slice('--data-dir='.length);

  const prisma = new PrismaClient();

  try {
    const result = await seedMarketData(prisma, { dryRun, dataDir });

    for (const issue of result.importReport.warnings) {
      console.warn(`${issue.severity} ${issue.rule} ${issue.source}:${issue.line} - ${issue.message}`);
    }
    for (const issue of result.importReport.fatals) {
      console.error(`${issue.severity} ${issue.rule} ${issue.source}:${issue.line} - ${issue.message}`);
    }

    console.log(summariseReport(result.importReport));

    if (reportFailed(result.importReport)) {
      process.exitCode = 1;
      return;
    }

    if (dryRun) {
      console.log('Dry run: no strategies were changed and no simulation was written.');
      return;
    }

    for (const entry of result.strategies) {
      const simulation = entry.simulation;
      const window =
        simulation === null
          ? 'not simulated'
          : `${simulation.windowStart}..${simulation.windowEnd}, ` +
            `${simulation.dayCount} day(s), ${simulation.fillCount} fill(s)`;
      console.log(`  ${entry.strategy.name} [${entry.seed.ruleKey}] - ${window}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error('Market seed failed:', error);
  process.exitCode = 1;
});
