import { fatalIssue, formatIssue, formatIssues, hasFatal, isFatal, warningIssue } from './validation';

/**
 * MODULE 06b - the finding record.
 *
 * The contract under test is that a finding is a value, not a throw: a report
 * is a list of these and a caller decides what a list means. The shape is
 * asserted field by field, and the formatting is asserted because the CLI prints
 * it and a test may need to search a report for a rule name.
 */
describe('validation issue', () => {
  it('builds a fatal finding with the given rule, source, line and message', () => {
    const issue = fatalIssue('KLINE_FIELD_COUNT', 'symbols/BTCUSDT/a.zip:12', 12, 'got 11 fields');

    expect(issue).toEqual({
      severity: 'fatal',
      rule: 'KLINE_FIELD_COUNT',
      source: 'symbols/BTCUSDT/a.zip:12',
      line: 12,
      message: 'got 11 fields',
    });
  });

  it('builds a warning finding with its own severity', () => {
    const issue = warningIssue('CSV_BLANK_LINE', 'symbols/BTCUSDT/a.zip', 4, 'blank line');

    expect(issue.severity).toBe('warning');
    expect(isFatal(issue)).toBe(false);
  });

  it('tells fatal findings apart from warnings', () => {
    expect(isFatal(fatalIssue('X', 's', 0, 'm'))).toBe(true);
    expect(isFatal(warningIssue('X', 's', 0, 'm'))).toBe(false);
  });

  it('reports whether any finding is fatal', () => {
    expect(hasFatal([])).toBe(false);
    expect(hasFatal([warningIssue('X', 's', 0, 'm')])).toBe(false);
    expect(
      hasFatal([warningIssue('X', 's', 0, 'm'), fatalIssue('X', 's', 0, 'm')]),
    ).toBe(true);
  });

  it('renders a finding with a line as source:line', () => {
    expect(formatIssue(fatalIssue('KLINE_FIELD_COUNT', 'a.csv', 7, '11 fields'))).toBe(
      'fatal KLINE_FIELD_COUNT a.csv:7 - 11 fields',
    );
  });

  it('renders a finding about a whole file without pretending it has a line', () => {
    expect(formatIssue(warningIssue('ZIP_FORMAT', 'a.zip', 0, 'no EOCD'))).toBe(
      'warning ZIP_FORMAT a.zip - no EOCD',
    );
  });

  it('renders a list by mapping the formatter over it', () => {
    const lines = formatIssues([
      fatalIssue('NO_ARCHIVES', 'BTCUSDT', 0, 'none found'),
      warningIssue('CSV_BLANK_LINE', 'a.csv', 2, 'blank line'),
    ]);

    expect(lines).toEqual([
      'fatal NO_ARCHIVES BTCUSDT - none found',
      'warning CSV_BLANK_LINE a.csv:2 - blank line',
    ]);
  });
});