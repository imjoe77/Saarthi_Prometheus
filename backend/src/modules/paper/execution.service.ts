import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PaperOrder } from '@prisma/client';

import { DomainException } from '../../common/errors/domain.exception';
import { PrismaService } from '../../database/prisma.service';
import { LiveDataService } from '../live-data/live-data.service';
import { StrategyService } from '../strategy/strategy.service';
import { roundMoney, truncateQuantity } from '../simulation/engine/simulation-engine';
import type { MarketInstrument } from '../live-data/instruments/instrument-catalogue';
import type { PaperOrderSide } from './domain/execution';
import { DEFAULT_PAPER_INITIAL_CASH, evaluatePaperExecution } from './domain/execution';
/**
 * MODULE 06c - the execution service that atomically writes fills.
 *
 * GUARDRAILS INSIDE ONE TRANSACTION. `execute` does three things that must not
 * desynchronise: read the account/position, evaluate against the live quote,
 * and mutate cash, positions and the order row. Concurrency between BUYs and
 * SELLs on the same strategy is guarded by `pg_advisory_xact_lock(hashtext(strategyId)::bigint)`
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
    // quote is fetched, because "buy nothing" would otherwise fill at a price
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
        positionQuantity: position?.quantity ?? new Prisma.Decimal(0),
        instrument,
        quote,
        asOf: at,
      });

      if (!evalResult.filled) {
        const order = await tx.paperOrder.create({
          data: {
            strategyId: input.strategyId,
            symbol: input.symbol,
            side: input.side,
            quantity: truncated,
            status: 'REJECTED',
            rejectReason: evalResult.rejectReason,
            fillPrice: null,
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

      const filled = evalResult;
      if (input.side === 'BUY') {
        const result = await tx.paperAccount.updateMany({
          where: { strategyId: input.strategyId, cash: { gte: filled.gross } },
          data: { cash: { decrement: filled.gross }, lastActivityAt: at },
        });
        if (result.count === 0) {
          const order = await tx.paperOrder.create({
            data: {
              strategyId: input.strategyId,
              symbol: input.symbol,
              side: input.side,
              quantity: truncated,
              status: 'REJECTED',
              rejectReason: 'INSUFFICIENT_PAPER_CASH',
              fillPrice: null,
              placedAt: at,
              filledAt: null,
              clientRequestId: input.clientRequestId,
            },
          });
          return order;
        }
        if (position) {
          const newQty = position.quantity.plus(truncated);
          const newAvg = position.quantity
            .times(position.averageEntryPrice)
            .plus(truncated.times(filled.fillPrice))
            .dividedBy(newQty);
          await tx.paperPosition.update({
            where: { strategyId_symbol: { strategyId: input.strategyId, symbol: input.symbol } },
            data: {
              quantity: roundMoney(newQty),
              averageEntryPrice: roundMoney(newAvg),
              lastActivityAt: at,
            },
          });
        } else {
          await tx.paperPosition.create({
            data: {
              strategyId: input.strategyId,
              symbol: input.symbol,
              quantity: roundMoney(truncated),
              averageEntryPrice: roundMoney(filled.fillPrice),
              openedAt: at,
              lastActivityAt: at,
            },
          });
        }
      } else {
        if (position === null) {
          const order = await tx.paperOrder.create({
            data: {
              strategyId: input.strategyId,
              symbol: input.symbol,
              side: input.side,
              quantity: truncated,
              status: 'REJECTED',
              rejectReason: 'INSUFFICIENT_POSITION',
              fillPrice: null,
              placedAt: at,
              filledAt: null,
              clientRequestId: input.clientRequestId,
            },
          });
          await tx.paperAccount.update({ where: { strategyId: input.strategyId }, data: { lastActivityAt: at } });
          return order;
        }
        const newQty = position.quantity.minus(truncated);
        const realized = truncated.times(filled.fillPrice).minus(truncated.times(position.averageEntryPrice));
        if (newQty.isZero()) {
          await tx.paperPosition.delete({
            where: { strategyId_symbol: { strategyId: input.strategyId, symbol: input.symbol } },
          });
        } else {
          await tx.paperPosition.update({
            where: { strategyId_symbol: { strategyId: input.strategyId, symbol: input.symbol } },
            data: {
              quantity: roundMoney(newQty),
              lastActivityAt: at,
            },
          });
        }
        const result = await tx.paperAccount.updateMany({
          where: { strategyId: input.strategyId },
          data: {
            cash: { increment: filled.gross },
            realizedPnl: { increment: roundMoney(realized) },
            lastActivityAt: at,
          },
        });
        if (result.count === 0) {
          // should not happen as account exists, but be safe
        }
      }

      const order = await tx.paperOrder.create({
        data: {
          strategyId: input.strategyId,
          symbol: input.symbol,
          side: input.side,
          quantity: truncated,
          status: 'FILLED',
          rejectReason: null,
          fillPrice: roundMoney(filled.fillPrice),
          placedAt: at,
          filledAt: at,
          clientRequestId: input.clientRequestId,
        },
      });
      return order;
    });
  }
}