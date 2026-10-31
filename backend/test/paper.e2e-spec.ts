import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { HttpStatus } from '@nestjs/common';
import request from 'supertest';

import { createApp } from '../src/bootstrap';
import type { DomainException } from '../src/common/errors/domain.exception';
import { PrismaService } from '../src/database/prisma.service';
import { FakeMarketDataProvider } from '../src/modules/live-data/providers/fake-market-data-provider';
import { isMarketOpen } from '../src/modules/live-data/market-state';
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
  side: 'BUY' | 'SELL';
  quantity: string;
  status: 'FILLED' | 'REJECTED';
  rejectReason: string | null;
  fillPrice: string | null;
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
  quantity: string;
  averageEntryPrice: string;
  openedAt: string;
  lastActivityAt: string;
}

interface PaperSummaryPayload {
  account: PaperAccountPayload | null;
  positions: PaperPositionPayload[];
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

  const createdUserIds: string[] = [];

  beforeAll(async () => {
    // Must be set before `createApp()`: the provider token is bound from config
    // while the module graph is being built, not per request.
    process.env['MARKET_DATA_PROVIDER'] = 'fake';

    app = await createApp();
    await app.init();

    prisma = app.get(PrismaService);
    fake = app.get(FakeMarketDataProvider);
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
      await prisma.wallet.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }

    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** Creates a Prometheus user through the real auth path and returns a token. */
  async function createUser(label: string): Promise<{ token: string; userId: string }> {
    const email = `${label}-${randomUUID()}@paper.test`;
    const token = await mintToken({ subject: `google:${label}-${randomUUID()}`, email });

    const response = await http().get('/api/auth/me').set(bearer(token)).expect(200);
    createdUserIds.push(response.body.id);

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
    side?: 'BUY' | 'SELL';
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
        side: options.side ?? 'BUY',
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
        .send({ clientRequestId: randomUUID(), symbol: 'SOL/USD', side: 'BUY', quantity: '1' })
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
    it('fills a BUY at the ask, debits cash and opens a position', async () => {
      const user = await createUser('buyfill');
      const strategyId = await createStrategy(user.token, 'buyfill');
      seedFreshQuote('SOL/USD', '169.5', '170.5');

      const response = await placeOrder(user.token, strategyId, { quantity: '2' }).expect(201);
      const order = response.body as PaperOrderPayload;

      expect(order.status).toBe('FILLED');
      expect(order.rejectReason).toBeNull();
      expect(order.fillPrice).toBe('170.5');
      expect(order.symbol).toBe('SOL/USD');
      expect(order.side).toBe('BUY');
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
        quantity: '2',
        averageEntryPrice: '170.5',
      });
    });

