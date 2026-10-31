import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import request from 'supertest';

import { createApp } from '../src/bootstrap';
import type { DomainException } from '../src/common/errors/domain.exception';
import { PrismaService } from '../src/database/prisma.service';
import { reportFailed } from '../src/modules/market-data/importer/import-report';
import { importMarketData } from '../src/modules/market-data/importer/market-data-importer';
import { mintToken } from './token-minting';

/**
 * The shape of a candle and of a failure as the API returns them.
 *
 * Both are declared rather than left as `Record<string, unknown>` so that a
 * field rename in a DTO surfaces here as a type error instead of as an
 * assertion that quietly stops comparing.
 */
interface CandlePayload {
  symbol: string;
  day: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  quoteVolume: string;
}

interface CandlePagePayload {
  items: CandlePayload[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface ErrorPayload {
  code: string;
  message: string;
  requestId: string;
}

/**
 * MODULE 06b - historical market data over HTTP.
 *
 * Boots the real application against the real database and the real committed
 * dataset: beforeAll runs the importer - reading `data/market/raw` from disk,
 * parsing every archive and writing with `ON CONFLICT DO NOTHING` - and then
 * every assertion reads back what the whole chain stored. This is the suite's
 * single most important property: the numbers below are grep-able facts in the
 * CSVs under `data/market/raw`, not hand-written samples, so a dataset
 * regression that quietly changed a price would fail here.
 *
 * Isolation: candles are the shipped dataset and are not deleted. Users are
 * created through the real auth path and purged in `afterAll`.
 *
 * WHAT THIS SUITE DOES NOT DO: it never seeds strategies or simulations. The
 * reader of `data/market/raw` is exercised here; the writer that also carries
 * a strategy under it belongs to the simulation suite, and the two are kept
 * apart so a market-data failure cannot be blamed on a seeding policy.
 */
describe('Market Data (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const createdUserIds: string[] = [];

  beforeAll(async () => {
    app = await createApp();
    await app.init();

    prisma = app.get(PrismaService);

    const report = await importMarketData(prisma);
    expect(reportFailed(report)).toBe(false);
    expect(report.inserted).toBe(0);
    expect(report.unchanged).toBe(1932);
  });

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await prisma.strategy.deleteMany({ where: { ownerId: { in: createdUserIds } } });
      await prisma.wallet.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }

    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** Creates a Prometheus user through the real auth path and returns a token. */
  async function createUser(label: string): Promise<{ token: string; userId: string }> {
    const email = `${label}-${randomUUID()}@market.test`;
    const token = await mintToken({ subject: `google:${label}-${randomUUID()}`, email });

    const response = await http().get('/api/auth/me').set(bearer(token)).expect(200);
    createdUserIds.push(response.body.id);

    return { token, userId: response.body.id };
  }

  async function candles(userToken: string, query: string): Promise<CandlePagePayload> {
    const response = await http()
      .get(`/api/market/candles?${query}`)
      .set(bearer(userToken))
      .expect(200);

    return response.body as CandlePagePayload;
  }

  /** Asserts a failure carries our stable code, and returns the body. */
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

  /** The first BTCUSDT bar, greppable in the committed CSV as-open. */
  const FIRST_BTC_CANDLE: CandlePayload = {
    symbol: 'BTCUSDT',
    day: '2025-01-01',
    open: '93576',
    high: '95151.15',
    low: '92888',
    close: '94591.79',
    volume: '10373.32613',
    quoteVolume: '975444194.1379983',
  };

  // ---------------------------------------------------------------------------

  describe('route surface', () => {
    it('refuses the only candles route without a token', async () => {
      await http().get('/api/market/candles?symbol=BTCUSDT').expect(401);
    });

    it('exposes no write route, because importing is an offline operation', async () => {
      const user = await createUser('surface');

      await http().post('/api/market/candles').set(bearer(user.token)).expect(404);
      await http().post('/api/market/import').set(bearer(user.token)).send({ symbol: 'BTCUSDT' }).expect(404);
      await http().delete(`/api/market/candles/${randomUUID()}`).set(bearer(user.token)).expect(404);
    });
  });

  // ---------------------------------------------------------------------------

  describe('reading candles', () => {
    it('lists BTCUSDT case-insensitively, ascending by day, with the committed first bar first', async () => {
      const user = await createUser('reader');
      const page = await candles(user.token, 'symbol=btcusdt&limit=5&page=1');

      expect(page.page).toBe(1);
      expect(page.limit).toBe(5);
      expect(page.total).toBe(644);
      expect(page.totalPages).toBe(129);
      expect(page.items).toHaveLength(5);
      expect(page.items[0]).toEqual(FIRST_BTC_CANDLE);

      const days = page.items.map((item) => item.day);
      expect([...days].sort()).toEqual(days);
    });

    it('returns a single selected day exactly as the source stored it', async () => {
      const user = await createUser('single');
      const page = await candles(user.token, 'symbol=BTCUSDT&from=2025-01-01&to=2025-01-01');

      expect(page.total).toBe(1);
      expect(page.items[0]).toEqual(FIRST_BTC_CANDLE);
    });

    it('returns the last bar of the window exactly', async () => {
      const user = await createUser('last');
      const page = await candles(user.token, 'symbol=BTCUSDT&from=2026-10-06&to=2026-10-06');

      expect(page.total).toBe(1);
      expect(page.items[0]).toMatchObject({
        symbol: 'BTCUSDT',
        day: '2026-10-06',
        open: '85766.87',
        close: '85549.93',
      });
    });

    it('reads a day in the middle of the window and reports the totals for the other symbols', async () => {
      const user = await createUser('middle');
      const middle = await candles(user.token, 'symbol=BTCUSDT&from=2025-06-15&to=2025-06-15');

      expect(middle.total).toBe(1);
      expect(middle.items[0]?.day).toBe('2025-06-15');

      expect((await candles(user.token, 'symbol=ETHUSDT')).total).toBe(644);
      expect((await candles(user.token, 'symbol=SOLUSDT')).total).toBe(644);
    });

    it('reports the first ETHUSDT and SOLUSDT bars, which the engine fills are priced off', async () => {
      const user = await createUser('firsts');

      const eth = await candles(user.token, 'symbol=ethusdt&from=2025-01-01&to=2025-01-01');
      const sol = await candles(user.token, 'symbol=solusdt&from=2025-01-01&to=2025-01-01');

      expect(eth.items[0]).toMatchObject({ day: '2025-01-01', open: '3337.78' });
      expect(sol.items[0]).toMatchObject({ day: '2025-01-01', open: '189.31' });
    });

    it('serves money as exact decimal strings, and never exposes provenance', async () => {
      const user = await createUser('strings');
      const page = await candles(user.token, 'symbol=BTCUSDT&limit=1&page=1');
      const candle = page.items[0];

      if (candle === undefined) {
        throw new Error('expected a candle to be returned');
      }

      for (const field of ['open', 'high', 'low', 'close', 'volume', 'quoteVolume'] as const) {
        expect(typeof candle[field]).toBe('string');
        expect(new Prisma.Decimal(candle[field]).isFinite()).toBe(true);
      }

      const serialised = JSON.stringify(page);
      expect(serialised).not.toContain('sourceFile');
      expect(serialised).not.toContain('importedAt');
      expect(serialised).not.toContain('NaN');
      expect(serialised).not.toContain('Infinity');
    });

    it('pages by offset and keeps the totals standing past the last page', async () => {
      const user = await createUser('paging');

      const page = await candles(user.token, 'symbol=BTCUSDT&limit=2&page=1');
      expect(page.items).toHaveLength(2);
      expect(page.total).toBe(644);
      expect(page.totalPages).toBe(322);

      const beyond = await candles(user.token, 'symbol=BTCUSDT&limit=20&page=999');
      expect(beyond.items).toHaveLength(0);
      expect(beyond.total).toBe(644);
      expect(beyond.totalPages).toBe(33);
    });

    it('answers 200 with an empty page for a known symbol on a day it has no bars', async () => {
      const user = await createUser('empty');
      const page = await candles(user.token, 'symbol=BTCUSDT&from=2010-01-01&to=2010-01-02');

      expect(page).toEqual({ items: [], page: 1, limit: 20, total: 0, totalPages: 0 });
    });
  });

  // ---------------------------------------------------------------------------

  describe('boundaries', () => {
    it('answers 404 for a symbol that is not in the dataset', async () => {
      const user = await createUser('unknown');

      const response = await http()
        .get('/api/market/candles?symbol=ZZZZZ')
        .set(bearer(user.token))
        .expect(404);

      expectDomainError(response, 'NOT_FOUND', HttpStatus.NOT_FOUND);
    });

    it.each([
      ['a missing symbol', ''],
      ['an empty symbol', 'symbol='],
      ['a non-alphanumeric symbol', 'symbol=BTC/USDT'],
      ['an over-long symbol', `symbol=${'B'.repeat(21)}`],
      ['from after to', 'symbol=BTCUSDT&from=2025-02-01&to=2025-01-01'],
      ['a calendar day that does not exist', 'symbol=BTCUSDT&from=2025-13-45'],
      ['an instant instead of a calendar day', 'symbol=BTCUSDT&from=2025-01-01T00:00:00Z'],
      ['page zero', 'symbol=BTCUSDT&page=0'],
      ['a non-numeric page', 'symbol=BTCUSDT&page=abc'],
      ['limit zero', 'symbol=BTCUSDT&limit=0'],
      ['an over-large limit', 'symbol=BTCUSDT&limit=101'],
    ])('rejects %s', async (_label, query) => {
      const user = await createUser('boundary');

      await http().get(`/api/market/candles?${query}`).set(bearer(user.token)).expect(400);
    });
  });
});