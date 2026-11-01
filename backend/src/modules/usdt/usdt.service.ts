import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { Prisma, type Asset, type UsdtOrder, type UsdtOrderSide } from '@prisma/client';

import { DomainException } from '../../common/errors/domain.exception';
import { PrismaService } from '../../database/prisma.service';
import { normaliseAmount } from '../wallet/decimal.util';
import { WalletService } from '../wallet/wallet.service';
import { ExchangeRevenueService } from '../tokenomics/exchange-revenue.service';
import {
  LiquidityAllocationService,
  type BuyAllocationOutcome,
} from '../liquidity/liquidity-allocation.service';
import { decodeCursor, encodeCursor } from './cursor.util';
import type { UsdtOrderQueryDto } from './dto/usdt-order-query.dto';
import type { UsdtOrderWriteDto } from './dto/usdt-order-write.dto';
import type { UsdtQuoteQueryDto } from './dto/usdt-quote-query.dto';
import { UsdtPricingService, type UsdtPricingResult } from './usdt-pricing.service';

/**
 * MODULE 08 — the USDT quote and order flow.
 *
 * QUOTE prices through `UsdtPricingService`: a fresh CoinDCX order-book VWAP
 * for the requested quantity, measured against fresh CoinGecko reference data
 * with zero Prometheus brokerage. No wallet and no persistence. When live
 * data is unavailable the quote is a clearly labelled fallback (savings
 * suppressed) or, with nothing configured to show, 503 PRICING_UNAVAILABLE.
 *
 * ORDERS move Module 03 money through `WalletService` and write the order row
 * inside ONE database transaction: debit the sold side, credit the bought
 * side, insert `usdt_orders`. All three commit or none do, so a row exists if
 * and only if both balance legs moved - an insufficient balance rolls the
 * whole transaction back and leaves no order behind. Settlement runs only on
 * live pricing: an order requires a fresh execution VWAP AND a fresh
 * reference in the same request, otherwise 503 PRICING_UNAVAILABLE - fallback
 * and stale prices never execute. The optional per-side price guard
 * (`maxExecutionPrice` on a BUY, `minExecutionPrice` on a SELL) is the
 * explicit slippage rule: a guard the fresh VWAP has breached is a 409 with
 * nothing settled, so a price shown earlier is never silently replaced.
 *
 * IDEMPOTENCY IS A KEY, NOT A FLAG - `(userId, clientRequestId)` is unique.
 * A replay finds the original row and returns it without touching a balance
 * (and without re-pricing: the original order is the truth); two racing
 * requests with the same key both start, and the loser's insert fails with a
 * unique violation that rolls its whole transaction back, so the balance
 * legs apply exactly once across both.
 *
 * Refusals are the shared vocabulary: malformed, zero or negative amounts are
 * 400 VALIDATION_FAILED; a balance that cannot fund the order is 409
 * INSUFFICIENT_BALANCE; a breached price guard is 409 CONFLICT; and missing
 * live pricing is 503 PRICING_UNAVAILABLE. No rejected order is recorded,
 * because the plan's checkpoint is about recorded, settled orders and a
 * failed request that moved nothing has no state worth keeping.
 *
 * MODULE 09 (liquidity): with no liquidity providers registered a BUY settles
 * exactly as above - the original minted behaviour. Once any provider exists,
 * the same transaction also draws the order's USDT from LP commitments
 * (`LiquidityAllocationService`), so an order the eligible liquidity cannot
 * cover is 409 INSUFFICIENT_LIQUIDITY and nothing settles - no partial fills.
 * SELL never touches liquidity, and the response of a funded BUY carries the
 * per-commitment slices that explain where its USDT came from.
 */
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export interface UsdtOrderPage {
  items: UsdtOrder[];
  nextCursor: string | null;
}

export interface UsdtPlacedOrder {
  order: UsdtOrder;
  created: boolean;
  /** Live pricing provenance, present only when this call created the order. */
  pricing: UsdtPricingResult | null;
  /**
   * BUY funding outcome for this call: which LP commitments supplied the
   * USDT (`legacy: false`), or that no providers exist and Module 08's
   * original behaviour applied (`legacy: true`). Always the empty legacy
   * shape on replays and on SELL, whose response carries no block.
   */
  liquidity: BuyAllocationOutcome;
}

