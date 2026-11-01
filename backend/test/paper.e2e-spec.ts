import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { HttpStatus } from '@nestjs/common';
import request from 'supertest';

import { createApp } from '../src/bootstrap';
import type { DomainException } from '../src/common/errors/domain.exception';
import { PrismaService } from '../src/database/prisma.service';
import { seedAssets } from '../src/modules/assets/asset-seed';
import { FakeMarketDataProvider } from '../src/modules/live-data/providers/fake-market-data-provider';
import { isMarketOpen } from '../src/modules/live-data/market-state';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { mintToken } from './token-minting';

/**
 * The shape of a paper order and of an account summary as the API returns them.
 *
 * Declared rather than left untyped so a DTO rename surfaces as a type error
 * here instead of as an assertion that silently stops comparing.
 */
interface PaperOrderPayload {
  orderId: string;
  strategyId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  quantity: string;
  status: 'FILLED' | 'REJECTED';
  rejectReason: string | null;
  fillPrice: string | null;
  realizedPnl: string | null;
  placedAt: string;
  filledAt: string | null;
  clientRequestId: string;
}

interface PaperAccountPayload {
  currency: string;
  cash: string;
  realizedPnl: string;
  openedAt: string;
  lastActivityAt: string;
}

interface PaperPositionPayload {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  quantity: string;
  averageEntryPrice: string;
  markPrice: string | null;
  marketValue: string | null;
  unrealizedPnl: string | null;
  stale: boolean;
  openedAt: string;
  lastActivityAt: string;
}

interface PaperSummaryPayload {
  account: PaperAccountPayload | null;
  positions: PaperPositionPayload[];
  walletUsdt: string;
}

interface ErrorPayload {
  code: string;
  message: string;
  requestId: string;
}

/**
 * MODULE 06c - paper trading over HTTP, end to end.
 *
 * WHY THE FAKE FEED. Every assertion in this suite is about the ledger, not
 * about a quote. Running against a real feed would make the suite's outcome
 * depend on whether an exchange happened to answer, on whether it was open, and
 * on what it charged - so the provider is pinned to the deterministic fake and
 * each case seeds the exact quote it trades against. The fake is labelled
 * `isDemo: true` on every response, and one test asserts exactly that, which is
 * the property that keeps this suite from ever being mistaken for evidence that
 * a live feed works.
 *
 * WHY THE FILL CASES TRADE CRYPTO. `MARKET_CLOSED` is decided by the real wall
 * clock, not by the provider, so a stock fill is only possible inside the US
 * cash session. Crypto trades 24/7, which makes `SOL/USD` the deterministic
 * instrument for fills, average-price maths and realised P&L. The equities case
 * is still covered: it asserts the outcome the session rule actually implies at
 * the moment the test runs, rather than asserting a fixed answer that would be
 * wrong for half of every week.
 *
 * Isolation: users are created through the real auth path; every row they own -
 * orders, positions, accounts, strategies - is purged in `afterAll`.
 */
