import { AssetKind, type PrismaClient } from '@prisma/client';

/**
 * MODULE 03 — the assets Prometheus supports at this stage.
 *
 * Reference data, not token logic. EMBER is recorded here exactly like INR and
 * USDT: an accounting ledger entry with a symbol, a display precision and a
 * lifecycle flag. Its on-chain representation, buybacks and burns belong to
 * Module 10; this module must not grow any of that.
 *
 * `decimals` is presentation only. Storage is always NUMERIC(38,18); the value
 * tells the API how many places to render and how much precision a mutation of
 * that asset is allowed to carry.
 */
export const SEED_ASSETS = [
  { symbol: 'INR', name: 'Indian Rupee', kind: AssetKind.FIAT, decimals: 2 },
  { symbol: 'USDT', name: 'Tether USD', kind: AssetKind.STABLECOIN, decimals: 6 },
  { symbol: 'EMBER', name: 'Prometheus Ember', kind: AssetKind.TOKEN, decimals: 18 },
] as const;

/**
 * Establishes the supported assets, idempotently.
 *
 * `upsert` on the unique `symbol` is what makes running the seed twice safe: the
 * second run updates the descriptive fields in place rather than colliding with
 * the unique index. Re-activating an asset on every run is deliberate for a
 * development seed - the seed states what the supported set is.
 *
 * Takes a `PrismaClient` rather than `PrismaService` so the same function can be
 * called from the `prisma db seed` script (which has no Nest container) and from
 * the integration tests (which do).
 */
export async function seedAssets(prisma: PrismaClient): Promise<void> {
  for (const asset of SEED_ASSETS) {
    await prisma.asset.upsert({
      where: { symbol: asset.symbol },
      create: {
        symbol: asset.symbol,
        name: asset.name,
        kind: asset.kind,
        decimals: asset.decimals,
      },
      update: {
        name: asset.name,
        kind: asset.kind,
        decimals: asset.decimals,
        isActive: true,
      },
    });
  }
}
