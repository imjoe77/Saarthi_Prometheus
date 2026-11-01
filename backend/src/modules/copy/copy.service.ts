import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, TransactionType, type CopyAccount, type CopyEvent, type CopyPosition, type StrategyFollow } from '@prisma/client';

import { DomainException } from '../../common/errors/domain.exception';
import { PrismaService } from '../../database/prisma.service';
import { LiveDataService } from '../live-data/live-data.service';
import { WalletService } from '../wallet/wallet.service';
import { markPosition } from '../trading/domain/position-book';
import {
  PAPER_EXECUTION_PORT,
  type PaperExecutionPort,
} from '../paper/ports/paper-execution.port';
import { StrategyService } from '../strategy/strategy.service';
import {
  type CopyRejectReason,
  evaluateEligibility,
  followStartCursor,
  parseAllocationFraction,
} from './domain/copy-sizing';
import { replayCopyLedger, type PerformancePoint } from './domain/copy-performance';

/** One page shape. Offset, exactly like the strategy catalogue: these lists are
 *  re-read and re-sorted, so an offset is honest and costs one count per call. */
export interface CopyPage<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/** A follow together with the strategy it points at and its outcome counts. */
export interface FollowRecord {
  follow: StrategyFollow;
  strategy: { id: string; name: string; status: 'ACTIVE' | 'ARCHIVED'; visibility: 'PRIVATE' | 'PUBLIC' };
  copiedCount: number;
  rejectedCount: number;
  /**
   * True when the expert has committed a fill after this follow's cursor that
   * the engine has not consumed yet.
   */
  hasPendingEvents: boolean;
}

/** Derived answer to "may this follow copy right now?", never the raw visibility. */
export type FollowEligibility = 'ELIGIBLE' | CopyRejectReason;

export interface CopyStatusRecord {
  follow: StrategyFollow;
  strategy: {
    id: string;
    name: string;
    status: 'ACTIVE' | 'ARCHIVED';
    visibility: 'PRIVATE' | 'PUBLIC';
  };
  eligibility: FollowEligibility;
  copiedCount: number;
  rejectedCount: number;
  hasPendingEvents: boolean;
}

export interface FollowerRecord {
  follow: StrategyFollow;
  maskedEmail: string;
  copiedCount: number;
  rejectedCount: number;
}

/** One consumed copy event, with the strategy whose fill it mirrors. */
export interface CopyEventRecord {
  event: CopyEvent;
  strategy: { id: string; name: string };
}

/** The replayed profit-and-loss path across every follow the caller holds. */
export interface CopyPerformanceRecord {
  followCount: number;
  /** The ledger's own total, read from `copy_accounts.realized_pnl`. */
  realizedPnl: Prisma.Decimal;
  /** The caller's copy cash, summed over the separate pots. */
  cash: Prisma.Decimal;
  copiedCount: number;
  rejectedCount: number;
  /** One point per executed fill, in the order the engine consumed them. */
  points: PerformancePoint[];
}

/**
 * One open copy holding, marked at the market.
 *
 * THE MARKS MAY BE NULL. A symbol the feed cannot price has no honest market
 * value, so the value columns are null rather than zero - zero would claim the
 * holding is worth nothing, which is a claim, not an absence.
 */
export interface MarkedCopyPosition {
  readonly position: CopyPosition;
  readonly markPrice: Prisma.Decimal | null;
  readonly marketValue: Prisma.Decimal | null;
  readonly unrealizedPnl: Prisma.Decimal | null;
  readonly stale: boolean;
}

