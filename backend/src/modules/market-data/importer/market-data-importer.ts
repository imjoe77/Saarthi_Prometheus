import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { PrismaClient } from '@prisma/client';

import { findMissingDays } from '../domain/day-window';
import { parseKlineLine, type KlineCandle } from '../domain/kline-row';
import { readZipEntries, zipFailureFinding, type ZipEntry } from '../domain/zip-archive';
import { fatalIssue, warningIssue, type ValidationIssue } from '../domain/validation';
import {
  buildImportReport,
  emptySymbolReport,
  type ImportReport,
  type ImportSymbolReport,
} from './import-report';

/**
 * MODULE 06b - the only code that reads `data/market/raw`.
 *
 * THE DIRECTORY IS THE INTERFACE. There is no import endpoint, no import job
 * queue and no new environment variable: the dataset is a committed, read-only
 * artifact, and the way to re-import it is to run the seed again. Adding a
 * configuration surface for a path that never moves would be a setting nobody
 * could ever change.
 *
 * ALL-OR-NOTHING PER SYMBOL, never per run. Eighty-one archives across three
 * symbols are read in a deterministic order, and a single fatal finding inside
 * one symbol's data refuses *that symbol's* writes while the other two proceed.
 * The alternative - importing whichever archives happened to parse - would store
 * a shorter history than the source describes, and every curve computed from it
 * would cover a different period from the one the report claims.
 *
 * IDEMPOTENT BY PRIMARY KEY. The key is `(symbol, day)` and every write is
 * `INSERT ... ON CONFLICT DO NOTHING`, so running the importer twice inserts
 * nothing the second time and says so through `unchanged`. There is no upsert: a
 * committed candle is historical fact, and re-reading a file must never be able
 * to rewrite one.
 *
 * RE-RUN GUARANTEES, stated because they are what the tests assert:
 *  - fresh database: `inserted === 1932`, `unchanged === 0`
 *  - second run:     `inserted === 0`, `unchanged === 1932`
 *  - missing data directory: one fatal `DATA_DIR_MISSING`, zero writes, no throw
 */
const ARCHIVE_SUFFIX = '.zip';
const CSV_SUFFIX = '.csv';

export interface ImportOptions {
  /** Explicit data root. Defaults to the repository's `data/market/raw`. */
  readonly dataDir?: string;
  /** Restrict the run to these symbols. Unknown ones are reported, not created. */
  readonly symbols?: readonly string[];
  /** Parse and count, but write nothing. */
  readonly dryRun?: boolean;
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Locate `data/market/raw` without configuring it.
 *
 * Two candidates cover every way this project is run - from `backend/` (npm
 * scripts, the seed, the integration suite) and from the repository root. The
 * first that exists wins; when neither does, the `backend/` candidate is
 * returned so the fatal finding names a checkable path rather than `undefined`.
 */
export async function defaultDataDir(cwd: string = process.cwd()): Promise<string> {
  const candidates = [
    path.resolve(cwd, '..', 'data', 'market', 'raw'),
    path.resolve(cwd, 'data', 'market', 'raw'),
  ];

  for (const candidate of candidates) {
    if (await isDirectory(candidate)) {
      return candidate;
    }
  }

  return candidates[0] ?? path.resolve(cwd, '..', 'data', 'market', 'raw');
}

function compareNames(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

async function listDirectories(directory: string): Promise<string[] | null> {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(compareNames);
  } catch {
    return null;
  }
}

async function listArchives(directory: string): Promise<string[] | null> {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(ARCHIVE_SUFFIX))
      .map((entry) => entry.name)
      .sort(compareNames);
  } catch {
    return null;
  }
}

interface SymbolOutcome {
  readonly report: ImportSymbolReport;
  /** The window that parsed cleanly, kept even when a later archive fails. */
  readonly rows: readonly { readonly candle: KlineCandle; readonly sourceFile: string }[];
}

function failedSymbol(
  base: ImportSymbolReport,
  fatals: readonly ValidationIssue[],
  warnings: readonly ValidationIssue[],
  rowsParsed: number,
  rowsRejected: number,
  archivesRead: number,
): SymbolOutcome {
  return {
    report: { ...base, fatals, warnings, rowsParsed, rowsRejected, archivesRead },
    rows: [],
  };
}

