import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, type ExchangeRevenueEvent, type ExchangeRevenueStatus } from '@prisma/client';

import { ERROR_CODES } from '../../common/constants/error-codes';
import { DomainException } from '../../common/errors/domain.exception';
import { APP_CONFIG, type AppConfig, type ExchangeRevenueMode } from '../../config/config.module';
import { PrismaService } from '../../database/prisma.service';
import {
  decideExchangeRevenue,
  exchangeRevenueKeys,
  nextAttemptDelayMs,
  type ExchangeRevenueDecision,
} from './domain/exchange-revenue';
import { EMBER_DECIMALS, INR_DECIMALS } from './domain/allocation-math';
import { formatDecimal } from '../wallet/decimal.util';
import { TokenomicsService } from './tokenomics.service';

/** Rows one pass will claim. Beyond this the backlog simply waits for the next tick. */
const PASS_BATCH_SIZE = 25;

/**
 * How long a PROCESSING row may be held before a later pass assumes its worker
 * died and re-queues it. Deliberately far longer than the pipeline can run: a
 * burn waits up to `BLOCKCHAIN_RECEIPT_TIMEOUT_MS` for its receipt, twice, so a
 * sweep that fires sooner would re-queue work that is still legitimately in
 * flight and make two workers chase the same order.
 */
const PROCESSING_LEASE_MS = 15 * 60_000;

/** The system account that proposes exchange-funded tokenomics records. */
const ENGINE_EMAIL = 'tokenomics-engine@prometheus.local';

/**
 * What `UsdtService.place` hands over from inside its own transaction.
 *
 * `lpInrSettled` and `lpBacked` come from the allocation outcome the settlement
 * just produced, which is the only place the truth about LP credits exists. They
 * are passed in rather than re-read because the rows they describe are not
 * visible to a separate query inside the same transaction.
 */
export interface ExchangeRevenueSettlement {
  readonly orderId: string;
  readonly userId: string;
  readonly side: 'BUY' | 'SELL';
  readonly usdtAmount: Prisma.Decimal;
  readonly customerInr: Prisma.Decimal;
  readonly lpInrSettled: Prisma.Decimal;
  readonly lpBacked: boolean;
}

/**
 * MODULE 08 x MODULE 11 — the bridge between settled exchange orders and the
 * burn/buyback engine.
 *
 * WHY AN OUTBOX
 * -------------
 * A USDT settlement is one database transaction that must stay atomic: customer
 * legs, LP legs and the order row commit together or not at all. The tokenomics
 * pipeline it feeds is four separate transactions — allocation, buyback,
 * execution, and up to two burns, each of which may take a minute waiting for a
 * chain receipt. Running that inside the settlement would hold the customer's
 * money hostage to a blockchain, and failing halfway would roll back a trade
 * that had already happened.
 *
 * So the settlement writes one row saying what it did, and this service works
 * the queue afterwards. That is the whole justification for the table: it is the
 * only way to make "the order settled" and "the tokenomics ran" two durable
 * facts with a recoverable gap between them.
 *
 * THE ROW IS WRITTEN INSIDE THE SETTLEMENT TRANSACTION
 * ---------------------------------------------------
 * Not after it. A BUY that is refused, fails pricing, runs short of liquidity or
 * rolls back never reaches this table at all, so "failed orders must not create
 * allocations" is enforced by the same commit that moves the money rather than by
 * a check that could be wrong.
 *
 * IDEMPOTENCY IS STRUCTURAL, NOT LUCKY
 * ------------------------------------
 * Three independent layers, each sufficient alone:
 *   1. `exchange_revenue_events.order_id` is UNIQUE — one order, one event.
 *   2. Every tokenomics call is keyed by a UUID *derived from the order id*
 *      (`exchangeRevenueKeys`), so a replayed pipeline gets the original
 *      allocation, buyback and burns back rather than creating new ones.
 *   3. The database constraints Module 11 already owns — one buyback per
 *      allocation, one burn per buyback — hold even across different callers.
 *
 * A CRASH IS A NON-EVENT
 * ----------------------
 * The pipeline is re-runnable from any point: each step either did its work or
 * returns the row that did. A worker that dies after the allocation committed
 * resumes by replaying the same key, reaching the buyback, and continuing. Rows
 * left PROCESSING by a dead worker are re-queued once their lease expires, so no
 * order is ever silently stranded.
 *
 * GUARDRAILS ARE OBEYED, NEVER WORKED AROUND
 * ------------------------------------------
 * When Module 12's reserve floor or the treasury's available balance refuses a
 * burn, the event goes to BLOCKED with the guardrail's own sentence attached, and
 * is retried on the backoff schedule until the retry budget runs out. The
 * allocation, buyback and execution stay recorded — they destroy no supply — so
 * funding the treasury later completes the order's effect rather than restarting
 * it.
 */
