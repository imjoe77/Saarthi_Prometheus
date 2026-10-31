/**
 * MODULE 06b - the finding record shared by the importer, the ZIP reader and the
 * row parser.
 *
 * ONE TYPE, TWO SEVERITIES, NO EXCEPTIONS FOR DATA. Importing 1,932 bars from 81
 * third-party archives is a batch job: stopping at the first malformed byte
 * would hide every other problem behind it, and throwing from inside a parser
 * would make "what is wrong with this file" a stack-trace question instead of a
 * report. Every check therefore *returns* an issue and the caller decides what a
 * finding means for the symbol it belongs to.
 *
 * FATAL vs WARNING is the whole decision, and it is made here so it is made
 * once:
 *  - `fatal` - the row or the archive cannot be trusted, so the symbol is not
 *    written at all. A partially imported symbol is worse than an absent one:
 *    the simulation would silently run over a shorter history and produce a
 *    curve that looks like an answer.
 *  - `warning` - the value is recorded as parsed and the source is at fault in a
 *    way that does not change what is stored. Reported, never repaired.
 *
 * The `rule` field is a stable, upper-snake identifier rather than prose,
 * because a report a person reads and a report a test asserts on should be the
 * same report.
 */
export type IssueSeverity = 'fatal' | 'warning';

export interface ValidationIssue {
  readonly severity: IssueSeverity;
  /** Stable rule identifier, e.g. `KLINE_FIELD_COUNT`. */
  readonly rule: string;
  /** Where the finding came from: an archive path, a symbol, or `data/market`. */
  readonly source: string;
  /** 1-based line number inside `source`, or 0 when the file is the subject. */
  readonly line: number;
  /** Human-readable statement of what was wrong. */
  readonly message: string;
}

export function fatalIssue(
  rule: string,
  source: string,
  line: number,
  message: string,
): ValidationIssue {
  return { severity: 'fatal', rule, source, line, message };
}

export function warningIssue(
  rule: string,
  source: string,
  line: number,
  message: string,
): ValidationIssue {
  return { severity: 'warning', rule, source, line, message };
}

export function isFatal(issue: ValidationIssue): boolean {
  return issue.severity === 'fatal';
}

export function hasFatal(issues: readonly ValidationIssue[]): boolean {
  return issues.some(isFatal);
}

/** One line of a report: `fatal KLINE_FIELD_COUNT symbols/BTCUSDT/a.zip:12 - ...`. */
export function formatIssue(issue: ValidationIssue): string {
  const at = issue.line > 0 ? `${issue.source}:${issue.line}` : issue.source;
  return `${issue.severity} ${issue.rule} ${at} - ${issue.message}`;
}

export function formatIssues(issues: readonly ValidationIssue[]): string[] {
  return issues.map(formatIssue);
}