async function importSymbol(
  symbol: string,
  symbolDir: string,
  dataDir: string,
): Promise<SymbolOutcome> {
  const base = emptySymbolReport(symbol);
  const warnings: ValidationIssue[] = [];
  const fatals: ValidationIssue[] = [];

  const archives = await listArchives(symbolDir);
  if (archives === null) {
    fatals.push(fatalIssue('SYMBOL_DIR_MISSING', symbol, 0, `no readable directory at ${symbolDir}`));
    return failedSymbol(base, fatals, warnings, 0, 0, 0);
  }
  if (archives.length === 0) {
    fatals.push(fatalIssue('NO_ARCHIVES', symbol, 0, `no ${ARCHIVE_SUFFIX} files in ${symbolDir}`));
    return failedSymbol(base, fatals, warnings, 0, 0, 0);
  }

  const byDay = new Map<string, { candle: KlineCandle; sourceFile: string }>();
  let archivesRead = 0;
  let rowsParsed = 0;
  let rowsRejected = 0;

  for (const archiveName of archives) {
    const archivePath = path.join(symbolDir, archiveName);
    const source = path.relative(dataDir, archivePath).split(path.sep).join('/');

    let buffer: Buffer;
    try {
      buffer = await fs.readFile(archivePath);
    } catch (error) {
      fatals.push(zipFailureFinding(error, source));
      return failedSymbol(base, fatals, warnings, rowsParsed, rowsRejected, archivesRead);
    }

    let entries: ZipEntry[];
    try {
      entries = readZipEntries(buffer);
    } catch (error) {
      fatals.push(zipFailureFinding(error, source));
      return failedSymbol(base, fatals, warnings, rowsParsed, rowsRejected, archivesRead);
    }
    archivesRead += 1;

    const csvs = entries.filter(
      (entry) => !entry.name.endsWith('/') && entry.name.endsWith(CSV_SUFFIX),
    );
    if (csvs.length !== 1) {
      fatals.push(
        fatalIssue('CSV_COUNT', source, 0, `expected exactly one CSV member, found ${csvs.length}`),
      );
      return failedSymbol(base, fatals, warnings, rowsParsed, rowsRejected, archivesRead);
    }

    const csv = csvs[0];
    if (csv === undefined) {
      return failedSymbol(base, fatals, warnings, rowsParsed, rowsRejected, archivesRead);
    }

    if (csv.name.includes('/')) {
      fatals.push(
        fatalIssue(
          'CSV_PATH',
          source,
          0,
          `the CSV member '${csv.name}' is not at the archive root`,
        ),
      );
      return failedSymbol(base, fatals, warnings, rowsParsed, rowsRejected, archivesRead);
    }

    const archiveBase = archiveName.slice(0, -ARCHIVE_SUFFIX.length);
    const csvBase = csv.name.slice(0, -CSV_SUFFIX.length);
    if (csvBase !== archiveBase) {
      fatals.push(
        fatalIssue(
          'CSV_NAME_MISMATCH',
          source,
          0,
          `the archive is named '${archiveName}' but holds '${csv.name}'`,
        ),
      );
      return failedSymbol(base, fatals, warnings, rowsParsed, rowsRejected, archivesRead);
    }

    const lines = csv.data.toString('utf8').split(/\r?\n/);
    let previousDay: string | null = null;

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      const lineNumber = index + 1;

      if (line.trim() === '') {
        // A trailing newline is the normal end of a text file; a blank line
        // anywhere else is not, and is reported without stopping the import.
        const isTail = lines.slice(index).every((rest) => rest.trim() === '');
        if (!isTail) {
          warnings.push(
            warningIssue('CSV_BLANK_LINE', source, lineNumber, 'blank line inside the CSV'),
          );
        }
        continue;
      }

      const parsed = parseKlineLine(line, source, lineNumber);
      if (!parsed.ok) {
        fatals.push(parsed.issue);
        rowsRejected += 1;
        return failedSymbol(base, fatals, warnings, rowsParsed, rowsRejected, archivesRead);
      }

      const existing = byDay.get(parsed.candle.day);
      if (existing !== undefined) {
        fatals.push(
          fatalIssue(
            'DUPLICATE_DAY',
            source,
            lineNumber,
            `day ${parsed.candle.day} was already read from ${existing.sourceFile}`,
          ),
        );
        rowsRejected += 1;
        return failedSymbol(base, fatals, warnings, rowsParsed, rowsRejected, archivesRead);
      }

      if (previousDay !== null && parsed.candle.day <= previousDay) {
        fatals.push(
          fatalIssue(
            'OUT_OF_ORDER',
            source,
            lineNumber,
            `day ${parsed.candle.day} does not follow ${previousDay} inside the same file`,
          ),
        );
        rowsRejected += 1;
        return failedSymbol(base, fatals, warnings, rowsParsed, rowsRejected, archivesRead);
      }

      byDay.set(parsed.candle.day, { candle: parsed.candle, sourceFile: source });
      warnings.push(...parsed.warnings);
      previousDay = parsed.candle.day;
      rowsParsed += 1;
    }
  }

  const days = [...byDay.keys()].sort(compareNames);
  const missing = findMissingDays(days);
  if (missing.length > 0) {
    const preview = missing.slice(0, 5).join(', ');
    const more = missing.length > 5 ? ` (+${missing.length - 5} more)` : '';
    fatals.push(
      fatalIssue(
        'GAP',
        symbol,
        0,
        `${missing.length} day(s) absent between ${days[0] ?? '?'} and ${days[days.length - 1] ?? '?'}: ${preview}${more}`,
      ),
    );
    return failedSymbol(base, fatals, warnings, rowsParsed, rowsRejected, archivesRead);
  }

  return {
    report: {
      ...base,
      archivesRead,
      rowsParsed,
      rowsRejected,
      windowStart: days[0] ?? null,
      windowEnd: days[days.length - 1] ?? null,
      warnings,
      fatals,
    },
    rows: days.flatMap((day) => {
      const row = byDay.get(day);
      return row === undefined ? [] : [row];
    }),
  };
}