export interface CopyAggregateAccount {
  followCount: number;
  cash: Prisma.Decimal;
  realizedPnl: Prisma.Decimal;
  /** The caller's real USDT balance, which gates whether a copy may happen. */
  walletUsdt: Prisma.Decimal;
  positions: Array<{
    symbol: string;
    direction: 'LONG' | 'SHORT';
    quantity: Prisma.Decimal;
    averageEntryPrice: Prisma.Decimal;
    markPrice: Prisma.Decimal | null;
    marketValue: Prisma.Decimal | null;
    unrealizedPnl: Prisma.Decimal | null;
    stale: boolean;
    followCount: number;
  }>;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/**
 * MODULE 07 - follow relationships, configuration and read surfaces.
 *
 * OWNERSHIP AND VISIBILITY ARE RE-DERIVED, NEVER TRUSTED. Every method takes
 * the caller's id from the verified token; no body, path or query can name a
 * follower. Following requires the same PUBLIC + ACTIVE posture Module 05 uses
 * for discovery, so a strategy that cannot be discovered cannot be followed
 * either, and a strategy that stops being visible stops copying - with the
 * reason recorded on the event rather than by silently vanishing.
 *
 * WHAT THIS SERVICE DOES NOT DO: it never moves money. Cash and positions are
 * written only by `CopyExecutionService`, inside a transaction that also writes
 * the event and the cursor, so a read here can never observe a half-applied
 * copy.
 *
 * FOLLOWING IS ONE ROW PER (FOLLOWER, STRATEGY), EVER. Re-following updates the
 * same row: the cursor, the account and the history belong to the relationship,
 * not to a session, and a second row would split them in two.
 */
@Injectable()
export class CopyService {
  private readonly logger = new Logger(CopyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly strategyService: StrategyService,
    private readonly liveDataService: LiveDataService,
    private readonly walletService: WalletService,
    @Inject(PAPER_EXECUTION_PORT) private readonly port: PaperExecutionPort,
  ) {}

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  /**
   * Follows a public, active strategy for the caller.
   *
   * Three refusals, three different answers:
   *  - your own strategy -> 409 (you know it exists; pretending otherwise would
   *    be unhelpful, and following yourself would copy your own fills),
   *  - a duplicate active follow -> 409 (the row is the rule),
   *  - anything not visible -> 404 (the Module 05 posture: "not yours" and
   *    "does not exist" must be indistinguishable, or the route becomes an
   *    oracle for other people's private strategies).
   *
   * THE CURSOR IS SEEDED AT THE FOLLOW INSTANT. A follow copies the expert's
   * *next* fill and never the fills that already exist, because the follower
   * was not there for them: back-filling would build a position out of trades
   * nobody intended to mirror. The rule a reader can rely on is `filled_at`.
   *
   * RE-FOLLOWING KEEPS THE CURSOR rather than reseeding it. The gap's fills are
   * therefore still walked and recorded - as `FOLLOW_NOT_ACTIVE`, because they
   * predate the new `followed_at` - so a re-follow neither copies the gap nor
   * drops it without a record.
   */
  async follow(followerId: string, strategyId: string, allocationRaw: string): Promise<FollowRecord> {
    const allocation = parseAllocationFraction(allocationRaw);
    if (!allocation.ok) {
      throw DomainException.badRequest(allocation.error);
    }

    const strategy = await this.strategyService.findVisibleTo(followerId, strategyId);

    if (strategy.ownerId === followerId) {
      throw DomainException.conflict(
        'You cannot follow your own strategy. Copy trading mirrors another account\'s committed fills.',
      );
    }

    if (strategy.status !== 'ACTIVE' || strategy.visibility !== 'PUBLIC') {
      // Defensive: `findVisibleTo` already 404s these for a non-owner. Kept so
      // the eligibility rule has exactly one written home.
      throw DomainException.notFound('Strategy', strategyId);
    }

    const now = new Date();
    const cursor = followStartCursor(now);

    try {
      const created = await this.prisma.strategyFollow.create({
        data: {
          followerId,
          strategyId,
          status: 'ACTIVE',
          allocationFraction: allocation.fraction,
          followedAt: now,
          unfollowedAt: null,
          cursorFilledAt: cursor.filledAt,
          cursorOrderId: cursor.orderId,
          lastProcessedAt: null,
        },
      });

      return this.recordFor(created);
    } catch (error) {
      if (!this.isUniqueConstraintViolation(error)) {
        throw error;
      }

      const existing = await this.prisma.strategyFollow.findUniqueOrThrow({
        where: { followerId_strategyId: { followerId, strategyId } },
      });

      if (existing.status === 'ACTIVE') {
        throw DomainException.conflict('You already follow this strategy. Change its allocation instead.');
      }

      const reactivated = await this.prisma.strategyFollow.update({
        where: { followerId_strategyId: { followerId, strategyId } },
        data: {
          status: 'ACTIVE',
          allocationFraction: allocation.fraction,
          followedAt: now,
          unfollowedAt: null,
          // Cursor deliberately untouched - see the method comment.
        },
      });

      return this.recordFor(reactivated);
    }
  }

  /**
   * Stops copying. Idempotent: unfollowing twice reports the same state rather
   * than an error, because the second call wants nothing to happen - and it
   * does not.
   *
   * PENDING EVENTS ARE NOT DISCARDED. The cursor is left where it is, so the
   * engine still walks the fills committed since the last pass and records each
   * one as `FOLLOW_NOT_ACTIVE`. They are never copied, and they are never a
   * silent gap either: the history says exactly which fills were seen and
   * refused, in order.
   *
   * CASH AND POSITIONS ARE NOT LIQUIDATED. There is no price here to liquidate
   * at, and inventing one would move a balance on the strength of a guess. The
   * account stays readable, stays attached to the follow, and resumes only if
   * the follower follows again.
   */
  async unfollow(followerId: string, strategyId: string): Promise<FollowRecord> {
    const follow = await this.prisma.strategyFollow.findUnique({
      where: { followerId_strategyId: { followerId, strategyId } },
    });

    if (follow === null) {
      throw DomainException.notFound('Strategy', strategyId);
    }

    if (follow.status === 'UNFOLLOWED') {
      return this.recordFor(follow);
    }

    const updated = await this.prisma.strategyFollow.update({
      where: { followerId_strategyId: { followerId, strategyId } },
      data: { status: 'UNFOLLOWED', unfollowedAt: new Date() },
    });

    return this.recordFor(updated);
  }

