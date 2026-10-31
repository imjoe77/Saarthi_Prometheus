import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { AssetKind, Prisma } from '@prisma/client';
import request from 'supertest';

import { createApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import { seedAssets } from '../src/modules/assets/asset-seed';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { mintToken } from './token-minting';

/**
 * MODULE 04 - the portfolio read model over HTTP.
 *
 * Boots the real application against the real database, because the properties
 * that matter here only exist against it: that amounts come back at each asset's
 * real stored precision, that ownership holds over a real token, and - the one
 * that most justifies this suite - that reading a portfolio changes nothing.
 *
 * Balance movements are driven through `WalletService` from the container, because
 * the public API deliberately offers no way to move money. That is exactly the
 * arrangement being asserted: the portfolio is populated only through the
 * accounting boundary, and read back through a route that cannot write.
 *
 * Isolation: every user gets a UUID in its email and is purged in `afterAll`
 * (transactions, then balances, then wallets, then users, because the schema uses
 * Restrict to protect financial history). The one temporary asset created here is
 * removed too, so the seeded INR/USDT/EMBER rows are never modified.
 */
describe('Portfolio (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let walletService: WalletService;

  const createdUserIds: string[] = [];
  const createdAssetIds: string[] = [];

  const assetIdBySymbol = new Map<string, string>();

  beforeAll(async () => {
    app = await createApp();
    await app.init();

    prisma = app.get(PrismaService);
    walletService = app.get(WalletService);

    await seedAssets(prisma);

    for (const symbol of ['INR', 'USDT', 'EMBER']) {
      const asset = await prisma.asset.findUniqueOrThrow({ where: { symbol } });
      assetIdBySymbol.set(symbol, asset.id);
    }
  });

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await prisma.transaction.deleteMany({ where: { wallet: { userId: { in: createdUserIds } } } });
      await prisma.walletBalance.deleteMany({ where: { wallet: { userId: { in: createdUserIds } } } });
      await prisma.wallet.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }

    if (createdAssetIds.length > 0) {
      await prisma.asset.deleteMany({ where: { id: { in: createdAssetIds } } });
    }

    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  const assetId = (symbol: string) => assetIdBySymbol.get(symbol) as string;

  /** Creates a Prometheus user through the real auth path and returns a token. */
  async function createUser(label: string): Promise<{ token: string; userId: string }> {
    const token = await mintToken({
      subject: `google:${label}-${randomUUID()}`,
      email: `${label}-${randomUUID()}@portfolio.test`,
    });

    const response = await http().get('/api/auth/me').set(bearer(token)).expect(200);
    createdUserIds.push(response.body.id);

    return { token, userId: response.body.id };
  }

  async function createWallet(token: string): Promise<string> {
    const response = await http().post('/api/wallets').set(bearer(token)).expect(201);
    return response.body.id as string;
  }

  async function portfolio(token: string, query = '') {
    return http().get(`/api/portfolio${query}`).set(bearer(token)).expect(200);
  }

  /** A user with a wallet and no balances, for the empty-state cases. */
  async function emptyPortfolioUser(label: string) {
    const user = await createUser(label);
    await createWallet(user.token);
    return user;
  }

  describe('route surface', () => {
    it('refuses a request with no token', async () => {
      await http().get('/api/portfolio').expect(401);
    });

    it('has no route that names another user', async () => {
      const user = await createUser('surface');

      await http().get(`/api/portfolio/${user.userId}`).set(bearer(user.token)).expect(404);
      await http().get('/api/portfolio/me').set(bearer(user.token)).expect(404);
    });

    it('exposes no write', async () => {
      const user = await createUser('readonly');

      await http().post('/api/portfolio').set(bearer(user.token)).expect(404);
      await http().patch('/api/portfolio').set(bearer(user.token)).expect(404);
      await http().delete('/api/portfolio').set(bearer(user.token)).expect(404);
    });

    it('ignores a client-supplied userId', async () => {
      const owner = await emptyPortfolioUser('owner');
      const other = await createUser('other');

      const plain = await portfolio(owner.token);
      const tampered = await portfolio(owner.token, `?userId=${other.userId}`);

      // `generatedAt` is the only field allowed to differ: it is the read's own clock.
      expect({ ...tampered.body, generatedAt: null }).toEqual({ ...plain.body, generatedAt: null });
      expect(JSON.stringify(tampered.body)).not.toContain(other.userId);
    });
  });

  describe('a user with no wallet', () => {
    it('answers 200 with an empty portfolio rather than 404', async () => {
      const user = await createUser('nowallet');

      const response = await portfolio(user.token);

      expect(response.body.wallet).toBeNull();
      expect(response.body.holdings).toEqual([]);
      expect(response.body.composition).toEqual({
        assetCount: 0,
        fundedAssetCount: 0,
        byKind: { FIAT: 0, STABLECOIN: 0, TOKEN: 0 },
      });
      expect(response.body.activity).toBeNull();
      expect(typeof response.body.generatedAt).toBe('string');
    });
  });

  describe('a wallet with no balances', () => {
    it('reports no holdings and no activity', async () => {
      const user = await emptyPortfolioUser('emptybalances');

      const { body } = await portfolio(user.token);

      expect(body.wallet.status).toBe('ACTIVE');
      expect(body.holdings).toEqual([]);
      expect(body.composition.assetCount).toBe(0);
      expect(body.composition.fundedAssetCount).toBe(0);
      expect(body.activity).toBeNull();
    });
  });

  describe('holdings', () => {
    it('reports available, locked and their total', async () => {
      const user = await emptyPortfolioUser('single');
      const walletId = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.userId } }).then((w) => w.id);

      await walletService.credit(walletId, assetId('INR'), '1500.50');

      const { body } = await portfolio(user.token);
      const holding = body.holdings[0];

      expect(holding.asset.symbol).toBe('INR');
      expect(holding.available).toBe('1500.50');
      expect(holding.locked).toBe('0.00');
      expect(holding.total).toBe('1500.50');
      expect(holding.isFunded).toBe(true);
      expect(holding.lockedShare).toBe(0);
      expect(body.composition.fundedAssetCount).toBe(1);
    });

    it('aggregates available plus locked', async () => {
      const user = await emptyPortfolioUser('locked');
      const walletId = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.userId } }).then((w) => w.id);

      await walletService.credit(walletId, assetId('INR'), '100');
      await walletService.lock(walletId, assetId('INR'), '40');

      const { body } = await portfolio(user.token);
      const holding = body.holdings[0];

      expect(holding.available).toBe('60.00');
      expect(holding.locked).toBe('40.00');
      expect(holding.total).toBe('100.00');
      expect(holding.lockedShare).toBe(0.4);
    });

    it('renders each asset at its own precision, as strings', async () => {
      const user = await emptyPortfolioUser('precision');
      const walletId = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.userId } }).then((w) => w.id);

      await walletService.credit(walletId, assetId('INR'), '10');
      await walletService.credit(walletId, assetId('USDT'), '12.5');
      await walletService.credit(walletId, assetId('EMBER'), '3');

      const { body } = await portfolio(user.token);
      const bySymbol = new Map<string, Record<string, unknown>>(
        body.holdings.map((holding: { asset: { symbol: string } } & Record<string, unknown>) => [
          holding.asset.symbol,
          holding,
        ]),
      );

      expect(bySymbol.get('INR')?.total).toBe('10.00');
      expect(bySymbol.get('USDT')?.total).toBe('12.500000');
      expect(bySymbol.get('EMBER')?.total).toBe('3.000000000000000000');

      for (const holding of body.holdings) {
        expect(typeof holding.available).toBe('string');
        expect(typeof holding.locked).toBe('string');
        expect(typeof holding.total).toBe('string');
      }
    });

    it('lists every holding ordered by symbol and counts each category', async () => {
      const user = await emptyPortfolioUser('multi');
      const walletId = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.userId } }).then((w) => w.id);

      await walletService.credit(walletId, assetId('EMBER'), '5');
      await walletService.credit(walletId, assetId('USDT'), '5');
      await walletService.credit(walletId, assetId('INR'), '5');

      const { body } = await portfolio(user.token);

      expect(body.holdings.map((holding: { asset: { symbol: string } }) => holding.asset.symbol)).toEqual([
        'EMBER',
        'INR',
        'USDT',
      ]);
      expect(body.composition.assetCount).toBe(3);
      expect(body.composition.fundedAssetCount).toBe(3);
      expect(body.composition.byKind).toEqual({ FIAT: 1, STABLECOIN: 1, TOKEN: 1 });
    });

    it('keeps a drained balance row but does not count it as funded', async () => {
      const user = await emptyPortfolioUser('drained');
      const walletId = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.userId } }).then((w) => w.id);

      await walletService.credit(walletId, assetId('USDT'), '10');
      await walletService.debit(walletId, assetId('USDT'), '10');

      const { body } = await portfolio(user.token);
      const holding = body.holdings[0];

      expect(body.holdings).toHaveLength(1);
      expect(holding.available).toBe('0.000000');
      expect(holding.isFunded).toBe(false);
      expect(holding.lockedShare).toBeNull();
      expect(body.composition.assetCount).toBe(1);
      expect(body.composition.fundedAssetCount).toBe(0);
    });

    it('still reports a holding in an asset that has been retired', async () => {
      const user = await emptyPortfolioUser('retired');
      const walletId = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.userId } }).then((w) => w.id);

      const symbol = `OLD${randomUUID().slice(0, 6).toUpperCase()}`;
      const asset = await prisma.asset.create({
        data: { symbol, name: 'Retired Token', kind: AssetKind.TOKEN, decimals: 8 },
      });
      createdAssetIds.push(asset.id);

      await walletService.credit(walletId, asset.id, '42');
      await prisma.asset.update({ where: { id: asset.id }, data: { isActive: false } });

      const { body } = await portfolio(user.token);
      const holding = body.holdings.find(
        (candidate: { asset: { symbol: string } }) => candidate.asset.symbol === symbol,
      );

      expect(holding).toBeDefined();
      expect(holding.asset.isActive).toBe(false);
      expect(holding.total).toBe('42.00000000');
      expect(holding.isFunded).toBe(true);
      expect(body.composition.byKind.TOKEN).toBe(1);
    });
  });

  describe('activity', () => {
    it('summarises movements, the recent window, per-type counts and the span', async () => {
      const user = await emptyPortfolioUser('activity');
      const walletId = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.userId } }).then((w) => w.id);

      await walletService.credit(walletId, assetId('INR'), '1000');
      await walletService.credit(walletId, assetId('USDT'), '500');
      await walletService.lock(walletId, assetId('INR'), '250');
      await walletService.unlock(walletId, assetId('INR'), '100');
      await walletService.debit(walletId, assetId('USDT'), '200');

      const { body } = await portfolio(user.token);
      const movements = await prisma.transaction.findMany({
        where: { walletId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });

      expect(body.activity.totalMovements).toBe(5);
      expect(body.activity.movementsLast30Days).toBe(5);
      expect(body.activity.byType).toEqual({
        DEPOSIT: 2,
        WITHDRAWAL: 1,
        TRANSFER_IN: 0,
        TRANSFER_OUT: 0,
        LOCK: 1,
        UNLOCK: 1,
        ADJUSTMENT: 0,
        BURN: 0,
      });
      expect(body.activity.firstMovementAt).toBe(movements[0]?.createdAt.toISOString());
      expect(body.activity.lastMovementAt).toBe(movements[4]?.createdAt.toISOString());
    });
  });

  describe('ownership', () => {
    it('never returns another user’s balances', async () => {
      const first = await emptyPortfolioUser('ownerfirst');
      const firstWallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: first.userId } });
      await walletService.credit(firstWallet.id, assetId('USDT'), '777.25');

      const second = await emptyPortfolioUser('ownerssecond');
      const secondWallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: second.userId } });
      await walletService.credit(secondWallet.id, assetId('INR'), '11');

      const { body } = await portfolio(second.token);

      expect(JSON.stringify(body)).not.toContain('777.25');
      expect(JSON.stringify(body)).not.toContain(firstWallet.id);
      expect(body.holdings).toHaveLength(1);
      expect(body.holdings[0].asset.symbol).toBe('INR');
    });
  });

  describe('read-only', () => {
    it('changes no financial row', async () => {
      const user = await emptyPortfolioUser('readonlyproof');
      const walletId = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.userId } }).then((w) => w.id);

      await walletService.credit(walletId, assetId('USDT'), '500');
      await walletService.lock(walletId, assetId('USDT'), '125');

      const fingerprint = async () => {
        const [wallet, balances, movements] = await Promise.all([
          prisma.wallet.findUniqueOrThrow({ where: { id: walletId } }),
          prisma.walletBalance.findMany({ where: { walletId }, orderBy: { assetId: 'asc' } }),
          prisma.transaction.findMany({ where: { walletId }, orderBy: { createdAt: 'asc' } }),
        ]);

        return JSON.stringify({ wallet, balances, movements });
      };

      const before = await fingerprint();

      await portfolio(user.token);
      await portfolio(user.token, '?cacheBust=1');

      expect(await fingerprint()).toBe(before);
    });
  });

  describe('honest values only', () => {
    it('never reports a valuation, a P&L or an allocation', async () => {
      const user = await emptyPortfolioUser('novalue');
      const walletId = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.userId } }).then((w) => w.id);

      await walletService.credit(walletId, assetId('USDT'), '1000');
      await walletService.lock(walletId, assetId('USDT'), '400');

      const { body } = await portfolio(user.token);

      expect(body).not.toHaveProperty('valuation');
      expect(body).not.toHaveProperty('pnl');
      expect(body).not.toHaveProperty('realizedPnl');
      expect(body).not.toHaveProperty('unrealizedPnl');
      expect(body).not.toHaveProperty('allocation');
      expect(body).not.toHaveProperty('netWorth');
      expect(body.holdings[0]).not.toHaveProperty('percentage');
      expect(body.holdings[0]).not.toHaveProperty('value');
    });

    it('emits no non-finite or negative derived number', async () => {
      const user = await emptyPortfolioUser('finite');
      const walletId = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.userId } }).then((w) => w.id);

      await walletService.credit(walletId, assetId('EMBER'), '0.000000000000000001');
      await walletService.credit(walletId, assetId('INR'), '0.01');
      await walletService.debit(walletId, assetId('INR'), '0.01');

      const { body } = await portfolio(user.token);
      const serialised = JSON.stringify(body);

      expect(serialised).not.toContain('null,null');
      expect(serialised).not.toContain('NaN');
      expect(serialised).not.toContain('Infinity');

      for (const holding of body.holdings) {
        expect(new Prisma.Decimal(holding.total).gte(0)).toBe(true);
        expect(new Prisma.Decimal(holding.available).gte(0)).toBe(true);
        expect(new Prisma.Decimal(holding.locked).gte(0)).toBe(true);
        expect(holding.lockedShare === null || (holding.lockedShare >= 0 && holding.lockedShare <= 1)).toBe(true);
      }
    });
  });
});