/**
 * Import every symbol under `dataDir` (or the requested subset) and report.
 *
 * Never throws for data. A missing directory, an unreadable archive and a row
 * with eleven fields are all findings in the returned report, because the only
 * caller that could usefully catch an exception is the caller that is already
 * reading this report.
 */
export async function importMarketData(
  prisma: PrismaClient,
  options: ImportOptions = {},
): Promise<ImportReport> {
  const dryRun = options.dryRun ?? false;
  const dataDir = options.dataDir ? path.resolve(options.dataDir) : await defaultDataDir();

  const directories = await listDirectories(dataDir);
  if (directories === null) {
    return buildImportReport(dataDir, dryRun, [
      {
        ...emptySymbolReport('-'),
        fatals: [
          fatalIssue(
            'DATA_DIR_MISSING',
            dataDir,
            0,
            'the market data directory does not exist or is not readable',
          ),
        ],
      },
    ]);
  }

  const symbols =
    options.symbols === undefined ? directories : [...options.symbols].sort(compareNames);

  if (symbols.length === 0) {
    return buildImportReport(dataDir, dryRun, [
      {
        ...emptySymbolReport('-'),
        fatals: [fatalIssue('NO_SYMBOLS', dataDir, 0, 'no symbol directories to import')],
      },
    ]);
  }

  const reports: ImportSymbolReport[] = [];

  for (const symbol of symbols) {
    const outcome = await importSymbol(symbol, path.join(dataDir, symbol), dataDir);
    let report = outcome.report;

    if (report.fatals.length === 0 && outcome.rows.length > 0) {
      const windowStart = report.windowStart;
      const windowEnd = report.windowEnd;

      if (windowStart === null || windowEnd === null) {
        reports.push(report);
        continue;
      }

      if (dryRun) {
        const existing = await prisma.marketCandle.count({
          where: {
            symbol,
            day: {
              gte: new Date(`${windowStart}T00:00:00.000Z`),
              lte: new Date(`${windowEnd}T00:00:00.000Z`),
            },
          },
        });
        report = { ...report, inserted: outcome.rows.length - existing, unchanged: existing };
      } else {
        const created = await prisma.marketCandle.createMany({
          data: outcome.rows.map(({ candle, sourceFile }) => ({
            symbol,
            day: new Date(`${candle.day}T00:00:00.000Z`),
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            volume: candle.volume,
            quoteVolume: candle.quoteVolume,
            sourceFile,
          })),
          skipDuplicates: true,
        });
        report = {
          ...report,
          inserted: created.count,
          unchanged: outcome.rows.length - created.count,
        };
      }
    }

    reports.push(report);
  }

  return buildImportReport(dataDir, dryRun, reports);
}
