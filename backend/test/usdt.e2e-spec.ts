import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { HttpStatus } from '@nestjs/common';
import request from 'supertest';

import { createApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import { seedAssets } from '../src/modules/assets/asset-seed';
import { LiquidityService } from '../src/modules/liquidity/liquidity.service';
import { formatDecimal } from '../src/modules/wallet/decimal.util';
import { WalletService } from '../src/modules/wallet/wallet.service';
import {
  clearTestLiquidityEnv,
  configureTestLiquidityEnv,
  resetLiquidityTables,
} from './liquidity-test-fixture';
import { mintToken } from './token-minting';

/**
 * MODULE 08 - the USDT quote/order flow over HTTP, against the real database,
 * priced by the deterministic fake market provider.
 *
 * There is deliberately no mocked Prisma here: the guarantees this module makes
 * - that a quote reproduces the order-book VWAP, that an order's balance legs
 * and its row commit as one unit, that a replay cannot double-spend, that two
 * racing orders on one balance settle exactly one, that fallback and stale
 * prices never execute - only exist in the database, so a test against a fake
 * would prove nothing.
 *
 * THE FAKE MARKET (USDT_PRICING_PROVIDER=fake under NODE_ENV=test) is fixed so
 * every expected figure is exact: asks 100.10 x 5000 and 100.20 x 5000, bids
 * 99.90 x 5000 and 99.80 x 5000, CoinGecko competitors AlphaExchange 100.25
 * and BetaExchange 100.15 (average 100.20), aggregate 100.10. So a BUY of
 * 10,000 walks both ask levels to a VWAP of 100.15, which the best-price
 * guarantee then drives a clear ₹1.50 under the cheapest ask on screen: Beta's
 * executable offer of 100.1650225 less 1.50, floored to 98.66 (986,600.00 INR,
 * savings 15,400.00). A SELL of 10,000 walks the bids to 99.85 and the
 * guarantee floors it a ₹1.50 above AlphaExchange's bid of 100.239975, i.e.
 * 101.74, which is the figure that settles: both directions are guaranteed to
 * be at least a rupee and a half better than the market rather than merely not
 * the expensive row. The scenarios flip per request via
 * USDT_FAKE_PRICING_SCENARIO: `stale`, `down` and `no-reference` provoke the
 * refusal paths.
 *
 * Isolation: every user is created with a UUID in its email and purged in
 * `afterAll` (orders, then transactions, then balances, then wallets, then
 * users, because the schema uses Restrict to protect financial history). The
 * seeded INR/USDT/EMBER rows are never modified.
 *
 * MODULE 09: one generous fixture LP (1,000,000 USDT committed, seeded before
 * any test) so every BUY here draws from real liquidity rather than the
 * legacy minted path - which is also the state production is in from the
 * moment the first LP registers. The suite resets the liquidity tables in
 * `beforeAll` and purges them in `afterAll`, so it neither inherits nor leaks
 * provider rows (the e2e config runs files serially for exactly this reason).
 * SELL, replays and history remain untouched by the fixture, as Module 09
 * requires.
 */
describe('USDT exchange (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let walletService: WalletService;

  const createdUserIds: string[] = [];

  const assetIdBySymbol = new Map<string, string>();

  // The fixture LP (registered in beforeAll) whose commitments fund every
  // BUY in this suite.
  let fixtureLpId: string;
  let fixtureCommitmentId: string;

  beforeAll(async () => {
    // MODULE 09: test slabs must be configured before the app boots - the
    // fixture LP's EMBER-gated commitment refuses 503 without them.
    configureTestLiquidityEnv();

    app = await createApp();
    await app.init();

    prisma = app.get(PrismaService);
    walletService = app.get(WalletService);

    await seedAssets(prisma);
    await resetLiquidityTables(prisma);

    for (const symbol of ['INR', 'USDT', 'EMBER']) {
      const asset = await prisma.asset.findUniqueOrThrow({ where: { symbol } });
      assetIdBySymbol.set(symbol, asset.id);
    }

    // One generous simulated LP (TEST slabs only, see liquidity-test-fixture)
    // so every BUY below draws real LP funding rather than the legacy minted
    // path - the state production is in from the first registration onward.
    const fixture = await createUserWithWallet('lp-fixture', {
      usdt: '1000000',
      ember: '150000',
    });

    const liquidityService = app.get(LiquidityService);
    const { commitment } = await liquidityService.createCommitment(fixture.userId, {
      usdtAmount: '1000000',
      clientRequestId: randomUUID(),
    });
    fixtureLpId = commitment.lpId;
    fixtureCommitmentId = commitment.commitmentId;
  });

  afterAll(async () => {
    // Module 09 rows reference users, orders and each other with Restrict, so
    // they go first; then this suite's own users, in the usual child-first order.
    await resetLiquidityTables(prisma);

    if (createdUserIds.length > 0) {
      await prisma.usdtOrder.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.transaction.deleteMany({ where: { wallet: { userId: { in: createdUserIds } } } });
      await prisma.walletBalance.deleteMany({ where: { wallet: { userId: { in: createdUserIds } } } });
      await prisma.wallet.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }

    clearTestLiquidityEnv();
    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  const assetId = (symbol: 'INR' | 'USDT' | 'EMBER') => assetIdBySymbol.get(symbol) as string;

  /** Creates a Prometheus user through the real auth path and returns a token. */
  async function createUser(label: string): Promise<{ token: string; userId: string }> {
    const token = await mintToken({
      subject: `google:${label}-${randomUUID()}`,
      email: `${label}-${randomUUID()}@usdt.test`,
    });

    const response = await http().get('/api/auth/me').set(bearer(token)).expect(200);
    createdUserIds.push(response.body.id);

    return { token, userId: response.body.id };
  }

  /** A user with a wallet, optionally funded. The common setup for an order. */
  async function createUserWithWallet(
    label: string,
    funding: { inr?: string; usdt?: string; ember?: string } = {},
  ): Promise<{ token: string; userId: string }> {
    const user = await createUser(label);
    await http().post('/api/wallets').set(bearer(user.token)).expect(201);
    await fund(user.userId, funding);
    return user;
  }

  async function fund(
    userId: string,
    funding: { inr?: string; usdt?: string; ember?: string },
  ): Promise<void> {
    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId } });

    if (funding.inr) {
      await walletService.credit(wallet.id, assetId('INR'), funding.inr);
    }
    if (funding.usdt) {
      await walletService.credit(wallet.id, assetId('USDT'), funding.usdt);
    }
    if (funding.ember) {
      await walletService.credit(wallet.id, assetId('EMBER'), funding.ember);
    }
  }

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

  const orderCount = (userId: string) => prisma.usdtOrder.count({ where: { userId } });

  const buy = (token: string, usdtAmount: string, clientRequestId = randomUUID()) =>
    http().post('/api/usdt/buy').set(bearer(token)).send({ clientRequestId, usdtAmount });

  const sell = (token: string, usdtAmount: string, clientRequestId = randomUUID()) =>
    http().post('/api/usdt/sell').set(bearer(token)).send({ clientRequestId, usdtAmount });

  // -------------------------------------------------------------------------
  // Route surface
  // -------------------------------------------------------------------------

  describe('route surface', () => {
    it.each([
      ['GET', '/api/usdt/quote'],
      ['POST', '/api/usdt/buy'],
      ['POST', '/api/usdt/sell'],
      ['GET', '/api/usdt/orders'],
    ] as const)('refuses %s %s without a token', async (method, path) => {
      await http()[method.toLowerCase() as 'get' | 'post'](path).expect(401);
    });

    it('refuses an unknown query property rather than silently ignoring it', async () => {
      const { token } = await createUser('surface');

      const response = await http()
        .get('/api/usdt/quote')
        .query({ side: 'BUY', usdtAmount: '10', unexpected: '1' })
        .set(bearer(token))
        .expect(400);

      expect(response.body.code).toBe('VALIDATION_FAILED');
    });
  });

  // -------------------------------------------------------------------------
  // Quote calculation
  // -------------------------------------------------------------------------

  describe('quote calculation', () => {
    it('prices a BUY at the order-book VWAP with its full pricing provenance', async () => {
      const { token } = await createUser('quote-buy');

      const response = await http()
        .get('/api/usdt/quote')
        .query({ side: 'BUY', usdtAmount: '10000' })
        .set(bearer(token))
        .expect(200);

      expect(response.body).toMatchObject({
        side: 'BUY',
        usdtAmount: '10000.000000',
        // (5000 x 100.10 + 5000 x 100.20) / 10000 = 100.15 in the book, but the
        // guarantee drives the price a clear ₹1.50 under the cheapest ask:
        // 10,000 x 98.66.
        inrAmount: '986600.00',
        prometheusPrice: '98.66',
        // average(100.25, 100.20, 100.15) = 100.20
        referencePrice: '100.20',
        // 10,000 x (100.20 - 98.66) = 15,400
        savings: '15400.00',
      });

      expect(response.body.pricing).toMatchObject({
        status: 'live',
        referenceBasis: 'average_of_3_venues(AlphaExchange, BetaExchange, GammaExchange)',
        feesNote: 'fees not included',
        reasons: [],
        execution: {
          source: 'coindcx:USDT_INR',
          bookTimestamp: expect.any(String),
          fetchedAt: expect.any(String),
          tickerLast: '100',
          // The raw book, published next to the guaranteed figure so the
          // margin given away is visible rather than hidden.
          bookVwap: '100.15',
        },
        guarantee: {
          applied: true,
          matchedVenue: 'BetaExchange',
          matchedPrice: '100.1650225',
          note: expect.stringContaining('capped to at least 1.50 below'),
        },
        aggregate: {
          priceInr: '100.1',
          lastUpdatedAt: expect.any(String),
          note: expect.stringContaining('not an Indian exchange venue price'),
        },
        fallback: null,
        competitors: [
          {
            venue: 'AlphaExchange',
            lastPrice: '100.25',
            // The ask a buyer would actually pay there: 100.25 x 1.0001.
            venuePrice: '100.260025',
            venuePriceBasis: 'derived_from_spread',
            lastTradedAt: expect.any(String),
            volume24h: '1234.5',
            bidAskSpreadPct: '0.02',
          },
          {
            venue: 'BetaExchange',
            lastPrice: '100.15',
            venuePrice: '100.1650225',
            venuePriceBasis: 'derived_from_spread',
            lastTradedAt: expect.any(String),
            volume24h: '987.6',
            bidAskSpreadPct: '0.03',
          },
          {
            // The third comparison row: 100.20 x 1.0001, between the other two.
            venue: 'GammaExchange',
            lastPrice: '100.20',
            venuePrice: '100.21002',
            venuePriceBasis: 'derived_from_spread',
            lastTradedAt: expect.any(String),
            volume24h: '1500.0',
            bidAskSpreadPct: '0.02',
          },
        ],
      });
    });

    it('prices a SELL above every venue, floored up by the best-price guarantee', async () => {
      const { token } = await createUser('quote-sell');

      const response = await http()
        .get('/api/usdt/quote')
        .query({ side: 'SELL', usdtAmount: '2.5' })
        .set(bearer(token))
        .expect(200);

      expect(response.body).toMatchObject({
        side: 'SELL',
        usdtAmount: '2.500000',
        // 2.5 x 101.74 = 254.35
        inrAmount: '254.35',
        prometheusPrice: '101.74',
        referencePrice: '100.20',
        // 2.5 x (101.74 - 100.20) = 3.85: a SELL guarantee can only improve.
        savings: '3.85',
      });

      // The raw bid was 99.90; Alpha's bid is 100.25 x 0.9999 = 100.239975,
      // plus ₹1.50 and ceiled to the paise, and the customer is told that.
      expect(response.body.pricing.execution.bookVwap).toBe('99.90');
      expect(response.body.pricing.guarantee).toMatchObject({
        applied: true,
        matchedVenue: 'AlphaExchange',
        matchedPrice: '100.239975',
        note: expect.stringContaining('floored to at least 1.50 above'),
      });
      // Prometheus sells at least the margin above the venue it was measured
      // against, even after rendering the figure at two decimals.
      expect(Number(response.body.prometheusPrice)).toBeGreaterThanOrEqual(101.739975 - 1e-9);
    });

    it('quotes without a wallet, because a quote moves nothing', async () => {
      const { token } = await createUser('quote-no-wallet');

      await http()
        .get('/api/usdt/quote')
        .query({ side: 'BUY', usdtAmount: '0.01' })
        .set(bearer(token))
        .expect(200);
    });

    it.each([
      ['a missing side', { usdtAmount: '10' }],
      ['an unknown side', { side: 'HOLD', usdtAmount: '10' }],
      ['a missing amount', { side: 'BUY' }],
    ])('refuses %s with 400', async (_label, query) => {
      const { token } = await createUser('quote-shape');

      const response = await http()
        .get('/api/usdt/quote')
        .query(query)
        .set(bearer(token))
        .expect(400);

      expect(response.body.code).toBe('VALIDATION_FAILED');
    });
  });

  // -------------------------------------------------------------------------
  // Savings calculation
  // -------------------------------------------------------------------------

  describe('savings calculation', () => {
    it('is positive for a BUY - the customer pays below the reference', async () => {
      const { token } = await createUser('savings-buy');

      const response = await http()
        .get('/api/usdt/quote')
        .query({ side: 'BUY', usdtAmount: '10000' })
        .set(bearer(token))
        .expect(200);

      // 10,000 x (100.20 - 98.66) = 15,400: the margin the guarantee hands
      // back, plus the 0.04 the book already had on the reference.
      expect(response.body.savings).toBe('15400.00');
    });

    it('stays positive for a SELL - the guarantee lifts the bid above the reference', async () => {
      const { token } = await createUser('savings-sell');

      const response = await http()
        .get('/api/usdt/quote')
        .query({ side: 'SELL', usdtAmount: '10000' })
        .set(bearer(token))
        .expect(200);

      // Raw bid VWAP 99.85, floored up to Alpha's bid 100.239975 + 1.50 ->
      // 101.74: 10,000 x (101.74 - 100.20) = 15,400. The reference is an
      // average, so the guaranteed figure always sits well clear of it.
      expect(response.body.savings).toBe('15400.00');
      expect(response.body.prometheusPrice).toBe('101.74');
    });

    it('stays exact for a fractional volume', async () => {
      const { token } = await createUser('savings-fraction');

      const response = await http()
        .get('/api/usdt/quote')
        .query({ side: 'BUY', usdtAmount: '0.01' })
        .set(bearer(token))
        .expect(200);

      // 0.01 x 98.66 = 0.9866, rendered at the paise as 0.99, and the saving
      // 0.01 x 1.54 = 0.0154 renders as 0.02 rather than being inflated.
      expect(response.body.inrAmount).toBe('0.99');
      expect(response.body.savings).toBe('0.02');
    });
  });

  // -------------------------------------------------------------------------
  // Invalid / zero / negative amounts
  // -------------------------------------------------------------------------

  describe('invalid, zero and negative amounts', () => {
    it.each(['0', '-1', '-0.000001', 'abc', '', '0.0000001', '0.000001'])(
      'refuses the quote amount %s rather than pricing it',
      async (usdtAmount) => {
        const { token } = await createUser('quote-invalid');

        const response = await http()
          .get('/api/usdt/quote')
          .query({ side: 'BUY', usdtAmount })
          .set(bearer(token))
          .expect(400);

        expect(response.body.code).toBe('VALIDATION_FAILED');
      },
    );

    it('refuses a conversion that rounds below one paise, rather than charging nothing', async () => {
      const { token } = await createUser('quote-precision');

      // 0.000001 USDT at 98.66 = 0.00009866 INR: below the 0.01 INR minimum.
      const response = await http()
        .get('/api/usdt/quote')
        .query({ side: 'BUY', usdtAmount: '0.000001' })
        .set(bearer(token))
        .expect(400);

      expect(response.body.code).toBe('VALIDATION_FAILED');
      expect(response.body.message).toMatch(/minimum/);
    });

    it.each(['0', '-1', 'abc', '0.000001', '0.0000001'])(
      'refuses to buy with the amount %s and leaves the wallet and order list untouched',
      async (usdtAmount) => {
        const user = await createUserWithWallet('buy-invalid', { inr: '1000000' });

        await buy(user.token, usdtAmount).expect(400);

        expect(await balancesOf(user.userId)).toEqual({ INR: '1000000.00' });
        expect(await orderCount(user.userId)).toBe(0);
      },
    );

    it.each([
      ['a missing clientRequestId', () => ({ usdtAmount: '10' })],
      ['a non-UUID clientRequestId', () => ({ clientRequestId: 'not-a-uuid', usdtAmount: '10' })],
      ['a missing usdtAmount', (id: string) => ({ clientRequestId: id })],
      [
        'an extra property',
        (id: string) => ({ clientRequestId: id, usdtAmount: '10', side: 'BUY' }),
      ],
    ] as const)('refuses a buy body with %s', async (_label, buildBody) => {
      const user = await createUserWithWallet('buy-shape', { inr: '1000000' });

      await http()
        .post('/api/usdt/buy')
        .set(bearer(user.token))
        .send(buildBody(randomUUID()))
        .expect(400);

      expect(await orderCount(user.userId)).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Buy
  // -------------------------------------------------------------------------

  describe('buy', () => {
    it('debits INR, credits USDT and records the order with its live snapshot prices', async () => {
      const user = await createUserWithWallet('buy', { inr: '2000000' });

      const response = await buy(user.token, '10000').expect(201);

      expect(response.body).toMatchObject({
        orderId: expect.any(String),
        side: 'BUY',
        usdtAmount: '10000.000000',
        inrAmount: '986600.00',
        prometheusPrice: '98.66',
        referencePrice: '100.20',
        savings: '15400.00',
        clientRequestId: expect.any(String),
        placedAt: expect.any(String),
        filledAt: expect.any(String),
      });
      // Synchronous settlement: the row records the instant it committed.
      expect(response.body.filledAt).toBe(response.body.placedAt);

      // Order creation carries the live provenance of the prices that settled.
      expect(response.body.pricing).toMatchObject({
        status: 'live',
        referenceBasis: 'average_of_3_venues(AlphaExchange, BetaExchange, GammaExchange)',
        execution: { source: 'coindcx:USDT_INR' },
      });

      expect(await balancesOf(user.userId)).toEqual({
        INR: '1013400.00',
        USDT: '10000.000000',
      });
    });

    it('writes both balance legs to the wallet ledger, citable by order id', async () => {
      const user = await createUserWithWallet('buy-ledger', { inr: '2000000' });

      const order = (await buy(user.token, '10000').expect(201)).body as { orderId: string };

      const response = await http()
        .get('/api/wallets/me/transactions')
        .set(bearer(user.token))
        .expect(200);

      const items = response.body.items as Array<{
        type: string;
        amount: string;
        asset: { symbol: string };
        note: string | null;
        status: string;
      }>;

      // Newest first: both legs of the order cite it, then the funding deposit.
      expect(items).toHaveLength(3);
      expect(items[0]).toMatchObject({
        type: 'DEPOSIT',
        amount: '10000.000000',
        asset: { symbol: 'USDT' },
        note: `USDT BUY order ${order.orderId}`,
        status: 'COMPLETED',
      });
      expect(items[1]).toMatchObject({
        type: 'WITHDRAWAL',
        amount: '986600.00',
        asset: { symbol: 'INR' },
        note: `USDT BUY order ${order.orderId}`,
        status: 'COMPLETED',
      });
      expect(items[2]).toMatchObject({
        type: 'DEPOSIT',
        amount: '2000000.00',
        asset: { symbol: 'INR' },
        note: null,
      });
      expect(items.filter((row) => row.note === `USDT BUY order ${order.orderId}`)).toHaveLength(2);
    });

    it('answers 404 when the caller has no wallet, and creates neither wallet nor order', async () => {
      const { token, userId } = await createUser('buy-no-wallet');

      await buy(token, '10').expect(404);

      expect(await prisma.wallet.findUnique({ where: { userId } })).toBeNull();
      expect(await orderCount(userId)).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Sell
  // -------------------------------------------------------------------------

  describe('sell', () => {
    it('debits USDT, credits INR and records the guaranteed price above the reference', async () => {
      const user = await createUserWithWallet('sell', { inr: '500000', usdt: '10000' });

      const response = await sell(user.token, '4000').expect(201);

      expect(response.body).toMatchObject({
        side: 'SELL',
        usdtAmount: '4000.000000',
        // Raw bid VWAP 99.90, floored up to Alpha's bid 100.239975 + 1.50
        // -> 101.74.
        inrAmount: '406960.00',
        prometheusPrice: '101.74',
        referencePrice: '100.20',
        // 4,000 x (101.74 - 100.20): the guarantee puts the seller 6,160 INR
        // on the right side of the reference instead of 1,200 behind it.
        savings: '6160.00',
      });

      expect(response.body.pricing.guarantee).toMatchObject({
        applied: true,
        matchedVenue: 'AlphaExchange',
        matchedPrice: '100.239975',
      });
      expect(response.body.pricing.execution.bookVwap).toBe('99.90');

      expect(await balancesOf(user.userId)).toEqual({
        INR: '906960.00',
        USDT: '6000.000000',
      });
    });
  });

  // -------------------------------------------------------------------------
  // Insufficient balance
  // -------------------------------------------------------------------------

  describe('insufficient balance', () => {
    it('refuses a BUY the INR balance cannot fund, with 409 and no side effects', async () => {
      const user = await createUserWithWallet('buy-broke', { inr: '100' });

      const response = await buy(user.token, '10000').expect(HttpStatus.CONFLICT);

      expect(response.body.code).toBe('INSUFFICIENT_BALANCE');
      expect(await balancesOf(user.userId)).toEqual({ INR: '100.00' });
      expect(await orderCount(user.userId)).toBe(0);
    });

    it('refuses a SELL the USDT balance cannot fund, with 409 and no side effects', async () => {
      const user = await createUserWithWallet('sell-broke', { usdt: '1' });

      const response = await sell(user.token, '10000').expect(HttpStatus.CONFLICT);

      expect(response.body.code).toBe('INSUFFICIENT_BALANCE');
      expect(await balancesOf(user.userId)).toEqual({ USDT: '1.000000' });
      expect(await orderCount(user.userId)).toBe(0);
    });

    it('refuses a buy on a frozen wallet without recording an order', async () => {
      const user = await createUserWithWallet('buy-frozen', { inr: '1000000' });
      const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.userId } });

      await prisma.wallet.update({ where: { id: wallet.id }, data: { status: 'FROZEN' } });

      const response = await buy(user.token, '10').expect(HttpStatus.CONFLICT);

      expect(response.body.code).toBe('WALLET_FROZEN');
      expect(await orderCount(user.userId)).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Price guards (the explicit slippage rule)
  // -------------------------------------------------------------------------

  describe('price guards', () => {
    it('refuses a BUY whose fresh VWAP exceeds the accepted maximum, with 409 and no side effects', async () => {
      const user = await createUserWithWallet('guard-buy', { inr: '2000000' });

      // The guarantee prices this at 98.66, so an accepted maximum below that
      // must refuse it: the guard reads the price the customer would pay.
      const response = await http()
        .post('/api/usdt/buy')
        .set(bearer(user.token))
        .send({ clientRequestId: randomUUID(), usdtAmount: '10000', maxExecutionPrice: '98.00' })
        .expect(HttpStatus.CONFLICT);

      expect(response.body.code).toBe('CONFLICT');
      expect(response.body.message).toMatch(/exceeds the maximum/);
      expect(await balancesOf(user.userId)).toEqual({ INR: '2000000.00' });
      expect(await orderCount(user.userId)).toBe(0);
    });

    it('settles a BUY whose fresh VWAP is within the accepted maximum', async () => {
      const user = await createUserWithWallet('guard-buy-ok', { inr: '2000000' });

      // Equality is within the guard: the refusal is strict gt only. A 100
      // USDT buy fills at the first ask level alone, so its book VWAP is
      // 100.10 and the guarantee then settles it a ₹1.50 under the cheapest
      // ask at 98.66 - comfortably inside the accepted 100.15.
      const response = await http()
        .post('/api/usdt/buy')
        .set(bearer(user.token))
        .send({ clientRequestId: randomUUID(), usdtAmount: '100', maxExecutionPrice: '100.15' })
        .expect(201);

      expect(response.body.pricing.execution.bookVwap).toBe('100.10');
      expect(response.body.prometheusPrice).toBe('98.66');
      expect(await orderCount(user.userId)).toBe(1);
    });

    it('refuses a SELL whose fresh price is below the accepted minimum, with 409', async () => {
      const user = await createUserWithWallet('guard-sell', { usdt: '10000' });

      // The guard is checked against the price the customer would actually
      // receive - the guaranteed 101.74, not the raw 99.90 bid - so 101.80 is
      // still above it and the order is still refused.
      const response = await http()
        .post('/api/usdt/sell')
        .set(bearer(user.token))
        .send({ clientRequestId: randomUUID(), usdtAmount: '4000', minExecutionPrice: '101.80' })
        .expect(HttpStatus.CONFLICT);

      expect(response.body.code).toBe('CONFLICT');
      expect(response.body.message).toMatch(/below the minimum/);
      expect(await balancesOf(user.userId)).toEqual({ USDT: '10000.000000' });
      expect(await orderCount(user.userId)).toBe(0);
    });

    it('refuses the wrong-side guard as a client bug, with 400', async () => {
      const user = await createUserWithWallet('guard-sides', { inr: '1000000', usdt: '100' });

      await http()
        .post('/api/usdt/buy')
        .set(bearer(user.token))
        .send({ clientRequestId: randomUUID(), usdtAmount: '10', minExecutionPrice: '1' })
        .expect(400);

      await http()
        .post('/api/usdt/sell')
        .set(bearer(user.token))
        .send({ clientRequestId: randomUUID(), usdtAmount: '10', maxExecutionPrice: '999' })
        .expect(400);

      expect(await orderCount(user.userId)).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Live pricing policy: fallback display vs execution refusal
  // -------------------------------------------------------------------------

  describe('live pricing policy', () => {
    const originalScenario = process.env['USDT_FAKE_PRICING_SCENARIO'];

    afterEach(() => {
      if (originalScenario === undefined) {
        delete process.env['USDT_FAKE_PRICING_SCENARIO'];
      } else {
        process.env['USDT_FAKE_PRICING_SCENARIO'] = originalScenario;
      }
    });

    it('refuses to execute beyond the book depth, and falls back on the quote', async () => {
      process.env['USDT_FAKE_PRICING_SCENARIO'] = 'live';
      const user = await createUserWithWallet('depth', { inr: '3000000' });

      // The fake book holds 10,000 per side; 20,000 cannot be filled.
      const quoted = await http()
        .get('/api/usdt/quote')
        .query({ side: 'BUY', usdtAmount: '20000' })
        .set(bearer(user.token))
        .expect(200);
      expect(quoted.body.pricing.status).toBe('fallback');
      expect(quoted.body.pricing.reasons).toContain('insufficient_depth');

      const refused = await buy(user.token, '20000').expect(503);
      expect(refused.body.code).toBe('PRICING_UNAVAILABLE');
      expect(refused.body.details).toContain('insufficient_depth');
      expect(await orderCount(user.userId)).toBe(0);
    });

    it('serves a labelled fallback quote on a stale book, with savings suppressed', async () => {
      process.env['USDT_FAKE_PRICING_SCENARIO'] = 'stale';
      const { token } = await createUser('stale-quote');

      const response = await http()
        .get('/api/usdt/quote')
        .query({ side: 'BUY', usdtAmount: '10' })
        .set(bearer(token))
        .expect(200);

      // 10 x 99.90 at the configured fallback - indicative, never live.
      expect(response.body).toMatchObject({
        inrAmount: '999.00',
        prometheusPrice: '99.90',
        referencePrice: null,
        savings: null,
      });
      expect(response.body.pricing.status).toBe('fallback');
      expect(response.body.pricing.execution).toBeNull();
      expect(response.body.pricing.fallback).toMatchObject({ priceInr: '99.9' });
      expect(response.body.pricing.fallback.note).toContain('not live market data');
      expect(response.body.pricing.reasons).toContain('execution_stale');
      expect(response.body.pricing.reasons).toContain('serving_configured_fallback');
    });

    it('refuses to execute on a stale book with 503, moving nothing', async () => {
      process.env['USDT_FAKE_PRICING_SCENARIO'] = 'stale';
      const user = await createUserWithWallet('stale-buy', { inr: '1000000' });

      const response = await buy(user.token, '10').expect(503);

      expect(response.body.code).toBe('PRICING_UNAVAILABLE');
      expect(response.body.details).toContain('execution_stale');
      expect(await balancesOf(user.userId)).toEqual({ INR: '1000000.00' });
      expect(await orderCount(user.userId)).toBe(0);
    });

    it('serves the fallback and refuses to execute when the provider is down entirely', async () => {
      process.env['USDT_FAKE_PRICING_SCENARIO'] = 'down';
      const user = await createUserWithWallet('down-buy', { inr: '1000000' });

      const quoted = await http()
        .get('/api/usdt/quote')
        .query({ side: 'SELL', usdtAmount: '10' })
        .set(bearer(user.token))
        .expect(200);
      expect(quoted.body.pricing.status).toBe('fallback');
      expect(quoted.body.pricing.reasons).toContain('execution_unavailable');

      const refused = await buy(user.token, '10').expect(503);
      expect(refused.body.code).toBe('PRICING_UNAVAILABLE');
      expect(await balancesOf(user.userId)).toEqual({ INR: '1000000.00' });
      expect(await orderCount(user.userId)).toBe(0);
    });

    it('quotes live without savings when no reference exists, and refuses to execute', async () => {
      process.env['USDT_FAKE_PRICING_SCENARIO'] = 'no-reference';
      const user = await createUserWithWallet('no-ref', { inr: '1000000' });

      // Execution data alone is enough to show a live price, but never enough
      // to claim a saving or to settle an order.
      const quoted = await http()
        .get('/api/usdt/quote')
        .query({ side: 'BUY', usdtAmount: '10' })
        .set(bearer(user.token))
        .expect(200);
      expect(quoted.body.pricing.status).toBe('live');
      expect(quoted.body.referencePrice).toBeNull();
      expect(quoted.body.savings).toBeNull();
      expect(quoted.body.pricing.referenceBasis).toBeNull();

      const refused = await buy(user.token, '10').expect(503);
      expect(refused.body.code).toBe('PRICING_UNAVAILABLE');
      expect(refused.body.details).toContain('reference_unavailable');
      expect(await orderCount(user.userId)).toBe(0);
    });

    it('never prices an order from a replay when live data is unavailable', async () => {
      const user = await createUserWithWallet('replay-stale', { inr: '2000000' });
      const clientRequestId = randomUUID();

      const first = await buy(user.token, '100', clientRequestId).expect(201);

      // A replay returns the original order even though the market has since
      // gone stale: the recorded order is the truth, and nothing re-prices.
      process.env['USDT_FAKE_PRICING_SCENARIO'] = 'stale';
      const second = await buy(user.token, '100', clientRequestId).expect(200);

      expect(second.body.orderId).toBe(first.body.orderId);
      expect(second.body.pricing).toBeUndefined();
      expect(await orderCount(user.userId)).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Order lifecycle
  // -------------------------------------------------------------------------

  describe('order lifecycle', () => {
    it('lists the caller\'s orders newest first, with every recorded field', async () => {
      const user = await createUserWithWallet('lifecycle', { inr: '1000000', usdt: '100' });

      const first = (await buy(user.token, '100').expect(201)).body as { orderId: string };
      const second = (await buy(user.token, '50').expect(201)).body as { orderId: string };
      const third = (await sell(user.token, '25').expect(201)).body as { orderId: string };

      const response = await http().get('/api/usdt/orders').set(bearer(user.token)).expect(200);

      expect(response.body.nextCursor).toBeNull();
      const items = response.body.items as Array<Record<string, string>>;
      expect(items).toHaveLength(3);
      expect(items.map((order) => order.orderId)).toEqual([third.orderId, second.orderId, first.orderId]);
      expect(items[2]).toMatchObject({
        side: 'BUY',
        usdtAmount: '100.000000',
        inrAmount: '9866.00',
        savings: '154.00',
        clientRequestId: expect.any(String),
        filledAt: expect.any(String),
      });
      expect(items[0]).toMatchObject({ side: 'SELL', usdtAmount: '25.000000', savings: '38.50' });
      // History pages carry the recorded numbers, not a re-priced provenance block.
      expect(items[0]?.pricing).toBeUndefined();
    });

    it('pages the history with a keyset cursor and never repeats an order', async () => {
      const user = await createUserWithWallet('paging', { inr: '1000000' });

      const ids = [
        ((await buy(user.token, '10').expect(201)).body as { orderId: string }).orderId,
        ((await buy(user.token, '20').expect(201)).body as { orderId: string }).orderId,
        ((await buy(user.token, '30').expect(201)).body as { orderId: string }).orderId,
      ];

      const page1 = await http()
        .get('/api/usdt/orders')
        .query({ limit: 1 })
        .set(bearer(user.token))
        .expect(200);
      expect(page1.body.items).toHaveLength(1);
      expect(page1.body.nextCursor).toEqual(expect.any(String));
      expect(page1.body.items[0].orderId).toBe(ids[2]);

      const page2 = await http()
        .get('/api/usdt/orders')
        .query({ limit: 1, cursor: page1.body.nextCursor })
        .set(bearer(user.token))
        .expect(200);
      expect(page2.body.items).toHaveLength(1);
      expect(page2.body.items[0].orderId).toBe(ids[1]);

      const page3 = await http()
        .get('/api/usdt/orders')
        .query({ limit: 1, cursor: page2.body.nextCursor })
        .set(bearer(user.token))
        .expect(200);
      expect(page3.body.items).toHaveLength(1);
      expect(page3.body.items[0].orderId).toBe(ids[0]);
      expect(page3.body.nextCursor).toBeNull();
    });

    it('refuses a malformed cursor with 400 rather than restarting the list', async () => {
      const { token } = await createUser('bad-cursor');

      const response = await http()
        .get('/api/usdt/orders')
        .query({ cursor: 'not-a-cursor' })
        .set(bearer(token))
        .expect(400);

      expect(response.body.code).toBe('VALIDATION_FAILED');
    });

    it('never shows one user another user\'s orders', async () => {
      const alice = await createUserWithWallet('iso-a', { inr: '1000000' });
      const bob = await createUserWithWallet('iso-b', { inr: '1000000' });

      await buy(alice.token, '10').expect(201);
      await buy(bob.token, '20').expect(201);

      const aliceList = await http().get('/api/usdt/orders').set(bearer(alice.token)).expect(200);
      const bobList = await http().get('/api/usdt/orders').set(bearer(bob.token)).expect(200);

      expect(aliceList.body.items).toHaveLength(1);
      expect(aliceList.body.items[0].usdtAmount).toBe('10.000000');
      expect(bobList.body.items).toHaveLength(1);
      expect(bobList.body.items[0].usdtAmount).toBe('20.000000');
    });
  });

  // -------------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------------

  describe('idempotent replay', () => {
    it('returns the original order on a replay and moves no balance again', async () => {
      const user = await createUserWithWallet('replay', { inr: '2000000' });
      const clientRequestId = randomUUID();

      const first = await buy(user.token, '10000', clientRequestId).expect(201);
      const second = await buy(user.token, '10000', clientRequestId).expect(200);

      expect(second.body.orderId).toBe(first.body.orderId);
      // A replay is the recorded order, not a fresh quote: no pricing block.
      expect(second.body.pricing).toBeUndefined();
      expect(await balancesOf(user.userId)).toEqual({
        INR: '1013400.00',
        USDT: '10000.000000',
      });
      expect(await orderCount(user.userId)).toBe(1);
    });

    it('answers a replay with a different amount by the original order, not a second trade', async () => {
      const user = await createUserWithWallet('replay-amount', { inr: '2000000' });
      const clientRequestId = randomUUID();

      const first = await buy(user.token, '10000', clientRequestId).expect(201);
      const second = await buy(user.token, '1', clientRequestId).expect(200);

      expect(second.body.orderId).toBe(first.body.orderId);
      expect(second.body.usdtAmount).toBe('10000.000000');
      expect(await orderCount(user.userId)).toBe(1);
      expect(await balancesOf(user.userId)).toMatchObject({ INR: '1013400.00' });
    });
  });

  // -------------------------------------------------------------------------
  // Atomic state update
  // -------------------------------------------------------------------------

  describe('atomic state update', () => {
    it('settles exactly one of two racing buys that share one balance', async () => {
      // Exactly enough INR for one 10,000-USDT buy (986,600.00): whichever
      // wins, the other must find the balance gone and leave no order behind.
      const user = await createUserWithWallet('race', { inr: '986600' });

      const [a, b] = await Promise.all([buy(user.token, '10000'), buy(user.token, '10000')]);

      expect([a.status, b.status].sort()).toEqual([201, HttpStatus.CONFLICT]);
      const loser = a.status === 201 ? b : a;
      expect(loser.body.code).toBe('INSUFFICIENT_BALANCE');

      // One order, both legs of the one order, nothing of the loser.
      expect(await orderCount(user.userId)).toBe(1);
      expect(await balancesOf(user.userId)).toEqual({
        INR: '0.00',
        USDT: '10000.000000',
      });
    });

    it('applies a racing replay once, never twice', async () => {
      // Enough INR for both debits to succeed inside their transactions, so
      // the loser reaches the unique (userId, clientRequestId) insert and its
      // whole transaction rolls back onto the replay path - not onto a
      // balance refusal.
      const user = await createUserWithWallet('race-replay', { inr: '1973200' });
      const clientRequestId = randomUUID();

      const [a, b] = await Promise.all([
        buy(user.token, '10000', clientRequestId),
        buy(user.token, '10000', clientRequestId),
      ]);

      expect([a.status, b.status].sort()).toEqual([200, 201]);
      expect(a.body.orderId).toBe(b.body.orderId);

      expect(await orderCount(user.userId)).toBe(1);
      expect(await balancesOf(user.userId)).toEqual({
        INR: '986600.00',
        USDT: '10000.000000',
      });
    });

    it('leaves balances, ledger and order list untouched when a buy cannot be funded', async () => {
      const user = await createUserWithWallet('atomic', { inr: '986599.99' });

      const ledgerBefore = await prisma.transaction.count({
        where: { wallet: { userId: user.userId } },
      });

      await buy(user.token, '10000').expect(HttpStatus.CONFLICT);

      expect(await balancesOf(user.userId)).toEqual({ INR: '986599.99' });
      expect(await prisma.transaction.count({ where: { wallet: { userId: user.userId } } })).toBe(
        ledgerBefore,
      );
      expect(await orderCount(user.userId)).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // MODULE 09 - LP-funded BUYs against the suite's fixture provider
  // -------------------------------------------------------------------------

  describe('liquidity funding (Module 09)', () => {
    it('returns the LP funding block on a BUY creation, summing to the order figures', async () => {
      const user = await createUserWithWallet('liq-buy', { inr: '2000000' });

      const response = await buy(user.token, '100').expect(201);

      // 100 USDT fills at the first ask level alone: book VWAP 100.10, settled
      // a clear ₹1.50 under the cheapest ask at 98.66 - which is what LPs fund.
      expect(response.body.liquidity).toEqual({
        slices: [
          {
            commitmentId: fixtureCommitmentId,
            lpId: fixtureLpId,
            usdtAmount: '100.000000',
            inrAmount: '9866.00',
            priceInr: '98.66',
          },
        ],
        totalUsdt: '100.000000',
        totalInr: '9866.00',
      });
      // The block totals are the order's own figures, to the paisa.
      expect(response.body.liquidity.totalUsdt).toBe(response.body.usdtAmount);
      expect(response.body.liquidity.totalInr).toBe(response.body.inrAmount);
    });

    it('exposes the slices through the allocations endpoint for the order owner', async () => {
      const user = await createUserWithWallet('liq-alloc', { inr: '2000000' });

      const order = (await buy(user.token, '100').expect(201)).body as { orderId: string };

      const response = await http()
        .get(`/api/liquidity/allocations/${order.orderId}`)
        .set(bearer(user.token))
        .expect(200);

      expect(response.body.items).toHaveLength(1);
      expect(response.body.items[0]).toMatchObject({
        commitmentId: fixtureCommitmentId,
        usdtAmount: '100.000000',
        priceInr: '98.66',
      });
    });

    it('refuses a BUY with 409 INSUFFICIENT_LIQUIDITY when the only provider is suspended, restoring them afterwards', async () => {
      const user = await createUserWithWallet('liq-suspended', { inr: '2000000' });

      // Providers exist (so allocation is mandatory) but none are eligible:
      // aggregate eligible liquidity is zero.
      await prisma.liquidityProvider.update({
        where: { lpId: fixtureLpId },
        data: { status: 'SUSPENDED' },
      });

      try {
        const response = await buy(user.token, '100').expect(409);

        expect(response.body.code).toBe('INSUFFICIENT_LIQUIDITY');
        expect(await balancesOf(user.userId)).toEqual({ INR: '2000000.00' });
        expect(await orderCount(user.userId)).toBe(0);
      } finally {
        await prisma.liquidityProvider.update({
          where: { lpId: fixtureLpId },
          data: { status: 'ACTIVE' },
        });
      }
    });

    it('settles a SELL with no liquidity block', async () => {
      const user = await createUserWithWallet('liq-sell', { usdt: '100' });

      const response = await sell(user.token, '100').expect(201);

      expect(response.body).not.toHaveProperty('liquidity');
    });
  });
});
