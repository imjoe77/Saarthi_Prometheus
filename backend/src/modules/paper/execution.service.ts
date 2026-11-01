import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { PaperOrder } from '@prisma/client';

import { DomainException } from '../../common/errors/domain.exception';
import { PrismaService } from '../../database/prisma.service';
import { LiveDataService } from '../live-data/live-data.service';
import { StrategyService } from '../strategy/strategy.service';
import { WalletService } from '../wallet/wallet.service';
import { roundMoney, truncateQuantity } from '../simulation/engine/simulation-engine';
import type { MarketInstrument } from '../live-data/instruments/instrument-catalogue';
import type { PaperOrderSide, PaperRejectReason } from './domain/execution';
import { DEFAULT_PAPER_INITIAL_CASH, evaluatePaperExecution } from './domain/execution';

/**
 * MODULE 06c - the execution service that atomically writes fills.
 *
 * GUARDRAILS INSIDE ONE TRANSACTION. `execute` does three things that must not
 * desynchronise: read the account/position, evaluate against the live quote,
 * and mutate cash, positions and the order row. Concurrency between orders on
 * the same strategy is guarded by `pg_advisory_xact_lock(hashtext(strategyId)::bigint)`
 * inside a single `prisma.$transaction`, so the read-modify-write for average
 * entry and realized P&L cannot cross a race. Sufficiency checks are still
 * `updateMany` (the "UPDATE WHERE ..." pattern already proven in Module 03),
 * but they are wrapped in the same advisory-locked transaction so they are
 * definitive rather than optimistic against a re-read.
 *
 * REJECTIONS ARE PERSISTED, NOT THROWN. A request that does not fill produces a
 * `REJECTED` row with a `rejectReason`, and that row is returned with status
 * REJECTED and no fill price. The endpoint returns 201 in either case, because
 * the request was accepted, evaluated and recorded - a refusal is a committed
 * outcome, not a validation error. Only "strategy not found or not visible",
 * "unknown symbol", "not owned" and "idempotent replay" map to 404/400/409 as
 * specified; the rejection itself is never an exception.
 *
 * IDEMPOTENCY IS A KEY, NOT A FLAG. `(strategyId, clientRequestId)` is unique;
 * on conflict the original order is returned (replay). No row is inserted and
 * no balances move.
 *
 * THE BOOK IS NET. An order is a LONG or a SHORT, and the plan it produces -
 * computed by the shared kernel in Module `trading` - says what it does to the
 * position and the cash. This service does not decide that; it applies it.
 */
export interface ExecutePaperOrderInput {
  readonly viewerId: string;
  readonly strategyId: string;
  readonly clientRequestId: string;
  readonly symbol: string;
  readonly side: PaperOrderSide;
  readonly quantity: Prisma.Decimal;
}