@Injectable()
export class UsdtService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly walletService: WalletService,
    private readonly pricingService: UsdtPricingService,
    private readonly liquidityAllocation: LiquidityAllocationService,
    /**
     * The Module 08 x Module 11 bridge. Called inside the settlement
     * transaction to record what the order did; it decides nothing about
     * whether the order happens, and a policy failure is recorded rather than
     * allowed to break the exchange.
     */
    private readonly exchangeRevenue: ExchangeRevenueService,
  ) {}

  /** Prices a USDT amount from live market data (or a labelled fallback). */
  async quote(query: UsdtQuoteQueryDto): Promise<UsdtPricingResult> {
    const usdtAsset = await this.requireAsset('USDT');
    const usdtAmount = normaliseAmount(query.usdtAmount, usdtAsset);

    return this.pricingService.quote(query.side, usdtAmount);
  }

  /** Executes a BUY or SELL atomically, or returns the original on a replay. */
  async place(userId: string, side: UsdtOrderSide, dto: UsdtOrderWriteDto): Promise<UsdtPlacedOrder> {
    const usdtAsset = await this.requireAsset('USDT');
    const usdtAmount = normaliseAmount(dto.usdtAmount, usdtAsset);

    // Amount validation runs before any pricing or persistence work, so a bad
    // amount is a 400 even if this is a replay of an order that already exists.
    this.assertPriceGuardShape(side, dto);

    const replay = await this.findReplay(userId, dto.clientRequestId);
    if (replay) {
      return { order: replay, created: false, pricing: null, liquidity: { legacy: true, slices: [] } };
    }

    // Live, fresh pricing is required to settle; anything else is a 503 that
    // moved nothing. The prices returned here are the prices that settle.
    const pricing = await this.pricingService.requireExecution(side, usdtAmount);
    this.assertPriceGuard(side, dto, pricing);

    const inrAsset = await this.requireAsset('INR');
    const wallet = await this.walletService.getForUserOrThrow(userId);

    const orderId = randomUUID();
    const note = `USDT ${side} order ${orderId}`;
    const inrAmount = pricing.quote.inrAmount;
    const debit = side === 'BUY' ? { asset: inrAsset, amount: inrAmount } : { asset: usdtAsset, amount: usdtAmount };
    const credit = side === 'BUY' ? { asset: usdtAsset, amount: usdtAmount } : { asset: inrAsset, amount: inrAmount };

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        await this.walletService.debit(wallet.id, debit.asset.id, debit.amount, { note }, tx);
        await this.walletService.credit(wallet.id, credit.asset.id, credit.amount, { note }, tx);

        const order = await tx.usdtOrder.create({
          data: {
            orderId,
            userId,
            side,
            usdtAmount,
            inrAmount,
            prometheusPrice: pricing.quote.prometheusPrice,
            referencePrice: pricing.quote.referencePrice as Prisma.Decimal,
            savings: pricing.quote.savings as Prisma.Decimal,
            clientRequestId: dto.clientRequestId,
          },
        });

        // MODULE 09 - BUY only. LP funding legs join THIS transaction: when no
        // providers exist the call is a no-op (Module 08's original minted
        // behaviour), and once any provider exists every slice applies here or
        // the whole order - customer legs included - rolls back together.
        // SELL never touches liquidity. The order row must exist first because
        // liquidity_allocations.order_id is a real foreign key.
        const liquidity: BuyAllocationOutcome =
          side === 'BUY'
            ? await this.liquidityAllocation.allocateBuy(tx, {
                orderId,
                usdtAmount,
                inrAmount,
                priceInr: pricing.quote.prometheusPrice,
                usdtAssetId: usdtAsset.id,
                inrAssetId: inrAsset.id,
              })
            : { legacy: true, slices: [] };

        // MODULE 08 x MODULE 11. One row saying what this settlement did,
        // written in the same transaction so an order that never committed can
        // never be read as having funded anything. The revenue decision itself
        // belongs to the tokenomics module; this call only reports facts about
        // money that moved here, and cannot make the order fail.
        await this.exchangeRevenue.recordSettlement(tx, {
          orderId,
          userId,
          side,
          usdtAmount,
          customerInr: inrAmount,
          lpInrSettled: liquidity.slices.reduce(
            (sum, slice) => sum.plus(slice.inrAmount),
            new Prisma.Decimal(0),
          ),
          lpBacked: liquidity.legacy === false,
        });

        return { order, liquidity };
      });

      return { order: result.order, created: true, pricing, liquidity: result.liquidity };
    } catch (error) {
      // A concurrent request with the same key won the insert; its transaction
      // committed the balances, ours rolled back, and the original is the truth.
      if (this.isUniqueConstraintViolation(error)) {
        const winner = await this.findReplay(userId, dto.clientRequestId);
        if (winner) {
          return {
            order: winner,
            created: false,
            pricing: null,
            liquidity: { legacy: true, slices: [] },
          };
        }
      }

      throw error;
    }
  }

  /** One keyset page of the caller's order history, newest first. */
  async getOrdersPage(userId: string, options: UsdtOrderQueryDto): Promise<UsdtOrderPage> {
    const take = Math.min(Math.max(options.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);

    const where: Prisma.UsdtOrderWhereInput = { userId };

    if (options.cursor) {
      const { placedAt, orderId } = decodeCursor(options.cursor);
      where.OR = [{ placedAt: { lt: placedAt } }, { placedAt, orderId: { lt: orderId } }];
    }

    const rows = await this.prisma.usdtOrder.findMany({
      where,
      orderBy: [{ placedAt: 'desc' }, { orderId: 'desc' }],
      take: take + 1,
    });

    const hasMore = rows.length > take;
    const items = hasMore ? rows.slice(0, take) : rows;
    const last = items.at(-1);

    return {
      items,
      nextCursor: hasMore && last ? encodeCursor(last.placedAt, last.orderId) : null,
    };
  }

  /**
   * The explicit slippage rule: a supplied guard the fresh VWAP has breached
   * refuses the order before any wallet or persistence work.
   */
  private assertPriceGuard(side: UsdtOrderSide, dto: UsdtOrderWriteDto, pricing: UsdtPricingResult): void {
    const executionPrice = pricing.quote.prometheusPrice;

    if (side === 'BUY' && dto.maxExecutionPrice !== undefined) {
      const guard = new Prisma.Decimal(dto.maxExecutionPrice);
      if (executionPrice.gt(guard)) {
        throw DomainException.conflict(
          `The fresh execution price (${executionPrice.toFixed()}) exceeds the maximum you accepted (${guard.toFixed()}). No order was placed.`,
        );
      }
    }

    if (side === 'SELL' && dto.minExecutionPrice !== undefined) {
      const guard = new Prisma.Decimal(dto.minExecutionPrice);
      if (executionPrice.lt(guard)) {
        throw DomainException.conflict(
          `The fresh execution price (${executionPrice.toFixed()}) is below the minimum you accepted (${guard.toFixed()}). No order was placed.`,
        );
      }
    }
  }

  /** A guard belongs to exactly one side; the wrong one is a client bug. */
  private assertPriceGuardShape(side: UsdtOrderSide, dto: UsdtOrderWriteDto): void {
    if (side === 'BUY' && dto.minExecutionPrice !== undefined) {
      throw DomainException.badRequest('minExecutionPrice applies to SELL orders only.');
    }
    if (side === 'SELL' && dto.maxExecutionPrice !== undefined) {
      throw DomainException.badRequest('maxExecutionPrice applies to BUY orders only.');
    }
  }

  private findReplay(userId: string, clientRequestId: string): Promise<UsdtOrder | null> {
    return this.prisma.usdtOrder.findUnique({
      where: { userId_clientRequestId: { userId, clientRequestId } },
    });
  }

  /** Reference data must be present and active before anything is priced against it. */
  private async requireAsset(symbol: string): Promise<Asset> {
    const asset = await this.prisma.asset.findUnique({ where: { symbol } });

    if (!asset) {
      throw DomainException.notFound('Asset', symbol);
    }

    if (!asset.isActive) {
      throw DomainException.assetInactive(asset.symbol);
    }

    return asset;
  }

  private isUniqueConstraintViolation(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
  }
}