@Injectable()
export class ExchangeRevenueService {
  private readonly logger = new Logger(ExchangeRevenueService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly tokenomics: TokenomicsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Detection - runs inside the caller's settlement transaction
  // ---------------------------------------------------------------------------

  /**
   * Records what the settlement did and decides whether any of it is revenue.
   *
   * Takes `tx` so the row commits with the order or not at all. Returns the
   * decision for the caller's response; never throws for a business reason,
   * because an order that settled successfully must not be reported as failed
   * because of what the tokenomics policy made of it.
   */
  async recordSettlement(
    tx: Prisma.TransactionClient,
    settlement: ExchangeRevenueSettlement,
  ): Promise<ExchangeRevenueDecision> {
    const decision = this.decide(settlement);

    const emberPrice = new Prisma.Decimal(this.config.emberHub.baselinePriceInr);

    await tx.exchangeRevenueEvent.create({
      data: {
        eventId: randomUUID(),
        orderId: settlement.orderId,
        userId: settlement.userId,
        side: settlement.side,
        usdtAmount: settlement.usdtAmount,
        customerInr: settlement.customerInr,
        lpInrSettled: settlement.lpInrSettled,
        retainedInr: decision.retainedInr,
        revenueMode: this.config.tokenomics.exchangeRevenueMode,
        revenueBps: this.config.tokenomics.exchangeRevenueBps,
        revenueInr: decision.revenueInr,
        basisInr: decision.basisInr,
        emberPrice,
        directBurnPct: this.config.tokenomics.directBurnPct,
        buybackPct: this.config.tokenomics.buybackPct,
        status: decision.eligible ? 'PENDING' : 'INELIGIBLE',
        reasonCode: decision.reasonCode,
        detail: decision.detail,
        maxAttempts: this.config.tokenomics.exchangeRevenueMaxAttempts,
        nextAttemptAt: decision.eligible ? new Date() : null,
      },
    });

    return decision;
  }

  /**
   * The policy call, made safe for a settlement transaction.
   *
   * `decideExchangeRevenue` is pure and should not throw, but it runs on the
   * inside of a customer's trade: a defect here must cost them an unattributed
   * order they can see on the dashboard, not a failed purchase. Ineligible is
   * also the conservative direction, because the failure mode being guarded is
   * "burn EMBER we have no revenue against".
   */
  private decide(settlement: ExchangeRevenueSettlement): ExchangeRevenueDecision {
    try {
      return decideExchangeRevenue(
        { mode: this.config.tokenomics.exchangeRevenueMode, bps: this.config.tokenomics.exchangeRevenueBps },
        settlement,
      );
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message.slice(0, 400) : 'the revenue policy threw';
      this.logger.error(`Exchange revenue policy failed for order ${settlement.orderId}: ${detail}`);
      return {
        eligible: false,
        revenueInr: new Prisma.Decimal(0),
        basisInr: new Prisma.Decimal(0),
        retainedInr: new Prisma.Decimal(0),
        reasonCode: 'POLICY_ERROR',
        detail,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // The pass
  // ---------------------------------------------------------------------------

  /**
   * One pass over the queue: reclaim anything a dead worker left, then run every
   * due event. Returns how many events were claimed, for the worker's log line.
   */
  async runPass(): Promise<number> {
    const now = new Date();

    const stranded = await this.prisma.exchangeRevenueEvent.updateMany({
      where: { status: 'PROCESSING', updatedAt: { lt: new Date(now.getTime() - PROCESSING_LEASE_MS) } },
      // Re-arming `nextAttemptAt` is part of the rescue, not a courtesy. The row
      // the dead worker left may hold the backoff time of the attempt that
      // claimed it, or none at all, and a PENDING row outside its due window is
      // never read - so without this the sweep would move the status and still
      // strand the order forever.
      data: { status: 'PENDING', nextAttemptAt: now, updatedAt: now },
    });
    if (stranded.count > 0) {
      this.logger.warn(`Re-queued ${stranded.count} exchange revenue event(s) whose worker never finished.`);
    }

    const due = await this.prisma.exchangeRevenueEvent.findMany({
      where: { status: { in: ['PENDING', 'BLOCKED'] }, nextAttemptAt: { lte: now } },
      orderBy: { detectedAt: 'asc' },
      take: PASS_BATCH_SIZE,
    });

    let claimed = 0;
    for (const event of due) {
      if (!(await this.claim(event.eventId, now))) continue;
      claimed += 1;
      try {
        await this.processEvent(event.eventId);
      } catch (error: unknown) {
        // processEvent reschedules its own guardrail refusals; reaching here
        // means something unexpected threw, and the lease sweep will bring the
        // row back. Logging is the honest response - not a rethrow that would
        // abandon the pass mid-batch.
        this.logger.error(
          `Exchange revenue event ${event.eventId} failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return claimed;
  }

  /**
   * The lock. A guarded status transition is the whole concurrency control: two
   * passes that read the same due row both try this, exactly one moves it, and
   * the loser sees `count === 0` and moves on.
   */
  private async claim(eventId: string, now: Date): Promise<boolean> {
    const claimed = await this.prisma.exchangeRevenueEvent.updateMany({
      where: { eventId, status: { in: ['PENDING', 'BLOCKED'] } },
      data: { status: 'PROCESSING', attempts: { increment: 1 }, updatedAt: now },
    });
    return claimed.count === 1;
  }

  /**
   * Drives one order through the existing Module 11 pipeline.
   *
   * Every step is a replay of a call an operator could make by hand, with a key
   * derived from the order id, so this method can run as many times as anything
   * goes wrong and still produce exactly one allocation, one buyback and one
   * burn per portion.
   */
  async processEvent(eventId: string): Promise<ExchangeRevenueEvent> {
    const event = await this.prisma.exchangeRevenueEvent.findUniqueOrThrow({ where: { eventId } });

    if (event.status === 'COMPLETED' || event.status === 'INELIGIBLE') {
      return event;
    }

    const engineUserId = await this.ensureEngineUser();
    // EMBER at the token's own scale, rupees at the paisa. Module 11 validates the
    // scale it is handed, so this is also the step that must not quietly widen it.
    const emberPrice = ember(event.emberPrice);

    // Each id is recorded as its step succeeds, including on the path that then
    // fails. A burn blocked by the reserve floor has still produced a real
    // allocation and buyback, and the dashboard needs to say so rather than show
    // an order with nothing attached to it.
    const reached: Partial<Record<'allocationId' | 'buybackId' | 'directBurnId' | 'buybackBurnId', string>> = {};

    try {
      // Sized from `basisInr`, never from `revenueInr`. Under a revenue basis the
      // two are the same number, so this changes nothing; under a volume basis
      // only the basis is non-zero, and the allocation's reference amount is
      // exactly what its name says - the INR this record was measured against.
      // Nothing here moves a rupee: what follows converts that measure into
      // EMBER and asks the treasury to destroy some of what it already holds.
      const { allocation } = await this.tokenomics.createAllocation(engineUserId, {
        referenceAmount: inr(event.basisInr),
        emberPrice,
        clientRequestId: exchangeRevenueKeys.allocation(event.orderId),
      });
      reached.allocationId = allocation.allocationId;

      const { buyback } = await this.tokenomics.createBuyback(engineUserId, {
        allocationId: allocation.allocationId,
        clientRequestId: exchangeRevenueKeys.buyback(event.orderId),
      });
      reached.buybackId = buyback.buybackId;

      // The execution is recorded at the same configured distribution price the
      // quantities were derived at. It is a recorded simulated execution, not a
      // market order: no EMBER was bought from anywhere, and nothing here says
      // it was.
      await this.tokenomics.executeBuyback(engineUserId, buyback.buybackId, { executedPrice: emberPrice });

      const directBurn = allocation.directBurnEmber.gt(0)
        ? await this.tokenomics.createBurn(engineUserId, {
            source: 'DIRECT',
            amount: ember(allocation.directBurnEmber),
            clientRequestId: exchangeRevenueKeys.directBurn(event.orderId),
          })
        : null;
      if (directBurn) reached.directBurnId = directBurn.burn.burnId;

      const buybackBurn = await this.tokenomics.createBurn(engineUserId, {
        source: 'BUYBACK',
        buybackId: buyback.buybackId,
        clientRequestId: exchangeRevenueKeys.buybackBurn(event.orderId),
      });
      reached.buybackBurnId = buybackBurn.burn.burnId;

      return await this.prisma.exchangeRevenueEvent.update({
        where: { eventId },
        data: {
          status: 'COMPLETED',
          reasonCode: 'PIPELINE_COMPLETED',
          detail: directBurn === null
            ? 'The direct portion floored to zero EMBER at this price, so only the buyback was burned.'
            : null,
          allocationId: allocation.allocationId,
          buybackId: buyback.buybackId,
          directBurnId: directBurn?.burn.burnId ?? null,
          buybackBurnId: buybackBurn.burn.burnId,
          processedAt: new Date(),
        },
      });
    } catch (error: unknown) {
      return await this.reschedule(event, error, reached);
    }
  }

  /**
   * A refusal is a state of the world, not a bug. Treasury guardrails are
   * recorded as BLOCKED with the guardrail's own sentence and retried; anything
   * else is retried as a transient failure until the budget runs out.
   *
   * Whatever the pipeline had already produced is written with the refusal. The
   * allocation, buyback and execution destroy no supply, so a blocked burn is an
   * order half-done in the safe direction - and funding the treasury later
   * completes it rather than restarting it.
   */
  private async reschedule(
    event: ExchangeRevenueEvent,
    error: unknown,
    reached: Partial<Record<'allocationId' | 'buybackId' | 'directBurnId' | 'buybackBurnId', string>>,
  ): Promise<ExchangeRevenueEvent> {
    const guardrail = error instanceof DomainException ? guardrailReason(error.code) : null;
    const attempts = event.attempts; // already incremented by the claim
    const exhausted = attempts >= event.maxAttempts;

    const detail = error instanceof Error ? error.message.slice(0, 400) : 'the processing attempt failed';

    return await this.prisma.exchangeRevenueEvent.update({
      where: { eventId: event.eventId },
      data: {
        status: exhausted ? 'FAILED' : guardrail !== null ? 'BLOCKED' : 'PENDING',
        reasonCode: exhausted ? 'RETRIES_EXHAUSTED' : guardrail ?? 'RETRY_SCHEDULED',
        detail,
        // `undefined` leaves a column alone, so a step this attempt did not reach
        // keeps whatever an earlier attempt already recorded for it.
        allocationId: reached.allocationId,
        buybackId: reached.buybackId,
        directBurnId: reached.directBurnId,
        buybackBurnId: reached.buybackBurnId,
        // A blocked or retried row keeps whatever allocation it already made;
        // the keys are deterministic, so the next attempt re-runs the whole
        // sequence and lands on the same records.
        nextAttemptAt: exhausted ? null : new Date(Date.now() + nextAttemptDelayMs(attempts)),
      },
    });
  }

  /**
   * The system account that owns exchange-funded records.
   *
   * Auto-provisioned exactly as Module 11 provisions the treasury, for the same
   * reason: there is no seed step to forget and no HTTP surface that could
   * create it. A customer must not own the allocation their order funded — they
   * did not propose it, and `GET /tokenomics/records` lists records by proposer.
   */
  async ensureEngineUser(): Promise<string> {
    const existing = await this.prisma.user.findUnique({ where: { email: ENGINE_EMAIL }, select: { id: true } });
    if (existing) return existing.id;

    try {
      return (await this.prisma.user.create({ data: { email: ENGINE_EMAIL } })).id;
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return (await this.prisma.user.findUniqueOrThrow({ where: { email: ENGINE_EMAIL }, select: { id: true } })).id;
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /**
   * The dashboard's view of the integration: what the exchange produced, what
   * reached tokenomics, and what is still waiting.
   *
   * `burnedEmber` is split by on-chain state rather than summed into one number,
   * because an off-chain ledger burn and a confirmed Sepolia burn are different
   * claims and the page must not be able to present one as the other.
   */
  async summary(limit: number): Promise<ExchangeRevenueSummary> {
    const [grouped, recent, burnStates, allocated] = await Promise.all([
      this.prisma.exchangeRevenueEvent.groupBy({
        by: ['status'],
        _count: { _all: true },
        _sum: { revenueInr: true, customerInr: true, retainedInr: true, basisInr: true },
      }),
      this.prisma.exchangeRevenueEvent.findMany({
        orderBy: { detectedAt: 'desc' },
        take: Math.min(Math.max(limit, 1), 100),
        include: {
          allocation: {
            select: {
              allocationId: true,
              directBurnPct: true,
              buybackPct: true,
              directBurnEmber: true,
              buybackEmber: true,
            },
          },
          directBurn: { select: { burnId: true, amount: true, onChainStatus: true, onChainTxHash: true } },
          buybackBurn: { select: { burnId: true, amount: true, onChainStatus: true, onChainTxHash: true } },
          buyback: { select: { buybackId: true, status: true, executedEmber: true } },
        },
      }),
      this.prisma.tokenBurn.groupBy({
        by: ['onChainStatus'],
        where: { burnId: { in: await this.engineBurnIds() } },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      // What the exchange-funded allocations promise, as opposed to what has
      // actually been destroyed. These two numbers differ for as long as burns
      // are blocked or the chain is off, and the page must show both.
      this.prisma.tokenAllocation.aggregate({
        where: { revenueEvent: { isNot: null } },
        _sum: { directBurnEmber: true, buybackEmber: true, referenceAmount: true },
        _count: { _all: true },
      }),
    ]);

    // Amounts render through Module 11's own formatter, at the scale that module
    // uses on the wire: INR at 2dp, EMBER at 18. A bare `toFixed()` prints "10"
    // for one order and "10.000000000000000000" for the sum of ten, which no
    // client can parse consistently.
    const byStatus: Record<string, { count: number; revenueInr: string; basisInr: string; customerInr: string }> = {};
    for (const row of grouped) {
      byStatus[row.status] = {
        count: row._count._all,
        revenueInr: inr(row._sum.revenueInr),
        basisInr: inr(row._sum.basisInr),
        customerInr: inr(row._sum.customerInr),
      };
    }

    const totals = {
      ordersSeen: grouped.reduce((sum, row) => sum + row._count._all, 0),
      revenueInr: inr(
        grouped.reduce((sum, row) => sum.plus(row._sum.revenueInr ?? new Prisma.Decimal(0)), new Prisma.Decimal(0)),
      ),
      // The INR the engine was actually sized against. Under a revenue basis this
      // equals `revenueInr`; under a volume basis it is the traded value while
      // `revenueInr` stays zero. Reporting both is what keeps the two claims from
      // being confused on the dashboard.
      basisInr: inr(
        grouped.reduce((sum, row) => sum.plus(row._sum.basisInr ?? new Prisma.Decimal(0)), new Prisma.Decimal(0)),
      ),
      customerInr: inr(
        grouped.reduce((sum, row) => sum.plus(row._sum.customerInr ?? new Prisma.Decimal(0)), new Prisma.Decimal(0)),
      ),
      retainedInr: inr(
        grouped.reduce((sum, row) => sum.plus(row._sum.retainedInr ?? new Prisma.Decimal(0)), new Prisma.Decimal(0)),
      ),
      eligibleOrders: grouped
        .filter((row) => row.status !== 'INELIGIBLE')
        .reduce((sum, row) => sum + row._count._all, 0),
      allocationsRecorded: allocated._count._all,
      allocatedReferenceInr: inr(allocated._sum.referenceAmount),
      allocatedDirectBurnEmber: ember(allocated._sum.directBurnEmber),
      allocatedBuybackEmber: ember(allocated._sum.buybackEmber),
      burnedEmberByChainState: Object.fromEntries(
        burnStates.map((row) => [row.onChainStatus, ember(row._sum.amount)]),
      ),
    };

    // The configuration that produced these numbers, in the same response that
    // reports them. Without it a zero is ambiguous - "no orders yet", "policy
    // off" and "nothing was retained" all look the same on a dashboard.
    const policy = {
      mode: this.config.tokenomics.exchangeRevenueMode,
      bps: this.config.tokenomics.exchangeRevenueBps,
      baselineDirectBurnPct: this.config.tokenomics.directBurnPct,
      baselineBuybackPct: this.config.tokenomics.buybackPct,
      emberPrice: this.config.emberHub.baselinePriceInr,
      workerEnabled: this.config.tokenomics.exchangeRevenueWorkerEnabled,
      // The split actually applied comes from the adaptive policy inside
      // Module 11, so it is read off each allocation row (see `recent`), not here.
      splitIsAdaptive: true,
    };

    return { policy, totals, byStatus, recent: recent.map(toEventView) };
  }

  /** Every burn this integration recorded, for the on-chain/off-chain split. */
  private async engineBurnIds(): Promise<string[]> {
    const rows = await this.prisma.exchangeRevenueEvent.findMany({
      where: { OR: [{ directBurnId: { not: null } }, { buybackBurnId: { not: null } }] },
      select: { directBurnId: true, buybackBurnId: true },
      take: 5_000,
    });

    const ids = new Set<string>();
    for (const row of rows) {
      if (row.directBurnId) ids.add(row.directBurnId);
      if (row.buybackBurnId) ids.add(row.buybackBurnId);
    }
    return [...ids];
  }
}

// ---------------------------------------------------------------------------
// View helpers
// ---------------------------------------------------------------------------

/** The guardrail refusals that mean "retry later", each with its reason code. */
function guardrailReason(code: string): string | null {
  if (code === ERROR_CODES.TREASURY_RESERVE_BREACH) return 'TREASURY_RESERVE_FLOOR';
  if (code === ERROR_CODES.INSUFFICIENT_BALANCE) return 'TREASURY_INSUFFICIENT_BALANCE';
  return null;
}

/** Rupees, at the two-decimal scale every other module puts INR on the wire at. */
function inr(value: Prisma.Decimal | null | undefined): string {
  return formatDecimal(value ?? new Prisma.Decimal(0), INR_DECIMALS);
}

/** EMBER, at the token's own eighteen-decimal display scale. */
function ember(value: Prisma.Decimal | null | undefined): string {
  return formatDecimal(value ?? new Prisma.Decimal(0), EMBER_DECIMALS);
}

export interface ExchangeRevenueEventView {
  eventId: string;
  orderId: string;
  userId: string;
  side: string;
  status: string;
  reasonCode: string;
  detail: string | null;
  customerInr: string;
  lpInrSettled: string;
  retainedInr: string;
  revenueInr: string;
  /** The INR this order sized the engine against. See `ExchangeRevenueSummary`. */
  basisInr: string;
  revenueMode: string;
  revenueBps: number;
  emberPrice: string;
  directBurnPct: number;
  buybackPct: number;
  attempts: number;
  maxAttempts: number;
  detectedAt: string;
  processedAt: string | null;
  allocationId: string | null;
  /**
   * The split Module 11 actually applied to this order's revenue. It is read off
   * the allocation row because the 60/40 baseline is adapted per allocation by
   * treasury health, and the page has to report the decision, not the default.
   * Null until the pipeline reaches the allocation step.
   */
  allocation: {
    allocationId: string;
    directBurnPct: number;
    buybackPct: number;
    directBurnEmber: string;
    buybackEmber: string;
  } | null;
  buybackId: string | null;
  buybackStatus: string | null;
  buybackExecutedEmber: string | null;
  directBurn: { burnId: string; amount: string; onChainStatus: string; onChainTxHash: string | null } | null;
  buybackBurn: { burnId: string; amount: string; onChainStatus: string; onChainTxHash: string | null } | null;
}

function toEventView(event: {
  eventId: string;
  orderId: string;
  userId: string;
  side: string;
  status: string;
  reasonCode: string;
  detail: string | null;
  customerInr: Prisma.Decimal;
  lpInrSettled: Prisma.Decimal;
  retainedInr: Prisma.Decimal;
  revenueInr: Prisma.Decimal;
  basisInr: Prisma.Decimal;
  revenueMode: string;
  revenueBps: number;
  emberPrice: Prisma.Decimal;
  directBurnPct: number;
  buybackPct: number;
  attempts: number;
  maxAttempts: number;
  detectedAt: Date;
  processedAt: Date | null;
  allocationId: string | null;
  allocation: {
    allocationId: string;
    directBurnPct: number;
    buybackPct: number;
    directBurnEmber: Prisma.Decimal;
    buybackEmber: Prisma.Decimal;
  } | null;
  buybackId: string | null;
  buyback: { buybackId: string; status: string; executedEmber: Prisma.Decimal | null } | null;
  directBurn: { burnId: string; amount: Prisma.Decimal; onChainStatus: string; onChainTxHash: string | null } | null;
  buybackBurn: { burnId: string; amount: Prisma.Decimal; onChainStatus: string; onChainTxHash: string | null } | null;
}): ExchangeRevenueEventView {
  return {
    eventId: event.eventId,
    orderId: event.orderId,
    userId: event.userId,
    side: event.side,
    status: event.status,
    reasonCode: event.reasonCode,
    detail: event.detail,
    customerInr: inr(event.customerInr),
    lpInrSettled: inr(event.lpInrSettled),
    retainedInr: inr(event.retainedInr),
    revenueInr: inr(event.revenueInr),
    basisInr: inr(event.basisInr),
    revenueMode: event.revenueMode,
    revenueBps: event.revenueBps,
    emberPrice: ember(event.emberPrice),
    directBurnPct: event.directBurnPct,
    buybackPct: event.buybackPct,
    attempts: event.attempts,
    maxAttempts: event.maxAttempts,
    detectedAt: event.detectedAt.toISOString(),
    processedAt: event.processedAt?.toISOString() ?? null,
    allocationId: event.allocationId,
    allocation:
      event.allocation === null
        ? null
        : {
            allocationId: event.allocation.allocationId,
            directBurnPct: event.allocation.directBurnPct,
            buybackPct: event.allocation.buybackPct,
            directBurnEmber: ember(event.allocation.directBurnEmber),
            buybackEmber: ember(event.allocation.buybackEmber),
          },
    buybackId: event.buybackId,
    buybackStatus: event.buyback?.status ?? null,
    buybackExecutedEmber: event.buyback === null ? null : ember(event.buyback.executedEmber),
    directBurn: event.directBurn === null ? null : burnView(event.directBurn),
    buybackBurn: event.buybackBurn === null ? null : burnView(event.buybackBurn),
  };
}

function burnView(burn: {
  burnId: string;
  amount: Prisma.Decimal;
  onChainStatus: string;
  onChainTxHash: string | null;
}): ExchangeRevenueEventView['directBurn'] {
  return {
    burnId: burn.burnId,
    amount: ember(burn.amount),
    onChainStatus: burn.onChainStatus,
    onChainTxHash: burn.onChainTxHash,
  };
}

export interface ExchangeRevenueSummary {
  policy: {
    mode: ExchangeRevenueMode;
    bps: number;
    baselineDirectBurnPct: number;
    baselineBuybackPct: number;
    emberPrice: string;
    workerEnabled: boolean;
    splitIsAdaptive: boolean;
  };
  totals: {
    ordersSeen: number;
    revenueInr: string;
    /** INR the engine was sized against across every order seen. Equals
     *  `revenueInr` under a revenue basis and the traded volume under a volume
     *  basis; the two are reported apart so neither can be read as the other. */
    basisInr: string;
    customerInr: string;
    retainedInr: string;
    eligibleOrders: number;
    allocationsRecorded: number;
    allocatedReferenceInr: string;
    allocatedDirectBurnEmber: string;
    allocatedBuybackEmber: string;
    burnedEmberByChainState: Record<string, string>;
  };
  byStatus: Record<string, { count: number; revenueInr: string; basisInr: string; customerInr: string }>;
  recent: ExchangeRevenueEventView[];
}
