import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { PrismaClient } from '@prisma/client';

import { fatalIssue } from '../domain/validation';
import { buildDefaultZip, buildZip } from '../domain/zip.test-helper';
import { defaultDataDir, importMarketData } from './market-data-importer';
import { buildImportReport, emptySymbolReport, reportFailed, summariseReport } from './import-report';

/**
 * MODULE 06b - the importer, against its two real dependencies: the filesystem
 * and the database. The filesystem is real temp directories with archives
 * written by `zip.test-helper`; the database is an in-memory stand-in for the
 * two calls the importer actually makes (`count` in a dry run, `createMany` for
 * a real one). Everything the importer *decides* is asserted here - the rules,
 * the all-or-nothing-per-symbol policy, the idempotency numbers - so the e2e
 * suite can confine itself to the real Postgres round-trip.
 *
 * The fixture timestamps use the dataset's real arithmetic: a UTC midnight `µs`
 * open time and a close time exactly 86,399,999,999 microseconds later, as
 * `kline-row.ts` expects.
 */
function openMicros(day: string): string {
  return String(Date.parse(`${day}T00:00:00.000Z`) * 1000);
}

function lineFor(day: string): string {
  return [
    openMicros(day),
    '100',
    '105',
    '95',
    '101',
    '1234.5',
    String(BigInt(openMicros(day)) + 86_399_999_999n),
    '125000',
    '7',
    '600.25',
    '61234',
    '0',
  ].join(',');
}

interface CountWhere {
  symbol: string;
  day?: { gte?: Date; lte?: Date };
}

class InMemoryCandleStore {
  /** `SYMBOL#YYYY-MM-DD` keys, standing in for the natural primary key. */
  private readonly rows = new Map<string, string>();

  readonly marketCandle = {
    count: (args: { where: CountWhere }): number => {
      const { symbol, day } = args.where;
      let total = 0;
      for (const key of this.rows.keys()) {
        const [rowSymbol, rowDay] = key.split('#');
        if ((rowSymbol ?? '') !== symbol) {
          continue;
        }
        const row = rowDay ?? '';
        if (day?.gte !== undefined && row < day.gte.toISOString().slice(0, 10)) {
          continue;
        }
        if (day?.lte !== undefined && row > day.lte.toISOString().slice(0, 10)) {
          continue;
        }
        total += 1;
      }
      return total;
    },
    createMany: (args: {
      data: readonly { symbol: string; day: Date }[];
    }): { count: number } => {
      let inserted = 0;
      for (const candle of args.data) {
        const key = `${candle.symbol}#${candle.day.toISOString().slice(0, 10)}`;
        if (!this.rows.has(key)) {
          this.rows.set(key, candle.day.toISOString().slice(0, 10));
          inserted += 1;
        }
      }
      return { count: inserted };
    },
  };

  toPrisma(): PrismaClient {
    return this as unknown as PrismaClient;
  }

  count(): number {
    return this.rows.size;
  }

  has(symbol: string, day: string): boolean {
    return this.rows.has(`${symbol}#${day}`);
  }
}

describe('defaultDataDir', () => {
  it('prefers the sibling repo-root directory when it exists', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'prom-market-'));
    try {
      mkdirSync(path.join(root, 'data', 'market', 'raw'), { recursive: true });

      const cwd = path.join(root, 'backend');
      expect(await defaultDataDir(cwd)).toBe(path.join(root, 'data', 'market', 'raw'));
    } finally {
      rmdirSync(root, { recursive: true });
    }
  });

  it('falls back to a data directory under the backend working directory', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'prom-market-'));
    try {
      mkdirSync(path.join(root, 'backend', 'data', 'market', 'raw'), { recursive: true });

      const cwd = path.join(root, 'backend');
      expect(await defaultDataDir(cwd)).toBe(path.join(root, 'backend', 'data', 'market', 'raw'));
    } finally {
      rmdirSync(root, { recursive: true });
    }
  });

  it('names the backend-relative candidate when neither exists', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'prom-market-'));
    try {
      const cwd = path.join(root, 'backend');
      expect(await defaultDataDir(cwd)).toBe(path.join(root, 'data', 'market', 'raw'));
    } finally {
      rmdirSync(root, { recursive: true });
    }
  });
});

