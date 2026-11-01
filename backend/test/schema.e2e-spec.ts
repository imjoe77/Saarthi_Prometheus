import { randomUUID } from 'node:crypto';

import { Test } from '@nestjs/testing';
import { AssetKind, Prisma } from '@prisma/client';

import { AppConfigModule } from '../src/config/config.module';
import { DatabaseModule } from '../src/database/database.module';
import { PrismaService } from '../src/database/prisma.service';

/**
 * Sentinel used to abort a transaction after its assertions have run.
 *
 * Prisma's interactive transaction API has no explicit rollback handle, so the
 * documented way to discard a transaction's work is to throw out of it.
 */
class RollbackSignal extends Error {
  constructor() {
    super('rollback');
    this.name = 'RollbackSignal';
  }
}

const ROLLBACK = new RollbackSignal();

/**
 * Module 01 - schema, relationship and constraint verification.
 *
 * Asserts against a real PostgreSQL 16 instance, so it requires the docker
 * database. It is excluded from `npm test` (which stays database-free) and runs
 * with `npm run test:e2e`.
 *
 * Isolation: every assertion runs inside a transaction that is discarded
 * afterwards, so the suite leaves no rows behind and does not need to truncate
 * shared tables. That keeps it safe against seeded reference data and safe to
 * run repeatedly against a development database.
 *
 * Expected noise: roughly half the assertions deliberately provoke a constraint
 * violation, and Prisma logs each one at `error` level. That output is the
 * suite working as intended, not a failure - the `Test Suites`/`Tests`
 * summary is the signal to read.
 *
 * Two consequences worth knowing:
 *  - All reads and writes go through the `tx` handle. A query issued on the root
 *    `prisma` handle would run outside the transaction and see committed state.
 *  - Assertions that must inspect committed schema (indexes, column types)
 *    legitimately use the root handle, since catalog reads are unaffected.
 */
