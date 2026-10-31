import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import request from 'supertest';

import { createApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import { seedMarketData } from '../src/modules/simulation/market-seed';
import { mintToken } from './token-minting';

/**
 * The shapes this module answers with, declared rather than inferred so a field
 * rename in a DTO surfaces here as a type error instead of as an assertion
 * that quietly stops comparing.
 */
interface SimulationPayload {
  strategyId: string;
  ruleKey: string;
  ruleVersion: number;
  symbol: string;
  windowStart: string;
  windowEnd: string;
  initialCash: string;
  feeRate: string;
  dayCount: number;
  fillCount: number;
  computedAt: string;
  simulated: boolean;
  notRealTrades: boolean;
  assumption: string;
}

interface FillPayload {
  sequenceNo: number;
  fillDay: string;
  side: string;
  symbol: string;
  quantity: string;
  price: string;
  gross: string;
  fee: string;
  cashAfter: string;
  note: string | null;
}

interface BalancePayload {
  day: string;
  cash: string;
  positionQty: string;
  positionValue: string;
  value: string;
}

interface Page<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/**
 * MODULE 06b - the simulated curves over HTTP.
 *
 * Boots the real application against the real database, then lets the real
 * seed - `seedMarketData` - do its whole job: import the committed candle
 * dataset, upsert the three expert strategies under the system owner, and
 * compute each rule over its symbol's full window. Every assertion below reads
 * back that computation through the API, so the suite proves the complete path
 * from `data/market/raw` to a screen in one direction.
 *
 * The numbers are pinned facts about the committed dataset, exactly as the
 * failure that greps them would fail: `1.05611819` is the quantity that
 * `roundMoney`-exact arithmetic produces for a first fill at BTCUSDT's second
 * day's open, `102427.4012903694218` is that day's `cash + positionValue`.
 *
 * Isolation: the market seed is the shipped demo data and is left standing, the
 * same way the asset catalogue survives `prisma/seed.ts`. Only the temporary
 * users and their rows are purged. Simulations on temporary strategies are,
 * like every simulation, replace-all - nothing here invents a second curve for
 * one strategy.
 */
describe('Simulation (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const createdUserIds: string[] = [];
  const tempStrategyIds: string[] = [];

  let buyholdId: string;
  let smaId: string;
  let donchianId: string;

  beforeAll(async () => {
    app = await createApp();
    await app.init();

    prisma = app.get(PrismaService);

    const result = await seedMarketData(prisma);

    const buyhold = result.strategies.find((entry) => entry.seed.ruleKey === 'buyhold-btc');
    const sma = result.strategies.find((entry) => entry.seed.ruleKey === 'sma-cross-eth');
    const donchian = result.strategies.find((entry) => entry.seed.ruleKey === 'donchian-sol');

    if (buyhold === undefined || sma === undefined || donchian === undefined) {
      throw new Error('seedMarketData must return all three expert strategies');
    }

    buyholdId = buyhold.strategy.id;
    smaId = sma.strategy.id;
    donchianId = donchian.strategy.id;
  });

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await prisma.strategyDailyBalance.deleteMany({
        where: { simulationId: { in: tempStrategyIds } },
      });
      await prisma.strategyFill.deleteMany({ where: { simulationId: { in: tempStrategyIds } } });
      await prisma.strategySimulation.deleteMany({ where: { strategyId: { in: tempStrategyIds } } });
      await prisma.strategy.deleteMany({ where: { ownerId: { in: createdUserIds } } });
      await prisma.wallet.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }

    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** An ACTIVE reader separate from the seeded system owner. */
  async function createReader(label: string): Promise<{ token: string; userId: string }> {
    const token = await mintToken({ subject: `google:${label}-${randomUUID()}`, email: `${label}-${randomUUID()}@simulation.test` });

    const response = await http().get('/api/auth/me').set(bearer(token)).expect(200);
    createdUserIds.push(response.body.id);

    return { token, userId: response.body.id };
  }

  /** A private, never-simulated strategy owned by the given user. */
  async function createUnsimulatedStrategy(user: { token: string }): Promise<string> {
    const response = await http()
      .post('/api/strategies')
      .set(bearer(user.token))
      .send({ name: `Unsimulated ${randomUUID().slice(0, 8)}`, visibility: 'PRIVATE' })
      .expect(201);

    const id = response.body.id as string;
    tempStrategyIds.push(id);
    return id;
  }

  async function summary(userToken: string, strategyId: string): Promise<SimulationPayload> {
    const response = await http()
      .get(`/api/simulations/${strategyId}`)
      .set(bearer(userToken))
      .expect(200);

    return response.body as SimulationPayload;
  }

  async function fills(
    userToken: string,
    strategyId: string,
    query = '',
  ): Promise<Page<FillPayload>> {
    const response = await http()
      .get(`/api/simulations/${strategyId}/fills?${query}`)
      .set(bearer(userToken))
      .expect(200);

    return response.body as Page<FillPayload>;
  }

  async function balances(
    userToken: string,
    strategyId: string,
    query = '',
  ): Promise<Page<BalancePayload>> {
    const response = await http()
      .get(`/api/simulations/${strategyId}/balance?${query}`)
      .set(bearer(userToken))
      .expect(200);

    return response.body as Page<BalancePayload>;
  }

  /** Buy-and-hold's only fill, greppable in the CSVs and exact to the last digit. */
  const FIRST_BUYHOLD_FILL: FillPayload = {
    sequenceNo: 1,
    fillDay: '2025-01-02',
    side: 'BUY',
    symbol: 'BTCUSDT',
    quantity: '1.05611819',
    price: '94591.78',
    gross: '99900.0994824782',
    fee: '99.9000994824782',
    cashAfter: '0.0004180393218',
    note: 'initial_allocation',
  };

  // ---------------------------------------------------------------------------

  describe('route surface', () => {
    it('refuses every simulations route without a token', async () => {
      await http().get(`/api/simulations/${buyholdId}`).expect(401);
      await http().get(`/api/simulations/${buyholdId}/fills`).expect(401);
      await http().get(`/api/simulations/${buyholdId}/balance`).expect(401);
    });

    it('answers 400 for an id that is not a UUID', async () => {
      const reader = await createReader('notuuid');

      await http().get('/api/simulations/not-a-uuid').set(bearer(reader.token)).expect(400);
      await http().get(`/api/simulations/not-a-uuid/fills`).set(bearer(reader.token)).expect(400);
      await http().get(`/api/simulations/not-a-uuid/balance`).set(bearer(reader.token)).expect(400);
    });

    it('answers 404 for a UUID that names no strategy', async () => {
      const reader = await createReader('uuidless');

      await http().get(`/api/simulations/${randomUUID()}`).set(bearer(reader.token)).expect(404);
    });

    it('exposes no write route: simulations are the seed\u2019s job, not a caller\u2019s', async () => {
      const reader = await createReader('readonly');

      await http().post(`/api/simulations/${buyholdId}`).set(bearer(reader.token)).expect(404);
      await http().post('/api/simulations').set(bearer(reader.token)).expect(404);
    });
  });

  // ---------------------------------------------------------------------------

  describe('the summary', () => {
    it('answers 404 for a visible strategy that was never simulated', async () => {
      const owner = await createReader('unsimulated');
      const strategyId = await createUnsimulatedStrategy(owner);

      await http().get(`/api/simulations/${strategyId}`).set(bearer(owner.token)).expect(404);
    });

    it('describes Buy and Hold BTC with the provenance and flags enforced by the DTO', async () => {
      const reader = await createReader('buyhold');
      const body = await summary(reader.token, buyholdId);

      expect(body).toMatchObject({
        strategyId: buyholdId,
        ruleKey: 'buyhold-btc',
        ruleVersion: 1,
        symbol: 'BTCUSDT',
        windowStart: '2025-01-01',
        windowEnd: '2026-10-06',
        initialCash: '100000',
        feeRate: '0.001',
        dayCount: 644,
        fillCount: 1,
        simulated: true,
        notRealTrades: true,
      });
      expect(body.assumption.length).toBeGreaterThan(20);
      expect(() => new Date(body.computedAt).toISOString()).not.toThrow();
    });

    it('describes the two rules that actually traded', async () => {
      const reader = await createReader('others');

      const sma = await summary(reader.token, smaId);
      expect(sma).toMatchObject({ ruleKey: 'sma-cross-eth', symbol: 'ETHUSDT', fillCount: 9, dayCount: 644 });

      const donchian = await summary(reader.token, donchianId);
      expect(donchian).toMatchObject({ ruleKey: 'donchian-sol', symbol: 'SOLUSDT', fillCount: 23, dayCount: 644 });
    });
  });

  // ---------------------------------------------------------------------------

  describe('fills', () => {
    it('returns the single Buy and Hold fill, exact to the last digit', async () => {
      const reader = await createReader('buys');
      const page = await fills(reader.token, buyholdId);

      expect(page.total).toBe(1);
      expect(page.page).toBe(1);
      expect(page.limit).toBe(20);
      expect(page.totalPages).toBe(1);
      expect(page.items[0]).toEqual(FIRST_BUYHOLD_FILL);
    });

    it('returns all 23 Donchian fills ascending, with the first and last pinned', async () => {
      const reader = await createReader('donchian');
      const first = await fills(reader.token, donchianId, 'limit=1&page=1');

      expect(first.items[0]).toEqual({
        sequenceNo: 1,
        fillDay: '2025-04-18',
        side: 'BUY',
        symbol: 'SOLUSDT',
        quantity: '740.8788186',
        price: '134.84',
        gross: '99900.099900024',
        fee: '99.900099900024',
        cashAfter: '0.000000075976',
        note: 'donchian_breakout_up',
      });

      const lastPage = await fills(reader.token, donchianId, 'limit=10&page=3');
      expect(lastPage.total).toBe(23);
      expect(lastPage.items).toHaveLength(3);
      expect(lastPage.items[0]?.sequenceNo).toBe(21);
      expect(lastPage.items[2]).toEqual({
        sequenceNo: 23,
        fillDay: '2026-09-19',
        side: 'BUY',
        symbol: 'SOLUSDT',
        quantity: '1212.43669374',
        price: '112.72',
        gross: '136665.8641183728',
        fee: '136.6658641183728',
        cashAfter: '0.0000002101106',
        note: 'donchian_breakout_up',
      });

      const sequenceNos = [];
      for (let pageNumber = 1; pageNumber <= 3; pageNumber += 1) {
        const page = await fills(reader.token, donchianId, `limit=10&page=${pageNumber}`);
        for (const item of page.items) {
          sequenceNos.push(item.sequenceNo);
        }
      }
      expect(sequenceNos).toHaveLength(23);
      expect([...sequenceNos].sort((a, b) => a - b)).toEqual(sequenceNos);
    });

    it('returns the first SMA 20/50 fill when it finally goes long', async () => {
      const reader = await createReader('sma');
      const first = await fills(reader.token, smaId, 'limit=1&page=1');

      expect(first.total).toBe(9);
      expect(first.items[0]).toEqual({
        sequenceNo: 1,
        fillDay: '2025-05-09',
        side: 'BUY',
        symbol: 'ETHUSDT',
        quantity: '45.25711355',
        price: '2207.39',
        gross: '99900.0998791345',
        fee: '99.9000998791345',
        cashAfter: '0.0000209863655',
        note: 'sma_cross_up',
      });
    });
  });

  // ---------------------------------------------------------------------------

  describe('the daily balance curve', () => {
    it('starts the curve the day before the first fill, then holds the position', async () => {
      const reader = await createReader('curvehead');
      const page = await balances(reader.token, buyholdId, 'limit=2&page=1');

      expect(page.total).toBe(644);
      expect(page.items[0]).toEqual({
        day: '2025-01-01',
        cash: '100000',
        positionQty: '0',
        positionValue: '0',
        value: '100000',
      });
      expect(page.items[1]).toEqual({
        day: '2025-01-02',
        cash: '0.0004180393218',
        positionQty: '1.05611819',
        positionValue: '102427.4008723301',
        value: '102427.4012903694218',
      });
    });

    it('reconciles cash + positionValue to value for every one of the 644 days', async () => {
      const reader = await createReader('reconcile');
      const collected: BalancePayload[] = [];

      for (let pageNumber = 1; pageNumber <= 7; pageNumber += 1) {
        const page = await balances(reader.token, buyholdId, `limit=100&page=${pageNumber}`);
        collected.push(...page.items);
      }

      expect(collected).toHaveLength(644);

      for (const row of collected) {
        expect(row.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);

        const cash = new Prisma.Decimal(row.cash);
        const positionValue = new Prisma.Decimal(row.positionValue);
        const value = new Prisma.Decimal(row.value);

        expect(cash.isFinite()).toBe(true);
        expect(positionValue.isFinite()).toBe(true);
        expect(value.isFinite()).toBe(true);
        expect(value.equals(cash.plus(positionValue))).toBe(true);
        expect(value.greaterThan(0)).toBe(true);
      }
    });

    it('pages past the end of the curve with empty items and a standing total', async () => {
      const reader = await createReader('tail');
      const page = await balances(reader.token, buyholdId, 'limit=20&page=999');

      expect(page.items).toHaveLength(0);
      expect(page.total).toBe(644);
      expect(page.totalPages).toBe(33);
    });
  });

  // ---------------------------------------------------------------------------

  describe('boundaries', () => {
    it.each([
      ['page zero', 'page=0'],
      ['a non-numeric page', 'page=abc'],
      ['limit zero', 'limit=0'],
      ['an over-large limit', 'limit=101'],
    ])('rejects %s', async (_label, query) => {
      const reader = await createReader('bounds');

      await http().get(`/api/simulations/${buyholdId}/fills?${query}`).set(bearer(reader.token)).expect(400);
      await http().get(`/api/simulations/${buyholdId}/balance?${query}`).set(bearer(reader.token)).expect(400);
    });

    it('surfaces the seeded floating point values as money strings, never JSON numbers', async () => {
      const reader = await createReader('strings');
      const page = await balances(reader.token, buyholdId, 'limit=1&page=1');
      const row = page.items[0];

      if (row === undefined) {
        throw new Error('expected a balance row to be returned');
      }

      for (const field of ['cash', 'positionQty', 'positionValue', 'value'] as const) {
        expect(typeof row[field]).toBe('string');
        expect(new Prisma.Decimal(row[field]).isFinite()).toBe(true);
      }
    });
  });
});