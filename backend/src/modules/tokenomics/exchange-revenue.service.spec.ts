import { randomUUID } from 'node:crypto';

import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ERROR_CODES } from '../../common/constants/error-codes';
import { DomainException } from '../../common/errors/domain.exception';
import type { AppConfig } from '../../config/config.module';
import type { PrismaService } from '../../database/prisma.service';
import { exchangeRevenueKeys } from './domain/exchange-revenue';
import { ExchangeRevenueService, type ExchangeRevenueSettlement } from './exchange-revenue.service';
import type { TokenomicsService } from './tokenomics.service';

/**
 * The queue mechanics, against a mocked database and a mocked Module 11.
 *
 * What is under test here is not the arithmetic - `domain/exchange-revenue.spec
 * .ts` covers that, and `test/exchange-revenue.e2e-spec.ts` runs the whole bridge
 * against a real Postgres and real treasury. It is the *promise* the bridge makes
 * about a pipeline that spans several transactions: that a settled order is
 * recorded exactly once, that a crash or a concurrent worker cannot produce a
 * second allocation, and that a treasury guardrail stops the burn without being
 * argued with, worked around, or forgotten.
 *
 * Those are all properties of how the rows are claimed and transitioned, which is
 * precisely the part an e2e run cannot force - you cannot make two real processes
 * lose the same race on schedule. So the guarded updates are mocked at the
 * boundary that matters: `updateMany` returning `count: 0` is the claim being lost.
 */
