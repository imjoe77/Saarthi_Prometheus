import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { HttpStatus } from '@nestjs/common';
import request from 'supertest';

import { createApp } from '../src/bootstrap';
import { DomainException } from '../src/common/errors/domain.exception';
import { PrismaService } from '../src/database/prisma.service';
import { seedAssets } from '../src/modules/assets/asset-seed';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { mintToken } from './token-minting';

/**
 * MODULE 03 - wallets and assets over HTTP, plus the internal accounting API.
 *
 * Boots the real application against the real database. There is deliberately no
 * mocked Prisma here: the guarantees this module makes - that a guarded UPDATE
 * refuses a debit the balance cannot fund, that a concurrent pair of debits
 * settles exactly one, that a ledger failure rolls the balance back - only exist
 * in the database, so a test against a fake would prove nothing.
 *
 * The wallet surface is read-only apart from wallet creation. Balance movements
 * are internal, so those cases drive `WalletService` directly from the Nest
 * container and then assert what the HTTP reads report. The one public way to
 * credit a wallet is Module 03b's deposit route, which lives under
 * `/api/payments` and is exercised in its own suite.
 *
 * Isolation: every user is created with a UUID in its email and purged in
 * `afterAll` (transactions, then balances, then deposits, then wallets, then
 * users, because the schema uses Restrict to protect financial history).
 * Temporary assets are removed too, so the seeded INR/USDT/EMBER rows are never
 * modified.
 */
