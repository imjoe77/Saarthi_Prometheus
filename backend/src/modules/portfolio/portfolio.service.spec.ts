import { Prisma, type Asset, type TransactionType, type Wallet } from '@prisma/client';

import type { PrismaService } from '../../database/prisma.service';
import type { PortfolioHolding } from './portfolio.types';
import type { WalletService } from '../wallet/wallet.service';
import { PortfolioService } from './portfolio.service';

type BalanceWithAsset = Awaited<ReturnType<WalletService['getBalances']>>[number];

/**
 * MODULE 04 - the portfolio service's derivation logic.
 *
 * These tests cover the arithmetic and the counting, which are the parts of this
 * module that could quietly be wrong: a total that drifts, a ratio that becomes
 * `NaN` on an empty holding, a funded count that includes a drained row. They run
 * against hand-written fakes because none of that behaviour needs PostgreSQL - it
 * needs exact decimals, which is easier to state here than to provoke from SQL.
 *
 * The integration suite (`test/portfolio.e2e-spec.ts`) owns the other half: that
 * the endpoint is authenticated, that ownership holds, and that reading a
 * portfolio writes nothing.
 */

interface WalletMock {
  findForUser: jest.Mock;
  getBalances: jest.Mock;
}

interface PrismaMock {
  transaction: {
    aggregate: jest.Mock;
    count: jest.Mock;
    groupBy: jest.Mock;
  };
}

const NOW = new Date('2026-10-02T12:00:00.000Z');

const wallet: Wallet = {
  id: 'wallet-1111',
  userId: 'user-2222',
  status: 'ACTIVE',
  createdAt: new Date('2026-10-01T08:00:00.000Z'),
  updatedAt: new Date('2026-10-01T08:00:00.000Z'),
};

const ASSETS = {
  INR: {
    id: 'asset-inr',
    symbol: 'INR',
    name: 'Indian Rupee',
    kind: 'FIAT',
    decimals: 2,
    isActive: true,
    createdAt: NOW,
    updatedAt: NOW,
  },
  USDT: {
    id: 'asset-usdt',
    symbol: 'USDT',
    name: 'Tether USD',
    kind: 'STABLECOIN',
    decimals: 6,
    isActive: true,
    createdAt: NOW,
    updatedAt: NOW,
  },
  EMBER: {
    id: 'asset-ember',
    symbol: 'EMBER',
    name: 'Prometheus Ember',
    kind: 'TOKEN',
    decimals: 18,
    isActive: true,
    createdAt: NOW,
    updatedAt: NOW,
  },
} satisfies Record<string, Asset>;

type SeededSymbol = keyof typeof ASSETS;

/** Builds a balance row the way the wallet module would return it. */
function balanceOf(
  symbol: SeededSymbol,
  available: string,
  locked = '0',
  overrides: Partial<Asset> = {},
): BalanceWithAsset {
  const asset = { ...ASSETS[symbol], ...overrides };

  return {
    id: `balance-${symbol}`,
    walletId: wallet.id,
    assetId: asset.id,
    available: new Prisma.Decimal(available),
    locked: new Prisma.Decimal(locked),
    createdAt: NOW,
    updatedAt: NOW,
    asset,
  };
}

/** What the three ledger reads resolve to, for a given set of rows. */
interface LedgerFixture {
  aggregate: {
    _count: { _all: number };
    _min: { createdAt: Date | null };
    _max: { createdAt: Date | null };
  };
  recentCount: number;
  groupBy: { type: TransactionType; _count: { _all: number } }[];
}

/** A ledger with no rows at all: what Prisma's aggregates return for a new wallet. */
function emptyLedger(): LedgerFixture {
  return {
    aggregate: { _count: { _all: 0 }, _min: { createdAt: null }, _max: { createdAt: null } },
    recentCount: 0,
    groupBy: [],
  };
}

function ledgerOf(
  total: number,
  recent: number,
  rows: { type: TransactionType; count: number }[],
  first: string,
  last: string,
): LedgerFixture {
  return {
    aggregate: {
      _count: { _all: total },
      _min: { createdAt: new Date(first) },
      _max: { createdAt: new Date(last) },
    },
    recentCount: recent,
    groupBy: rows.map((row) => ({ type: row.type, _count: { _all: row.count } })),
  };
}

function buildService(options: {
  wallet?: Wallet | null;
  balances?: BalanceWithAsset[];
  ledger?: LedgerFixture;
}) {
  const walletService: WalletMock = {
    findForUser: jest.fn().mockResolvedValue(options.wallet === undefined ? null : options.wallet),
    getBalances: jest.fn().mockResolvedValue(options.balances ?? []),
  };

  const ledger = options.ledger ?? emptyLedger();
  const prisma: PrismaMock = {
    transaction: {
      aggregate: jest.fn().mockResolvedValue(ledger.aggregate),
      count: jest.fn().mockResolvedValue(ledger.recentCount),
      groupBy: jest.fn().mockResolvedValue(ledger.groupBy),
    },
  };

  const service = new PortfolioService(
    walletService as unknown as WalletService,
    prisma as unknown as PrismaService,
  );

  return { service, walletService, prisma };
}