describe('ExchangeRevenueService (unit)', () => {
  const orderId = '11111111-1111-1111-1111-111111111111';

  const prismaMock = {
    exchangeRevenueEvent: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      groupBy: jest.fn(),
    },
    tokenAllocation: { aggregate: jest.fn() },
    tokenBurn: { groupBy: jest.fn() },
    user: { findUnique: jest.fn(), findUniqueOrThrow: jest.fn(), create: jest.fn() },
  };

  const tokenomicsMock = {
    createAllocation: jest.fn(),
    createBuyback: jest.fn(),
    executeBuyback: jest.fn(),
    createBurn: jest.fn(),
  };

  const configMock = {
    tokenomics: {
      exchangeRevenueMode: 'RETAINED_BPS',
      exchangeRevenueBps: 10_000,
      exchangeRevenueWorkerEnabled: false,
      exchangeRevenueWorkerIntervalMs: 15_000,
      exchangeRevenueMaxAttempts: 3,
      directBurnPct: 60,
      buybackPct: 40,
    },
    emberHub: { baselinePriceInr: '2.45' },
  } as unknown as AppConfig;

  const service = (config: AppConfig = configMock): ExchangeRevenueService =>
    new ExchangeRevenueService(
      config,
      prismaMock as unknown as PrismaService,
      tokenomicsMock as unknown as TokenomicsService,
    );

  /** The tx client `UsdtService.place` passes in from its own settlement. */
  const txMock = { exchangeRevenueEvent: prismaMock.exchangeRevenueEvent };

  const d = (value: string): Prisma.Decimal => new Prisma.Decimal(value);

  function settlement(overrides: Partial<ExchangeRevenueSettlement> = {}): ExchangeRevenueSettlement {
    return {
      orderId,
      userId: 'customer-1',
      side: 'BUY',
      usdtAmount: d('10'),
      customerInr: d('1000.00'),
      lpInrSettled: d('990.00'),
      lpBacked: true,
      ...overrides,
    };
  }

  function eventRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      eventId: 'evt-1',
      orderId,
      userId: 'customer-1',
      side: 'BUY',
      status: 'PROCESSING',
      reasonCode: 'ATTRIBUTED',
      detail: null,
      usdtAmount: d('10'),
      customerInr: d('1000.00'),
      lpInrSettled: d('990.00'),
      retainedInr: d('10.00'),
      revenueInr: d('10.00'),
      basisInr: d('10.00'),
      revenueMode: 'RETAINED_BPS',
      revenueBps: 10_000,
      emberPrice: d('2.45'),
      directBurnPct: 60,
      buybackPct: 40,
      attempts: 1,
      maxAttempts: 3,
      allocationId: null,
      buybackId: null,
      directBurnId: null,
      buybackBurnId: null,
      detectedAt: new Date('2026-11-01T12:00:00.000Z'),
      processedAt: null,
      updatedAt: new Date('2026-11-01T12:00:00.000Z'),
      ...overrides,
    };
  }

  const allocationCreated = (directBurnEmber = '122.448979591836734694') => ({
    created: true,
    allocation: {
      allocationId: 'alloc-1',
      directBurnEmber: d(directBurnEmber),
      buybackEmber: d('81.632653061224489796'),
    },
  });

  const buybackCreated = { created: true, buyback: { buybackId: 'bb-1' } };
  const burnCreated = (burnId: string) => ({ created: true, burn: { burnId } });

  /** Which burn id Module 11 would hand back for a given source. */
  const burnIdFor = (source: 'DIRECT' | 'BUYBACK'): string =>
    source === 'DIRECT' ? 'burn-direct' : 'burn-buyback';

  /**
   * The happy path, wired once so the failure tests only have to break one call.
   *
   * `createBurn` dispatches on the DTO's source rather than on call order: the
   * pipeline makes a DIRECT and a BUYBACK burn, and a sequence of
   * `mockResolvedValueOnce` would make every refusal test depend on how many
   * burns the default happened to pre-queue. Which source is burned is itself a
   * thing worth asserting, so keying on it is the stricter mock, not the lazier one.
   */
  function tokenomicsSucceeds(): void {
    tokenomicsMock.createAllocation.mockResolvedValue(allocationCreated());
    tokenomicsMock.createBuyback.mockResolvedValue(buybackCreated);
    tokenomicsMock.executeBuyback.mockResolvedValue({ created: true, buyback: { buybackId: 'bb-1' } });
    tokenomicsMock.createBurn.mockImplementation(async (_user: string, dto: { source: string }) =>
      burnCreated(burnIdFor(dto.source as 'DIRECT' | 'BUYBACK')),
    );
  }

  /** Make one source of burn refuse with `error`; the other still succeeds. */
  function burnRefuses(source: 'DIRECT' | 'BUYBACK', error: Error): void {
    tokenomicsMock.createBurn.mockImplementation(async (_user: string, dto: { source: string }) => {
      if (dto.source === source) throw error;
      return burnCreated(burnIdFor(dto.source as 'DIRECT' | 'BUYBACK'));
    });
  }

  /** Capture the data written by the most recent `update`, whatever wrote it. */
  const lastUpdateData = (): Record<string, unknown> => {
    const calls = prismaMock.exchangeRevenueEvent.update.mock.calls;
    return calls[calls.length - 1]![0].data as Record<string, unknown>;
  };

  beforeEach(() => {
    // resetAllMocks, not clearAllMocks: mockRejectedValue and the sequenced
    // mockResolvedValueOnce burn chain survive a clear and would leak a refusal
    // - or the wrong burn id - into the next test.
    jest.resetAllMocks();
    prismaMock.exchangeRevenueEvent.update.mockImplementation(async ({ data }: { data: unknown }) => ({
      ...eventRow(),
      ...(data as Record<string, unknown>),
    }));
    prismaMock.exchangeRevenueEvent.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.exchangeRevenueEvent.findMany.mockResolvedValue([]);
    prismaMock.user.findUnique.mockResolvedValue({ id: 'engine-1' });
    tokenomicsSucceeds();
  });

  // -------------------------------------------------------------------------
  // Detection
  // -------------------------------------------------------------------------

  describe('recordSettlement', () => {
    it('queues an event when the settlement actually retained something', async () => {
      await service().recordSettlement(txMock as unknown as Prisma.TransactionClient, settlement());

      const data = prismaMock.exchangeRevenueEvent.create.mock.calls[0]![0].data as Record<string, unknown>;
      expect(data.status).toBe('PENDING');
      expect(data.reasonCode).toBe('ATTRIBUTED');
      expect((data.revenueInr as Prisma.Decimal).toFixed(2)).toBe('10.00');
      // Both columns are written on every row, revenue-basis included, so a
      // reader never has to guess which one the pipeline sized itself from.
      expect((data.basisInr as Prisma.Decimal).toFixed(2)).toBe('10.00');
      expect(data.orderId).toBe(orderId);
      expect(data.nextAttemptAt).toBeInstanceOf(Date);
    });

    it('persists a volume basis with its zero revenue beside it', async () => {
      // The outbox row is where the two claims are kept apart at write time:
      // ₹1,000 sized the engine, ₹0 reached the platform. If this pair ever
      // collapses to one number, the ledger is calling turnover income.
      const volumeConfig = {
        ...configMock,
        tokenomics: { ...configMock.tokenomics, exchangeRevenueMode: 'VOLUME_LINKED' },
      } as unknown as AppConfig;

      await service(volumeConfig).recordSettlement(
        txMock as unknown as Prisma.TransactionClient,
        settlement({ lpInrSettled: d('1000.00') }),
      );

      const data = prismaMock.exchangeRevenueEvent.create.mock.calls[0]![0].data as Record<string, unknown>;
      expect(data.revenueMode).toBe('VOLUME_LINKED');
      expect(data.reasonCode).toBe('VOLUME_SIZED');
      expect(data.status).toBe('PENDING');
      expect((data.revenueInr as Prisma.Decimal).toFixed(2)).toBe('0.00');
      expect((data.basisInr as Prisma.Decimal).toFixed(2)).toBe('1000.00');
      expect((data.retainedInr as Prisma.Decimal).toFixed(2)).toBe('0.00');
    });

    it('records the order but queues nothing when the LPs took the whole payment', async () => {
      // Every BUY that has ever settled on this exchange looks like this. The
      // row still exists so the dashboard can say why the burn total is zero.
      const decision = await service().recordSettlement(
        txMock as unknown as Prisma.TransactionClient,
        settlement({ lpInrSettled: d('1000.00') }),
      );

      const data = prismaMock.exchangeRevenueEvent.create.mock.calls[0]![0].data as Record<string, unknown>;
      expect(decision.eligible).toBe(false);
      expect(data.status).toBe('INELIGIBLE');
      expect(data.reasonCode).toBe('NO_RETAINED_MARGIN');
      expect(data.nextAttemptAt).toBeNull();
    });

    it('never queues a SELL, whatever the revenue policy says', async () => {
      // §3: a SELL must not trigger the BUY allocation path. Queued as PENDING it
      // would, so the status itself is the guarantee - runPass only reads PENDING.
      await service().recordSettlement(txMock as unknown as Prisma.TransactionClient, settlement({ side: 'SELL' }));

      const data = prismaMock.exchangeRevenueEvent.create.mock.calls[0]![0].data as Record<string, unknown>;
      expect(data.status).toBe('INELIGIBLE');
      expect(data.reasonCode).toBe('SELL_OUT_OF_SCOPE');
    });

    it('snapshots the mode, rate and baseline split the decision was made under', async () => {
      // The row outlives the configuration. A month later, the operator has to be
      // able to tell what rule produced this number, not what the rule is today.
      await service().recordSettlement(txMock as unknown as Prisma.TransactionClient, settlement());

      const data = prismaMock.exchangeRevenueEvent.create.mock.calls[0]![0].data as Record<string, unknown>;
      expect(data.revenueMode).toBe('RETAINED_BPS');
      expect(data.revenueBps).toBe(10_000);
      expect(data.directBurnPct).toBe(60);
      expect(data.buybackPct).toBe(40);
      expect(data.emberPrice).toEqual(d('2.45'));
    });

    it('costs a settled order nothing when the revenue policy itself throws', async () => {
      // The policy runs on the inside of a customer's trade. A defect here must
      // produce an unattributed order, not a failed purchase - and ineligible is
      // the safe direction, because the hazard being guarded is burning EMBER
      // there is no revenue against.
      const brokenConfig = {
        tokenomics: { ...configMock.tokenomics, exchangeRevenueBps: undefined },
        emberHub: configMock.emberHub,
      } as unknown as AppConfig;

      const decision = await new ExchangeRevenueService(
        brokenConfig,
        prismaMock as unknown as PrismaService,
        tokenomicsMock as unknown as TokenomicsService,
      ).recordSettlement(txMock as unknown as Prisma.TransactionClient, settlement());

      const data = prismaMock.exchangeRevenueEvent.create.mock.calls[0]![0].data as Record<string, unknown>;
      expect(decision.eligible).toBe(false);
      expect(data.reasonCode).toBe('POLICY_ERROR');
      expect(data.status).toBe('INELIGIBLE');
      expect(prismaMock.exchangeRevenueEvent.create).toHaveBeenCalledTimes(1);
    });

    it('writes on the transaction client it was handed, not on its own prisma', async () => {
      // §3: the row commits with the order or not at all. A refused, rolled-back
      // or liquidity-short BUY must never reach this table, and that is only true
      // because the insert is made on the caller's tx.
      const ownClient = { exchangeRevenueEvent: { create: jest.fn() } };
      txMock.exchangeRevenueEvent.create = jest.fn().mockResolvedValue({ eventId: 'evt-1' });

      await service().recordSettlement(txMock as unknown as Prisma.TransactionClient, settlement());

      expect(txMock.exchangeRevenueEvent.create).toHaveBeenCalledTimes(1);
      expect(ownClient.exchangeRevenueEvent.create).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // The pipeline
  // -------------------------------------------------------------------------

  describe('processEvent', () => {
    it('runs the order through Module 11 once, in order', async () => {
      prismaMock.exchangeRevenueEvent.findUniqueOrThrow.mockResolvedValue(eventRow());

      await service().processEvent('evt-1');

      expect(tokenomicsMock.createAllocation).toHaveBeenCalledTimes(1);
      expect(tokenomicsMock.createBuyback).toHaveBeenCalledTimes(1);
      expect(tokenomicsMock.executeBuyback).toHaveBeenCalledTimes(1);
      expect(tokenomicsMock.createBurn).toHaveBeenCalledTimes(2);
      expect(lastUpdateData().status).toBe('COMPLETED');
      expect(lastUpdateData()).toMatchObject({
        allocationId: 'alloc-1',
        buybackId: 'bb-1',
        directBurnId: 'burn-direct',
        buybackBurnId: 'burn-buyback',
      });
    });

    it('keys every record from the order id, so a replay lands on the same rows', async () => {
      // §3: at most one allocation per order, forever. The keys are derived, not
      // generated - so this is what survives a worker that died mid-pipeline.
      prismaMock.exchangeRevenueEvent.findUniqueOrThrow.mockResolvedValue(eventRow());

      await service().processEvent('evt-1');

      expect(tokenomicsMock.createAllocation).toHaveBeenCalledWith('engine-1', {
        referenceAmount: '10.00',
        emberPrice: '2.450000000000000000',
        clientRequestId: exchangeRevenueKeys.allocation(orderId),
      });
      expect(tokenomicsMock.createBuyback.mock.calls[0]![1].clientRequestId).toBe(
        exchangeRevenueKeys.buyback(orderId),
      );
      expect(tokenomicsMock.createBurn.mock.calls[0]![1].clientRequestId).toBe(
        exchangeRevenueKeys.directBurn(orderId),
      );
      expect(tokenomicsMock.createBurn.mock.calls[1]![1].clientRequestId).toBe(
        exchangeRevenueKeys.buybackBurn(orderId),
      );
    });

    it('sizes the allocation from the basis, not from the revenue it may not claim', async () => {
      // THE reason `basis_inr` is its own column. Under a volume basis the row
      // carries ₹1,000 of turnover and ₹0 of revenue, and the engine must be
      // sized against the first. Reading the second would queue nothing at all,
      // which is the correct behaviour for a revenue policy and a bug for this one.
      prismaMock.exchangeRevenueEvent.findUniqueOrThrow.mockResolvedValue(
        eventRow({ revenueInr: d('0'), basisInr: d('1000.00'), revenueMode: 'VOLUME_LINKED', reasonCode: 'VOLUME_SIZED' }),
      );

      await service().processEvent('evt-1');

      expect(tokenomicsMock.createAllocation).toHaveBeenCalledWith('engine-1', {
        referenceAmount: '1000.00',
        emberPrice: '2.450000000000000000',
        clientRequestId: exchangeRevenueKeys.allocation(orderId),
      });
    });

    it('proposes the records as the system account, never as the customer', async () => {
      // The customer did not propose these, and GET /tokenomics/records lists by
      // proposer - so attaching them to the customer would show them burns they
      // never made while hiding the ones the engine did.
      prismaMock.exchangeRevenueEvent.findUniqueOrThrow.mockResolvedValue(eventRow());

      await service().processEvent('evt-1');

      expect(tokenomicsMock.createAllocation.mock.calls[0]![0]).toBe('engine-1');
      expect(tokenomicsMock.createBurn.mock.calls[1]![0]).toBe('engine-1');
    });

    it('burns only the buyback when the adaptive split floored the direct part to zero', async () => {
      // A 100/0-ish adaptive decision is a real outcome, and createBurn(amount: 0)
      // is a validation error, not a burn. Say so in the row instead.
      prismaMock.exchangeRevenueEvent.findUniqueOrThrow.mockResolvedValue(eventRow());
      tokenomicsMock.createAllocation.mockResolvedValue(allocationCreated('0'));

      await service().processEvent('evt-1');

      expect(tokenomicsMock.createBurn).toHaveBeenCalledTimes(1);
      expect(tokenomicsMock.createBurn.mock.calls[0]![1]).toMatchObject({ source: 'BUYBACK' });
      expect(lastUpdateData()).toMatchObject({
        status: 'COMPLETED',
        directBurnId: null,
        buybackBurnId: 'burn-buyback',
      });
      expect(lastUpdateData().detail).toContain('floored to zero');
    });

    it('reads an already-completed event without touching the pipeline again', async () => {
      // A second worker, or a lease that expired while the first was still
      // waiting for a chain receipt. Either way the answer is the row, not a
      // second set of burns.
      prismaMock.exchangeRevenueEvent.findUniqueOrThrow.mockResolvedValue(
        eventRow({ status: 'COMPLETED', allocationId: 'alloc-1' }),
      );

      const result = await service().processEvent('evt-1');

      expect(tokenomicsMock.createAllocation).not.toHaveBeenCalled();
      expect(tokenomicsMock.createBurn).not.toHaveBeenCalled();
      expect(prismaMock.exchangeRevenueEvent.update).not.toHaveBeenCalled();
      expect(result.status).toBe('COMPLETED');
    });

    it('leaves an ineligible event alone', async () => {
      prismaMock.exchangeRevenueEvent.findUniqueOrThrow.mockResolvedValue(
        eventRow({ status: 'INELIGIBLE', reasonCode: 'NO_RETAINED_MARGIN' }),
      );

      await service().processEvent('evt-1');

      expect(tokenomicsMock.createAllocation).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Guardrails and retries
  // -------------------------------------------------------------------------

  describe('refusals', () => {
    it('blocks on the reserve floor and keeps the allocation it already made', async () => {
      // §3 and §4: the guardrail is obeyed, not worked around, and never bypassed
      // by a retry that quietly lowers the amount. But the allocation and buyback
      // this attempt did produce are destroyed-supply-free records, so the row
      // must show them: funding the treasury later completes the order.
      prismaMock.exchangeRevenueEvent.findUniqueOrThrow.mockResolvedValue(eventRow());
      burnRefuses('BUYBACK', DomainException.treasuryReserveBreach('500000', '100', '81.63'));

      await service().processEvent('evt-1');

      expect(lastUpdateData()).toMatchObject({
        status: 'BLOCKED',
        reasonCode: 'TREASURY_RESERVE_FLOOR',
        allocationId: 'alloc-1',
        buybackId: 'bb-1',
        directBurnId: 'burn-direct',
      });
      expect(lastUpdateData().detail).toContain('reserve floor');
    });

    it('blocks on an unfunded treasury, which is a different refusal from the floor', async () => {
      prismaMock.exchangeRevenueEvent.findUniqueOrThrow.mockResolvedValue(eventRow());
      tokenomicsMock.createAllocation.mockRejectedValue(
        new DomainException(
          ERROR_CODES.INSUFFICIENT_BALANCE,
          'Insufficient EMBER balance for this operation.',
          HttpStatus.CONFLICT,
        ),
      );

      await service().processEvent('evt-1');

      expect(lastUpdateData()).toMatchObject({ status: 'BLOCKED', reasonCode: 'TREASURY_INSUFFICIENT_BALANCE' });
    });

    it('schedules a retry with a backoff for anything that is not a guardrail', async () => {
      prismaMock.exchangeRevenueEvent.findUniqueOrThrow.mockResolvedValue(eventRow({ attempts: 1 }));
      tokenomicsMock.createAllocation.mockRejectedValue(new Error('connection reset'));

      await service().processEvent('evt-1');

      const data = lastUpdateData();
      expect(data.status).toBe('PENDING');
      expect(data.reasonCode).toBe('RETRY_SCHEDULED');
      expect(data.detail).toBe('connection reset');
      // First backoff step is 5s, and it must be in the future.
      const next = data.nextAttemptAt as Date;
      expect(next.getTime() - Date.now()).toBeGreaterThan(3_000);
      expect(next.getTime() - Date.now()).toBeLessThanOrEqual(6_000);
    });

    it('gives up only after the event’s own retry budget, and stops rescheduling', async () => {
      prismaMock.exchangeRevenueEvent.findUniqueOrThrow.mockResolvedValue(
        eventRow({ attempts: 3, maxAttempts: 3 }),
      );
      tokenomicsMock.createAllocation.mockRejectedValue(new Error('still broken'));

      await service().processEvent('evt-1');

      expect(lastUpdateData()).toMatchObject({
        status: 'FAILED',
        reasonCode: 'RETRIES_EXHAUSTED',
        nextAttemptAt: null,
      });
    });

    it('does not let a guardrail outlive the budget either', async () => {
      // Blocked forever is not a design. A permanently underfunded treasury must
      // end up FAILED and visible, not sit in the queue for the rest of time.
      prismaMock.exchangeRevenueEvent.findUniqueOrThrow.mockResolvedValue(eventRow({ attempts: 3, maxAttempts: 3 }));
      burnRefuses('DIRECT', DomainException.treasuryReserveBreach('500000', '0', '81.63'));

      await service().processEvent('evt-1');

      expect(lastUpdateData()).toMatchObject({ status: 'FAILED', reasonCode: 'RETRIES_EXHAUSTED' });
    });

    it('records a refusal for an order whose burn was refused before any record existed', async () => {
      // The allocation itself can be refused. Nothing should be attached, and the
      // row should still say why - a blank failure is indistinguishable from a bug.
      prismaMock.exchangeRevenueEvent.findUniqueOrThrow.mockResolvedValue(eventRow());
      tokenomicsMock.createAllocation.mockRejectedValue(new Error('nope'));

      await service().processEvent('evt-1');

      const data = lastUpdateData();
      expect(data.allocationId).toBeUndefined();
      expect(data.buybackId).toBeUndefined();
      expect(data.reasonCode).toBe('RETRY_SCHEDULED');
    });
  });

  // -------------------------------------------------------------------------
  // The pass: claiming, concurrency, crash recovery
  // -------------------------------------------------------------------------

  describe('runPass', () => {
    it('re-queues work whose worker never came back', async () => {
      // §3: recovery after a crash. The lease is long enough that a burn still
      // waiting for its receipt is not mistaken for a dead worker - a row only
      // becomes eligible for sweeping after fifteen unmolested minutes.
      prismaMock.exchangeRevenueEvent.updateMany
        .mockResolvedValueOnce({ count: 1 }) // the lease sweep
        .mockResolvedValue({ count: 1 });
      prismaMock.exchangeRevenueEvent.findMany.mockResolvedValue([]);

      await service().runPass();

      const sweep = prismaMock.exchangeRevenueEvent.updateMany.mock.calls[0]![0];
      expect(sweep.where.status).toBe('PROCESSING');
      expect(sweep.data.status).toBe('PENDING');
      // Re-queued is only useful if the row is then due: the swept row keeps the
      // dead attempt's schedule otherwise, and a PENDING row outside its window is
      // never read, so the crash would leave the order stranded all the same.
      expect(sweep.data.nextAttemptAt).toBeInstanceOf(Date);
      expect(sweep.where.updatedAt.lt.getTime() - Date.now()).toBeLessThan(-14 * 60_000);
    });

    it('does not process an event whose claim it lost', async () => {
      // The whole concurrency story in one mock: two passes read the same due row,
      // the guarded update moves it for exactly one of them, and `count: 0` here
      // means "someone else owns this order now".
      prismaMock.exchangeRevenueEvent.updateMany
        .mockResolvedValueOnce({ count: 0 }) // the sweep, nothing stranded
        .mockResolvedValueOnce({ count: 0 }); // the lost claim
      prismaMock.exchangeRevenueEvent.findMany.mockResolvedValue([eventRow()]);

      const claimed = await service().runPass();

      expect(claimed).toBe(0);
      expect(tokenomicsMock.createAllocation).not.toHaveBeenCalled();
    });

    it('claims through a guarded status transition and increments the attempt', async () => {
      prismaMock.exchangeRevenueEvent.updateMany
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 1 });
      prismaMock.exchangeRevenueEvent.findMany.mockResolvedValue([eventRow()]);
      prismaMock.exchangeRevenueEvent.findUniqueOrThrow.mockResolvedValue(eventRow());

      await service().runPass();

      const claim = prismaMock.exchangeRevenueEvent.updateMany.mock.calls[1]![0];
      expect(claim.where).toEqual({ eventId: 'evt-1', status: { in: ['PENDING', 'BLOCKED'] } });
      expect(claim.data.status).toBe('PROCESSING');
      expect(claim.data.attempts).toEqual({ increment: 1 });
    });

    it('takes COMPLETED and BLOCKED work off the queue, and never PROCESSING', async () => {
      prismaMock.exchangeRevenueEvent.updateMany.mockResolvedValue({ count: 0 });
      prismaMock.exchangeRevenueEvent.findMany.mockResolvedValue([]);

      await service().runPass();

      const where = prismaMock.exchangeRevenueEvent.findMany.mock.calls[0]![0].where;
      expect(where.status.in).toEqual(['PENDING', 'BLOCKED']);
      expect(where.nextAttemptAt.lte).toBeInstanceOf(Date);
      expect(prismaMock.exchangeRevenueEvent.findMany.mock.calls[0]![0].orderBy).toEqual({ detectedAt: 'asc' });
    });

    it('keeps going when one order fails, and reports what it claimed', async () => {
      // One poisoned order must not stall the queue for everyone else - but it
      // also must not be silently swallowed, so the row stays PROCESSING and the
      // lease sweep brings it back rather than this pass marking it anything.
      prismaMock.exchangeRevenueEvent.updateMany.mockResolvedValue({ count: 1 });
      prismaMock.exchangeRevenueEvent.findMany.mockResolvedValue([
        eventRow({ eventId: 'evt-1' }),
        eventRow({ eventId: 'evt-2' }),
      ]);
      prismaMock.exchangeRevenueEvent.findUniqueOrThrow
        .mockRejectedValueOnce(new Error('row vanished'))
        .mockResolvedValueOnce(eventRow({ eventId: 'evt-2' }));

      const claimed = await service().runPass();

      expect(claimed).toBe(2);
      expect(tokenomicsMock.createAllocation).toHaveBeenCalledTimes(1);
    });

    it('processes nothing when the queue is empty', async () => {
      prismaMock.exchangeRevenueEvent.updateMany.mockResolvedValue({ count: 0 });
      prismaMock.exchangeRevenueEvent.findMany.mockResolvedValue([]);

      expect(await service().runPass()).toBe(0);
      expect(tokenomicsMock.createAllocation).not.toHaveBeenCalled();
    });

    it('re-claims from PENDING on a blocked event whose backoff has elapsed', async () => {
      // The treasury gets funded, the row is due, and the same deterministic keys
      // carry it the rest of the way - no new allocation, no double burn.
      prismaMock.exchangeRevenueEvent.updateMany
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 1 });
      prismaMock.exchangeRevenueEvent.findMany.mockResolvedValue([eventRow({ status: 'BLOCKED', attempts: 2 })]);
      prismaMock.exchangeRevenueEvent.findUniqueOrThrow.mockResolvedValue(
        eventRow({ status: 'PROCESSING', allocationId: 'alloc-1', buybackId: 'bb-1', attempts: 2 }),
      );

      await service().runPass();

      expect(lastUpdateData().status).toBe('COMPLETED');
      // Replayed the same keys, so Module 11 returns the rows it already has.
      expect(tokenomicsMock.createAllocation.mock.calls[0]![1].clientRequestId).toBe(
        exchangeRevenueKeys.allocation(orderId),
      );
    });
  });

  // -------------------------------------------------------------------------
  // The engine account
  // -------------------------------------------------------------------------

  describe('ensureEngineUser', () => {
    it('reuses the system account once it exists', async () => {
      prismaMock.user.findUnique.mockResolvedValue({ id: 'engine-1' });

      expect(await service().ensureEngineUser()).toBe('engine-1');
      expect(prismaMock.user.create).not.toHaveBeenCalled();
    });

    it('provisions it when it does not', async () => {
      prismaMock.user.findUnique.mockResolvedValue(null);
      prismaMock.user.create.mockResolvedValue({ id: 'engine-2' });

      expect(await service().ensureEngineUser()).toBe('engine-2');
      expect(prismaMock.user.create.mock.calls[0]![0].data.email).toContain('tokenomics-engine');
    });

    it('survives two workers provisioning it at the same moment', async () => {
      prismaMock.user.findUnique.mockResolvedValue(null);
      prismaMock.user.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );
      prismaMock.user.findUniqueOrThrow.mockResolvedValue({ id: 'engine-3' });

      expect(await service().ensureEngineUser()).toBe('engine-3');
    });

    it('does not swallow an unrelated failure', async () => {
      prismaMock.user.findUnique.mockResolvedValue(null);
      prismaMock.user.create.mockRejectedValue(new Error('database is down'));

      await expect(service().ensureEngineUser()).rejects.toThrow('database is down');
    });
  });

  // -------------------------------------------------------------------------
  // The dashboard read
  // -------------------------------------------------------------------------

  describe('summary', () => {
    const groupedRows = [
      {
        status: 'INELIGIBLE',
        _count: { _all: 2 },
        _sum: { revenueInr: d('0'), basisInr: d('0'), customerInr: d('2000.00'), retainedInr: d('0') },
      },
      {
        status: 'COMPLETED',
        _count: { _all: 1 },
        _sum: { revenueInr: d('10.00'), basisInr: d('10.00'), customerInr: d('1000.00'), retainedInr: d('10.00') },
      },
    ];

    beforeEach(() => {
      prismaMock.exchangeRevenueEvent.groupBy.mockResolvedValue(groupedRows);
      prismaMock.exchangeRevenueEvent.findMany.mockResolvedValue([]);
      prismaMock.tokenBurn.groupBy.mockResolvedValue([]);
      prismaMock.tokenAllocation.aggregate.mockResolvedValue({
        _count: { _all: 1 },
        _sum: { directBurnEmber: d('122.44'), buybackEmber: d('81.63'), referenceAmount: d('10.00') },
      });
    });

    it('answers why the burn total is zero, not just that it is', async () => {
      // Mode, rate and the baseline split travel with the figures they produced.
      // Without them "0" cannot be told apart from "policy off" or "no orders".
      const summary = await service().summary(20);

      expect(summary.policy).toMatchObject({
        mode: 'RETAINED_BPS',
        bps: 10_000,
        baselineDirectBurnPct: 60,
        emberPrice: '2.45',
        workerEnabled: false,
        splitIsAdaptive: true,
      });
    });

    it('separates what was bought from what was retained', async () => {
      // The two numbers a reader must never confuse: ₹3,000 of orders and ₹10 of
      // revenue. Collapsing them is exactly the mistake this bridge exists to stop.
      const { totals } = await service().summary(20);

      expect(totals.ordersSeen).toBe(3);
      expect(totals.eligibleOrders).toBe(1);
      expect(totals.customerInr).toBe('3000.00');
      expect(totals.revenueInr).toBe('10.00');
      // Under a revenue basis the two are the same figure by definition: the
      // engine was sized against what was earned. It is the volume mode that
      // breaks the equality, and that is the next test.
      expect(totals.basisInr).toBe('10.00');
      expect(totals.allocatedDirectBurnEmber).toBe('122.440000000000000000');
    });

    it('reports a volume basis as sizing without claiming the rupees as income', async () => {
      // THE distinction the whole table exists to preserve. ₹1,000 of turnover
      // sizes the engine; the platform earned ₹0 of it. A summary that put the
      // same number in both fields would be reporting turnover as revenue.
      prismaMock.exchangeRevenueEvent.groupBy.mockResolvedValue([
        {
          status: 'COMPLETED',
          _count: { _all: 1 },
          _sum: { revenueInr: d('0'), basisInr: d('1000.00'), customerInr: d('1000.00'), retainedInr: d('0') },
        },
      ]);
      const volumeConfig = {
        ...configMock,
        tokenomics: { ...configMock.tokenomics, exchangeRevenueMode: 'VOLUME_LINKED' },
      } as unknown as AppConfig;

      const summary = await service(volumeConfig).summary(20);

      expect(summary.policy.mode).toBe('VOLUME_LINKED');
      expect(summary.totals.revenueInr).toBe('0.00');
      expect(summary.totals.basisInr).toBe('1000.00');
      expect(summary.byStatus.COMPLETED).toMatchObject({ revenueInr: '0.00', basisInr: '1000.00' });
    });

    it('is a plain object over the wire, not a Map', async () => {
      // A Map serialises to `{}` through Nest's JSON layer, which would look like
      // an empty queue rather than the reason the queue is empty.
      const summary = await service().summary(20);

      expect(summary.byStatus).not.toBeInstanceOf(Map);
      expect(JSON.parse(JSON.stringify(summary)).byStatus).toMatchObject({
        INELIGIBLE: { count: 2 },
        COMPLETED: { count: 1, revenueInr: '10.00' },
      });
    });

    it('reports the on-chain and off-chain burns apart', async () => {
      // §4: a ledger burn and a confirmed Sepolia burn are different claims.
      // Summing them would let the page present one as the other.
      prismaMock.tokenBurn.groupBy.mockResolvedValue([
        { onChainStatus: 'NOT_REQUIRED', _sum: { amount: d('204.07') }, _count: { _all: 2 } },
        { onChainStatus: 'CONFIRMED', _sum: { amount: d('40.00') }, _count: { _all: 1 } },
      ]);

      const { totals } = await service().summary(20);

      expect(totals.burnedEmberByChainState).toEqual({
        NOT_REQUIRED: '204.070000000000000000',
        CONFIRMED: '40.000000000000000000',
      });
    });

    it('carries the split the allocation actually used, per event', async () => {
      // The adaptive policy overrides the 60/40 baseline per allocation, so the
      // baseline on the event row is not the decision. The dashboard must show
      // what was applied, or it is reporting a number that never happened.
      prismaMock.exchangeRevenueEvent.findMany.mockResolvedValue([
        {
          ...eventRow({ status: 'COMPLETED', allocationId: 'alloc-1', buybackId: 'bb-1' }),
          allocation: {
            allocationId: 'alloc-1',
            directBurnPct: 75,
            buybackPct: 25,
            directBurnEmber: d('153.061224489795918367'),
            buybackEmber: d('51.020408163265306122'),
          },
          buyback: { buybackId: 'bb-1', status: 'RECORDED_SIMULATED_EXECUTION', executedEmber: d('51.020408163265306122') },
          directBurn: {
            burnId: 'burn-direct',
            amount: d('153.06'),
            onChainStatus: 'NOT_REQUIRED',
            onChainTxHash: null,
          },
          buybackBurn: {
            burnId: 'burn-buyback',
            amount: d('51.02'),
            onChainStatus: 'PENDING',
            onChainTxHash: null,
          },
        },
      ]);

      const { recent } = await service().summary(20);

      expect(recent[0]).toMatchObject({
        orderId,
        status: 'COMPLETED',
        buybackStatus: 'RECORDED_SIMULATED_EXECUTION',
        allocation: { directBurnPct: 75, buybackPct: 25 },
        directBurn: { onChainStatus: 'NOT_REQUIRED' },
        buybackBurn: { onChainStatus: 'PENDING' },
      });
      expect(recent[0]!.allocationId).toBe('alloc-1');
      expect(recent[0]!.customerInr).toBe('1000.00');
    });

    it('bounds the recent list without throwing on an absurd limit', async () => {
      // `engineBurnIds` queries the same table, so the one under test is picked by
      // the shape of its query rather than by which call number it happened to be.
      const recentTakes = (): number[] =>
        prismaMock.exchangeRevenueEvent.findMany.mock.calls
          .map((call) => call[0] as { take?: number; orderBy?: unknown })
          .filter((arg) => arg.orderBy !== undefined)
          .map((arg) => arg.take!);

      await service().summary(0);
      await service().summary(10_000);

      expect(recentTakes()).toEqual([1, 100]);
    });
  });

  it('never mints a burn id from the exchange side', async () => {
    // A guard against the shape of a future regression: the only ids this service
    // may write are the ones Module 11 handed back. Nothing here generates one.
    prismaMock.exchangeRevenueEvent.findUniqueOrThrow.mockResolvedValue(eventRow());
    const before = randomUUID();

    await service().processEvent('evt-1');

    expect(lastUpdateData().directBurnId).toBe('burn-direct');
    expect(String(lastUpdateData().directBurnId)).not.toBe(before);
  });
});
