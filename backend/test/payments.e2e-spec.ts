import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { createApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import { seedAssets } from '../src/modules/assets/asset-seed';
import { formatDecimal } from '../src/modules/wallet/decimal.util';
import { mintToken } from './token-minting';

/**
 * MODULE 03b - wallet top-ups over HTTP, against the real database.
 *
 * This is the suite that proves the promise the module makes to a user: add
 * rupees, and the rupees are real spendable INR held by the wallet, visible in
 * the balance and in the ledger as a DEPOSIT row. There is deliberately no
 * mocked Prisma here - the guarantees (the deposit row and the ledger credit
 * commit together, a replayed key moves no money, a ceiling refuses before
 * anything is written) only exist in the database, so a test against a fake
 * would prove nothing.
 *
 * The rail under test is the SIMULATED one, which is what `PAYMENTS_PROVIDER`
 * defaults to. What the simulation replaces is the payment - there is no bank,
 * no UPI intent and no card - and never the credit: the INR lands in
 * `wallet_balances` and in `transactions` exactly as a Razorpay payment would
 * land. The Razorpay rail's own refusals (a forged signature, a mismatched
 * amount, a webhook that arrives twice) are covered by the unit suite against
 * the same service.
 *
 * Isolation: every user is created with a UUID in its email and purged in
 * `afterAll` (transactions, then balances, then deposits, then wallets, then
 * users, because the schema uses Restrict to protect financial history). The
 * seeded INR/USDT/EMBER rows are never modified.
 */
describe('Wallet top-ups (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const createdUserIds: string[] = [];

  let inrAssetId: string;

  beforeAll(async () => {
    app = await createApp();
    await app.init();

    prisma = app.get(PrismaService);

    await seedAssets(prisma);

    const inr = await prisma.asset.findUniqueOrThrow({ where: { symbol: 'INR' } });
    inrAssetId = inr.id;
  });

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await prisma.transaction.deleteMany({ where: { wallet: { userId: { in: createdUserIds } } } });
      await prisma.walletBalance.deleteMany({ where: { wallet: { userId: { in: createdUserIds } } } });
      await prisma.walletDeposit.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.wallet.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }

    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** Creates a Prometheus user through the real auth path and returns a token. */
  async function createUser(label: string): Promise<{ token: string; userId: string }> {
    const token = await mintToken({
      subject: `google:${label}-${randomUUID()}`,
      email: `${label}-${randomUUID()}@payments.test`,
    });

    const response = await http().get('/api/auth/me').set(bearer(token)).expect(200);
    createdUserIds.push(response.body.id);

    return { token, userId: response.body.id };
  }

  const deposit = (token: string, amountInr: string, clientRequestId = randomUUID()) =>
    http()
      .post('/api/payments/deposits')
      .set(bearer(token))
      .send({ clientRequestId, amountInr });

  /** Available balances by symbol, formatted at the asset's display precision. */
  async function balancesOf(userId: string): Promise<Record<string, string>> {
    const wallet = await prisma.wallet.findUnique({
      where: { userId },
      include: { balances: { include: { asset: true } } },
    });

    return Object.fromEntries(
      (wallet?.balances ?? []).map((balance) => [
        balance.asset.symbol,
        formatDecimal(balance.available, balance.asset.decimals),
      ]),
    );
  }

  /** The wallet's ledger rows, newest first, as the API renders them. */
  async function ledgerOf(token: string): Promise<Array<Record<string, unknown>>> {
    const response = await http()
      .get('/api/wallets/me/transactions')
      .set(bearer(token))
      .expect(200);

    return response.body.items as Array<Record<string, unknown>>;
  }

  const depositCount = (userId: string) => prisma.walletDeposit.count({ where: { userId } });

  // -------------------------------------------------------------------------
  // Route surface
  // -------------------------------------------------------------------------

  describe('route surface', () => {
    it.each([
      ['GET', '/api/payments/provider'],
      ['POST', '/api/payments/deposits'],
      ['GET', '/api/payments/deposits'],
      ['POST', '/api/payments/deposits/8f14e45f-ceea-467a-9a5e-1b1c2d3e4f5a/verify'],
    ] as const)('refuses %s %s without a token', async (method, path) => {
      await http()[method.toLowerCase() as 'get' | 'post'](path).expect(401);
    });

    it('refuses an unknown property rather than silently ignoring it', async () => {
      const { token } = await createUser('surface');

      const response = await http()
        .post('/api/payments/deposits')
        .set(bearer(token))
        .send({ clientRequestId: randomUUID(), amountInr: '100', ammountInr: '100' })
        .expect(400);

      expect(response.body.code).toBe('VALIDATION_FAILED');
    });
  });

  // -------------------------------------------------------------------------
  // The active rail
  // -------------------------------------------------------------------------

  describe('GET /api/payments/provider', () => {
    it('reports the simulated rail, its ceiling and that no checkout is needed', async () => {
      const { token } = await createUser('provider');

      const response = await http().get('/api/payments/provider').set(bearer(token)).expect(200);

      expect(response.body).toMatchObject({
        provider: 'simulated',
        maxDepositInr: '500000',
        requiresCheckout: false,
      });
    });
  });

  // -------------------------------------------------------------------------
  // The top-up itself
  // -------------------------------------------------------------------------

  describe('POST /api/payments/deposits', () => {
    it('credits the wallet with real INR and records the deposit', async () => {
      const { token, userId } = await createUser('deposit');

      const response = await deposit(token, '5000').expect(201);

      expect(response.body).toMatchObject({
        id: expect.any(String),
        asset: { symbol: 'INR', decimals: 2 },
        amount: '5000.00',
        status: 'SUCCEEDED',
        provider: 'simulated',
        createdAt: expect.any(String),
        // Nothing left to pay: the simulated rail settled it on arrival.
        checkout: null,
      });

      // The money is in the wallet, not merely in a deposit record.
      expect(await balancesOf(userId)).toEqual({ INR: '5000.00' });
      expect(await depositCount(userId)).toBe(1);
    });

    it('writes the credit to the ledger as a DEPOSIT row', async () => {
      const { token } = await createUser('deposit-ledger');

      const depositResponse = (await deposit(token, '2500.75').expect(201)).body as { id: string };

      const ledger = await ledgerOf(token);

      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({
        type: 'DEPOSIT',
        amount: '2500.75',
        asset: { symbol: 'INR' },
        note: `INR deposit ${depositResponse.id}`,
        status: 'COMPLETED',
      });
    });

    it('creates the wallet for a user who has none, so a top-up is the first thing they do', async () => {
      const { token, userId } = await createUser('deposit-no-wallet');

      expect(await prisma.wallet.findUnique({ where: { userId } })).toBeNull();

      await deposit(token, '1000').expect(201);

      expect(await prisma.wallet.findUnique({ where: { userId } })).not.toBeNull();
      expect(await balancesOf(userId)).toEqual({ INR: '1000.00' });
    });

    it('adds a second top-up to the balance the first one left behind', async () => {
      const { token, userId } = await createUser('deposit-twice');

      await deposit(token, '1000').expect(201);
      await deposit(token, '250.50').expect(201);

      expect(await balancesOf(userId)).toEqual({ INR: '1250.50' });
      expect(await depositCount(userId)).toBe(2);
    });

    it('shows the topped-up INR on the wallet balances endpoint', async () => {
      const { token } = await createUser('deposit-balance-endpoint');

      await deposit(token, '750').expect(201);

      const response = await http().get('/api/wallets/me/balances').set(bearer(token)).expect(200);

      expect(response.body).toHaveLength(1);
      expect(response.body[0]).toMatchObject({
        asset: { symbol: 'INR', decimals: 2 },
        available: '750.00',
        locked: '0.00',
      });
    });
  });

  // -------------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------------

  describe('idempotent replay', () => {
    it('returns the original deposit and moves no balance again', async () => {
      const { token, userId } = await createUser('replay');
      const clientRequestId = randomUUID();

      const first = await deposit(token, '5000', clientRequestId).expect(201);
      const second = await deposit(token, '5000', clientRequestId).expect(200);

      expect(second.body.id).toBe(first.body.id);
      expect(await balancesOf(userId)).toEqual({ INR: '5000.00' });
      expect(await depositCount(userId)).toBe(1);
      expect(await ledgerOf(token)).toHaveLength(1);
    });

    it('answers a replay with a different amount by the original deposit, not a second top-up', async () => {
      const { token, userId } = await createUser('replay-amount');
      const clientRequestId = randomUUID();

      const first = await deposit(token, '5000', clientRequestId).expect(201);
      const second = await deposit(token, '1', clientRequestId).expect(200);

      expect(second.body.id).toBe(first.body.id);
      expect(second.body.amount).toBe('5000.00');
      expect(await balancesOf(userId)).toEqual({ INR: '5000.00' });
      expect(await depositCount(userId)).toBe(1);
    });

    it('applies two racing requests with one key exactly once', async () => {
      const { token, userId } = await createUser('replay-race');
      const clientRequestId = randomUUID();

      const [a, b] = await Promise.all([
        deposit(token, '5000', clientRequestId),
        deposit(token, '5000', clientRequestId),
      ]);

      // One of them started the deposit; the other read it back.
      expect([a.status, b.status].sort()).toEqual([200, 201]);
      expect(a.body.id).toBe(b.body.id);

      expect(await balancesOf(userId)).toEqual({ INR: '5000.00' });
      expect(await depositCount(userId)).toBe(1);
      expect(await ledgerOf(token)).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // The ceiling
  // -------------------------------------------------------------------------

  describe('the top-up ceiling', () => {
    it('refuses a top-up above the ceiling with 400 and writes nothing', async () => {
      const { token, userId } = await createUser('ceiling');

      const response = await deposit(token, '500000.01').expect(400);

      expect(response.body.code).toBe('VALIDATION_FAILED');
      expect(response.body.message).toMatch(/may not exceed/);
      expect(await balancesOf(userId)).toEqual({});
      expect(await depositCount(userId)).toBe(0);
    });

    it('accepts a top-up exactly at the ceiling', async () => {
      const { token, userId } = await createUser('ceiling-edge');

      await deposit(token, '500000').expect(201);

      expect(await balancesOf(userId)).toEqual({ INR: '500000.00' });
    });
  });

  // -------------------------------------------------------------------------
  // Refused amounts and bodies
  // -------------------------------------------------------------------------

  describe('refused amounts and bodies', () => {
    it.each([
      ['zero', '0'],
      ['a negative amount', '-100'],
      ['a non-numeric amount', 'abc'],
      ['more than two decimal places', '10.123'],
      ['an empty amount', ''],
    ])('refuses %s with 400 and credits nothing', async (_label, amountInr) => {
      const { token, userId } = await createUser('bad-amount');

      const response = await deposit(token, amountInr).expect(400);

      expect(response.body.code).toBe('VALIDATION_FAILED');
      expect(await balancesOf(userId)).toEqual({});
      expect(await depositCount(userId)).toBe(0);
    });

    it.each([
      ['a missing clientRequestId', () => ({ amountInr: '100' })],
      ['a non-UUID clientRequestId', () => ({ clientRequestId: 'not-a-uuid', amountInr: '100' })],
      ['a missing amount', (id: string) => ({ clientRequestId: id })],
      [
        'an extra property',
        (id: string) => ({ clientRequestId: id, amountInr: '100', currency: 'INR' }),
      ],
    ] as const)('refuses a deposit body with %s', async (_label, buildBody) => {
      const { token, userId } = await createUser('bad-body');

      const response = await http()
        .post('/api/payments/deposits')
        .set(bearer(token))
        .send(buildBody(randomUUID()))
        .expect(400);

      expect(response.body.code).toBe('VALIDATION_FAILED');
      expect(await depositCount(userId)).toBe(0);
      expect(await balancesOf(userId)).toEqual({});
    });
  });

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  describe('GET /api/payments/deposits', () => {
    it('lists the caller\'s top-ups newest first, with every recorded field', async () => {
      const { token } = await createUser('list');

      const first = (await deposit(token, '100').expect(201)).body as { id: string };
      const second = (await deposit(token, '200').expect(201)).body as { id: string };

      const response = await http().get('/api/payments/deposits').set(bearer(token)).expect(200);

      expect(response.body).toHaveLength(2);
      expect(response.body[0]).toMatchObject({
        id: second.id,
        amount: '200.00',
        status: 'SUCCEEDED',
        provider: 'simulated',
        asset: { symbol: 'INR', decimals: 2 },
        checkout: null,
      });
      expect(response.body[1]).toMatchObject({ id: first.id, amount: '100.00' });
    });

    it('never shows one user another user\'s top-ups', async () => {
      const alice = await createUser('list-alice');
      const bob = await createUser('list-bob');

      await deposit(alice.token, '100').expect(201);
      await deposit(bob.token, '200').expect(201);

      const aliceList = await http().get('/api/payments/deposits').set(bearer(alice.token)).expect(200);
      const bobList = await http().get('/api/payments/deposits').set(bearer(bob.token)).expect(200);

      expect(aliceList.body).toHaveLength(1);
      expect(aliceList.body[0].amount).toBe('100.00');
      expect(bobList.body).toHaveLength(1);
      expect(bobList.body[0].amount).toBe('200.00');
    });

    it('lists nothing for a user who has never topped up', async () => {
      const { token } = await createUser('list-empty');

      const response = await http().get('/api/payments/deposits').set(bearer(token)).expect(200);

      expect(response.body).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Verification is a Razorpay-only concept
  // -------------------------------------------------------------------------

  describe('POST /api/payments/deposits/:id/verify', () => {
    it('refuses to verify another user\'s deposit', async () => {
      const alice = await createUser('verify-alice');
      const bob = await createUser('verify-bob');

      const depositResponse = (await deposit(alice.token, '100').expect(201)).body as { id: string };

      const response = await http()
        .post(`/api/payments/deposits/${depositResponse.id}/verify`)
        .set(bearer(bob.token))
        .send({ razorpayOrderId: 'order_x', razorpayPaymentId: 'pay_x', razorpaySignature: 'sig' })
        .expect(404);

      expect(response.body.code).toBe('NOT_FOUND');
    });

    it('refuses a deposit id that is not a UUID', async () => {
      const { token } = await createUser('verify-bad-id');

      await http()
        .post('/api/payments/deposits/not-a-uuid/verify')
        .set(bearer(token))
        .send({ razorpayOrderId: 'order_x', razorpayPaymentId: 'pay_x', razorpaySignature: 'sig' })
        .expect(400);
    });

    it('refuses a verification body that is missing its fields', async () => {
      const { token } = await createUser('verify-bad-body');
      const depositResponse = (await deposit(token, '100').expect(201)).body as { id: string };

      const response = await http()
        .post(`/api/payments/deposits/${depositResponse.id}/verify`)
        .set(bearer(token))
        .send({ razorpayOrderId: 'order_x' })
        .expect(400);

      expect(response.body.code).toBe('VALIDATION_FAILED');
    });
  });

  // -------------------------------------------------------------------------
  // The money is real
  // -------------------------------------------------------------------------

  describe('the credited INR is the ledger\'s own number', () => {
    it('is the balance the USDT exchange would draw on, not a figure made for the screen', async () => {
      const { token, userId } = await createUser('spendable');

      await deposit(token, '10000').expect(201);

      // Read the balance the way the trading modules read it: straight from
      // `wallet_balances`, not from the deposit record.
      const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId } });
      const balance = await prisma.walletBalance.findUniqueOrThrow({
        where: { walletId_assetId: { walletId: wallet.id, assetId: inrAssetId } },
      });

      expect(formatDecimal(balance.available, 2)).toBe('10000.00');
      expect(formatDecimal(balance.locked, 2)).toBe('0.00');

      // And the ledger row that produced it is a real DEPOSIT transaction.
      const ledgerRow = await prisma.transaction.findFirstOrThrow({
        where: { walletId: wallet.id },
      });
      expect(ledgerRow.type).toBe('DEPOSIT');
      expect(formatDecimal(ledgerRow.amount, 2)).toBe('10000.00');
    });
  });
});
