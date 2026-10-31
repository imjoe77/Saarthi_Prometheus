import { withConnectionLimit } from './datasource-url';

describe('withConnectionLimit', () => {
  it('appends the pool limit when the URL has no query string', () => {
    const url = 'postgresql://user:pass@localhost:5432/prometheus';

    expect(withConnectionLimit(url, 10)).toBe(`${url}?connection_limit=10`);
  });

  it('appends with & when the URL already has query parameters', () => {
    const url = 'postgresql://user:pass@localhost:5432/prometheus?schema=public';

    expect(withConnectionLimit(url, 10)).toBe(`${url}&connection_limit=10`);
  });

  it('preserves an explicit connection_limit from the operator', () => {
    // Supabase transaction mode requires connection_limit=1; overriding it
    // would exhaust the pooler's capacity.
    const url = 'postgresql://postgres.ref:pw@pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1';

    expect(withConnectionLimit(url, 10)).toBe(url);
  });

  it('preserves an explicit limit regardless of parameter order', () => {
    const url = 'postgresql://u:p@h:5432/db?connection_limit=1&pgbouncer=true';

    expect(withConnectionLimit(url, 10)).toBe(url);
  });

  it('does not match connection_limit as a substring of another parameter', () => {
    const url = 'postgresql://u:p@h:5432/db?max_connection_limit=5';

    expect(withConnectionLimit(url, 10)).toBe(`${url}&connection_limit=10`);
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('leaves the URL alone when the pool size is %s', (_label, poolMax) => {
    const url = 'postgresql://user:pass@localhost:5432/prometheus';

    expect(withConnectionLimit(url, poolMax)).toBe(url);
  });
});