describe('importMarketData', () => {
  let root: string;

  function dataDir(): string {
    const dir = path.join(root, randomUUID());
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  function symbolDir(dir: string, symbol: string): string {
    const target = path.join(dir, symbol);
    mkdirSync(target, { recursive: true });
    return target;
  }

  /** One symbol directory holding a good archive per row of days. */
  function goodSymbol(dir: string, symbol: string, days: string[], names: string[]): void {
    const target = symbolDir(dir, symbol);
    for (let index = 0; index < days.length; index += 1) {
      const day = days[index] ?? '';
      const name = names[index] ?? `part-${index}`;
      writeFileSync(
        path.join(target, `${name}.zip`),
        buildDefaultZip([{ name: `${name}.csv`, data: `${lineFor(day)}\n` }]),
      );
    }
  }

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'prom-market-'));
  });

  afterAll(() => {
    rmdirSync(root, { recursive: true });
  });

  it('reports DATA_DIR_MISSING without throwing when the data root is absent', async () => {
    const store = new InMemoryCandleStore();
    const report = await importMarketData(store.toPrisma(), {
      dataDir: path.join(root, 'does', 'not', 'exist'),
      symbols: ['BTCUSDT'],
    });

    expect(reportFailed(report)).toBe(true);
    expect(report.symbols[0]?.symbol).toBe('-');
    expect(report.symbols[0]?.fatals[0]?.rule).toBe('DATA_DIR_MISSING');
    expect(store.count()).toBe(0);
  });

  it('reports NO_SYMBOLS when the data root holds no symbol directories', async () => {
    const store = new InMemoryCandleStore();
    const report = await importMarketData(store.toPrisma(), { dataDir: dataDir() });

    expect(reportFailed(report)).toBe(true);
    expect(report.symbols[0]?.fatals[0]?.rule).toBe('NO_SYMBOLS');
  });

  it('reports a requested symbol with no directory as SYMBOL_DIR_MISSING', async () => {
    const store = new InMemoryCandleStore();
    const report = await importMarketData(store.toPrisma(), {
      dataDir: dataDir(),
      symbols: ['BTCUSDT'],
    });

    expect(reportFailed(report)).toBe(true);
    const symbolReport = report.symbols.find((entry) => entry.symbol === 'BTCUSDT');
    expect(symbolReport?.fatals[0]?.rule).toBe('SYMBOL_DIR_MISSING');
  });

  it('reports NO_ARCHIVES when the symbol directory is empty', async () => {
    const dir = dataDir();
    symbolDir(dir, 'BTCUSDT');

    const store = new InMemoryCandleStore();
    const report = await importMarketData(store.toPrisma(), {
      dataDir: dir,
      symbols: ['BTCUSDT'],
    });

    expect(reportFailed(report)).toBe(true);
    expect(report.symbols[0]?.fatals[0]?.rule).toBe('NO_ARCHIVES');
  });

  it('imports a symbol and reports the real insert count', async () => {
    const dir = dataDir();
    goodSymbol(dir, 'BTCUSDT', ['2025-01-01', '2025-01-02', '2025-01-03'], ['jan-a', 'jan-b', 'jan-c']);

    const store = new InMemoryCandleStore();
    const report = await importMarketData(store.toPrisma(), {
      dataDir: dir,
      symbols: ['BTCUSDT'],
    });

    expect(reportFailed(report)).toBe(false);
    const symbolReport = report.symbols[0];
    expect(symbolReport).toMatchObject({
      symbol: 'BTCUSDT',
      archivesRead: 3,
      rowsParsed: 3,
      rowsRejected: 0,
      inserted: 3,
      unchanged: 0,
      windowStart: '2025-01-01',
      windowEnd: '2025-01-03',
      fatals: [],
      warnings: [],
    });
    expect(store.count()).toBe(3);
    expect(store.has('BTCUSDT', '2025-01-02')).toBe(true);
  });

  it('is idempotent: the second real run inserts nothing and reports it as unchanged', async () => {
    const dir = dataDir();
    goodSymbol(dir, 'BTCUSDT', ['2025-01-01', '2025-01-02', '2025-01-03'], ['a', 'b', 'c']);

    const store = new InMemoryCandleStore();
    await importMarketData(store.toPrisma(), { dataDir: dir, symbols: ['BTCUSDT'] });

    const second = await importMarketData(store.toPrisma(), { dataDir: dir, symbols: ['BTCUSDT'] });

    expect(second.symbols[0]).toMatchObject({ inserted: 0, unchanged: 3, rowsParsed: 3 });
    expect(store.count()).toBe(3);
  });

  it('computes a dry run from the rows that are already present', async () => {
    const dir = dataDir();
    goodSymbol(dir, 'BTCUSDT', ['2025-01-01', '2025-01-02'], ['a', 'b']);

    const store = new InMemoryCandleStore();
    await importMarketData(store.toPrisma(), { dataDir: dir, symbols: ['BTCUSDT'] });

    const dry = await importMarketData(store.toPrisma(), {
      dataDir: dir,
      symbols: ['BTCUSDT'],
      dryRun: true,
    });

    expect(dry.dryRun).toBe(true);
    expect(dry.symbols[0]).toMatchObject({ inserted: 0, unchanged: 2, rowsParsed: 2 });
    expect(store.count()).toBe(2);
  });

  it('names the specific day a GAP report claims is absent', async () => {
    const dir = dataDir();
    goodSymbol(dir, 'BTCUSDT', ['2025-01-01', '2025-01-02', '2025-01-04'], ['a', 'b', 'c']);

    const store = new InMemoryCandleStore();
    const report = await importMarketData(store.toPrisma(), {
      dataDir: dir,
      symbols: ['BTCUSDT'],
    });

    expect(reportFailed(report)).toBe(true);
    expect(report.symbols[0]?.fatals[0]?.rule).toBe('GAP');
    expect(report.symbols[0]?.fatals[0]?.message).toContain('2025-01-03');
    expect(store.count()).toBe(0);
  });

  it('refuses a day that appears in two archives as DUPLICATE_DAY', async () => {
    const dir = dataDir();
    const target = symbolDir(dir, 'BTCUSDT');
    writeFileSync(
      path.join(target, 'a.zip'),
      buildDefaultZip([{ name: 'a.csv', data: `${lineFor('2025-01-01')}\n${lineFor('2025-01-02')}\n` }]),
    );
    writeFileSync(
      path.join(target, 'b.zip'),
      buildDefaultZip([{ name: 'b.csv', data: `${lineFor('2025-01-01')}\n` }]),
    );

    const store = new InMemoryCandleStore();
    const report = await importMarketData(store.toPrisma(), { dataDir: dir, symbols: ['BTCUSDT'] });

    expect(report.symbols[0]?.fatals[0]?.rule).toBe('DUPLICATE_DAY');
    expect(store.count()).toBe(0);
  });

  it('refuses days that run backwards inside one file as OUT_OF_ORDER', async () => {
    const dir = dataDir();
    const target = symbolDir(dir, 'BTCUSDT');
    writeFileSync(
      path.join(target, 'a.zip'),
      buildDefaultZip([{ name: 'a.csv', data: `${lineFor('2025-01-02')}\n${lineFor('2025-01-01')}\n` }]),
    );

    const store = new InMemoryCandleStore();
    const report = await importMarketData(store.toPrisma(), { dataDir: dir, symbols: ['BTCUSDT'] });

    expect(report.symbols[0]?.fatals[0]?.rule).toBe('OUT_OF_ORDER');
    expect(store.count()).toBe(0);
  });

  it('refuses an archive with no CSV member as CSV_COUNT', async () => {
    const dir = dataDir();
    const target = symbolDir(dir, 'BTCUSDT');
    writeFileSync(path.join(target, 'a.zip'), buildDefaultZip([{ name: 'a.txt', data: 'x\n' }]));

    const store = new InMemoryCandleStore();
    const report = await importMarketData(store.toPrisma(), { dataDir: dir, symbols: ['BTCUSDT'] });

    expect(report.symbols[0]?.fatals[0]?.rule).toBe('CSV_COUNT');
  });

  it('refuses an archive whose CSV is in a subdirectory as CSV_PATH', async () => {
    const dir = dataDir();
    const target = symbolDir(dir, 'BTCUSDT');
    writeFileSync(
      path.join(target, 'a.zip'),
      buildZip([{ name: 'sub/a.csv', data: Buffer.from(`${lineFor('2025-01-01')}\n`) }]),
    );

    const store = new InMemoryCandleStore();
    const report = await importMarketData(store.toPrisma(), { dataDir: dir, symbols: ['BTCUSDT'] });

    expect(report.symbols[0]?.fatals[0]?.rule).toBe('CSV_PATH');
  });

  it('refuses an archive whose CSV name disagrees with the archive name', async () => {
    const dir = dataDir();
    const target = symbolDir(dir, 'BTCUSDT');
    writeFileSync(
      path.join(target, 'a.zip'),
      buildDefaultZip([{ name: 'y.csv', data: `${lineFor('2025-01-01')}\n` }]),
    );

    const store = new InMemoryCandleStore();
    const report = await importMarketData(store.toPrisma(), { dataDir: dir, symbols: ['BTCUSDT'] });

    expect(report.symbols[0]?.fatals[0]?.rule).toBe('CSV_NAME_MISMATCH');
  });

  it('warns about a blank line inside the CSV without stopping the import', async () => {
    const dir = dataDir();
    const target = symbolDir(dir, 'BTCUSDT');
    writeFileSync(
      path.join(target, 'a.zip'),
      buildDefaultZip([
        { name: 'a.csv', data: `${lineFor('2025-01-01')}\n\n${lineFor('2025-01-02')}\n` },
      ]),
    );

    const store = new InMemoryCandleStore();
    const report = await importMarketData(store.toPrisma(), { dataDir: dir, symbols: ['BTCUSDT'] });

    expect(reportFailed(report)).toBe(false);
    expect(report.symbols[0]?.warnings.map((warning) => warning.rule)).toEqual(['CSV_BLANK_LINE']);
    expect(report.symbols[0]?.inserted).toBe(2);
  });

  it('refuses the whole symbol when any archive is unreadable, keeping earlier archives unimported', async () => {
    const dir = dataDir();
    const target = symbolDir(dir, 'BTCUSDT');
    writeFileSync(
      path.join(target, 'a.zip'),
      buildDefaultZip([{ name: 'a.csv', data: `${lineFor('2025-01-01')}\n${lineFor('2025-01-02')}\n` }]),
    );
    writeFileSync(path.join(target, 'b.zip'), Buffer.from('not actually a zip'));

    const store = new InMemoryCandleStore();
    const report = await importMarketData(store.toPrisma(), { dataDir: dir, symbols: ['BTCUSDT'] });

    expect(reportFailed(report)).toBe(true);
    expect(report.symbols[0]?.fatals[0]?.rule).toBe('ZIP_FORMAT');
    expect(report.symbols[0]?.inserted).toBe(0);
    expect(report.symbols[0]?.archivesRead).toBe(1);
    expect(store.count()).toBe(0);
  });

  it('lets a good symbol proceed while a broken one is refused', async () => {
    const dir = dataDir();
    const btc = symbolDir(dir, 'BTCUSDT');
    writeFileSync(
      path.join(btc, 'a.zip'),
      buildDefaultZip([{ name: 'a.csv', data: `${lineFor('2025-01-01')}\n` }]),
    );
    const eth = symbolDir(dir, 'ETHUSDT');
    writeFileSync(path.join(eth, 'a.zip'), Buffer.from('not a zip'));

    const store = new InMemoryCandleStore();
    const report = await importMarketData(store.toPrisma(), { dataDir: dir });

    expect(report.symbols.map((entry) => entry.symbol)).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(report.symbols[0]?.inserted).toBe(1);
    expect(report.symbols[1]?.fatals[0]?.rule).toBe('ZIP_FORMAT');
    expect(reportFailed(report)).toBe(true);
    expect(store.count()).toBe(1);
    expect(store.has('BTCUSDT', '2025-01-01')).toBe(true);
  });

  it('reports an unknown requested symbol without pretending to import it', async () => {
    const dir = dataDir();
    goodSymbol(dir, 'BTCUSDT', ['2025-01-01'], ['a']);

    const store = new InMemoryCandleStore();
    const report = await importMarketData(store.toPrisma(), {
      dataDir: dir,
      symbols: ['BTCUSDT', 'NOPE'],
    });

    const missing = report.symbols.find((entry) => entry.symbol === 'NOPE');
    expect(missing?.fatals[0]?.rule).toBe('SYMBOL_DIR_MISSING');
    expect(report.symbols[0]?.inserted).toBe(1);
  });
});

