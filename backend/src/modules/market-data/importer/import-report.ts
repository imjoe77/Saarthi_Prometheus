import type { ValidationIssue } from '../domain/validation';

/**
 * MODULE 06b - what one import run did, in a shape a CLI, a seed script and a
 * test can all read.
 *
 * THE REPORT IS THE API. There is no `import` endpoint and no import log table:
 * importing is an offline operation over files that must not change, so the only
 * thing a caller needs is a value it can print, exit on, or assert against. A
 * report rather than a thrown error is what lets one run describe all three
 * symbols even when only one of them is broken.
 *
 * `inserted` and `unchanged` come from Postgres itself - `INSERT ... ON CONFLICT
 * DO NOTHING` counts what it actually inserted - so "the second run wrote
 * nothing" is a database fact and not a pre-computed guess about which keys
 * already existed.
 */
export interface ImportSymbolReport {
  readonly symbol: string;
  /** ZIP archives opened for this symbol. */
  readonly archivesRead: number;
  /** Rows that passed every fatal check. */
  readonly rowsParsed: number;
  /** Rows rejected, and therefore absent from the window. */
  readonly rowsRejected: number;
  /** Rows the database actually inserted on this run. */
  readonly inserted: number;
  /** Rows that were already present and were skipped. */
  readonly unchanged: number;
  /** First and last UTC day in the parsed window, or null when the symbol failed. */
  readonly windowStart: string | null;
  readonly windowEnd: string | null;
  readonly warnings: readonly ValidationIssue[];
  readonly fatals: readonly ValidationIssue[];
}

export interface ImportReport {
  readonly dryRun: boolean;
  readonly dataDir: string;
  readonly symbols: readonly ImportSymbolReport[];
  readonly archivesRead: number;
  readonly rowsParsed: number;
  readonly inserted: number;
  readonly unchanged: number;
  readonly warnings: readonly ValidationIssue[];
  readonly fatals: readonly ValidationIssue[];
}

export function emptySymbolReport(symbol: string): ImportSymbolReport {
  return {
    symbol,
    archivesRead: 0,
    rowsParsed: 0,
    rowsRejected: 0,
    inserted: 0,
    unchanged: 0,
    windowStart: null,
    windowEnd: null,
    warnings: [],
    fatals: [],
  };
}

export function buildImportReport(
  dataDir: string,
  dryRun: boolean,
  symbols: readonly ImportSymbolReport[],
): ImportReport {
  const warnings = symbols.flatMap((entry) => entry.warnings);
  const fatals = symbols.flatMap((entry) => entry.fatals);

  return {
    dryRun,
    dataDir,
    symbols,
    archivesRead: symbols.reduce((total, entry) => total + entry.archivesRead, 0),
    rowsParsed: symbols.reduce((total, entry) => total + entry.rowsParsed, 0),
    inserted: symbols.reduce((total, entry) => total + entry.inserted, 0),
    unchanged: symbols.reduce((total, entry) => total + entry.unchanged, 0),
    warnings,
    fatals,
  };
}

/** True when at least one symbol was refused outright. The caller must not proceed. */
export function reportFailed(report: ImportReport): boolean {
  return report.fatals.length > 0;
}

/** A one-screen summary line, for the CLI and the seed's stdout. */
export function summariseReport(report: ImportReport): string {
  const state = reportFailed(report) ? 'FAILED' : report.dryRun ? 'DRY RUN' : 'OK';
  const symbols = report.symbols
    .map((entry) => `${entry.symbol}=${entry.fatals.length > 0 ? 'FAILED' : 'ok'}`)
    .join(', ');
  return (
    `${state}: ${report.symbols.length} symbol(s) [${symbols}] - ` +
    `${report.archivesRead} archive(s), ${report.rowsParsed} row(s), ` +
    `${report.inserted} inserted, ${report.unchanged} unchanged, ` +
    `${report.warnings.length} warning(s), ${report.fatals.length} fatal(s)`
  );
}
