/**
 * Datasource URL helpers.
 *
 * Kept separate from `PrismaService` so the logic is testable as a pure
 * function, without booting Nest or opening a connection.
 */

/**
 * Applies the configured pool size to a Prisma datasource URL.
 *
 * Why append rather than build the query from scratch: the connection URL is
 * the operator's escape hatch and must survive untouched apart from the one
 * parameter this module owns.
 *
 * An explicit `connection_limit` already present in the URL always wins. This
 * is not defensive padding - it is a supported deployment path. Supabase's
 * transaction-mode pooler requires `connection_limit=1` alongside
 * `pgbouncer=true`, and silently rewriting that to 10 would produce connection
 * exhaustion against a pooler that cannot multiplex Prisma's connections.
 *
 * @param url the validated `DATABASE_URL`.
 * @param poolMax the validated `DATABASE_POOL_MAX`.
 * @returns the URL with a pool limit, unless one was already specified.
 */
export function withConnectionLimit(url: string, poolMax: number): string {
  // Defensive: env validation already bounds this to 1-100, but a malformed
  // value must never produce a corrupt URL that fails at connect time.
  if (!Number.isFinite(poolMax) || poolMax < 1) return url;

  // Must be anchored to a parameter boundary: `max_connection_limit=5` is a
  // different parameter and must not suppress the one being added.
  if (/[?&]connection_limit=/i.test(url)) return url;

  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}connection_limit=${poolMax}`;
}