    it('fills a second BUY by blending the average entry price', async () => {
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

    it('fills a SELL at the bid, credits cash and realises P&L against the entry price', async () => {
      const user = await createUser('sellfill');
      const strategyId = await createStrategy(user.token, 'sellfill');

      seedFreshQuote('SOL/USD', '99.5', '100.5');
      await placeOrder(user.token, strategyId, { quantity: '4' }).expect(201);

      seedFreshQuote('SOL/USD', '149.5', '150.5');
      const response = await placeOrder(user.token, strategyId, { side: 'SELL', quantity: '4' }).expect(201);
      const order = response.body as PaperOrderPayload;

      expect(order.status).toBe('FILLED');
      expect(order.fillPrice).toBe('149.5');

      const after = await summary(user.token, strategyId);
      // Realised = (149.5 - 100.5) * 4 = 196. Cash = 100000 - 402 + 598 = 100196.
      expect(after.account?.realizedPnl).toBe('196');
      expect(after.account?.cash).toBe('100196');
      // A fully closed position is deleted, not left at zero.
      expect(after.positions).toEqual([]);
    });

    it('partially sells, leaving the remainder open at the unchanged entry price', async () => {
      const user = await createUser('partial');
      const strategyId = await createStrategy(user.token, 'partial');

      seedFreshQuote('SOL/USD', '199.5', '200.5');
      await placeOrder(user.token, strategyId, { quantity: '3' }).expect(201);

      seedFreshQuote('SOL/USD', '249.5', '250.5');
      await placeOrder(user.token, strategyId, { side: 'SELL', quantity: '1' }).expect(201);

      const after = await summary(user.token, strategyId);
      expect(after.positions).toHaveLength(1);
      expect(after.positions[0]?.quantity).toBe('2');
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

  describe('rejections', () => {
    it('rejects a SELL larger than the position with INSUFFICIENT_POSITION', async () => {
      const user = await createUser('shortsell');
      const strategyId = await createStrategy(user.token, 'shortsell');
      seedFreshQuote('SOL/USD', '9.5', '10.5');

      await placeOrder(user.token, strategyId, { quantity: '2' }).expect(201);

      seedFreshQuote('SOL/USD', '19.5', '20.5');
      const response = await placeOrder(user.token, strategyId, { side: 'SELL', quantity: '5' }).expect(201);
      const order = response.body as PaperOrderPayload;

      expect(order.status).toBe('REJECTED');
      expect(order.rejectReason).toBe('INSUFFICIENT_POSITION');
      expect(order.fillPrice).toBeNull();

      // The failed sell moves nothing.
      const after = await summary(user.token, strategyId);
      expect(after.positions[0]?.quantity).toBe('2');
      expect(after.account?.cash).toBe('99979');
      expect(after.account?.realizedPnl).toBe('0');
    });

    it('rejects a BUY that costs more than the paper cash with INSUFFICIENT_PAPER_CASH', async () => {
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
    it('never oversells paper cash when several BUYs race on the same strategy', async () => {
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

    it('serialises concurrent BUYs and SELLs so a position cannot go negative', async () => {
      const user = await createUser('mixedrace');
      const strategyId = await createStrategy(user.token, 'mixedrace');

      seedFreshQuote('SOL/USD', '99.5', '100.5');
      await placeOrder(user.token, strategyId, { quantity: '2' }).expect(201);

      seedFreshQuote('SOL/USD', '149.5', '150.5');
      const results = await Promise.all([
        placeOrder(user.token, strategyId, { side: 'SELL', quantity: '1' }),
        placeOrder(user.token, strategyId, { side: 'SELL', quantity: '1' }),
        placeOrder(user.token, strategyId, { side: 'SELL', quantity: '1' }),
      ]);

      const filled = results.filter((r) => (r.body as PaperOrderPayload).status === 'FILLED');
      const rejected = results.filter((r) => (r.body as PaperOrderPayload).status === 'REJECTED');

      expect(filled).toHaveLength(2);
      expect(rejected).toHaveLength(1);
      expect((rejected[0]?.body as PaperOrderPayload).rejectReason).toBe('INSUFFICIENT_POSITION');

      const after = await summary(user.token, strategyId);
      expect(after.positions).toEqual([]);
      // (149.5 - 100.5) * 2 = 98 realised; cash 100000 - 201 + 299 = 100098.
      expect(after.account?.realizedPnl).toBe('98');
      expect(after.account?.cash).toBe('100098');
    });
  });

  // ---------------------------------------------------------------------------

  describe('order history', () => {
    it('lists orders newest first, with rejected rows carrying a reason and no price', async () => {
      const user = await createUser('history');
      const strategyId = await createStrategy(user.token, 'history');

      seedFreshQuote('SOL/USD', '19.5', '20.5');
      await placeOrder(user.token, strategyId, { quantity: '1' }).expect(201);
      await placeOrder(user.token, strategyId, { side: 'SELL', quantity: '5' }).expect(201);
      await placeOrder(user.token, strategyId, { symbol: 'DOGE/USD' }).expect(404);

      const history = await orders(user.token, strategyId);
      expect(history).toHaveLength(2);

      expect(history[0]?.side).toBe('SELL');
      expect(history[0]?.status).toBe('REJECTED');
      expect(history[0]?.rejectReason).toBe('INSUFFICIENT_POSITION');
      expect(history[0]?.fillPrice).toBeNull();
      expect(history[0]?.filledAt).toBeNull();

      expect(history[1]?.side).toBe('BUY');
      expect(history[1]?.status).toBe('FILLED');
      expect(history[1]?.fillPrice).toBe('20.5');
      expect(history[1]?.filledAt).not.toBeNull();

      expect(Date.parse(history[0]!.placedAt)).toBeGreaterThanOrEqual(Date.parse(history[1]!.placedAt));
    });
  });
});