describe('Wallet and assets (e2e)', () => {
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
      await prisma.walletDeposit.deleteMany({ where: { userId: { in: createdUserIds } } });
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

  const inrId = () => assetIdBySymbol.get('INR') as string;

  /** Creates a Prometheus user through the real auth path and returns a token. */
  async function createUser(label: string): Promise<{ token: string; userId: string }> {
    const token = await mintToken({
      subject: `google:${label}-${randomUUID()}`,
      email: `${label}-${randomUUID()}@wallet.test`,
    });

    const response = await http().get('/api/auth/me').set(bearer(token)).expect(200);
    createdUserIds.push(response.body.id);

    return { token, userId: response.body.id };
  }

  async function createWallet(token: string): Promise<string> {
    const response = await http().post('/api/wallets').set(bearer(token)).expect(201);
    return response.body.id as string;
  }

  async function walletRow(userId: string) {
    return prisma.wallet.findUniqueOrThrow({ where: { userId } });
  }

  function expectDomainCode(error: unknown, code: string, status: HttpStatus): void {
    expect(error).toBeInstanceOf(DomainException);
    const domain = error as DomainException;
    expect(domain.code).toBe(code);
    expect(domain.getStatus()).toBe(status);
  }

  // -------------------------------------------------------------------------
  // Authentication and route surface
  // -------------------------------------------------------------------------

  describe('without a token', () => {
    it.each([
      ['GET', '/api/wallets/me'],
      ['GET', '/api/wallets/me/balances'],
      ['GET', '/api/wallets/me/transactions'],
      ['GET', '/api/assets'],
      ['POST', '/api/wallets'],
    ] as const)('refuses %s %s', async (method, path) => {
      await http()[method.toLowerCase() as 'get' | 'post'](path).expect(401);
    });
  });

  describe('the wallet surface is read-only', () => {
    it.each([
      ['/api/wallets/me/credit'],
      ['/api/wallets/me/debit'],
      ['/api/wallets/me/balances'],
      ['/api/wallets/me/transactions'],
    ])('does not expose POST %s', async (path) => {
      const { token } = await createUser('surface');
      await createWallet(token);

      await http().post(path).set(bearer(token)).send({ amount: '1000000' }).expect(404);
    });

    it('has no GET /api/wallets/:id route to name another wallet', async () => {
      const { token } = await createUser('no-id-route');
      const walletId = await createWallet(token);

      await http().get(`/api/wallets/${walletId}`).set(bearer(token)).expect(404);
    });
  });

  // -------------------------------------------------------------------------
  // Asset catalogue
  // -------------------------------------------------------------------------

  describe('GET /api/assets', () => {
    it('lists the seeded assets with their display precision', async () => {
      const { token } = await createUser('assets');

      const response = await http().get('/api/assets').set(bearer(token)).expect(200);
      const bySymbol = Object.fromEntries(
        (response.body as Array<{ symbol: string }>).map((asset) => [asset.symbol, asset]),
      );

      expect(bySymbol['INR']).toMatchObject({ symbol: 'INR', decimals: 2, kind: 'FIAT' });
      expect(bySymbol['USDT']).toMatchObject({ symbol: 'USDT', decimals: 6, kind: 'STABLECOIN' });
      expect(bySymbol['EMBER']).toMatchObject({ symbol: 'EMBER', decimals: 18, kind: 'TOKEN' });
    });

    it('omits an inactive asset without deleting it', async () => {
      const { token } = await createUser('inactive-list');

      const retired = await prisma.asset.create({
        data: {
          symbol: `TST-${randomUUID()}`,
          name: 'Retired test asset',
          kind: 'TOKEN',
          decimals: 8,
          isActive: false,
        },
      });
      createdAssetIds.push(retired.id);

      const response = await http().get('/api/assets').set(bearer(token)).expect(200);
      const symbols = (response.body as Array<{ symbol: string }>).map((asset) => asset.symbol);

      expect(symbols).not.toContain(retired.symbol);
      // The row still exists; it is only hidden from the catalogue.
      expect(await prisma.asset.findUnique({ where: { id: retired.id } })).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Wallet creation and reads
  // -------------------------------------------------------------------------

  describe('POST /api/wallets', () => {
    it('creates on the first call and returns the existing wallet afterwards', async () => {
      const { token, userId } = await createUser('create');

      const first = await http().post('/api/wallets').set(bearer(token)).expect(201);
      const second = await http().post('/api/wallets').set(bearer(token)).expect(200);

      expect(second.body.id).toBe(first.body.id);
      expect(first.body).toEqual({
        id: expect.any(String),
        status: 'ACTIVE',
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
      // The owner is never part of the response, and exactly one wallet exists.
      expect(first.body).not.toHaveProperty('userId');
      expect(await prisma.wallet.count({ where: { userId } })).toBe(1);
    });

    it('settles concurrent creations on a single wallet', async () => {
      const { token, userId } = await createUser('create-race');

      const [a, b] = await Promise.all([
        http().post('/api/wallets').set(bearer(token)),
        http().post('/api/wallets').set(bearer(token)),
      ]);

      expect([a.status, b.status].sort()).toEqual([200, 201]);
      expect(a.body.id).toBe(b.body.id);
      expect(await prisma.wallet.count({ where: { userId } })).toBe(1);
    });

    it('ignores a caller-supplied user id', async () => {
      const alice = await createUser('ignore-a');
      const bob = await createUser('ignore-b');

      const response = await http()
        .post('/api/wallets')
        .query({ userId: bob.userId })
        .send({ userId: bob.userId })
        .set(bearer(alice.token))
        .expect(201);

      const stored = await walletRow(alice.userId);
      expect(response.body.id).toBe(stored.id);
      expect(await prisma.wallet.findUnique({ where: { userId: bob.userId } })).toBeNull();
    });
  });

  describe('GET /api/wallets/me', () => {
    it('answers 404 before the wallet exists', async () => {
      const { token } = await createUser('me-missing');
      await http().get('/api/wallets/me').set(bearer(token)).expect(404);
    });

    it('returns only the caller\'s wallet', async () => {
      const alice = await createUser('me-a');
      const bob = await createUser('me-b');
      const aliceWallet = await createWallet(alice.token);
      const bobWallet = await createWallet(bob.token);

      const asAlice = await http().get('/api/wallets/me').set(bearer(alice.token)).expect(200);
      const asBob = await http().get('/api/wallets/me').set(bearer(bob.token)).expect(200);

      expect(asAlice.body.id).toBe(aliceWallet);
      expect(asBob.body.id).toBe(bobWallet);
      expect(asAlice.body.id).not.toBe(asBob.body.id);
    });
  });

  describe('GET /api/wallets/me/balances', () => {
    it('is empty for a new wallet', async () => {
      const { token } = await createUser('balances-empty');
      await createWallet(token);

      const response = await http().get('/api/wallets/me/balances').set(bearer(token)).expect(200);

      expect(response.body).toEqual([]);
    });

    it('renders amounts as strings at the asset scale', async () => {
      const { token, userId } = await createUser('balances-format');
      await createWallet(token);
      const wallet = await walletRow(userId);

      await walletService.credit(wallet.id, inrId(), '1000');

      const response = await http().get('/api/wallets/me/balances').set(bearer(token)).expect(200);

      expect(response.body).toEqual([
        {
          asset: { symbol: 'INR', name: 'Indian Rupee', decimals: 2 },
          available: '1000.00',
          locked: '0.00',
        },
      ]);
      // No derived total, and no internal ids.
      expect(response.body[0]).not.toHaveProperty('total');
      expect(response.body[0]).not.toHaveProperty('walletId');
      expect(response.body[0]).not.toHaveProperty('assetId');
    });
  });

  // -------------------------------------------------------------------------
  // Internal accounting
  // -------------------------------------------------------------------------

  describe('balance movements', () => {
    it('applies credit, debit, lock and unlock in sequence', async () => {
      const { token, userId } = await createUser('movements');
      await createWallet(token);
      const wallet = await walletRow(userId);
      const inr = inrId();

      await walletService.credit(wallet.id, inr, '1000');
      await walletService.credit(wallet.id, inr, '500');
      await walletService.debit(wallet.id, inr, '200');
      const locked = await walletService.lock(wallet.id, inr, '300');

      expect(locked.available.toString()).toBe('1000');
      expect(locked.locked.toString()).toBe('300');

      const unlocked = await walletService.unlock(wallet.id, inr, '100');

      expect(unlocked.available.toString()).toBe('1100');
      expect(unlocked.locked.toString()).toBe('200');

      const response = await http().get('/api/wallets/me/balances').set(bearer(token)).expect(200);
      expect(response.body[0]).toMatchObject({ available: '1100.00', locked: '200.00' });
    });

    it('refuses a debit the balance cannot fund', async () => {
      const { token, userId } = await createUser('overdraft');
      await createWallet(token);
      const wallet = await walletRow(userId);

      await walletService.credit(wallet.id, inrId(), '100');

      try {
        await walletService.debit(wallet.id, inrId(), '100.01');
        throw new Error('Expected the debit to be refused.');
      } catch (error) {
        expectDomainCode(error, 'INSUFFICIENT_BALANCE', HttpStatus.CONFLICT);
      }

      const balance = await prisma.walletBalance.findUniqueOrThrow({
        where: { walletId_assetId: { walletId: wallet.id, assetId: inrId() } },
      });
      expect(balance.available.toString()).toBe('100');
    });

    it('refuses an unlock the locked balance cannot cover', async () => {
      const { token, userId } = await createUser('unlock-over');
      await createWallet(token);
      const wallet = await walletRow(userId);

      await walletService.credit(wallet.id, inrId(), '100');
      await walletService.lock(wallet.id, inrId(), '40');

      await expect(walletService.unlock(wallet.id, inrId(), '41')).rejects.toBeInstanceOf(DomainException);
    });

    it('refuses a movement when the wallet is frozen', async () => {
      const { token, userId } = await createUser('frozen');
      await createWallet(token);
      const wallet = await walletRow(userId);
      await walletService.credit(wallet.id, inrId(), '100');

      await prisma.wallet.update({ where: { id: wallet.id }, data: { status: 'FROZEN' } });

      try {
        await walletService.debit(wallet.id, inrId(), '10');
        throw new Error('Expected the debit to be refused.');
      } catch (error) {
        expectDomainCode(error, 'WALLET_FROZEN', HttpStatus.CONFLICT);
      }

      await prisma.wallet.update({ where: { id: wallet.id }, data: { status: 'ACTIVE' } });
    });

    it('refuses a movement on an inactive asset', async () => {
      const { token, userId } = await createUser('inactive-asset');
      await createWallet(token);
      const wallet = await walletRow(userId);

      const retired = await prisma.asset.create({
        data: {
          symbol: `TST-${randomUUID()}`,
          name: 'Retired test asset',
          kind: 'TOKEN',
          decimals: 8,
          isActive: false,
        },
      });
      createdAssetIds.push(retired.id);

      try {
        await walletService.credit(wallet.id, retired.id, '1');
        throw new Error('Expected the credit to be refused.');
      } catch (error) {
        expectDomainCode(error, 'ASSET_INACTIVE', HttpStatus.CONFLICT);
      }
    });

    it.each(['0', '-1', '1.234'])('rejects the invalid amount %s', async (amount) => {
      const { token, userId } = await createUser('bad-amount');
      await createWallet(token);
      const wallet = await walletRow(userId);

      await expect(walletService.credit(wallet.id, inrId(), amount)).rejects.toBeInstanceOf(DomainException);
    });
  });

  // -------------------------------------------------------------------------
  // Atomicity and concurrency
  // -------------------------------------------------------------------------

  describe('atomicity and concurrency', () => {
    it('rolls the balance back when the ledger write fails', async () => {
      const { token, userId } = await createUser('rollback');
      await createWallet(token);
      const wallet = await walletRow(userId);
      const inr = inrId();

      await walletService.credit(wallet.id, inr, '100');

      interface LedgerInternals {
        appendLedger: (...args: unknown[]) => Promise<void>;
      }
      const spy = jest
        .spyOn(walletService as unknown as LedgerInternals, 'appendLedger')
        .mockRejectedValueOnce(new Error('simulated ledger failure'));

      await expect(walletService.credit(wallet.id, inr, '50')).rejects.toThrow('simulated ledger failure');
      spy.mockRestore();

      const balance = await prisma.walletBalance.findUniqueOrThrow({
        where: { walletId_assetId: { walletId: wallet.id, assetId: inr } },
      });
      expect(balance.available.toString()).toBe('100');

      const transactions = await prisma.transaction.count({ where: { walletId: wallet.id, assetId: inr } });
      expect(transactions).toBe(1);
    });

    it('settles exactly one of two concurrent debits for the whole balance', async () => {
      const { token, userId } = await createUser('concurrent-debit');
      await createWallet(token);
      const wallet = await walletRow(userId);
      const inr = inrId();

      await walletService.credit(wallet.id, inr, '100');

      const results = await Promise.allSettled([
        walletService.debit(wallet.id, inr, '100'),
        walletService.debit(wallet.id, inr, '100'),
      ]);

      const fulfilled = results.filter((result) => result.status === 'fulfilled');
      const rejected = results.filter((result) => result.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(DomainException);

      const balance = await prisma.walletBalance.findUniqueOrThrow({
        where: { walletId_assetId: { walletId: wallet.id, assetId: inr } },
      });
      expect(balance.available.toString()).toBe('0');

      // One credit plus exactly one settled debit: the losing attempt wrote nothing.
      const transactions = await prisma.transaction.count({ where: { walletId: wallet.id, assetId: inr } });
      expect(transactions).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // Ledger and paging
  // -------------------------------------------------------------------------

  describe('GET /api/wallets/me/transactions', () => {
    it('records each movement as a completed, self-describing row', async () => {
      const { token, userId } = await createUser('ledger');
      await createWallet(token);
      const wallet = await walletRow(userId);
      const inr = inrId();

      await walletService.credit(wallet.id, inr, '1000');
      await walletService.debit(wallet.id, inr, '200');
      await walletService.lock(wallet.id, inr, '300');

      const response = await http().get('/api/wallets/me/transactions').set(bearer(token)).expect(200);

      expect(response.body.nextCursor).toBeNull();
      const items = response.body.items as Array<Record<string, unknown>>;
      // Newest first.
      expect(items.map((item) => item.type)).toEqual(['LOCK', 'WITHDRAWAL', 'DEPOSIT']);

      for (const item of items) {
        expect(item.status).toBe('COMPLETED');
        expect(item.asset).toMatchObject({ symbol: 'INR', decimals: 2 });
        expect(typeof item.amount).toBe('string');
        expect(item).not.toHaveProperty('walletId');
        expect(item).not.toHaveProperty('assetId');
      }

      const latest = items[0] as { availableAfter: string; lockedAfter: string };
      expect(latest.availableAfter).toBe('500.00');
      expect(latest.lockedAfter).toBe('300.00');
    });

    it('pages stably with a keyset cursor', async () => {
      const { token, userId } = await createUser('paging');
      await createWallet(token);
      const wallet = await walletRow(userId);
      const inr = inrId();

      for (let i = 0; i < 5; i += 1) {
        await walletService.credit(wallet.id, inr, '1');
      }

      const page1 = await http().get('/api/wallets/me/transactions?limit=2').set(bearer(token)).expect(200);
      const page2 = await http()
        .get(`/api/wallets/me/transactions?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`)
        .set(bearer(token))
        .expect(200);
      const page3 = await http()
        .get(`/api/wallets/me/transactions?limit=2&cursor=${encodeURIComponent(page2.body.nextCursor)}`)
        .set(bearer(token))
        .expect(200);

      const ids = [...page1.body.items, ...page2.body.items, ...page3.body.items].map(
        (item: { id: string }) => item.id,
      );

      expect(page1.body.items).toHaveLength(2);
      expect(page2.body.items).toHaveLength(2);
      expect(page3.body.items).toHaveLength(1);
      expect(page3.body.nextCursor).toBeNull();
      expect(new Set(ids).size).toBe(5);
    });

    it('rejects a malformed cursor', async () => {
      const { token } = await createUser('bad-cursor');
      await createWallet(token);

      await http().get('/api/wallets/me/transactions?cursor=not-a-cursor').set(bearer(token)).expect(400);
    });
  });
});
