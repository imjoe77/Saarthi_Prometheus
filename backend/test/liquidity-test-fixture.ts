import type { PrismaService } from '../src/database/prisma.service';

/**
 * Shared Module 09 test fixture - TEST VALUES ONLY.
 *
 * The slab thresholds here are deliberately shaped to exercise boundary
 * arithmetic (a zero-floor slab, then 100k/250k/500k cliffs). They now match
 * the approved production `LIQUIDITY_EMBER_SLABS` table (2026-10-18) exactly,
 * so the tested behaviour and the deployed behaviour share the same numbers;
 * the fixture itself is still test-only (env override before boot) and the
 * production value comes from configuration, never from this file.
 *
 * Every suite that boots an app for liquidity assertions must call
 * {@link configureTestLiquidityEnv} BEFORE `createApp()` - configuration is
 * read once at boot - and {@link clearTestLiquidityEnv} in `afterAll` so a
 * worker reused for the next file does not inherit the values.
 */
export const TEST_LIQUIDITY_SLABS = [
  { minUsdt: '0', requiredEmber: '1000' },
  { minUsdt: '100000', requiredEmber: '20000' },
  { minUsdt: '250000', requiredEmber: '45000' },
  { minUsdt: '500000', requiredEmber: '80000' },
] as const;

/** Test-default shortfall threshold (the production default is 200000). */
export const TEST_LIQUIDITY_THRESHOLD = '5000';

export function configureTestLiquidityEnv(): void {
  process.env['LIQUIDITY_EMBER_SLABS'] = JSON.stringify(TEST_LIQUIDITY_SLABS);
  process.env['LIQUIDITY_MIN_AVAILABLE_USDT'] = TEST_LIQUIDITY_THRESHOLD;
}

export function clearTestLiquidityEnv(): void {
  delete process.env['LIQUIDITY_EMBER_SLABS'];
  delete process.env['LIQUIDITY_MIN_AVAILABLE_USDT'];
}

/**
 * Deletes every Module 09 row so a suite starts from a known world: zero
 * providers means BUY orders take the legacy path until the suite registers
 * its own, and no shortfall notice from a previous run is mistaken for a live
 * one. Children before parents, because the schema restricts financial history.
 */
export async function resetLiquidityTables(prisma: PrismaService): Promise<void> {
  await prisma.liquidityAllocation.deleteMany({});
  await prisma.liquidityCommitmentReduction.deleteMany({});
  await prisma.liquidityCommitment.deleteMany({});
  await prisma.liquidityProvider.deleteMany({});
  await prisma.liquidityTopUpRequest.deleteMany({});
}