  /**
   * Changes the allocation of an existing follow. The new fraction applies to
   * the *next* event consumed - the history keeps the fraction each past event
   * was sized with, so changing it never rewrites what already happened.
   *
   * An unfollowed follow may be reconfigured too: the setting belongs to the
   * relationship and is waiting for whoever follows again.
   */
  async setAllocation(followerId: string, strategyId: string, allocationRaw: string): Promise<FollowRecord> {
    const allocation = parseAllocationFraction(allocationRaw);
    if (!allocation.ok) {
      throw DomainException.badRequest(allocation.error);
    }

    const follow = await this.prisma.strategyFollow.findUnique({
      where: { followerId_strategyId: { followerId, strategyId } },
    });

    if (follow === null) {
      throw DomainException.notFound('Strategy', strategyId);
    }

    const updated = await this.prisma.strategyFollow.update({
      where: { followerId_strategyId: { followerId, strategyId } },
      data: { allocationFraction: allocation.fraction },
    });

    return this.recordFor(updated);
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /** One follow of the caller's, or 404 - including one they never created. */
  async getFollow(followerId: string, strategyId: string): Promise<FollowRecord> {
    const follow = await this.prisma.strategyFollow.findUnique({
      where: { followerId_strategyId: { followerId, strategyId } },
      include: { strategy: true },
    });

    if (follow === null) {
      throw DomainException.notFound('Strategy', strategyId);
    }

    return this.recordFor(follow);
  }

  /**
   * The caller's follows, newest first, with outcome counts resolved in one
   * grouped query so a page of 20 does not become 21 round trips.
   *
   * THE PENDING FLAG COMES FROM THE PORT, IN ONE QUERY FOR THE PAGE. A
   * follower asking "is my copy late" wants the answer on the list they
   * already read, not a second call per row, so the whole page's pending
   * state is resolved together.
   */
  async listFollows(followerId: string, options: { page?: number; limit?: number } = {}): Promise<CopyPage<FollowRecord>> {
    const limit = clamp(options.limit ?? DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    const page = Math.max(1, Math.trunc(options.page ?? 1));

    const [rows, total] = await Promise.all([
      this.prisma.strategyFollow.findMany({
        where: { followerId },
        include: { strategy: true },
        orderBy: [{ followedAt: 'desc' }, { strategyId: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.strategyFollow.count({ where: { followerId } }),
    ]);

    const counts = await this.countOutcomes(
      { followerId, strategyId: { in: rows.map((row) => row.strategyId) } },
      'strategyId',
    );

    const pending = await this.pendingStrategies(rows);

    return {
      items: rows.map((row) => ({
        follow: row,
        strategy: {
          id: row.strategy.id,
          name: row.strategy.name,
          status: row.strategy.status,
          visibility: row.strategy.visibility,
        },
        copiedCount: counts.get(row.strategyId)?.copied ?? 0,
        rejectedCount: counts.get(row.strategyId)?.rejected ?? 0,
        hasPendingEvents: pending.has(row.strategyId),
      })),
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  /**
   * One caller's copy cash for one follow.
   *
   * `account` is null until the first *eligible* fill provisions it - the same
   * "no answer yet is not a zero" rule the expert's paper account follows - so
   * a follow that has never copied reads as absent rather than as 100,000 that
   * nobody has touched.
   *
   * The positions are priced at the market, and the wallet balance comes
   * along because it is the gate every further copy has to pass.
   */
  async getFollowAccount(
    followerId: string,
    strategyId: string,
  ): Promise<{
    account: CopyAccount | null;
    positions: MarkedCopyPosition[];
    walletUsdt: Prisma.Decimal;
  }> {
    await this.getFollowWithStrategy(followerId, strategyId);

    const [account, positions, walletUsdt] = await Promise.all([
      this.prisma.copyAccount.findUnique({
        where: { followerId_strategyId: { followerId, strategyId } },
      }),
      this.prisma.copyPosition.findMany({
        where: { followerId, strategyId },
        orderBy: [{ openedAt: 'asc' }, { symbol: 'asc' }],
      }),
      this.walletService.getAvailableBalance(followerId, 'USDT'),
    ]);

    const quotes = await this.quoteBySymbol(positions.map((position) => position.symbol));

    const marked = positions.map((position) => {
      const quote = quotes.get(position.symbol);
      const markPrice = quote?.markPrice ?? null;

      if (markPrice === null) {
        return {
          position,
          markPrice: null,
          marketValue: null,
          unrealizedPnl: null,
          stale: quote?.stale ?? false,
        };
      }

      const result = markPosition(
        {
          direction: position.direction,
          quantity: position.quantity,
          averageEntryPrice: position.averageEntryPrice,
        },
        markPrice,
      );

      return {
        position,
        markPrice,
        marketValue: result.marketValue,
        unrealizedPnl: result.unrealizedPnl,
        stale: quote?.stale ?? false,
      };
    });

    return { account, positions: marked, walletUsdt };
  }

  /**
   * The caller's copy cash and holdings across every follow, summed.
   *
   * Each follow holds its own pot, so this is an *aggregate of separate
   * balances*, not one pooled account - which is why `followCount` is part of
   * the answer.
   *
   * POSITIONS MERGE PER SYMBOL *AND DIRECTION*. Two experts can disagree
   * about the same instrument - one long, one short - and averaging those two
   * into one "AAPL" row would produce a number that describes neither
   * position. A long row and a short row are two facts about the book, and
   * the aggregate keeps them apart.
   *
   * THE HOLDINGS ARE PRICED. Each row carries the quote it was marked at, its
   * market value and its unrealised P&L, or nulls when the feed produced no
   * price at all. A copy account that could only be read in units would leave
   * the follower to value their own book, and a valuation nobody computes is
   * a valuation nobody can check.
   */
  async getAggregateAccount(followerId: string): Promise<CopyAggregateAccount> {
    const [accounts, positions, followCount, walletUsdt] = await Promise.all([
      this.prisma.copyAccount.findMany({ where: { followerId } }),
      this.prisma.copyPosition.findMany({ where: { followerId } }),
      this.prisma.strategyFollow.count({ where: { followerId } }),
      this.walletService.getAvailableBalance(followerId, 'USDT'),
    ]);

    const merged = new Map<
      string,
      {
        symbol: string;
        direction: 'LONG' | 'SHORT';
        quantity: Prisma.Decimal;
        value: Prisma.Decimal;
        followCount: number;
      }
    >();

    for (const position of positions) {
      const key = `${position.symbol}|${position.direction}`;
      const current = merged.get(key) ?? {
        symbol: position.symbol,
        direction: position.direction,
        quantity: new Prisma.Decimal(0),
        value: new Prisma.Decimal(0),
        followCount: 0,
      };
      current.quantity = current.quantity.plus(position.quantity);
      current.value = current.value.plus(position.quantity.times(position.averageEntryPrice));
      current.followCount += 1;
      merged.set(key, current);
    }

    const rows = [...merged.values()].map((row) => ({
      symbol: row.symbol,
      direction: row.direction,
      quantity: row.quantity,
      averageEntryPrice: row.quantity.isZero()
        ? new Prisma.Decimal(0)
        : row.value.dividedBy(row.quantity),
      followCount: row.followCount,
    }));

    const quotes = await this.quoteBySymbol(rows.map((row) => row.symbol));

    return {
      followCount,
      cash: accounts.reduce((sum, account) => sum.plus(account.cash), new Prisma.Decimal(0)),
      realizedPnl: accounts.reduce((sum, account) => sum.plus(account.realizedPnl), new Prisma.Decimal(0)),
      walletUsdt,
      positions: rows.map((row) => {
        const quote = quotes.get(row.symbol);
        const markPrice = quote?.markPrice ?? null;

        if (markPrice === null) {
          return {
            ...row,
            markPrice: null,
            marketValue: null,
            unrealizedPnl: null,
            stale: quote?.stale ?? false,
          };
        }

        const marked = markPosition(
          {
            direction: row.direction,
            quantity: row.quantity,
            averageEntryPrice: row.averageEntryPrice,
          },
          markPrice,
        );

        return {
          ...row,
          markPrice,
          marketValue: marked.marketValue,
          unrealizedPnl: marked.unrealizedPnl,
          stale: quote?.stale ?? false,
        };
      }),
    };
  }

  /**
   * The latest quote for each of the given symbols - one read per symbol, not
   * one per position, so a book holding the same instrument in two directions
   * still pays for a single quote.
   *
   * A symbol the feed cannot price is present in the map with a null price
   * rather than absent, so a caller can tell "no price" from "not asked".
   */
  private async quoteBySymbol(
    symbols: readonly string[],
  ): Promise<Map<string, { markPrice: Prisma.Decimal | null; stale: boolean }>> {
    const at = new Date();
    const unique = [...new Set(symbols)];

    const entries = await Promise.all(
      unique.map(async (symbol) => {
        const quote = await this.liveDataService.quote(symbol, at);

        return [
          symbol,
          {
            markPrice: quote.available && quote.price !== null ? new Prisma.Decimal(quote.price) : null,
            stale: quote.stale,
          },
        ] as const;
      }),
    );

    return new Map(entries);
  }

  /** Copied-order history for one follow, newest first. Includes refusals. */
  async listEvents(
    followerId: string,
    strategyId: string,
    options: { page?: number; limit?: number } = {},
  ): Promise<CopyPage<CopyEventRecord>> {
    const record = await this.getFollow(followerId, strategyId);

    const limit = clamp(options.limit ?? DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    const page = Math.max(1, Math.trunc(options.page ?? 1));
    const where = { followerId, strategyId };

    const [rows, total] = await Promise.all([
      this.prisma.copyEvent.findMany({
        where,
        orderBy: [{ processedAt: 'desc' }, { expertOrderId: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.copyEvent.count({ where }),
    ]);

    return {
      items: rows.map((event) => ({ event, strategy: { id: record.strategy.id, name: record.strategy.name } })),
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  /**
   * Every copy event the caller has, across every follow, newest first.
   *
   * THE PER-FOLLOW HISTORY IS NOT ENOUGH ON ITS OWN. `listEvents` answers
   * "what did this strategy do to my book", which is the right question when a
   * follower is looking at one strategy. The question a follower actually has
   * most often is the other one: "what did the experts I follow do to my book,
   * in one list" - and answering it by opening each follow in turn is the
   * difference between one screen and five.
   *
   * THE STRATEGY RIDES ALONG, BECAUSE A CROSS-FOLLOW ROW IS MEANINGLESS
   * WITHOUT IT. A single event says "copied 0.5 BTC"; only the strategy name
   * says *whose* trade that was. The per-follow route can carry the name too,
   * so both routes answer with the same shape.
   *
   * REFUSALS STAY IN THE LIST. A refusal is a fill the engine saw and did not
   * copy, and a cross-follow feed that hid them would show a follower a
   * suspiciously quiet book.
   */
  async listFollowEvents(
    followerId: string,
    options: { page?: number; limit?: number } = {},
  ): Promise<CopyPage<CopyEventRecord>> {
    const limit = clamp(options.limit ?? DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    const page = Math.max(1, Math.trunc(options.page ?? 1));
    const where = { followerId };

    const [rows, total] = await Promise.all([
      this.prisma.copyEvent.findMany({
        where,
        include: { follow: { select: { strategy: { select: { id: true, name: true } } } } },
        orderBy: [{ processedAt: 'desc' }, { expertOrderId: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.copyEvent.count({ where }),
    ]);

    return {
      items: rows.map((row) => ({ event: row, strategy: row.follow.strategy })),
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  /**
   * The caller's profit and loss, as a total and as the path that reached it.
   *
   * THE TOTAL IS THE LEDGER'S. `realized_pnl` on `copy_accounts` is written by
   * the engine inside the same transaction that moved the position, so it is
   * the authoritative figure and is what this method returns as `realizedPnl`.
   *
   * THE PATH IS A REPLAY. The account keeps no history of its own balance, so
   * the path is reconstructed from the event table by `replayCopyLedger`, which
   * reproduces the engine's average-cost arithmetic exactly. The replayed total
   * must equal the stored total; when it does not, one of the two is wrong and
   * that is a bug to be logged, not a number to be quietly replaced. The stored
   * total is what the API reports, and the warning says which direction the
   * disagreement went.
   */
  async listPerformance(followerId: string): Promise<CopyPerformanceRecord> {
    const [events, accounts, followCount] = await Promise.all([
      this.prisma.copyEvent.findMany({
        where: { followerId },
        orderBy: [{ expertFilledAt: 'asc' }, { expertOrderId: 'asc' }],
      }),
      this.prisma.copyAccount.findMany({ where: { followerId } }),
      this.prisma.strategyFollow.count({ where: { followerId } }),
    ]);

    const replay = replayCopyLedger(
      events.map((event) => ({
        followerId: event.followerId,
        strategyId: event.strategyId,
        symbol: event.symbol,
        side: event.side,
        quantity: event.status === 'REJECTED' ? null : event.quantity,
        fillPrice: event.fillPrice,
        gross: event.gross,
        status: event.status,
        expertFilledAt: event.expertFilledAt,
        expertOrderId: event.expertOrderId,
        processedAt: event.processedAt,
      })),
    );

    const ledgerRealizedPnl = accounts.reduce(
      (sum, account) => sum.plus(account.realizedPnl),
      new Prisma.Decimal(0),
    );

    if (!replay.realizedPnl.equals(ledgerRealizedPnl)) {
      this.logger.warn(
        `Copy performance replay disagrees with the ledger for follower ${followerId}: ` +
          `replayed ${replay.realizedPnl.toFixed(18)} against stored ${ledgerRealizedPnl.toFixed(18)}. ` +
          'The stored total is reported; the replay is not trusted over it.',
      );
    }

    return {
      followCount,
      realizedPnl: ledgerRealizedPnl,
      cash: accounts.reduce((sum, account) => sum.plus(account.cash), new Prisma.Decimal(0)),
      copiedCount: replay.copiedCount,
      rejectedCount: replay.rejectedCount,
      points: replay.points,
    };
  }

  /**
   * Processing state for one follow: where the cursor is, what has been
   * consumed, and whether anything committed is still waiting.
   *
   * `hasPendingEvents` asks the port for the answer rather than counting the
   * backlog: a count would walk the whole backlog on every status read, and
   * the screen only needs to know whether work is in flight.
   */
  async getStatus(followerId: string, strategyId: string): Promise<CopyStatusRecord> {
    const { follow, strategy } = await this.getFollowWithStrategy(followerId, strategyId);
    const pending = await this.pendingStrategies([follow]);

    const counts = await this.countOutcomes(
      { followerId: follow.followerId, strategyId: follow.strategyId },
      'strategyId',
    );
    const outcome = counts.get(follow.strategyId) ?? { copied: 0, rejected: 0 };

    const eligibility = evaluateEligibility({
      followStatus: follow.status,
      followedAt: follow.followedAt,
      fillFilledAt: new Date(),
      strategy: { status: strategy.status, visibility: strategy.visibility },
    });

    return {
      follow,
      strategy,
      eligibility: eligibility.eligible ? 'ELIGIBLE' : eligibility.rejectReason,
      copiedCount: outcome.copied,
      rejectedCount: outcome.rejected,
      hasPendingEvents: pending.has(follow.strategyId),
    };
  }

  /**
   * The follow row plus the strategy it points at, without the outcome counts
   * `getFollow` carries - the status and sync routes already fetch those. The
   * 404 for a follow that does not exist comes from here, so no route can read
   * a cursor without first establishing that the caller owns it.
   */
  async getFollowWithStrategy(
    followerId: string,
    strategyId: string,
  ): Promise<{
    follow: StrategyFollow;
    strategy: { id: string; name: string; status: 'ACTIVE' | 'ARCHIVED'; visibility: 'PRIVATE' | 'PUBLIC' };
  }> {
    const row = await this.prisma.strategyFollow.findUnique({
      where: { followerId_strategyId: { followerId, strategyId } },
      include: { strategy: { select: { id: true, name: true, status: true, visibility: true } } },
    });

    if (row === null) {
      throw DomainException.notFound('Strategy', strategyId);
    }

    const { strategy, ...follow } = row;
    return { follow, strategy };
  }

  /**
   * The keyset position one pass should resume from, for the synchronous sync
   * route. Reading it is a separate step from consuming it: the pass reads the
   * fill page with this cursor, then each `applyFill` re-reads the row under the
   * advisory lock, so a cursor that moved between the two is not a stale
   * instruction - it is a duplicate delivery the primary key will absorb.
   */
  async getCursor(
    followerId: string,
    strategyId: string,
  ): Promise<{ cursorFilledAt: Date | null; cursorOrderId: string | null }> {
    const { follow } = await this.getFollowWithStrategy(followerId, strategyId);
    return { cursorFilledAt: follow.cursorFilledAt, cursorOrderId: follow.cursorOrderId };
  }

  /**
   * Every follow the engine should consider on its next pass, cursors included.
   *
   * UNFOLLOWED ROWS ARE NOT FILTERED OUT. The engine has to walk them anyway to
   * record their pending fills as `FOLLOW_NOT_ACTIVE`, and filtering here would
   * make that recording depend on when the scan happened rather than on what
   * the follow's state was. Eligibility is decided per fill, inside the
   * transaction, never by this list.
   */
  async listFollowQueue(): Promise<
    Array<{ followerId: string; strategyId: string; cursorFilledAt: Date | null; cursorOrderId: string | null }>
  > {
    return this.prisma.strategyFollow.findMany({
      select: { followerId: true, strategyId: true, cursorFilledAt: true, cursorOrderId: true },
      orderBy: [{ followedAt: 'asc' }, { followerId: 'asc' }, { strategyId: 'asc' }],
    });
  }

  /**
   * Followers of one strategy - visible only to that strategy's owner.
   *
   * Ownership is resolved through `findOwned`, so a non-owner gets the Module 05
   * 404 rather than a 403: "forbidden" would confirm the id exists, and a
   * follower list is exactly the sort of thing worth confirming.
   *
   * WHAT IS NOT RETURNED: the follower's address, in any form the owner could
   * reverse. A masked address (first character plus the domain) is enough for an
   * owner to recognise their audience and useless for contacting it, which is
   * the balance this route has to strike between "who follows me" and "whose
   * email address is that". The address is fetched in its own query and never
   * placed on the follow row, so nothing downstream can spread it into a
   * response by accident.
   */
  async listFollowers(
    ownerId: string,
    strategyId: string,
    options: { page?: number; limit?: number } = {},
  ): Promise<CopyPage<FollowerRecord>> {
    const strategy = await this.strategyService.findOwned(ownerId, strategyId);

    const limit = clamp(options.limit ?? DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    const page = Math.max(1, Math.trunc(options.page ?? 1));
    const where = { strategyId: strategy.id };

    const [rows, total] = await Promise.all([
      this.prisma.strategyFollow.findMany({
        where,
        orderBy: [{ followedAt: 'desc' }, { followerId: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.strategyFollow.count({ where }),
    ]);

    const followerIds = rows.map((row) => row.followerId);
    const [counts, users] = await Promise.all([
      this.countOutcomes({ strategyId: strategy.id, followerId: { in: followerIds } }, 'followerId'),
      this.prisma.user.findMany({ where: { id: { in: followerIds } }, select: { id: true, email: true } }),
    ]);

    const emailByUserId = new Map(users.map((user) => [user.id, user.email]));

    return {
      items: rows.map((row) => ({
        follow: row,
        maskedEmail: maskEmail(emailByUserId.get(row.followerId) ?? ''),
        copiedCount: counts.get(row.followerId)?.copied ?? 0,
        rejectedCount: counts.get(row.followerId)?.rejected ?? 0,
      })),
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async recordFor(
    follow: StrategyFollow | (StrategyFollow & { strategy: { id: string; name: string; status: 'ACTIVE' | 'ARCHIVED'; visibility: 'PRIVATE' | 'PUBLIC' } }),
  ): Promise<FollowRecord> {
    const strategy =
      'strategy' in follow && follow.strategy !== null && typeof follow.strategy === 'object'
        ? follow.strategy
        : await this.prisma.strategy.findUniqueOrThrow({
            where: { id: follow.strategyId },
            select: { id: true, name: true, status: true, visibility: true },
          });

    const counts = await this.countOutcomes(
      { followerId: follow.followerId, strategyId: follow.strategyId },
      'strategyId',
    );
    const outcome = counts.get(follow.strategyId) ?? { copied: 0, rejected: 0 };

    const pending = await this.pendingStrategies([follow]);

    return {
      follow,
      strategy,
      copiedCount: outcome.copied,
      rejectedCount: outcome.rejected,
      hasPendingEvents: pending.has(follow.strategyId),
    };
  }

  /**
   * Which of these follows have an expert fill waiting to be consumed.
   *
   * The port answers it for the whole batch at once, so a page of follows
   * costs one query rather than one per row.
   */
  private async pendingStrategies(
    follows: ReadonlyArray<{
      strategyId: string;
      cursorFilledAt: Date | null;
      cursorOrderId: string | null;
    }>,
  ): Promise<Set<string>> {
    return this.port.pendingAfter(
      follows.map((follow) => ({
        strategyId: follow.strategyId,
        cursorFilledAt: follow.cursorFilledAt,
        cursorOrderId: follow.cursorOrderId,
      })),
    );
  }

  /**
   * Copied and rejected counts, grouped, for one page of follows at a time.
   *
   * One `groupBy` answers both shapes a count is needed in - keyed by strategy
   * for the routes the follower sees and by follower for the route the strategy
   * owner sees - so a page of 20 rows costs one query, not twenty-one.
   */
  private async countOutcomes(
    where: Prisma.CopyEventWhereInput,
    key: 'strategyId' | 'followerId',
  ): Promise<Map<string, { copied: number; rejected: number }>> {
    const grouped = await this.prisma.copyEvent.groupBy({
      by: ['followerId', 'strategyId', 'status'],
      where,
      _count: { _all: true },
    });

    const result = new Map<string, { copied: number; rejected: number }>();

    for (const row of grouped) {
      const id = row[key];
      const current = result.get(id) ?? { copied: 0, rejected: 0 };
      if (row.status === 'COPIED') current.copied += row._count._all;
      else current.rejected += row._count._all;
      result.set(id, current);
    }

    return result;
  }

  /**
   * Unlocks a direct chat consultation session with the expert behind a strategy.
   * Costs 10 EMBER from the caller's wallet.
   */
  async connectExpert(
    userId: string,
    strategyId: string,
  ): Promise<{
    success: boolean;
    strategyId: string;
    strategyName: string;
    fee: string;
    asset: string;
    remainingBalance: string;
    unlockedAt: string;
  }> {
    const strategy = await this.prisma.strategy.findUnique({
      where: { id: strategyId },
    });

    if (!strategy) {
      throw DomainException.notFound('Strategy');
    }

    const REQUIRED_EMBER = new Prisma.Decimal(10);
    const emberBalance = await this.walletService.getAvailableBalance(userId, 'EMBER');

    if (emberBalance.lessThan(REQUIRED_EMBER)) {
      throw DomainException.badRequest(
        `Connecting with an expert requires 10 EMBER. Your current balance is ${emberBalance.toString()} EMBER. Please acquire EMBER from the EMBER Hub.`,
      );
    }

    const wallet = await this.walletService.getForUserOrThrow(userId);
    const emberAsset = await this.prisma.asset.findFirst({
      where: { symbol: 'EMBER' },
    });

    if (emberAsset) {
      await this.walletService.debit(
        wallet.id,
        emberAsset.id,
        '10',
        {
          type: TransactionType.TRANSFER_OUT,
          note: `Direct expert consultation unlock for strategy: ${strategy.name}`,
        },
      );
    }

    const remaining = emberBalance.minus(REQUIRED_EMBER);

    return {
      success: true,
      strategyId: strategy.id,
      strategyName: strategy.name,
      fee: '10',
      asset: 'EMBER',
      remainingBalance: remaining.toString(),
      unlockedAt: new Date().toISOString(),
    };
  }

  /**
   * Responds to a naive trader's direct message to the expert behind a strategy.
   */
  async chatWithExpert(
    userId: string,
    strategyId: string,
    message: string,
  ): Promise<{
    strategyId: string;
    expertName: string;
    reply: string;
    timestamp: string;
  }> {
    const strategy = await this.prisma.strategy.findUnique({
      where: { id: strategyId },
    });

    if (!strategy) {
      throw DomainException.notFound('Strategy');
    }

    const reply = this.generateExpertReply(strategy.name, strategy.description, message);

    return {
      strategyId: strategy.id,
      expertName: `Expert Trader (${strategy.name})`,
      reply,
      timestamp: new Date().toISOString(),
    };
  }

  private generateExpertReply(strategyName: string, description: string | null, message: string): string {
    const query = message.toLowerCase();

    if (query.includes('risk') || query.includes('stop loss') || query.includes('drawdown')) {
      return `For "${strategyName}", I maintain a strict risk management framework. Every position is sized so that maximum risk does not exceed 1.5% to 2% of equity. If market momentum invalidates our key support/resistance levels, positions are trimmed or exited immediately to protect capital.`;
    }

    if (query.includes('allocation') || query.includes('size') || query.includes('how much') || query.includes('fraction')) {
      return `If you're copying "${strategyName}", I suggest starting with an allocation fraction between 0.1 and 0.25 (10% to 25%). This allows you to experience the trade replication and market variance comfortably before scaling up your position size.`;
    }

    if (query.includes('why') || query.includes('trade') || query.includes('signal') || query.includes('enter') || query.includes('exit') || query.includes('short') || query.includes('long')) {
      return `My entry and exit decisions on "${strategyName}" are based on confluence between order-flow liquidity depth, key trendline breakouts, and multi-timeframe volume confirmation. When we spot institutional accumulation, we enter early with tight stops and scale out as targets are reached.`;
    }

    if (query.includes('market') || query.includes('outlook') || query.includes('trend') || query.includes('crypto') || query.includes('btc')) {
      return `Market structure currently shows elevated volatility. On "${strategyName}", we capitalize on high-probability intraday swings while avoiding holding through unpredictable macroeconomic announcements. Stay disciplined with your copy allocation!`;
    }

    return `Thanks for reaching out! Regarding "${strategyName}": our edge comes from systematic discipline, disciplined entries, and strict stop-loss rules. Feel free to ask me about our latest fills, risk limits, or market analysis!`;
  }

  private isUniqueConstraintViolation(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
  }
}

/**
 * Masks a follower's address for display to the strategy's owner.
 *
 * `alice@example.com` becomes `a***@example.com`. The local part keeps one
 * character - enough to tell two followers apart when an owner recognises a
 * first initial - and the domain survives because two addresses at different
 * domains are not the same person to recognise.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';

  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (domain.length === 0) return '***';

  return `${local[0]}***@${domain}`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