/**
 * The holdings a test expects, asserting there is one.
 *
 * Guards against a test passing for the wrong reason: an empty array would make
 * `expect(undefined).toBe(...)` fail loudly, but a missing holding in a
 * three-holding assertion should never be mistaken for a passing one.
 */
function holdingOf(holdings: readonly PortfolioHolding[], index = 0): PortfolioHolding {
  const holding = holdings[index];

  if (!holding) {
    throw new Error(`expected a holding at index ${index}, found ${holdings.length}`);
  }

  return holding;
}

describe('PortfolioService', () => {
  describe('a user with no wallet', () => {
    it('returns an empty portfolio rather than failing', async () => {
      const { service } = buildService({ wallet: null });

      const snapshot = await service.getSnapshot('user-2222', NOW);

      expect(snapshot.wallet).toBeNull();
      expect(snapshot.holdings).toEqual([]);
      expect(snapshot.composition).toEqual({
        assetCount: 0,
        fundedAssetCount: 0,
        byKind: { FIAT: 0, STABLECOIN: 0, TOKEN: 0 },
      });
      expect(snapshot.activity).toBeNull();
      expect(snapshot.generatedAt).toBe(NOW);
    });

    it('does not read balances or the ledger', async () => {
      const { service, walletService, prisma } = buildService({ wallet: null });

      await service.getSnapshot('user-2222', NOW);

      expect(walletService.getBalances).not.toHaveBeenCalled();
      expect(prisma.transaction.aggregate).not.toHaveBeenCalled();
    });
  });

  describe('deriving a holding', () => {
    it('sums available and locked into a total without storing it', async () => {
      const { service } = buildService({
        wallet,
        balances: [balanceOf('USDT', '1000.000000', '250.000000')],
      });

      const holding = holdingOf((await service.getSnapshot('user-2222', NOW)).holdings);

      expect(holding.available.toFixed(6)).toBe('1000.000000');
      expect(holding.locked.toFixed(6)).toBe('250.000000');
      expect(holding.total.toFixed(6)).toBe('1250.000000');
    });

    it('adds decimals exactly, where floating point would not', async () => {
      const { service } = buildService({ wallet, balances: [balanceOf('USDT', '0.1', '0.2')] });

      const holding = holdingOf((await service.getSnapshot('user-2222', NOW)).holdings);

      // 0.1 + 0.2 === 0.30000000000000004 in IEEE-754.
      expect(holding.total.toFixed(6)).toBe('0.300000');
    });

    it('reports the locked share of a funded holding', async () => {
      const { service } = buildService({ wallet, balances: [balanceOf('USDT', '60', '40')] });

      const holding = holdingOf((await service.getSnapshot('user-2222', NOW)).holdings);

      expect(holding.isFunded).toBe(true);
      expect(holding.lockedShare).toBe(0.4);
    });

    it('reports a fully locked holding as a share of one', async () => {
      const { service } = buildService({ wallet, balances: [balanceOf('USDT', '0', '125.5')] });

      const holding = holdingOf((await service.getSnapshot('user-2222', NOW)).holdings);

      expect(holding.isFunded).toBe(true);
      expect(holding.lockedShare).toBe(1);
    });

    it('reports nothing locked as a share of zero', async () => {
      const { service } = buildService({ wallet, balances: [balanceOf('INR', '10', '0')] });

      const holding = holdingOf((await service.getSnapshot('user-2222', NOW)).holdings);

      expect(holding.lockedShare).toBe(0);
    });

    it('rounds a repeating share to four places', async () => {
      const { service } = buildService({ wallet, balances: [balanceOf('USDT', '2', '1')] });

      const holding = holdingOf((await service.getSnapshot('user-2222', NOW)).holdings);

      expect(holding.lockedShare).toBe(0.3333);
    });

    it('marks a drained row un-funded with no share at all', async () => {
      const { service } = buildService({ wallet, balances: [balanceOf('EMBER', '0', '0')] });

      const holding = holdingOf((await service.getSnapshot('user-2222', NOW)).holdings);

      expect(holding.isFunded).toBe(false);
      expect(holding.lockedShare).toBeNull();
      expect(holding.total.toFixed(18)).toBe('0.000000000000000000');
    });

    it.each([
      ['0 and 0', '0', '0'],
      ['1 wei available', '0.000000000000000001', '0'],
      ['1 wei locked', '0', '0.000000000000000001'],
    ])('never produces NaN or Infinity: %s', async (_label, available, locked) => {
      const { service } = buildService({ wallet, balances: [balanceOf('EMBER', available, locked)] });

      const holding = holdingOf((await service.getSnapshot('user-2222', NOW)).holdings);

      expect(holding.total.gte(0)).toBe(true);
      expect(Number.isNaN(holding.lockedShare as number)).toBe(false);
      expect(holding.lockedShare === null || Number.isFinite(holding.lockedShare)).toBe(true);
    });

    it('keeps a holding in an asset that has been retired', async () => {
      const { service } = buildService({
        wallet,
        balances: [balanceOf('EMBER', '10', '0', { isActive: false })],
      });

      const holding = holdingOf((await service.getSnapshot('user-2222', NOW)).holdings);

      expect(holding.asset.isActive).toBe(false);
      expect(holding.isFunded).toBe(true);
    });
  });

  describe('composition', () => {
    it('counts every category and separates funded from drained', async () => {
      const { service } = buildService({
        wallet,
        balances: [
          balanceOf('INR', '500.00', '0'),
          balanceOf('USDT', '40', '10'),
          balanceOf('EMBER', '0', '0'),
        ],
      });

      const { composition } = await service.getSnapshot('user-2222', NOW);

      expect(composition.assetCount).toBe(3);
      expect(composition.fundedAssetCount).toBe(2);
      expect(composition.byKind).toEqual({ FIAT: 1, STABLECOIN: 1, TOKEN: 1 });
    });

    it('counts several holdings of one category together', async () => {
      const inr = balanceOf('INR', '1', '0');
      const second = { ...balanceOf('INR', '2', '0'), id: 'balance-inr-2' };

      const { service } = buildService({ wallet, balances: [inr, second] });

      const { composition } = await service.getSnapshot('user-2222', NOW);

      expect(composition.byKind.FIAT).toBe(2);
      expect(composition.fundedAssetCount).toBe(2);
    });

    it('reports zero for a category the user does not hold', async () => {
      const { service } = buildService({ wallet, balances: [balanceOf('USDT', '5', '0')] });

      const { composition } = await service.getSnapshot('user-2222', NOW);

      expect(composition.byKind).toEqual({ FIAT: 0, STABLECOIN: 1, TOKEN: 0 });
    });
  });

  describe('activity', () => {
    it('is null for a wallet with no ledger history', async () => {
      const { service } = buildService({ wallet, balances: [] });

      const { activity } = await service.getSnapshot('user-2222', NOW);

      expect(activity).toBeNull();
    });

    it('summarises counts, the recent window and the span covered', async () => {
      const { service } = buildService({
        wallet,
        ledger: ledgerOf(
          7,
          5,
          [
            { type: 'DEPOSIT', count: 3 },
            { type: 'LOCK', count: 2 },
            { type: 'UNLOCK', count: 1 },
            { type: 'WITHDRAWAL', count: 1 },
          ],
          '2026-09-01T00:00:00.000Z',
          '2026-10-02T09:00:00.000Z',
        ),
      });

      const { activity } = await service.getSnapshot('user-2222', NOW);

      expect(activity).not.toBeNull();
      expect(activity?.totalMovements).toBe(7);
      expect(activity?.movementsLast30Days).toBe(5);
      expect(activity?.firstMovementAt).toBe('2026-09-01T00:00:00.000Z');
      expect(activity?.lastMovementAt).toBe('2026-10-02T09:00:00.000Z');
    });

    it('reports every ledger type, zero included', async () => {
      const { service } = buildService({
        wallet,
        ledger: ledgerOf(1, 1, [{ type: 'DEPOSIT', count: 1 }], '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'),
      });

      const { activity } = await service.getSnapshot('user-2222', NOW);

      expect(activity?.byType).toEqual({
        DEPOSIT: 1,
        WITHDRAWAL: 0,
        TRANSFER_IN: 0,
        TRANSFER_OUT: 0,
        LOCK: 0,
        UNLOCK: 0,
        ADJUSTMENT: 0,
        BURN: 0,
      });
    });

    it('asks for the recent window relative to the supplied moment', async () => {
      const { service, prisma } = buildService({ wallet });

      await service.getSnapshot('user-2222', new Date('2026-10-02T12:00:00.000Z'));

      expect(prisma.transaction.count).toHaveBeenCalledWith({
        where: {
          walletId: wallet.id,
          createdAt: { gte: new Date('2026-09-02T12:00:00.000Z') },
        },
      });
    });
  });

  describe('query shape', () => {
    it('scopes every ledger read to this wallet', async () => {
      const { service, prisma } = buildService({ wallet, ledger: emptyLedger() });

      await service.getSnapshot('user-2222', NOW);

      expect(prisma.transaction.aggregate).toHaveBeenCalledWith(
        expect.objectContaining({ where: { walletId: wallet.id } }),
      );
      expect(prisma.transaction.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({ where: { walletId: wallet.id } }),
      );
    });

    it('issues a fixed number of reads regardless of how much is held', async () => {
      const one = buildService({ wallet, balances: [balanceOf('USDT', '1', '0')] });
      const many = buildService({
        wallet,
        balances: [
          balanceOf('INR', '1', '0'),
          balanceOf('USDT', '1', '0'),
          balanceOf('EMBER', '1', '0'),
        ],
      });

      await one.service.getSnapshot('user-2222', NOW);
      await many.service.getSnapshot('user-2222', NOW);

      const calls = (mocks: PrismaMock) =>
        mocks.transaction.aggregate.mock.calls.length +
        mocks.transaction.count.mock.calls.length +
        mocks.transaction.groupBy.mock.calls.length;

      expect(calls(one.prisma)).toBe(3);
      expect(calls(many.prisma)).toBe(calls(one.prisma));
    });
  });
});