@Injectable()
export class PaperExecutionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly strategyService: StrategyService,
    private readonly liveDataService: LiveDataService,
    private readonly walletService: WalletService,
  ) {}

  async execute(input: ExecutePaperOrderInput): Promise<PaperOrder> {
    const strategy = await this.strategyService.findOwned(input.viewerId, input.strategyId);
    const instrument: MarketInstrument = this.liveDataService.instrument(input.symbol);

    const existing = await this.prisma.paperOrder.findUnique({
      where: {
        strategyId_clientRequestId: {
          strategyId: strategy.id,
          clientRequestId: input.clientRequestId,
        },
      },
    });
    if (existing) {
      return existing;
    }

    // A quantity that rounds to zero is not an order. It is refused before any
    // quote is fetched, because "trade nothing" would otherwise fill at a price
    // the client never intended to trade and write a real ledger row for it.
    const truncated = truncateQuantity(input.quantity);
    if (truncated.lte(0)) {
      throw DomainException.badRequest('quantity must be a positive amount of the base asset.');
    }

    const at = new Date();
    const quoteDto = await this.liveDataService.quote(input.symbol, at);
    const quote = {
      symbol: quoteDto.symbol,
      bid: quoteDto.bid ?? undefined,
      ask: quoteDto.ask ?? undefined,
      asOf: quoteDto.asOf ?? new Date(0).toISOString(),
    };

    // The trader's real USDT balance is read once, outside the transaction:
    // it is the gate that decides whether the order may be placed at all, and
    // the wallet ledger is not written by this transaction.
    const walletUsdt = await this.walletService.getAvailableBalance(input.viewerId, 'USDT');

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.strategyId})::bigint)`;

      const account = await tx.paperAccount.upsert({
        where: { strategyId: input.strategyId },
        create: {
          strategyId: input.strategyId,
          currency: 'USD',
          cash: DEFAULT_PAPER_INITIAL_CASH,
          realizedPnl: new Prisma.Decimal(0),
          openedAt: new Date(),
          lastActivityAt: new Date(),
        },
        update: {},
      });

      const position = await tx.paperPosition.findUnique({
        where: { strategyId_symbol: { strategyId: input.strategyId, symbol: input.symbol } },
      });

      const evalResult = evaluatePaperExecution({
        side: input.side,
        quantity: truncated,
        cash: account.cash,
        position:
          position === null
            ? null
            : {
                direction: position.direction,
                quantity: position.quantity,
                averageEntryPrice: position.averageEntryPrice,
              },
        walletUsdt,
        instrument,
        quote,
        asOf: at,
      });

      if (!evalResult.filled) {
        return this.reject(
          tx,
          input,
          truncated,
          evalResult.rejectReason,
          at,
        );
      }

      const filled = evalResult;
      const plan = filled.plan;

      // The cash movement is the order's own notional, signed by its direction.
      // A LONG spends it and a SHORT brings it in, whatever the book looks like.
      if (plan.cashDelta.lt(0)) {
        const spend = plan.cashDelta.negated();
        const debited = await tx.paperAccount.updateMany({
          where: { strategyId: input.strategyId, cash: { gte: spend } },
          data: { cash: { decrement: spend }, lastActivityAt: at },
        });
        if (debited.count === 0) {
          return this.reject(tx, input, truncated, 'INSUFFICIENT_PAPER_CASH', at);
        }
      } else if (plan.cashDelta.gt(0)) {
        await tx.paperAccount.update({
          where: { strategyId: input.strategyId },
          data: { cash: { increment: plan.cashDelta }, lastActivityAt: at },
        });
      }

      if (!plan.realizedPnl.isZero()) {
        await tx.paperAccount.update({
          where: { strategyId: input.strategyId },
          data: { realizedPnl: { increment: plan.realizedPnl }, lastActivityAt: at },
        });
      }

      if (plan.position === null) {
        // An emptied position is deleted, never stored as a zero row: a zero
        // row would read as "held nothing" to one caller and "missing data" to
        // another, and this module refuses to make that ambiguity possible.
        await tx.paperPosition.delete({
          where: { strategyId_symbol: { strategyId: input.strategyId, symbol: input.symbol } },
        });
      } else if (position === null) {
        await tx.paperPosition.create({
          data: {
            strategyId: input.strategyId,
            symbol: input.symbol,
            direction: plan.position.direction,
            quantity: plan.position.quantity,
            averageEntryPrice: plan.position.averageEntryPrice,
            openedAt: at,
            lastActivityAt: at,
          },
        });
      } else {
        await tx.paperPosition.update({
          where: { strategyId_symbol: { strategyId: input.strategyId, symbol: input.symbol } },
          data: {
            direction: plan.position.direction,
            quantity: plan.position.quantity,
            averageEntryPrice: plan.position.averageEntryPrice,
            lastActivityAt: at,
          },
        });
      }

      return tx.paperOrder.create({
        data: {
          strategyId: input.strategyId,
          symbol: input.symbol,
          side: input.side,
          quantity: truncated,
          status: 'FILLED',
          rejectReason: null,
          fillPrice: roundMoney(filled.fillPrice),
          realizedPnl: plan.realizedPnl.isZero() ? null : plan.realizedPnl,
          placedAt: at,
          filledAt: at,
          clientRequestId: input.clientRequestId,
        },
      });
    });
  }

  /**
   * Closes an open position at the live market price.
   *
   * A CLOSE IS AN ORDER AGAINST THE POSITION, NOT A SPECIAL CASE. It is the
   * same engine, the same price rules and the same wallet gate, with the
   * direction reversed and the quantity taken from the position itself - so a
   * close cannot fill at a price the ticker would not have produced, and
   * cannot skip a check that an ordinary order would have faced.
   *
   * There is nothing to close if the book is flat for that symbol, and that is
   * a 404 rather than a rejected order: the request described a position that
   * does not exist, which is a wrong request, not a market outcome.
   */
  async closePosition(
    viewerId: string,
    strategyId: string,
    symbol: string,
  ): Promise<PaperOrder> {
    await this.strategyService.findOwned(viewerId, strategyId);

    const position = await this.prisma.paperPosition.findUnique({
      where: { strategyId_symbol: { strategyId, symbol } },
    });

    if (position === null) {
      throw DomainException.notFound('Position', symbol);
    }

    return this.execute({
      viewerId,
      strategyId,
      clientRequestId: randomUUID(),
      symbol,
      side: position.direction === 'LONG' ? 'SHORT' : 'LONG',
      quantity: position.quantity,
    });
  }

  /** Writes the refusal row and returns it. A refusal is a committed outcome. */
  private async reject(
    tx: Prisma.TransactionClient,
    input: ExecutePaperOrderInput,
    quantity: Prisma.Decimal,
    rejectReason: PaperRejectReason,
    at: Date,
  ): Promise<PaperOrder> {
    const order = await tx.paperOrder.create({
      data: {
        strategyId: input.strategyId,
        symbol: input.symbol,
        side: input.side,
        quantity,
        status: 'REJECTED',
        rejectReason,
        fillPrice: null,
        realizedPnl: null,
        placedAt: at,
        filledAt: null,
        clientRequestId: input.clientRequestId,
      },
    });

    await tx.paperAccount.update({
      where: { strategyId: input.strategyId },
      data: { lastActivityAt: at },
    });

    return order;
  }
}