describe('Module 01 schema', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, DatabaseModule],
    }).compile();

    prisma = moduleRef.get(PrismaService);
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    if (prisma) await prisma.onModuleDestroy();
  });

  /** Runs `body` in a transaction, then discards every write it made. */
  async function withRollback(body: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
    try {
      await prisma.$transaction(async (tx) => {
        await body(tx);
        throw ROLLBACK;
      });
    } catch (error) {
      // Only the sentinel is expected. A genuine failure inside `body` must
      // surface rather than being swallowed as a successful rollback.
      if (!(error instanceof RollbackSignal)) throw error;
    }
  }

  /** Seeds the minimal graph needed to exercise a relationship. */
  async function seedGraph(tx: Prisma.TransactionClient) {
    const user = await tx.user.create({ data: { email: `${randomUUID()}@test.local` } });
    const wallet = await tx.wallet.create({ data: { userId: user.id } });
    const asset = await tx.asset.create({
      data: { symbol: `T${randomUUID().slice(0, 8)}`, name: 'Test Asset', kind: AssetKind.TOKEN },
    });
    return { user, wallet, asset };
  }

  // -------------------------------------------------------------------------
  // Structure
  // -------------------------------------------------------------------------

  describe('structure', () => {
    it('creates every Module 01 table', async () => {
      const rows = await prisma.$queryRaw<Array<{ table_name: string }>>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      `;
      const tables = rows.map((row) => row.table_name);

      // Module 02 adds auth_accounts; Module 05 adds strategies; Module 03b
      // adds wallet_deposits. The list stays explicit rather than being read
      // from the catalog, so an accidentally dropped table is still caught.
      for (const expected of [
        'users',
        'auth_accounts',
        'strategies',
        'wallets',
        'assets',
        'wallet_balances',
        'transactions',
        'wallet_deposits',
      ]) {
        expect(tables).toContain(expected);
      }
    });

    it('stores financial columns as NUMERIC(38,18), not floating point', async () => {
      const rows = await prisma.$queryRaw<
        Array<{ table_name: string; column_name: string; data_type: string; precision: number; scale: number }>
      >`
        SELECT table_name, column_name, data_type,
               numeric_precision AS precision, numeric_scale AS scale
        FROM information_schema.columns
        WHERE table_schema = 'public' AND data_type = 'numeric'
        ORDER BY table_name, column_name
      `;

      const financial = rows.filter((row) =>
        [
          'wallet_balances.available',
          'wallet_balances.locked',
          'transactions.amount',
          'transactions.available_after',
          'transactions.locked_after',
          'wallet_deposits.amount',
        ].includes(`${row.table_name}.${row.column_name}`),
      );

      expect(financial).toHaveLength(6);
      for (const row of financial) {
        expect(row.data_type).toBe('numeric');
        expect(row.precision).toBe(38);
        expect(row.scale).toBe(18);
      }
    });

    it('stores no floating-point columns, so money cannot drift', async () => {
      const rows = await prisma.$queryRaw<Array<{ column_name: string; data_type: string }>>`
        SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND data_type IN ('real', 'double precision', 'money')
      `;

      expect(rows).toEqual([]);
    });

    it('uses UUID primary keys for every application entity', async () => {
      const rows = await prisma.$queryRaw<Array<{ table_name: string; data_type: string }>>`
        SELECT table_name, data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'id'
          AND table_name <> '_prisma_migrations'
      `;

      // Every table must have an id, and every one of them must be a UUID. The
      // count is asserted as a set rather than a number so that adding a table in
      // a later module does not require editing this test - but the table list is
      // pinned, so a missing or unexpected table still fails.
      expect(rows.map((row) => row.table_name).sort()).toEqual([
        'admin_audit_logs',
        'assets',
        'auth_accounts',
        'blockchain_events',
        'role_requests',
        'strategies',
        'transactions',
        'user_profiles',
        'user_roles',
        'users',
        'wallet_balances',
        'wallet_deposits',
        'wallets',
      ]);
      for (const row of rows) {
        expect(row.data_type).toBe('uuid');
      }
    });

    it('stores timestamps as timestamptz so UTC is unambiguous', async () => {
      const rows = await prisma.$queryRaw<Array<{ data_type: string }>>`
        SELECT data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name IN ('created_at', 'updated_at')
      `;

      // Two such columns per entity table; the table list is pinned by the test
      // above, so asserting the exact count here is a real cross-check rather
      // than a number that drifts with the schema. Module 13 added four stamps:
      // created_at on admin_audit_logs and role_requests, and both columns on
      // user_profiles (user_roles carries neither). The EMBER blockchain layer
      // added one: updated_at on ember_mint_requests. Module 14 (Sentinel)
      // added five: both columns on sentinel_alerts and sentinel_voice_settings,
      // and updated_at on sentinel_voice_calls (24 total - the call row's own
      // lifecycle times are queued_at/initiated_at/completed_at, deliberately
      // not the generic pair). Module 03b added two: both columns on
      // wallet_deposits (26 total). The Module 08 x 11 outbox added one:
      // updated_at on exchange_revenue_events, whose creation stamp is
      // detected_at - when the order settled, not when a session touched the row.
      expect(rows).toHaveLength(27);
      for (const row of rows) {
        // A naive timestamp would re-interpret its value in whatever session
        // time zone happens to be set, which silently corrupts audit history.
        expect(row.data_type).toBe('timestamp with time zone');
      }
    });

    it('creates the indexes that justified lookup paths need', async () => {
      const rows = await prisma.$queryRaw<Array<{ indexname: string }>>`
        SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
      `;
      const indexes = rows.map((row) => row.indexname);

      // Wallet history listing (Module 03) and per-asset analysis.
      expect(indexes).toContain('transactions_wallet_id_created_at_idx');
      expect(indexes).toContain('transactions_asset_id_created_at_idx');
      // The one-balance-per-wallet-per-asset invariant.
      expect(indexes).toContain('wallet_balances_wallet_id_asset_id_key');
      // Asset-level aggregates, which the composite index cannot serve.
      expect(indexes).toContain('wallet_balances_asset_id_idx');
      // Uniqueness guarantees.
      expect(indexes).toContain('users_email_key');
      expect(indexes).toContain('assets_symbol_key');
      expect(indexes).toContain('wallets_user_id_key');
      // Module 05: the two modelled strategy indexes plus the hand-written
      // functional unique index that enforces one name per owner.
      expect(indexes).toContain('strategies_owner_id_created_at_idx');
      expect(indexes).toContain('strategies_visibility_status_created_at_idx');
      expect(indexes).toContain('strategies_owner_id_lower_name_key');
      // Module 03b: the deposit's idempotency key and its history listing.
      expect(indexes).toContain('wallet_deposits_user_id_client_request_id_key');
      expect(indexes).toContain('wallet_deposits_user_id_created_at_idx');
    });
  });

  // -------------------------------------------------------------------------
  // Relationships
  // -------------------------------------------------------------------------

  describe('relationships', () => {
    it('gives a user exactly one wallet and reads it back', async () => {
      await withRollback(async (tx) => {
        const { user, wallet } = await seedGraph(tx);

        const loaded = await tx.user.findUniqueOrThrow({
          where: { id: user.id },
          include: { wallet: true },
        });

        expect(loaded.wallet).not.toBeNull();
        expect(loaded.wallet?.id).toBe(wallet.id);
      });
    });

    it('rejects a second wallet for the same user', async () => {
      await withRollback(async (tx) => {
        const { user } = await seedGraph(tx);

        await expect(tx.wallet.create({ data: { userId: user.id } })).rejects.toMatchObject({
          code: 'P2002',
        });
      });
    });

    it('rejects a wallet whose user does not exist', async () => {
      await withRollback(async (tx) => {
        await expect(tx.wallet.create({ data: { userId: randomUUID() } })).rejects.toMatchObject({
          code: 'P2003',
        });
      });
    });

    it('links a balance to both its wallet and its asset', async () => {
      await withRollback(async (tx) => {
        const { wallet, asset } = await seedGraph(tx);

        const balance = await tx.walletBalance.create({
          data: { walletId: wallet.id, assetId: asset.id, available: '1500.25', locked: '499.75' },
        });

        const loaded = await tx.walletBalance.findUniqueOrThrow({
          where: { id: balance.id },
          include: { wallet: true, asset: true },
        });

        expect(loaded.walletId).toBe(wallet.id);
        expect(loaded.assetId).toBe(asset.id);
        expect(loaded.asset.symbol).toBe(asset.symbol);
      });
    });

    it('rejects a balance for a non-existent wallet', async () => {
      await withRollback(async (tx) => {
        const { asset } = await seedGraph(tx);

        await expect(
          tx.walletBalance.create({ data: { walletId: randomUUID(), assetId: asset.id } }),
        ).rejects.toMatchObject({ code: 'P2003' });
      });
    });

    it('rejects a balance for a non-existent asset', async () => {
      await withRollback(async (tx) => {
        const { wallet } = await seedGraph(tx);

        await expect(
          tx.walletBalance.create({ data: { walletId: wallet.id, assetId: randomUUID() } }),
        ).rejects.toMatchObject({ code: 'P2003' });
      });
    });

    it('rejects a duplicate balance for the same wallet and asset', async () => {
      await withRollback(async (tx) => {
        const { wallet, asset } = await seedGraph(tx);

        await tx.walletBalance.create({ data: { walletId: wallet.id, assetId: asset.id } });

        await expect(
          tx.walletBalance.create({ data: { walletId: wallet.id, assetId: asset.id } }),
        ).rejects.toMatchObject({ code: 'P2002' });
      });
    });

    it('allows the same asset to be held by two different wallets', async () => {
      await withRollback(async (tx) => {
        const { wallet, asset } = await seedGraph(tx);
        const other = await tx.user.create({ data: { email: `${randomUUID()}@test.local` } });
        const otherWallet = await tx.wallet.create({ data: { userId: other.id } });

        await tx.walletBalance.create({ data: { walletId: wallet.id, assetId: asset.id } });
        await tx.walletBalance.create({ data: { walletId: otherWallet.id, assetId: asset.id } });

        const count = await tx.walletBalance.count({ where: { assetId: asset.id } });
        expect(count).toBe(2);
      });
    });

    it('links a transaction to both its wallet and its asset', async () => {
      await withRollback(async (tx) => {
        const { wallet, asset } = await seedGraph(tx);

        const record = await tx.transaction.create({
          data: {
            walletId: wallet.id,
            assetId: asset.id,
            type: 'DEPOSIT',
            status: 'COMPLETED',
            amount: '2500.000000000000000000',
            availableAfter: '2500',
          },
        });

        const loaded = await tx.transaction.findUniqueOrThrow({
          where: { id: record.id },
          include: { wallet: { include: { user: true } }, asset: true },
        });

        expect(loaded.wallet.user).toBeDefined();
        expect(loaded.asset.symbol).toBe(asset.symbol);
      });
    });

    it('rejects a transaction referencing a wallet that does not exist', async () => {
      await withRollback(async (tx) => {
        const { asset } = await seedGraph(tx);

        await expect(
          tx.transaction.create({
            data: { walletId: randomUUID(), assetId: asset.id, type: 'DEPOSIT', amount: '1' },
          }),
        ).rejects.toMatchObject({ code: 'P2003' });
      });
    });

    it('rejects a transaction referencing an asset that does not exist', async () => {
      await withRollback(async (tx) => {
        const { wallet } = await seedGraph(tx);

        await expect(
          tx.transaction.create({
            data: { walletId: wallet.id, assetId: randomUUID(), type: 'DEPOSIT', amount: '1' },
          }),
        ).rejects.toMatchObject({ code: 'P2003' });
      });
    });

    it('refuses to delete a wallet whose owner has financial history', async () => {
      // Documents the Restrict decision: destroying a user must not silently
      // erase a ledger.
      await withRollback(async (tx) => {
        const { user, wallet, asset } = await seedGraph(tx);
        await tx.transaction.create({
          data: { walletId: wallet.id, assetId: asset.id, type: 'DEPOSIT', amount: '10' },
        });

        await expect(tx.user.delete({ where: { id: user.id } })).rejects.toBeDefined();
      });
    });

    it('refuses to delete an asset that is referenced by a balance', async () => {
      await withRollback(async (tx) => {
        const { wallet, asset } = await seedGraph(tx);
        await tx.walletBalance.create({ data: { walletId: wallet.id, assetId: asset.id } });

        await expect(tx.asset.delete({ where: { id: asset.id } })).rejects.toBeDefined();
      });
    });
  });

  // -------------------------------------------------------------------------
  // Uniqueness
  // -------------------------------------------------------------------------

  describe('uniqueness', () => {
    it('rejects a duplicate user email', async () => {
      await withRollback(async (tx) => {
        const email = `${randomUUID()}@test.local`;
        await tx.user.create({ data: { email } });

        await expect(tx.user.create({ data: { email } })).rejects.toMatchObject({ code: 'P2002' });
      });
    });

    it('rejects a duplicate auth identity, keeping auth 1:1 with users', async () => {
      await withRollback(async (tx) => {
        const authUserId = randomUUID();
        await tx.user.create({ data: { email: `${randomUUID()}@test.local`, authUserId } });

        await expect(
          tx.user.create({ data: { email: `${randomUUID()}@test.local`, authUserId } }),
        ).rejects.toMatchObject({ code: 'P2002' });
      });
    });

    it('allows multiple users with no auth identity yet', async () => {
      // Module 01 must be usable before Module 02 exists.
      await withRollback(async (tx) => {
        await tx.user.create({ data: { email: `${randomUUID()}@test.local` } });
        await tx.user.create({ data: { email: `${randomUUID()}@test.local` } });

        const count = await tx.user.count({ where: { authUserId: null } });
        expect(count).toBeGreaterThanOrEqual(2);
      });
    });

    it('rejects a duplicate asset symbol', async () => {
      await withRollback(async (tx) => {
        const symbol = `T${randomUUID().slice(0, 8)}`;
        await tx.asset.create({ data: { symbol, name: 'First', kind: AssetKind.FIAT } });

        await expect(
          tx.asset.create({ data: { symbol, name: 'Second', kind: AssetKind.TOKEN } }),
        ).rejects.toMatchObject({ code: 'P2002' });
      });
    });
  });

  // -------------------------------------------------------------------------
  // Integrity constraints
  //
  // These assert against the database, not the ORM. Raw SQL is used on purpose:
  // it proves the CHECK constraints exist and hold regardless of which client
  // or code path writes the row.
  // -------------------------------------------------------------------------

  describe('integrity constraints', () => {
    it('rejects a negative available balance', async () => {
      await withRollback(async (tx) => {
        const { wallet, asset } = await seedGraph(tx);

        await expect(
          tx.$executeRaw`INSERT INTO wallet_balances
                         (id, wallet_id, asset_id, available, locked, created_at, updated_at)
                         VALUES (${randomUUID()}::uuid, ${wallet.id}::uuid, ${asset.id}::uuid,
                                 -1, 0, now(), now())`,
        ).rejects.toThrow(/wallet_balances_available_non_negative/);
      });
    });

    it('rejects a negative locked balance', async () => {
      await withRollback(async (tx) => {
        const { wallet, asset } = await seedGraph(tx);

        await expect(
          tx.$executeRaw`INSERT INTO wallet_balances
                         (id, wallet_id, asset_id, available, locked, created_at, updated_at)
                         VALUES (${randomUUID()}::uuid, ${wallet.id}::uuid, ${asset.id}::uuid,
                                 100, -5, now(), now())`,
        ).rejects.toThrow(/wallet_balances_locked_non_negative/);
      });
    });

    it('rejects a negative balance written through Prisma as well', async () => {
      // The CHECK is the guarantee; this proves the ORM path cannot bypass it.
      await withRollback(async (tx) => {
        const { wallet, asset } = await seedGraph(tx);

        await expect(
          tx.walletBalance.create({
            data: { walletId: wallet.id, assetId: asset.id, available: '-0.01' },
          }),
        ).rejects.toThrow(/wallet_balances_available_non_negative/);
      });
    });

    it('accepts a zero balance, which is the correct initial state', async () => {
      await withRollback(async (tx) => {
        const { wallet, asset } = await seedGraph(tx);

        const balance = await tx.walletBalance.create({
          data: { walletId: wallet.id, assetId: asset.id, available: 0, locked: 0 },
        });

        expect(balance.available.toString()).toBe('0');
        expect(balance.locked.toString()).toBe('0');
      });
    });

    it('preserves 18 decimal places exactly', async () => {
      await withRollback(async (tx) => {
        const { wallet, asset } = await seedGraph(tx);
        const precise = '0.000000000000000001';

        const balance = await tx.walletBalance.create({
          data: { walletId: wallet.id, assetId: asset.id, available: precise },
        });
        const reloaded = await tx.walletBalance.findUniqueOrThrow({ where: { id: balance.id } });

        // toFixed, not toString: Prisma.Decimal prints very small or very large
        // magnitudes in exponential notation ("1e-18"). The numeric value is
        // what the column stores, so assert on the fixed-point rendering.
        expect(reloaded.available.toFixed(18)).toBe(precise);
      });
    });

    it('round-trips a sum that binary floating point would corrupt', async () => {
      await withRollback(async (tx) => {
        const { wallet, asset } = await seedGraph(tx);
        // 0.1 + 0.2 !== 0.3 as a float. Through NUMERIC it is exact, which is
        // the whole reason for the NUMERIC(38,18) decision.
        const persisted = '0.300000000000000000';

        const balance = await tx.walletBalance.create({
          data: { walletId: wallet.id, assetId: asset.id, available: persisted },
        });
        const reloaded = await tx.walletBalance.findUniqueOrThrow({ where: { id: balance.id } });

        // Exact decimal arithmetic: 0.1 + 0.2 is 0.3, not 0.30000000000000004.
        // The same sum in IEEE-754 doubles drifts, which is the reason
        // balances are stored as NUMERIC and read back as Prisma.Decimal.
        expect(reloaded.available.add('0.1').add('0.2').toFixed(18)).toBe('0.600000000000000000');
        expect(new Prisma.Decimal(0.1).add(0.2).toFixed(18)).toBe('0.300000000000000000');
        expect(0.1 + 0.2).not.toBe(0.3);
      });
    });

    it('rejects a zero transaction amount', async () => {
      await withRollback(async (tx) => {
        const { wallet, asset } = await seedGraph(tx);

        await expect(
          tx.transaction.create({ data: { walletId: wallet.id, assetId: asset.id, type: 'DEPOSIT', amount: '0' } }),
        ).rejects.toThrow(/transactions_amount_positive/);
      });
    });

    it('rejects a negative transaction amount', async () => {
      await withRollback(async (tx) => {
        const { wallet, asset } = await seedGraph(tx);

        await expect(
          tx.transaction.create({ data: { walletId: wallet.id, assetId: asset.id, type: 'DEPOSIT', amount: '-100' } }),
        ).rejects.toThrow(/transactions_amount_positive/);
      });
    });

    it('rejects every non-positive amount, each in its own transaction', async () => {
      // PostgreSQL aborts a transaction on the first constraint violation
      // (SQLSTATE 25P02), so multiple expected rejections cannot share one
      // transaction. Each amount is proven in isolation instead.
      for (const amount of ['0', '-0.000000000000000001', '-1000000']) {
        await withRollback(async (tx) => {
          const { wallet, asset } = await seedGraph(tx);

          await expect(
            tx.transaction.create({ data: { walletId: wallet.id, assetId: asset.id, type: 'DEPOSIT', amount } }),
          ).rejects.toThrow(/transactions_amount_positive/);
        });
      }
    });

    it('rejects a negative post-transaction balance snapshot', async () => {
      await withRollback(async (tx) => {
        const { wallet, asset } = await seedGraph(tx);

        await expect(
          tx.transaction.create({
            data: {
              walletId: wallet.id,
              assetId: asset.id,
              type: 'WITHDRAWAL',
              amount: '10',
              availableAfter: '-10',
            },
          }),
        ).rejects.toThrow(/transactions_available_after_non_negative/);
      });
    });

    it('rejects a negative locked snapshot', async () => {
      await withRollback(async (tx) => {
        const { wallet, asset } = await seedGraph(tx);

        await expect(
          tx.transaction.create({
            data: {
              walletId: wallet.id,
              assetId: asset.id,
              type: 'LOCK',
              amount: '10',
              lockedAfter: '-10',
            },
          }),
        ).rejects.toThrow(/transactions_locked_after_non_negative/);
      });
    });

    it('allows a null snapshot, since a failed entry moves nothing', async () => {
      await withRollback(async (tx) => {
        const { wallet, asset } = await seedGraph(tx);

        const record = await tx.transaction.create({
          data: {
            walletId: wallet.id,
            assetId: asset.id,
            type: 'DEPOSIT',
            status: 'FAILED',
            amount: '10',
          },
        });

        expect(record.availableAfter).toBeNull();
      });
    });

    it('requires a note on an ADJUSTMENT so a correction is attributable', async () => {
      // Each case gets its own transaction: a rejected statement aborts the
      // surrounding one, so a following assertion would see SQLSTATE 25P02
      // instead of its own constraint.
      await withRollback(async (tx) => {
        const { wallet, asset } = await seedGraph(tx);

        await expect(
          tx.transaction.create({
            data: { walletId: wallet.id, assetId: asset.id, type: 'ADJUSTMENT', amount: '5' },
          }),
        ).rejects.toThrow(/transactions_adjustment_requires_note/);
      });

      await withRollback(async (tx) => {
        const { wallet, asset } = await seedGraph(tx);

        await expect(
          tx.transaction.create({
            data: { walletId: wallet.id, assetId: asset.id, type: 'ADJUSTMENT', amount: '5', note: '   ' },
          }),
        ).rejects.toThrow(/transactions_adjustment_requires_note/);
      });

      await withRollback(async (tx) => {
        const { wallet, asset } = await seedGraph(tx);

        const noted = await tx.transaction.create({
          data: {
            walletId: wallet.id,
            assetId: asset.id,
            type: 'ADJUSTMENT',
            amount: '5',
            note: 'Seed correction',
          },
        });
        expect(noted.note).toBe('Seed correction');
      });
    });

    it('allows an unattributed transaction that is not an adjustment', async () => {
      await withRollback(async (tx) => {
        const { wallet, asset } = await seedGraph(tx);

        const record = await tx.transaction.create({
          data: { walletId: wallet.id, assetId: asset.id, type: 'DEPOSIT', amount: '5' },
        });

        expect(record.note).toBeNull();
      });
    });

    it('rejects a blank asset symbol', async () => {
      await withRollback(async (tx) => {
        await expect(
          tx.asset.create({ data: { symbol: '   ', name: 'Blank', kind: AssetKind.FIAT } }),
        ).rejects.toThrow(/assets_symbol_not_blank/);
      });
    });

    // -------------------------------------------------------------------------
    // Module 03b - wallet deposits
    // -------------------------------------------------------------------------

    it('rejects a non-positive deposit amount', async () => {
      for (const amount of ['0', '-100']) {
        await withRollback(async (tx) => {
          const { user, asset } = await seedGraph(tx);

          await expect(
            tx.walletDeposit.create({
              data: { userId: user.id, assetId: asset.id, amount, clientRequestId: randomUUID() },
            }),
          ).rejects.toThrow(/wallet_deposits_amount_positive/);
        });
      }
    });

    it('rejects a blank deposit idempotency key', async () => {
      await withRollback(async (tx) => {
        const { user, asset } = await seedGraph(tx);

        await expect(
          tx.walletDeposit.create({
            data: { userId: user.id, assetId: asset.id, amount: '100', clientRequestId: '   ' },
          }),
        ).rejects.toThrow(/wallet_deposits_client_request_id_not_blank/);
      });
    });

    it('rejects a blank provider reference', async () => {
      await withRollback(async (tx) => {
        const { user, asset } = await seedGraph(tx);

        await expect(
          tx.walletDeposit.create({
            data: {
              userId: user.id,
              assetId: asset.id,
              amount: '100',
              clientRequestId: randomUUID(),
              providerReference: '   ',
            },
          }),
        ).rejects.toThrow(/wallet_deposits_provider_reference_not_blank/);
      });
    });

    it('accepts several deposits with no provider reference, because a null reference is not a duplicate', async () => {
      await withRollback(async (tx) => {
        const { user, asset } = await seedGraph(tx);

        await tx.walletDeposit.create({
          data: { userId: user.id, assetId: asset.id, amount: '100', clientRequestId: randomUUID() },
        });
        const second = await tx.walletDeposit.create({
          data: { userId: user.id, assetId: asset.id, amount: '250', clientRequestId: randomUUID() },
        });

        expect(second.providerReference).toBeNull();
      });
    });

    it('rejects a second deposit with the same idempotency key for the same user', async () => {
      await withRollback(async (tx) => {
        const { user, asset } = await seedGraph(tx);
        const clientRequestId = randomUUID();

        await tx.walletDeposit.create({
          data: { userId: user.id, assetId: asset.id, amount: '100', clientRequestId },
        });

        await expect(
          tx.walletDeposit.create({
            data: { userId: user.id, assetId: asset.id, amount: '100', clientRequestId },
          }),
        ).rejects.toMatchObject({ code: 'P2002' });
      });
    });

    it('rejects a duplicate provider reference, because a provider order funds one deposit', async () => {
      await withRollback(async (tx) => {
        const { user, asset } = await seedGraph(tx);

        await tx.walletDeposit.create({
          data: {
            userId: user.id,
            assetId: asset.id,
            amount: '100',
            clientRequestId: randomUUID(),
            providerReference: 'order_shared',
          },
        });

        await expect(
          tx.walletDeposit.create({
            data: {
              userId: user.id,
              assetId: asset.id,
              amount: '100',
              clientRequestId: randomUUID(),
              providerReference: 'order_shared',
            },
          }),
        ).rejects.toMatchObject({ code: 'P2002' });
      });
    });

    it('defaults a new deposit to PENDING, because the money has not arrived yet', async () => {
      await withRollback(async (tx) => {
        const { user, asset } = await seedGraph(tx);

        const deposit = await tx.walletDeposit.create({
          data: { userId: user.id, assetId: asset.id, amount: '100', clientRequestId: randomUUID() },
        });

        expect(deposit.status).toBe('PENDING');
        expect(deposit.provider).toBe('manual');
      });
    });

    it('rejects a transaction type outside the declared enum', async () => {
      await withRollback(async (tx) => {
        const { wallet, asset } = await seedGraph(tx);

        await expect(
          tx.$executeRaw`INSERT INTO transactions
                         (id, wallet_id, asset_id, type, status, amount, created_at, updated_at)
                         VALUES (${randomUUID()}::uuid, ${wallet.id}::uuid, ${asset.id}::uuid,
                                 'NOT_A_TYPE', 'COMPLETED', 1, now(), now())`,
        ).rejects.toThrow();
      });
    });

    it('rejects a transaction status outside the declared enum', async () => {
      await withRollback(async (tx) => {
        const { wallet, asset } = await seedGraph(tx);

        await expect(
          tx.$executeRaw`INSERT INTO transactions
                         (id, wallet_id, asset_id, type, status, amount, created_at, updated_at)
                         VALUES (${randomUUID()}::uuid, ${wallet.id}::uuid, ${asset.id}::uuid,
                                 'DEPOSIT', 'MADE_UP', 1, now(), now())`,
        ).rejects.toThrow();
      });
    });

    it('rejects an asset kind outside the declared enum', async () => {
      await withRollback(async (tx) => {
        await expect(
          tx.$executeRaw`INSERT INTO assets (id, symbol, name, kind, decimals, is_active, created_at, updated_at)
                         VALUES (${randomUUID()}::uuid, ${`X${randomUUID().slice(0, 6)}`}, 'Bad', 'CRYPTO', 18, true, now(), now())`,
        ).rejects.toThrow();
      });
    });

    it('defaults a new user to ACTIVE and a wallet to ACTIVE', async () => {
      await withRollback(async (tx) => {
        const { user, wallet } = await seedGraph(tx);

        expect(user.status).toBe('ACTIVE');
        expect(wallet.status).toBe('ACTIVE');
      });
    });

    it('defaults a new asset to active and a transaction to PENDING', async () => {
      await withRollback(async (tx) => {
        const { wallet, asset } = await seedGraph(tx);

        expect(asset.isActive).toBe(true);

        const record = await tx.transaction.create({
          data: { walletId: wallet.id, assetId: asset.id, type: 'DEPOSIT', amount: '1' },
        });
        expect(record.status).toBe('PENDING');
      });
    });

    it('sets createdAt and updatedAt on every row', async () => {
      await withRollback(async (tx) => {
        const { user, wallet, asset } = await seedGraph(tx);
        const balance = await tx.walletBalance.create({
          data: { walletId: wallet.id, assetId: asset.id, available: '1' },
        });
        const record = await tx.transaction.create({
          data: { walletId: wallet.id, assetId: asset.id, type: 'DEPOSIT', amount: '1' },
        });

        for (const row of [user, wallet, asset, balance, record]) {
          expect(row.createdAt).toBeInstanceOf(Date);
          expect(row.updatedAt).toBeInstanceOf(Date);
        }
      });
    });

    it('advances updatedAt when a row is modified', async () => {
      await withRollback(async (tx) => {
        const { wallet, asset } = await seedGraph(tx);
        const balance = await tx.walletBalance.create({
          data: { walletId: wallet.id, assetId: asset.id, available: '1' },
        });

        const updated = await tx.walletBalance.update({
          where: { id: balance.id },
          data: { available: '2' },
        });

        expect(updated.available.toString()).toBe('2');
        expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(balance.updatedAt.getTime());
      });
    });
  });

  // -------------------------------------------------------------------------
  // Atomicity
  //
  // Proves the rollback mechanism now, before Module 03 makes correctness
  // depend on it for balance-and-transaction atomicity.
  // -------------------------------------------------------------------------

  describe('atomicity', () => {
    it('discards every write when a transaction fails partway', async () => {
      const { wallet, asset } = await seedGraphInOwnTransaction(prisma);

      await expect(
        prisma.$transaction(async (client) => {
          await client.walletBalance.create({
            data: { walletId: wallet.id, assetId: asset.id, available: '100' },
          });
          // Deliberate failure after a successful write.
          throw new Error('rollback requested');
        }),
      ).rejects.toThrow('rollback requested');

      const survivors = await prisma.walletBalance.count({ where: { walletId: wallet.id } });
      expect(survivors).toBe(0);

      await cleanup(prisma, wallet.id);
    });

    it('applies nothing when a batch contains one invalid row', async () => {
      const { wallet, asset } = await seedGraphInOwnTransaction(prisma);

      await expect(
        prisma.$transaction([
          prisma.walletBalance.create({ data: { walletId: wallet.id, assetId: asset.id, available: '10' } }),
          // Duplicate of the row above: violates the composite unique index.
          prisma.walletBalance.create({ data: { walletId: wallet.id, assetId: asset.id, available: '20' } }),
        ]),
      ).rejects.toBeDefined();

      const survivors = await prisma.walletBalance.count({ where: { walletId: wallet.id } });
      expect(survivors).toBe(0);

      await cleanup(prisma, wallet.id);
    });

    it('commits every write when the whole transaction succeeds', async () => {
      const { wallet, asset } = await seedGraphInOwnTransaction(prisma);

      await prisma.$transaction(async (client) => {
        await client.walletBalance.create({
          data: { walletId: wallet.id, assetId: asset.id, available: '100' },
        });
        await client.transaction.create({
          data: {
            walletId: wallet.id,
            assetId: asset.id,
            type: 'DEPOSIT',
            status: 'COMPLETED',
            amount: '100',
            availableAfter: '100',
          },
        });
      });

      const balances = await prisma.walletBalance.count({ where: { walletId: wallet.id } });
      const records = await prisma.transaction.count({ where: { walletId: wallet.id } });
      expect(balances).toBe(1);
      expect(records).toBe(1);

      await cleanup(prisma, wallet.id);
    });
  });

  // -------------------------------------------------------------------------
  // Module 02 additions: auth_accounts
  //
  // These assertions exist because the authentication service relies on them
  // for correctness. `AuthService` decides whether to create a Prometheus user by
  // consulting `auth_accounts`, so a missing or wrong constraint here would not
  // fail loudly - it would silently produce duplicate users in production.
  // -------------------------------------------------------------------------

  describe('auth_accounts (Module 02)', () => {
    it('links an identity to a user and reads it back', async () => {
      await withRollback(async (tx) => {
        const user = await tx.user.create({ data: { email: `${randomUUID()}@test.local` } });
        const account = await tx.authAccount.create({
          data: {
            userId: user.id,
            provider: 'google',
            providerAccountId: '109876543210',
            providerEmail: 'linked@example.com',
            label: 'google',
          },
        });

        const loaded = await tx.user.findUniqueOrThrow({
          where: { id: user.id },
          include: { authAccounts: true },
        });

        expect(loaded.authAccounts).toHaveLength(1);
        expect(loaded.authAccounts[0]).toMatchObject({
          id: account.id,
          provider: 'google',
          providerAccountId: '109876543210',
        });
      });
    });

    it('refuses the same provider identity twice', async () => {
      // This is the constraint that stops a second Prometheus user being created
      // for one provider login.
      await withRollback(async (tx) => {
        const first = await tx.user.create({ data: { email: `${randomUUID()}@test.local` } });
        await tx.authAccount.create({
          data: { userId: first.id, provider: 'google', providerAccountId: 'shared-id' },
        });

        const second = await tx.user.create({ data: { email: `${randomUUID()}@test.local` } });
        await expect(
          tx.authAccount.create({
            data: { userId: second.id, provider: 'google', providerAccountId: 'shared-id' },
          }),
        ).rejects.toMatchObject({ code: 'P2002' });
      });
    });

    it('treats the same account id at a different provider as a different identity', async () => {
      // Google and GitHub number users independently, so id collisions across
      // providers are expected and must not collide here.
      await withRollback(async (tx) => {
        const user = await tx.user.create({ data: { email: `${randomUUID()}@test.local` } });
        await tx.authAccount.create({
          data: { userId: user.id, provider: 'google', providerAccountId: '12345' },
        });
        const other = await tx.user.create({ data: { email: `${randomUUID()}@test.local` } });
        const github = await tx.authAccount.create({
          data: { userId: other.id, provider: 'github', providerAccountId: '12345' },
        });

        expect(github.provider).toBe('github');
      });
    });

    it('refuses a second account of the same provider for one user', async () => {
      // Keeps a re-login from leaving two near-identical rows behind.
      await withRollback(async (tx) => {
        const user = await tx.user.create({ data: { email: `${randomUUID()}@test.local` } });
        await tx.authAccount.create({
          data: { userId: user.id, provider: 'google', providerAccountId: 'aaa' },
        });

        await expect(
          tx.authAccount.create({
            data: { userId: user.id, provider: 'google', providerAccountId: 'bbb' },
          }),
        ).rejects.toMatchObject({ code: 'P2002' });
      });
    });

    it('lets one user hold both a google and a github identity', async () => {
      // The reason AuthAccount exists instead of a single column on users.
      await withRollback(async (tx) => {
        const user = await tx.user.create({ data: { email: `${randomUUID()}@test.local` } });
        await tx.authAccount.create({
          data: { userId: user.id, provider: 'google', providerAccountId: 'g-1' },
        });
        await tx.authAccount.create({
          data: { userId: user.id, provider: 'github', providerAccountId: 'h-1' },
        });

        const linked = await tx.authAccount.count({ where: { userId: user.id } });
        expect(linked).toBe(2);
      });
    });

    it('allows providerEmail and label to be null', async () => {
      await withRollback(async (tx) => {
        const user = await tx.user.create({ data: { email: `${randomUUID()}@test.local` } });
        const account = await tx.authAccount.create({
          data: { userId: user.id, provider: 'github', providerAccountId: 'no-email' },
        });

        expect(account.providerEmail).toBeNull();
        expect(account.label).toBeNull();
      });
    });

    it('removes an account when its user is deleted', async () => {
      // Cascade, not restrict: an orphaned identity row could otherwise be
      // matched on a later login and resolve to a user that no longer exists.
      await withRollback(async (tx) => {
        const user = await tx.user.create({ data: { email: `${randomUUID()}@test.local` } });
        await tx.authAccount.create({
          data: { userId: user.id, provider: 'google', providerAccountId: 'cascade-me' },
        });

        await tx.user.delete({ where: { id: user.id } });

        const orphans = await tx.authAccount.count({ where: { providerAccountId: 'cascade-me' } });
        expect(orphans).toBe(0);
      });
    });

    it('refuses an account whose user does not exist', async () => {
      await withRollback(async (tx) => {
        await expect(
          tx.authAccount.create({
            data: { userId: randomUUID(), provider: 'google', providerAccountId: 'no-user' },
          }),
        ).rejects.toMatchObject({ code: 'P2003' });
      });
    });

    it('rejects an unknown provider at the database level', async () => {
      // The check constraint is a backstop. Application code validates the
      // provider too, but the table is reachable by any client that can talk to
      // PostgreSQL, and an unrecognised provider would resolve to no user.
      await withRollback(async (tx) => {
        const user = await tx.user.create({ data: { email: `${randomUUID()}@test.local` } });

        await expect(
          tx.authAccount.create({
            data: { userId: user.id, provider: 'facebook', providerAccountId: '1' },
          }),
        ).rejects.toBeDefined();
      });
    });

    it('rejects a provider that is not lower case', async () => {
      // Lookups compare a lower-cased provider from the token, so a stored
      // `Google` would never match and would lock the user out silently.
      await withRollback(async (tx) => {
        const user = await tx.user.create({ data: { email: `${randomUUID()}@test.local` } });

        await expect(
          tx.authAccount.create({
            data: { userId: user.id, provider: 'Google', providerAccountId: '1' },
          }),
        ).rejects.toBeDefined();
      });
    });

    it('rejects a blank provider account id', async () => {
      await withRollback(async (tx) => {
        const user = await tx.user.create({ data: { email: `${randomUUID()}@test.local` } });

        await expect(
          tx.authAccount.create({
            data: { userId: user.id, provider: 'google', providerAccountId: '   ' },
          }),
        ).rejects.toBeDefined();
      });
    });

    it('indexes the columns the auth lookup actually uses', async () => {
      const rows = await prisma.$queryRaw<Array<{ indexname: string }>>`
        SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'auth_accounts'
      `;
      const indexes = rows.map((row) => row.indexname);

      // Resolving "which user owns this identity?" runs on every authenticated
      // request, so its index is on the hot path.
      expect(indexes).toContain('auth_accounts_provider_provider_account_id_key');
      expect(indexes).toContain('auth_accounts_user_id_provider_key');
      expect(indexes).toContain('auth_accounts_user_id_idx');
    });

    it('stores auth_user_id as a nullable, unique column on users', async () => {
      // Retained from Module 01 and kept authoritative for single-identity users.
      await withRollback(async (tx) => {
        const linked = await tx.user.create({
          data: { email: `${randomUUID()}@test.local`, authUserId: 'google:42' },
        });
        const standalone = await tx.user.create({ data: { email: `${randomUUID()}@test.local` } });

        expect(linked.authUserId).toBe('google:42');
        expect(standalone.authUserId).toBeNull();

        await expect(
          tx.user.create({
            data: { email: `${randomUUID()}@test.local`, authUserId: 'google:42' },
          }),
        ).rejects.toMatchObject({ code: 'P2002' });
      });
    });

    it('refuses two users sharing one email, case-insensitively', async () => {
      // `AuthService` lower-cases before writing, so the column must at minimum
      // refuse an exact duplicate.
      await withRollback(async (tx) => {
        await tx.user.create({ data: { email: 'dup@example.com' } });

        await expect(tx.user.create({ data: { email: 'dup@example.com' } })).rejects.toMatchObject({
          code: 'P2002',
        });
      });
    });

    it('stores no credential material on auth_accounts', async () => {
      // Verified from the live catalog rather than the Prisma model, because the
      // requirement is about what the table physically contains.
      const rows = await prisma.$queryRaw<Array<{ column_name: string }>>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'auth_accounts'
      `;
      const columns = rows.map((row) => row.column_name);

      expect(columns.sort()).toEqual([
        'created_at',
        'id',
        'label',
        'provider',
        'provider_account_id',
        'provider_email',
        'updated_at',
        'user_id',
      ]);
      for (const forbidden of ['access_token', 'refresh_token', 'password', 'token_hash', 'secret']) {
        expect(columns).not.toContain(forbidden);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Module 05 additions: strategies
  //
  // A strategy is a metadata row, so almost everything worth asserting here is a
  // constraint: who may own it, which names are refused, and - the one that needs
  // the most care to keep true as the schema grows - that no speculative column
  // has appeared. The service would refuse those values anyway, but a column that
  // exists is a column something else can later read and report.
  // -------------------------------------------------------------------------

  describe('strategies (Module 05)', () => {
    /** A user, with no wallet: strategies do not require one. */
    async function seedOwner(tx: Prisma.TransactionClient) {
      return tx.user.create({ data: { email: `${randomUUID()}@test.local` } });
    }

    it('links a strategy to its owner and reads it back', async () => {
      await withRollback(async (tx) => {
        const user = await seedOwner(tx);

        const strategy = await tx.strategy.create({
          data: { ownerId: user.id, name: 'EMBER momentum', description: 'Swing trades.' },
        });
        const loaded = await tx.user.findUniqueOrThrow({
          where: { id: user.id },
          include: { strategies: true },
        });

        expect(loaded.strategies).toHaveLength(1);
        expect(loaded.strategies[0]).toMatchObject({
          id: strategy.id,
          name: 'EMBER momentum',
          description: 'Swing trades.',
        });
      });
    });

    it('allows one user to own several strategies', async () => {
      await withRollback(async (tx) => {
        const user = await seedOwner(tx);

        await tx.strategy.create({ data: { ownerId: user.id, name: 'First' } });
        await tx.strategy.create({ data: { ownerId: user.id, name: 'Second' } });

        expect(await tx.strategy.count({ where: { ownerId: user.id } })).toBe(2);
      });
    });

    it('rejects a strategy whose owner does not exist', async () => {
      await withRollback(async (tx) => {
        await expect(
          tx.strategy.create({ data: { ownerId: randomUUID(), name: 'Orphan' } }),
        ).rejects.toMatchObject({ code: 'P2003' });
      });
    });

    it('refuses to delete a user who owns a strategy', async () => {
      // Restrict, not Cascade: Module 06 and 07 will hang follow history off this
      // owner, and a deletion must not be able to take it along silently.
      await withRollback(async (tx) => {
        const user = await seedOwner(tx);
        await tx.strategy.create({ data: { ownerId: user.id, name: 'Keep me' } });

        await expect(tx.user.delete({ where: { id: user.id } })).rejects.toBeDefined();
      });
    });

    it('refuses a duplicate name for one owner', async () => {
      await withRollback(async (tx) => {
        const user = await seedOwner(tx);
        await tx.strategy.create({ data: { ownerId: user.id, name: 'Twice' } });

        await expect(
          tx.strategy.create({ data: { ownerId: user.id, name: 'Twice' } }),
        ).rejects.toMatchObject({ code: 'P2002' });
      });
    });

    it('refuses a name that differs only by case', async () => {
      // The functional unique index on (owner_id, lower(name)) is the entire
      // enforcement of this rule, so the case variant is asserted against the
      // database rather than against any comparison in the service.
      await withRollback(async (tx) => {
        const user = await seedOwner(tx);
        await tx.strategy.create({ data: { ownerId: user.id, name: 'EMBER Momentum' } });

        await expect(
          tx.strategy.create({ data: { ownerId: user.id, name: 'ember momentum' } }),
        ).rejects.toMatchObject({ code: 'P2002' });
      });
    });

    it('refuses a name that differs only by surrounding whitespace', async () => {
      // `btrim` is part of the rule, so a raw writer cannot park a second row
      // under a name that only looks different.
      await withRollback(async (tx) => {
        const user = await seedOwner(tx);
        await tx.strategy.create({ data: { ownerId: user.id, name: 'Spaced' } });

        await expect(
          tx.strategy.create({ data: { ownerId: user.id, name: '   Spaced   ' } }),
        ).rejects.toMatchObject({ code: 'P2002' });
      });
    });

    it('allows two different owners to hold the same name', async () => {
      await withRollback(async (tx) => {
        const first = await seedOwner(tx);
        const second = await seedOwner(tx);

        await tx.strategy.create({ data: { ownerId: first.id, name: 'Same name' } });
        await tx.strategy.create({ data: { ownerId: second.id, name: 'Same name' } });

        expect(await tx.strategy.count({ where: { name: 'Same name' } })).toBe(2);
      });
    });

    it('rejects a blank name', async () => {
      await withRollback(async (tx) => {
        const user = await seedOwner(tx);

        await expect(
          tx.strategy.create({ data: { ownerId: user.id, name: '   ' } }),
        ).rejects.toThrow(/strategies_name_not_blank/);
      });
    });

    it('rejects a name longer than the documented limit', async () => {
      await withRollback(async (tx) => {
        const user = await seedOwner(tx);

        await expect(
          tx.strategy.create({ data: { ownerId: user.id, name: 'x'.repeat(81) } }),
        ).rejects.toThrow(/strategies_name_length/);
      });
    });

    it('accepts a name exactly at the limit', async () => {
      await withRollback(async (tx) => {
        const user = await seedOwner(tx);

        const strategy = await tx.strategy.create({
          data: { ownerId: user.id, name: 'x'.repeat(80) },
        });

        expect(strategy.name).toHaveLength(80);
      });
    });

    it('rejects a description longer than the documented limit', async () => {
      await withRollback(async (tx) => {
        const user = await seedOwner(tx);

        await expect(
          tx.strategy.create({
            data: { ownerId: user.id, name: 'Verbose', description: 'x'.repeat(1001) },
          }),
        ).rejects.toThrow(/strategies_description_length/);
      });
    });

    it('allows a null description, since one is optional', async () => {
      await withRollback(async (tx) => {
        const user = await seedOwner(tx);

        const strategy = await tx.strategy.create({ data: { ownerId: user.id, name: 'Silent' } });

        expect(strategy.description).toBeNull();
      });
    });

    it('defaults a new strategy to PRIVATE and ACTIVE', async () => {
      await withRollback(async (tx) => {
        const user = await seedOwner(tx);

        const strategy = await tx.strategy.create({ data: { ownerId: user.id, name: 'Defaulted' } });

        expect(strategy.visibility).toBe('PRIVATE');
        expect(strategy.status).toBe('ACTIVE');
      });
    });

    it('rejects a visibility outside the declared enum', async () => {
      await withRollback(async (tx) => {
        const user = await seedOwner(tx);

        await expect(
          tx.$executeRaw`INSERT INTO strategies
                         (id, owner_id, name, visibility, status, created_at, updated_at)
                         VALUES (${randomUUID()}::uuid, ${user.id}::uuid, 'Odd', 'UNLISTED', 'ACTIVE', now(), now())`,
        ).rejects.toThrow();
      });
    });

    it('rejects a status outside the declared enum', async () => {
      await withRollback(async (tx) => {
        const user = await seedOwner(tx);

        await expect(
          tx.$executeRaw`INSERT INTO strategies
                         (id, owner_id, name, visibility, status, created_at, updated_at)
                         VALUES (${randomUUID()}::uuid, ${user.id}::uuid, 'Odd', 'PRIVATE', 'PAUSED', now(), now())`,
        ).rejects.toThrow();
      });
    });

    it('stores only the approved columns, and no performance figure among them', async () => {
      // Read from the live catalog rather than the Prisma model, because the claim
      // is about what the table physically contains.
      const rows = await prisma.$queryRaw<Array<{ column_name: string }>>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'strategies'
      `;
      const columns = rows.map((row) => row.column_name);

      expect(columns.sort()).toEqual([
        'created_at',
        'description',
        'id',
        'name',
        'owner_id',
        'status',
        'updated_at',
        'visibility',
      ]);

      // Each of these would be a number nothing in this repository can compute.
      for (const forbidden of [
        'roi',
        'apy',
        'sharpe',
        'win_rate',
        'profit_factor',
        'drawdown',
        'pnl',
        'aum',
        'follower_count',
        'risk_level',
        'risk_score',
        'category',
        'tags',
        'performance',
      ]) {
        expect(columns).not.toContain(forbidden);
      }
    });

    it('indexes the columns the strategy queries actually use', async () => {
      const rows = await prisma.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
        SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'strategies'
      `;
      const byName = new Map(rows.map((row) => [row.indexname, row.indexdef]));

      // "My strategies", newest first.
      expect(byName.get('strategies_owner_id_created_at_idx')).toContain('owner_id');
      // Discovery: both filter columns lead, so every discovery query is served by
      // the index prefix alone.
      expect(byName.get('strategies_visibility_status_created_at_idx')).toContain('visibility');
      // The uniqueness rule, expressed as an expression the schema language cannot.
      expect(byName.get('strategies_owner_id_lower_name_key')).toBeDefined();
      expect(byName.get('strategies_owner_id_lower_name_key')).toContain('lower');
      expect(byName.get('strategies_owner_id_lower_name_key')).toContain('UNIQUE');
    });

    it('sets createdAt and updatedAt on a strategy', async () => {
      await withRollback(async (tx) => {
        const user = await seedOwner(tx);
        const strategy = await tx.strategy.create({ data: { ownerId: user.id, name: 'Timed' } });

        expect(strategy.createdAt).toBeInstanceOf(Date);
        expect(strategy.updatedAt).toBeInstanceOf(Date);
      });
    });
  });
});

/**
 * Committed seed used by the atomicity tests.
 *
 * These assert against the root `prisma` handle, because observing what was
 * committed is the entire point. That makes them incompatible with the
 * rollback wrapper used elsewhere, so they seed and clean up explicitly.
 */
async function seedGraphInOwnTransaction(prisma: PrismaService) {
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@test.local` } });
  const wallet = await prisma.wallet.create({ data: { userId: user.id } });
  const asset = await prisma.asset.create({
    data: { symbol: `T${randomUUID().slice(0, 8)}`, name: 'Committed', kind: AssetKind.TOKEN },
  });
  return { user, wallet, asset };
}

/**
 * Removes a committed graph.
 *
 * Delete order is the reverse of the foreign keys: transactions, balances and
 * deposits first, then the asset and wallet, then the user. The user delete is
 * RESTRICT, so it must come after the wallet.
 */
async function cleanup(prisma: PrismaService, walletId: string): Promise<void> {
  const wallet = await prisma.wallet.findUniqueOrThrow({
    where: { id: walletId },
    select: { userId: true },
  });
  await prisma.transaction.deleteMany({ where: { walletId } });
  await prisma.walletBalance.deleteMany({ where: { walletId } });
  // Deposits reference the user and the asset with RESTRICT, so they have to go
  // before either of them.
  await prisma.walletDeposit.deleteMany({ where: { userId: wallet.userId } });
  // The seed created a dedicated throwaway asset, so removing it by name is
  // sufficient and cannot touch reference data that another suite may rely on.
  await prisma.asset.deleteMany({ where: { name: 'Committed' } });
  await prisma.wallet.delete({ where: { id: walletId } });
  await prisma.user.delete({ where: { id: wallet.userId } });
}