describe('import report', () => {
  it('totals the per-symbol figures', () => {
    const report = buildImportReport('/data', false, [
      { ...emptySymbolReport('BTCUSDT'), archivesRead: 2, rowsParsed: 4, inserted: 4 },
      { ...emptySymbolReport('ETHUSDT'), archivesRead: 1, rowsParsed: 2, inserted: 2, unchanged: 1 },
    ]);

    expect(report.archivesRead).toBe(3);
    expect(report.rowsParsed).toBe(6);
    expect(report.inserted).toBe(6);
    expect(report.unchanged).toBe(1);
    expect(reportFailed(report)).toBe(false);
  });

  it('flags a report failed when any symbol was refused', () => {
    const failed = emptySymbolReport('BTCUSDT');
    const report = buildImportReport('/data', false, [
      { ...failed, fatals: [{ severity: 'fatal', rule: 'ZIP_FORMAT', source: 'a.zip', line: 0, message: 'x' }] },
    ]);

    expect(reportFailed(report)).toBe(true);
  });

  it('summarises a passing run, a dry run and a failure on one line each', () => {
    const good = { ...emptySymbolReport('BTCUSDT'), archivesRead: 1, rowsParsed: 2, inserted: 2 };
    const bad = {
      ...emptySymbolReport('ETHUSDT'),
      fatals: [fatalIssue('GAP', 'ETHUSDT', 0, '1 day')],
    };

    expect(
      summariseReport(buildImportReport('/data', false, [good])),
    ).toBe(
      'OK: 1 symbol(s) [BTCUSDT=ok] - 1 archive(s), 2 row(s), 2 inserted, 0 unchanged, 0 warning(s), 0 fatal(s)',
    );
    expect(
      summariseReport(buildImportReport('/data', true, [good])).startsWith('DRY RUN:'),
    ).toBe(true);
    expect(
      summariseReport(buildImportReport('/data', false, [good, bad])).startsWith('FAILED:'),
    ).toBe(true);
    expect(
      summariseReport(buildImportReport('/data', false, [bad])).includes('ETHUSDT=FAILED'),
    ).toBe(true);
  });
});