describe('Paper Trading (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fake: FakeMarketDataProvider;
  let walletService: WalletService;

  const createdUserIds: string[] = [];

  beforeAll(async () => {
    // Must be set before `createApp()`: the provider token is bound from config
    // while the module graph is being built, not per request.
    process.env['MARKET_DATA_PROVIDER'] = 'fake';

    app = await createApp();
    await app.init();

    prisma = app.get(PrismaService);
    fake = app.get(FakeMarketDataProvider);
    walletService = app.get(WalletService);

    // The USDT balance every order's notional is checked against.
    await seedAssets(prisma);
  });

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      const where = { ownerId: { in: createdUserIds } };
      const strategies = await prisma.strategy.findMany({ where, select: { id: true } });
      const strategyIds = strategies.map((s) => s.id);

      if (strategyIds.length > 0) {
        await prisma.paperOrder.deleteMany({ where: { strategyId: { in: strategyIds } } });
        await prisma.paperPosition.deleteMany({ where: { strategyId: { in: strategyIds } } });
        await prisma.paperAccount.deleteMany({ where: { strategyId: { in: strategyIds } } });
      }

      await prisma.strategy.deleteMany({ where });
      await prisma.transaction.deleteMany({ where: { wallet: { userId: { in: createdUserIds } } } });
      await prisma.walletBalance.deleteMany({ where: { wallet: { userId: { in: createdUserIds } } } });
      await prisma.wallet.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }

    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  /**
   * Credits the user's real USDT balance.
   *
   * Every order's notional has to be covered by the trader's wallet, so a user
   * with no USDT cannot trade at all. The credit goes through the real wallet
   * ledger - it is a DEPOSIT row, not a patched balance - so the balance the
   * gate reads is a balance the system actually holds.
   */
  async function fundUsdt(userId: string, amount: string): Promise<void> {
    const wallet = await prisma.wallet.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });
    const asset = await prisma.asset.findUniqueOrThrow({ where: { symbol: 'USDT' } });

    await walletService.credit(wallet.id, asset.id, amount);
  }

  /** Creates a Prometheus user through the real auth path and returns a token. */
  async function createUser(label: string, usdt = '1000000'): Promise<{ token: string; userId: string }> {
    const email = `${label}-${randomUUID()}@paper.test`;
    const token = await mintToken({ subject: `google:${label}-${randomUUID()}`, email });

    const response = await http().get('/api/auth/me').set(bearer(token)).expect(200);
    createdUserIds.push(response.body.id);

    await fundUsdt(response.body.id, usdt);

    return { token, userId: response.body.id };
  }

  /** Creates a PRIVATE strategy the user owns. */
  async function createStrategy(token: string, label: string): Promise<string> {
    const response = await http()
      .post('/api/strategies')
      .set(bearer(token))
      .send({ name: `${label}-${randomUUID()}`, description: 'paper e2e', visibility: 'PRIVATE' })
      .expect(201);

    return response.body.id as string;
  }

  interface PlaceOrderOptions {
    clientRequestId?: string;
    quantity?: string;
    side?: 'LONG' | 'SHORT';
    symbol?: string;
  }

  /**
   * Builds the request without awaiting it, so a caller can chain supertest's
   * `.expect(...)` - which only exists on the `Test` thenable, not on the
   * resolved `Response`.
   */
  function placeOrder(token: string, strategyId: string, options: PlaceOrderOptions = {}): request.Test {
    return http()
      .post(`/api/strategies/${strategyId}/paper/orders`)
      .set(bearer(token))
      .send({
        clientRequestId: options.clientRequestId ?? randomUUID(),
        symbol: options.symbol ?? 'SOL/USD',
        side: options.side ?? 'LONG',
        quantity: options.quantity ?? '1',
      });
  }

  async function summary(token: string, strategyId: string): Promise<PaperSummaryPayload> {
    const response = await http()
      .get(`/api/strategies/${strategyId}/paper/account`)
      .set(bearer(token))
      .expect(200);

    return response.body as PaperSummaryPayload;
  }

  async function orders(token: string, strategyId: string): Promise<PaperOrderPayload[]> {
    const response = await http()
      .get(`/api/strategies/${strategyId}/paper/orders`)
      .set(bearer(token))
      .expect(200);

    return response.body as PaperOrderPayload[];
  }

  function expectDomainError(
    response: request.Response,
    code: DomainException['code'],
    status: HttpStatus,
  ): ErrorPayload {
    const body = response.body as ErrorPayload;
    expect(body.code).toBe(code);
    expect(response.status).toBe(status);
    expect(typeof body.message).toBe('string');
    expect(typeof body.requestId).toBe('string');

    return body;
  }

  /** Seeds a fresh, two-sided quote so a fill is deterministic. */
  function seedFreshQuote(symbol: string, bid: string, ask: string): void {
    fake.seedQuote(symbol, ask, { bid, ask, asOf: new Date().toISOString() });
  }

  // ---------------------------------------------------------------------------

  describe('route surface', () => {
    it('refuses every paper route without a token', async () => {
      const strategyId = randomUUID();

      await http().post(`/api/strategies/${strategyId}/paper/orders`).expect(401);
      await http().get(`/api/strategies/${strategyId}/paper/orders`).expect(401);
      await http().get(`/api/strategies/${strategyId}/paper/account`).expect(401);
    });

    it('rejects a strategy id that is not a UUID, because the route contract is a UUID', async () => {
      const user = await createUser('badid');

      await http().get('/api/strategies/joel/paper/orders').set(bearer(user.token)).expect(400);
      await http().get('/api/strategies/joel/paper/account').set(bearer(user.token)).expect(400);
      await http()
        .post('/api/strategies/joel/paper/orders')
        .set(bearer(user.token))
        .send({ clientRequestId: randomUUID(), symbol: 'SOL/USD', side: 'LONG', quantity: '1' })
        .expect(400);
    });

    it('reports the fake feed as demo on the status route, never as live', async () => {
      const user = await createUser('status');

      const response = await http().get('/api/market-data/status').set(bearer(user.token)).expect(200);

      expect(response.body).toMatchObject({ provider: 'fake', enabled: true, isDemo: true });
    });
  });

  // ---------------------------------------------------------------------------

  describe('ownership', () => {
    it('hides another owner\'s paper account and orders behind a 404, never a 403', async () => {
      const owner = await createUser('owner');
      const stranger = await createUser('stranger');
      const strategyId = await createStrategy(owner.token, 'owned');

      const ordersResponse = await http()
        .get(`/api/strategies/${strategyId}/paper/orders`)
        .set(bearer(stranger.token))
        .expect(404);
      expectDomainError(ordersResponse, 'NOT_FOUND', HttpStatus.NOT_FOUND);

      const accountResponse = await http()
        .get(`/api/strategies/${strategyId}/paper/account`)
        .set(bearer(stranger.token))
        .expect(404);
      expectDomainError(accountResponse, 'NOT_FOUND', HttpStatus.NOT_FOUND);

      const placeResponse = await placeOrder(stranger.token, strategyId).expect(404);
      expectDomainError(placeResponse, 'NOT_FOUND', HttpStatus.NOT_FOUND);
    });

    it('404s a strategy that does not exist at all', async () => {
      const user = await createUser('ghost');
      const missing = randomUUID();

      await http().get(`/api/strategies/${missing}/paper/orders`).set(bearer(user.token)).expect(404);
      await http().get(`/api/strategies/${missing}/paper/account`).set(bearer(user.token)).expect(404);
    });
  });

  // ---------------------------------------------------------------------------

  describe('empty state', () => {
    it('returns a null account and no positions until the first order provisions one', async () => {
      const user = await createUser('empty');
      const strategyId = await createStrategy(user.token, 'empty');

      const before = await summary(user.token, strategyId);
      expect(before.account).toBeNull();
      expect(before.positions).toEqual([]);
      expect(await orders(user.token, strategyId)).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------

  describe('fills', () => {
    it('fills a LONG at the ask, debits cash and opens a position', async () => {
      const user = await createUser('longfill');
      const strategyId = await createStrategy(user.token, 'longfill');
      seedFreshQuote('SOL/USD', '169.5', '170.5');

      const response = await placeOrder(user.token, strategyId, { quantity: '2' }).expect(201);
      const order = response.body as PaperOrderPayload;

      expect(order.status).toBe('FILLED');
      expect(order.rejectReason).toBeNull();
      expect(order.fillPrice).toBe('170.5');
      expect(order.symbol).toBe('SOL/USD');
      expect(order.side).toBe('LONG');
      expect(order.quantity).toBe('2');
      expect(order.filledAt).not.toBeNull();

      const after = await summary(user.token, strategyId);
      expect(after.account).not.toBeNull();
      // 100000 - (2 * 170.5) = 99659
      expect(after.account?.cash).toBe('99659');
      expect(after.account?.realizedPnl).toBe('0');
      expect(after.account?.currency).toBe('USD');

      expect(after.positions).toHaveLength(1);
      expect(after.positions[0]).toMatchObject({
        symbol: 'SOL/USD',
        direction: 'LONG',
        quantity: '2',
        averageEntryPrice: '170.5',
      });
    });

    it('fills a second LONG by blending the average entry price', async () => {
      const user = await createUser('blend');
      const strategyId = await createStrategy(user.token, 'blend');

      seedFreshQuote('SOL/USD', '99.5', '100.5');
      await placeOrder(user.token, strategyId, { quantity: '2' }).expect(201);

      seedFreshQuote('SOL/USD', '299.5', '300.5');
      await placeOrder(user.token, strategyId, { quantity: '1' }).expect(201);

      const after = await summary(user.token, strategyId);
      expect(after.positions).toHaveLength(1);
      // ((2 * 100.5) + (1 * 300.5)) / 3, at the 18 places the engine rounds money to.
      expect(after.positions[0]?.quantity).toBe('3');
      expect(after.positions[0]?.averageEntryPrice).toBe('167.16666666666666667');
      // 100000 - 201 - 300.5 = 99498.5
      expect(after.account?.cash).toBe('99498.5');
    });

    it('fills a SHORT at the bid, closes the long and realises P&L against the entry price', async () => {
      const user = await createUser('shortfill');
      const strategyId = await createStrategy(user.token, 'shortfill');

      seedFreshQuote('SOL/USD', '99.5', '100.5');
      await placeOrder(user.token, strategyId, { quantity: '4' }).expect(201);

      seedFreshQuote('SOL/USD', '149.5', '150.5');
      const response = await placeOrder(user.token, strategyId, { side: 'SHORT', quantity: '4' }).expect(201);
      const order = response.body as PaperOrderPayload;

      expect(order.status).toBe('FILLED');
      expect(order.fillPrice).toBe('149.5');
      expect(order.realizedPnl).toBe('196');

      const after = await summary(user.token, strategyId);
      // Realised = (149.5 - 100.5) * 4 = 196. Cash = 100000 - 402 + 598 = 100196.
      expect(after.account?.realizedPnl).toBe('196');
      expect(after.account?.cash).toBe('100196');
      // A fully closed position is deleted, not left at zero.
      expect(after.positions).toEqual([]);
    });

    it('opens a short against a flat book, bringing the notional in', async () => {
      const user = await createUser('openshort');
      const strategyId = await createStrategy(user.token, 'openshort');

      seedFreshQuote('SOL/USD', '99.5', '100.5');
      const response = await placeOrder(user.token, strategyId, { side: 'SHORT', quantity: '2' }).expect(201);
      const order = response.body as PaperOrderPayload;

      expect(order.status).toBe('FILLED');
      expect(order.fillPrice).toBe('99.5');
      expect(order.realizedPnl).toBeNull();

      const after = await summary(user.token, strategyId);
      expect(after.positions).toHaveLength(1);
      expect(after.positions[0]).toMatchObject({
        direction: 'SHORT',
        quantity: '2',
        averageEntryPrice: '99.5',
      });
      // 100000 + (2 * 99.5) = 100199
      expect(after.account?.cash).toBe('100199');
      expect(after.account?.realizedPnl).toBe('0');
    });

    it('partially closes, leaving the remainder open at the unchanged entry price', async () => {
      const user = await createUser('partial');
      const strategyId = await createStrategy(user.token, 'partial');

      seedFreshQuote('SOL/USD', '199.5', '200.5');
      await placeOrder(user.token, strategyId, { quantity: '3' }).expect(201);

      seedFreshQuote('SOL/USD', '249.5', '250.5');
      await placeOrder(user.token, strategyId, { side: 'SHORT', quantity: '1' }).expect(201);

      const after = await summary(user.token, strategyId);
      expect(after.positions).toHaveLength(1);
      expect(after.positions[0]?.quantity).toBe('2');
      expect(after.positions[0]?.direction).toBe('LONG');
      expect(after.positions[0]?.averageEntryPrice).toBe('200.5');
      expect(after.account?.realizedPnl).toBe('49');
    });

    it('rejects a stock order with MARKET_CLOSED when the session rule says closed, and fills when open', async () => {
      const user = await createUser('session');
      const strategyId = await createStrategy(user.token, 'session');
      seedFreshQuote('AAPL', '231.9', '232.1');

      const response = await placeOrder(user.token, strategyId, { symbol: 'AAPL' }).expect(201);
      const order = response.body as PaperOrderPayload;

      // The rule is evaluated against the real clock, so the expected answer is
      // computed here rather than hard-coded - a hard-coded value would be
      // wrong outside the US cash session and would fail on weekends.
      const expected = isMarketOpen('STOCK', new Date());
      if (expected === 'OPEN') {
        expect(order.status).toBe('FILLED');
        expect(order.fillPrice).toBe('232.1');
      } else {
        expect(order.status).toBe('REJECTED');
        expect(order.rejectReason).toBe('MARKET_CLOSED');
        expect(order.fillPrice).toBeNull();
      }

      // The rejected row is persisted, which is the contract: a refusal is a
      // committed outcome, not a thrown-away exception.
      const history = await orders(user.token, strategyId);
      expect(history).toHaveLength(1);
      expect(history[0]?.status).toBe(order.status);
    });
  });

  // ---------------------------------------------------------------------------

  describe('closing a position', () => {
    it('closes the open position with an order in the opposite direction', async () => {
      const user = await createUser('close');
      const strategyId = await createStrategy(user.token, 'close');

      seedFreshQuote('SOL/USD', '99.5', '100.5');
      await placeOrder(user.token, strategyId, { quantity: '2' }).expect(201);

      seedFreshQuote('SOL/USD', '149.5', '150.5');
      const response = await http()
        .post(`/api/strategies/${strategyId}/paper/positions/SOL%2FUSD/close`)
        .set(bearer(user.token))
        .expect(201);
      const order = response.body as PaperOrderPayload;

      expect(order.status).toBe('FILLED');
      expect(order.side).toBe('SHORT');
      expect(order.quantity).toBe('2');
      expect(order.fillPrice).toBe('149.5');
      expect(order.realizedPnl).toBe('98');

      const after = await summary(user.token, strategyId);
      expect(after.positions).toEqual([]);
      expect(after.account?.realizedPnl).toBe('98');
      expect(after.account?.cash).toBe('100098'); // 100000 - 201 + 299
    });

    it('404s when the strategy holds no position for that symbol', async () => {
      const user = await createUser('close-none');
      const strategyId = await createStrategy(user.token, 'close-none');

      await http()
        .post(`/api/strategies/${strategyId}/paper/positions/SOL%2FUSD/close`)
        .set(bearer(user.token))
        .expect(404);
    });
  });

  // ---------------------------------------------------------------------------

  describe('rejections', () => {
    it('rejects a LONG the real wallet cannot cover with INSUFFICIENT_WALLET_BALANCE', async () => {
      const user = await createUser('nowallet', '10');
      const strategyId = await createStrategy(user.token, 'nowallet');
      seedFreshQuote('SOL/USD', '99.5', '100.5');

      const response = await placeOrder(user.token, strategyId, { quantity: '2' }).expect(201);
      const order = response.body as PaperOrderPayload;

      expect(order.status).toBe('REJECTED');
      expect(order.rejectReason).toBe('INSUFFICIENT_WALLET_BALANCE');
      expect(order.fillPrice).toBeNull();

      // The refusal moves nothing: no position opens and the pot is untouched.
      const after = await summary(user.token, strategyId);
      expect(after.positions).toEqual([]);
      expect(after.account?.cash).toBe('100000');
      expect(after.account?.realizedPnl).toBe('0');
      // The wallet is reported as it is: the balance that could not cover the
      // order is the reason the order was refused.
      expect(after.walletUsdt).toBe('10');
    });

    it('rejects a LONG that costs more than the paper cash with INSUFFICIENT_PAPER_CASH', async () => {
      const user = await createUser('overdraft');
      const strategyId = await createStrategy(user.token, 'overdraft');
      // 5000 * 30 = 150000, well beyond the 100000 opening cash.
      seedFreshQuote('BTC/USD', '29.5', '30');

      const response = await placeOrder(user.token, strategyId, {
        symbol: 'BTC/USD',
        quantity: '5000',
      }).expect(201);
      const order = response.body as PaperOrderPayload;

      expect(order.status).toBe('REJECTED');
      expect(order.rejectReason).toBe('INSUFFICIENT_PAPER_CASH');

      const after = await summary(user.token, strategyId);
      expect(after.positions).toEqual([]);
    });

    it('rejects a quote older than the instrument threshold with STALE_MARKET_DATA', async () => {
      const user = await createUser('stale');
      const strategyId = await createStrategy(user.token, 'stale');

      // ETH/USD is crypto with a 30s threshold; a two-minute-old quote is stale.
      fake.seedQuote('ETH/USD', '3400', {
        bid: '3399',
        ask: '3401',
        asOf: new Date(Date.now() - 120_000).toISOString(),
      });

      const response = await placeOrder(user.token, strategyId, {
        symbol: 'ETH/USD',
        quantity: '0.5',
      }).expect(201);
      const order = response.body as PaperOrderPayload;

      expect(order.status).toBe('REJECTED');
      expect(order.rejectReason).toBe('STALE_MARKET_DATA');
    });

    it('rejects an order whose symbol has no quote with MARKET_DATA_UNAVAILABLE', async () => {
      const user = await createUser('unavailable');
      const strategyId = await createStrategy(user.token, 'unavailable');

      // A known instrument the fake provider has no price for.
      const response = await placeOrder(user.token, strategyId, { symbol: 'AMZN' }).expect(201);
      const order = response.body as PaperOrderPayload;

      // AMZN may legitimately reject as MARKET_CLOSED instead, because the
      // session rule runs before the price lookup. Either is a persisted
      // rejection; what must never happen is a fill with no price.
      expect(order.status).toBe('REJECTED');
      expect(['MARKET_DATA_UNAVAILABLE', 'MARKET_CLOSED', 'STALE_MARKET_DATA']).toContain(order.rejectReason);
      expect(order.fillPrice).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------

  describe('validation', () => {
    it('refuses a zero or negative quantity before any quote is fetched', async () => {
      const user = await createUser('zeroqty');
      const strategyId = await createStrategy(user.token, 'zeroqty');

      for (const quantity of ['0', '-1']) {
        const response = await placeOrder(user.token, strategyId, { quantity }).expect(400);
        const body = expectDomainError(response, 'VALIDATION_FAILED', HttpStatus.BAD_REQUEST);
        expect(body.message).toContain('positive');
      }

      expect(await orders(user.token, strategyId)).toEqual([]);
    });

    it('refuses a symbol outside the eight-instrument universe with a 404', async () => {
      const user = await createUser('badsymbol');
      const strategyId = await createStrategy(user.token, 'badsymbol');

      const response = await placeOrder(user.token, strategyId, { symbol: 'NOPE' }).expect(404);
      const body = expectDomainError(response, 'NOT_FOUND', HttpStatus.NOT_FOUND);
      expect(body.message).toContain('NOPE');
    });

    it('refuses a case-variant of a canonical symbol, because the symbol is a contract', async () => {
      const user = await createUser('case');
      const strategyId = await createStrategy(user.token, 'case');

      await placeOrder(user.token, strategyId, { symbol: 'sol/usd' }).expect(404);
      await placeOrder(user.token, strategyId, { symbol: 'aapl' }).expect(404);
    });

    it('refuses a clientRequestId that is not a UUID', async () => {
      const user = await createUser('crid');
      const strategyId = await createStrategy(user.token, 'crid');

      const response = await placeOrder(user.token, strategyId, { clientRequestId: 'probe-123' }).expect(400);
      expectDomainError(response, 'VALIDATION_FAILED', HttpStatus.BAD_REQUEST);
    });
  });

  // ---------------------------------------------------------------------------

  describe('idempotency', () => {
    it('replays the original order for a repeated clientRequestId and moves nothing twice', async () => {
      const user = await createUser('idem');
      const strategyId = await createStrategy(user.token, 'idem');
      seedFreshQuote('SOL/USD', '49.5', '50.5');

      const clientRequestId = randomUUID();

      const first = await placeOrder(user.token, strategyId, { clientRequestId, quantity: '2' }).expect(201);
      const second = await placeOrder(user.token, strategyId, { clientRequestId, quantity: '2' }).expect(201);

      expect(second.body.orderId).toBe(first.body.orderId);
      expect(second.body.clientRequestId).toBe(clientRequestId);

      const history = await orders(user.token, strategyId);
      expect(history).toHaveLength(1);

      const after = await summary(user.token, strategyId);
      expect(after.account?.cash).toBe('99899');
      expect(after.positions[0]?.quantity).toBe('2');
    });

    it('scopes idempotency to the strategy, so the same key on another strategy is a new order', async () => {
      const user = await createUser('idemscope');
      const first = await createStrategy(user.token, 'idemscope-a');
      const second = await createStrategy(user.token, 'idemscope-b');
      seedFreshQuote('SOL/USD', '9.5', '10.5');

      const clientRequestId = randomUUID();

      const a = await placeOrder(user.token, first, { clientRequestId, quantity: '1' }).expect(201);
      const b = await placeOrder(user.token, second, { clientRequestId, quantity: '1' }).expect(201);

      expect(b.body.orderId).not.toBe(a.body.orderId);
      expect(await orders(user.token, first)).toHaveLength(1);
      expect(await orders(user.token, second)).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------

  describe('concurrency', () => {
    it('never oversells paper cash when several LONGs race on the same strategy', async () => {
      const user = await createUser('race');
      const strategyId = await createStrategy(user.token, 'race');

      // Each order costs 100000/3, so at most two of four can be funded. The
      // advisory lock is what makes this deterministic rather than a coin toss.
      seedFreshQuote('BTC/USD', '33332.5', '33333.5');
      const quantity = '1';

      const results = await Promise.all(
        Array.from({ length: 4 }, () => placeOrder(user.token, strategyId, { symbol: 'BTC/USD', quantity })),
      );

      const filled = results.filter((r) => (r.body as PaperOrderPayload).status === 'FILLED');
      const rejected = results.filter((r) => (r.body as PaperOrderPayload).status === 'REJECTED');

      expect(filled).toHaveLength(2);
      expect(rejected).toHaveLength(2);
      for (const response of rejected) {
        expect((response.body as PaperOrderPayload).rejectReason).toBe('INSUFFICIENT_PAPER_CASH');
      }

      const history = await orders(user.token, strategyId);
      expect(history).toHaveLength(4);
      expect(history.filter((o) => o.status === 'FILLED')).toHaveLength(2);

      const after = await summary(user.token, strategyId);
      // 100000 - (2 * 33333.5) = 33333, which is less than one more order.
      expect(after.account?.cash).toBe('33333');
      expect(after.positions[0]?.quantity).toBe('2');
    });

    it('serialises concurrent orders so the book never contradicts itself', async () => {
      const user = await createUser('mixedrace');
      const strategyId = await createStrategy(user.token, 'mixedrace');

      seedFreshQuote('SOL/USD', '99.5', '100.5');
      await placeOrder(user.token, strategyId, { quantity: '2' }).expect(201);

      // Three identical SHORTs against a long of 2. The advisory lock runs them
      // one at a time, so two of them close the long and the third opens a
      // short against a flat book - which is a short, not a refusal.
      seedFreshQuote('SOL/USD', '149.5', '150.5');
      const results = await Promise.all([
        placeOrder(user.token, strategyId, { side: 'SHORT', quantity: '1' }),
        placeOrder(user.token, strategyId, { side: 'SHORT', quantity: '1' }),
        placeOrder(user.token, strategyId, { side: 'SHORT', quantity: '1' }),
      ]);

      const filled = results.filter((r) => (r.body as PaperOrderPayload).status === 'FILLED');
      const rejected = results.filter((r) => (r.body as PaperOrderPayload).status === 'REJECTED');

      expect(filled).toHaveLength(3);
      expect(rejected).toHaveLength(0);

      const after = await summary(user.token, strategyId);
      expect(after.positions).toHaveLength(1);
      expect(after.positions[0]).toMatchObject({
        direction: 'SHORT',
        quantity: '1',
        averageEntryPrice: '149.5',
      });
      // (149.5 - 100.5) * 2 = 98 realised; cash 100000 - 201 + 448.5 = 100247.5.
      expect(after.account?.realizedPnl).toBe('98');
      expect(after.account?.cash).toBe('100247.5');
    });
  });

  // ---------------------------------------------------------------------------

  describe('order history', () => {
    it('lists orders newest first, with rejected rows carrying a reason and no price', async () => {
      const user = await createUser('history');
      const strategyId = await createStrategy(user.token, 'history');

      seedFreshQuote('SOL/USD', '19.5', '20.5');
      await placeOrder(user.token, strategyId, { quantity: '1' }).expect(201);

      // 5000 * 30 = 150000, beyond the 100000 opening cash: a refusal with a
      // reason and no price, which is what the history has to show.
      seedFreshQuote('BTC/USD', '29.5', '30');
      await placeOrder(user.token, strategyId, { symbol: 'BTC/USD', quantity: '5000' }).expect(201);

      await placeOrder(user.token, strategyId, { symbol: 'DOGE/USD' }).expect(404);

      const history = await orders(user.token, strategyId);
      expect(history).toHaveLength(2);

      expect(history[0]?.side).toBe('LONG');
      expect(history[0]?.status).toBe('REJECTED');
      expect(history[0]?.rejectReason).toBe('INSUFFICIENT_PAPER_CASH');
      expect(history[0]?.fillPrice).toBeNull();
      expect(history[0]?.filledAt).toBeNull();

      expect(history[1]?.side).toBe('LONG');
      expect(history[1]?.status).toBe('FILLED');
      expect(history[1]?.fillPrice).toBe('20.5');
      expect(history[1]?.filledAt).not.toBeNull();

      expect(Date.parse(history[0]!.placedAt)).toBeGreaterThanOrEqual(Date.parse(history[1]!.placedAt));
    });
  });
});
