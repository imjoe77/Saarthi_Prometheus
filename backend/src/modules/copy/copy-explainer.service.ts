import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../database/prisma.service';
import { decimalString } from '../market-data/domain/decimal-string';
import { CopyService } from './copy.service';
import {
  copyFillKey,
  isClosingEffect,
  isOpeningEffect,
  replayCopyFills,
  type CopyFillOutcome,
} from './domain/copy-replay';
import {
  classifyCopyWording,
  composeCopyExplanation,
  isBookQuestion,
  selectEventForIntent,
  type CopyEventFact,
  type CopyExplanation,
  type CopyExplanationFacts,
  type CopyPositionFact,
} from './domain/copy-explanation';

/** How many recent fills to read when resolving which trade is being asked about. */
const RECENT_EVENT_LIMIT = 50;

/** How many fills of history the book replay may read. */
const HISTORY_LIMIT = 500;

/** The page points at a row with an id of this shape. */
const EVENT_FOCUS_PREFIX = 'copy-event:';

/** One row of the copy ledger, as Prisma reads it. */
type CopyEventRow = {
  expertOrderId: string;
  strategyId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  expertQuantity: Prisma.Decimal;
  expertFillPrice: Prisma.Decimal | null;
  expertFilledAt: Date;
  allocationFraction: Prisma.Decimal;
  quantity: Prisma.Decimal;
  fillPrice: Prisma.Decimal | null;
  gross: Prisma.Decimal | null;
  realizedPnl: Prisma.Decimal | null;
  status: 'COPIED' | 'REJECTED';
  rejectReason: string | null;
  follow: { strategy: { name: string; description: string | null } };
};

/**
 * MODULE 07 - answering "why did that trade happen?" from the copy ledger.
 *
 * THE CALLER'S OWN BOOK, READ SERVER SIDE. The follower is identified by the
 * verified token, never by anything in the request, so this service can only
 * ever explain the caller's own trades. The browser may say *which* trade it
 * means; it can never say what that trade was.
 *
 * THE PAGE POINTS, THE LEDGER ANSWERS. A page that shows a trade row can hand
 * over a pointer - the symbol in view, or the id of the row in question - and
 * this service resolves that pointer against the ledger and reads the facts
 * itself. Nothing the browser sends can change a number in the answer.
 */
@Injectable()
export class CopyExplainerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly copyService: CopyService,
  ) {}

  /**
   * Explains the trade the question is about.
   *
   * Returns null when the caller's book holds nothing that could answer it -
   * no position, no copied fill, no refusal. The caller then falls back to the
   * general knowledge base, which is a true answer about concepts and an
   * untrue one about a book that does not exist.
   */
  async explain(followerId: string, query: string, symbol: string | null, focusId: string | null): Promise<CopyExplanation | null> {
    const account = await this.copyService.getAggregateAccount(followerId);

    const history = await this.prisma.copyEvent.findMany({
      where: { followerId },
      include: { follow: { select: { strategy: { select: { name: true, description: true } } } } },
      orderBy: [{ expertFilledAt: 'desc' }, { expertOrderId: 'desc' }],
      take: HISTORY_LIMIT + 1,
    });

    if (account.positions.length === 0 && history.length === 0) return null;

    const knownSymbols = [
      ...account.positions.map((position) => position.symbol),
      ...history.map((event) => event.symbol),
    ];

    // A question about the words ("what is a short position?") is the general
    // knowledge base's to answer, and it answers it better. The ledger only
    // speaks when the question is about the reader's own book, or when the
    // reader pointed at a row.
    if (focusId === null && !isBookQuestion(query, knownSymbols)) return null;

    // The replay needs the fills that OPENED the book, so the history has to
    // be whole. One row more than the replay's reach means it is not, and a
    // partial replay would call the oldest fill it can see an opening when it
    // was really an addition - a confident wrong answer. So the history is
    // read newest first, and the extra row is the signal that the book runs
    // deeper than the replay can follow.
    const complete = history.length <= HISTORY_LIMIT;
    const outcomes = complete ? this.replay(history) : new Map<string, CopyFillOutcome>();

    const events = history.slice(0, RECENT_EVENT_LIMIT);

    const facts = await this.buildFacts(followerId, account, history, events, outcomes, query, symbol, focusId);
    return composeCopyExplanation(facts, query);
  }

  /**
   * Replays the follower's own fills through the same net-book kernel the copy
   * engine used, so each row learns what it did to the holding it met.
   */
  private replay(history: CopyEventRow[]): Map<string, CopyFillOutcome> {
    return replayCopyFills(
      history.map((event) => ({
        expertOrderId: event.expertOrderId,
        strategyId: event.strategyId,
        symbol: event.symbol,
        side: event.side,
        quantity: event.status === 'REJECTED' ? null : decimalString(event.quantity),
        fillPrice: event.fillPrice === null ? null : decimalString(event.fillPrice),
        expertFilledAt: event.expertFilledAt.toISOString(),
        status: event.status,
      })),
    );
  }

  /** Turns one ledger row into the fact the composer is allowed to know. */
  private toEventFact(event: CopyEventRow, outcomes: Map<string, CopyFillOutcome>): CopyEventFact {
    const outcome = outcomes.get(copyFillKey(event.strategyId, event.expertOrderId));
    const stored = event.realizedPnl === null ? null : decimalString(event.realizedPnl);

    // A row written before the net-book migration recorded a zero for every
    // fill, because the column was NOT NULL DEFAULT 0 back then. A stored
    // zero therefore says nothing about the fill, and the replay's figure -
    // the one the pot actually booked - is the honest one.
    const realizedPnl = stored !== null && stored !== '0' ? stored : (outcome?.realizedPnl ?? null);

    return {
      expertOrderId: event.expertOrderId,
      symbol: event.symbol,
      side: event.side,
      expertQuantity: decimalString(event.expertQuantity),
      expertFillPrice: event.expertFillPrice === null ? null : decimalString(event.expertFillPrice),
      expertFilledAt: event.expertFilledAt.toISOString(),
      allocationFraction: decimalString(event.allocationFraction),
      quantity: event.status === 'REJECTED' ? null : decimalString(event.quantity),
      fillPrice: event.fillPrice === null ? null : decimalString(event.fillPrice),
      gross: event.gross === null ? null : decimalString(event.gross),
      realizedPnl,
      status: event.status,
      rejectReason: event.rejectReason,
      strategyName: event.follow.strategy.name,
      effect: outcome?.effect ?? null,
    };
  }

  private async buildFacts(
    followerId: string,
    account: Awaited<ReturnType<CopyService['getAggregateAccount']>>,
    history: CopyEventRow[],
    events: CopyEventRow[],
    outcomes: Map<string, CopyFillOutcome>,
    query: string,
    symbolHint: string | null,
    focusId: string | null,
  ): Promise<CopyExplanationFacts> {
    const eventFacts: CopyEventFact[] = events.map((event) => this.toEventFact(event, outcomes));

    // The row the reader pointed at wins over everything else. The pointer may
    // name a row older than the recent window the page shows, so the whole
    // history is searched for it - the reader pointed at it, and it is there.
    const focusedId = focusId?.startsWith(EVENT_FOCUS_PREFIX)
      ? focusId.slice(EVENT_FOCUS_PREFIX.length)
      : null;
    const focusedRow =
      focusedId === null
        ? null
        : (events.find((event) => event.expertOrderId === focusedId) ??
          history.find((event) => event.expertOrderId === focusedId) ??
          null);
    const focusedEvent = focusedRow === null ? null : this.toEventFact(focusedRow, outcomes);

    const knownSymbols = new Set<string>([
      ...account.positions.map((position) => position.symbol),
      ...eventFacts.map((event) => event.symbol),
    ]);

    const resolvedSymbol =
      focusedEvent?.symbol ??
      this.matchSymbol(symbolHint, knownSymbols) ??
      this.matchSymbolFromText(query, knownSymbols) ??
      eventFacts[0]?.symbol ??
      account.positions[0]?.symbol ??
      null;

    const scoped = resolvedSymbol === null ? [] : eventFacts.filter((event) => event.symbol === resolvedSymbol);

    // The wording says which KIND of event is being asked about; the pointer
    // says which row is in view. When the question is about an exit, the exit
    // is the answer even if the pointer is on the entry that preceded it -
    // "why did it sell" and "why did it buy" are different questions about the
    // same market.
    const wording = classifyCopyWording(query);
    const intent = wording.score > 0 ? wording.intent : null;

    const latestEvent =
      intent === 'WHY_EXIT'
        ? (focusedEvent !== null && isClosingEffect(focusedEvent.effect)
            ? focusedEvent
            : (scoped.find((event) => isClosingEffect(event.effect)) ?? null))
        : (focusedEvent ?? selectEventForIntent(intent, scoped, wording.side));

    const lastEvent = focusedEvent ?? scoped[0] ?? eventFacts[0] ?? null;

    // Which way the holding points. A fill that opened or added to a holding
    // carries the holding's own direction, which is what tells a long apart
    // from a short once the position has been closed again.
    const entryEvent =
      scoped.find((event) => event.status === 'COPIED' && isOpeningEffect(event.effect)) ?? null;

    const positionRow =
      account.positions.find(
        (row) =>
          row.symbol === resolvedSymbol &&
          (entryEvent === null || row.direction === entryEvent.side),
      ) ??
      account.positions.find((row) => row.symbol === resolvedSymbol) ??
      null;

    const openedAt = positionRow
      ? (
          await this.prisma.copyPosition.findFirst({
            where: { followerId, symbol: positionRow.symbol, direction: positionRow.direction },
            orderBy: { openedAt: 'asc' },
            select: { openedAt: true },
          })
        )?.openedAt ?? null
      : null;

    const position: CopyPositionFact | null =
      positionRow === null
        ? null
        : {
            symbol: positionRow.symbol,
            direction: positionRow.direction,
            quantity: decimalString(positionRow.quantity),
            averageEntryPrice: decimalString(positionRow.averageEntryPrice),
            markPrice: positionRow.markPrice === null ? null : decimalString(positionRow.markPrice),
            marketValue: positionRow.marketValue === null ? null : decimalString(positionRow.marketValue),
            unrealizedPnl: positionRow.unrealizedPnl === null ? null : decimalString(positionRow.unrealizedPnl),
            stale: positionRow.stale,
            openedAt: (openedAt ?? new Date(0)).toISOString(),
          };

    const strategyDescription =
      (latestEvent !== null
        ? history.find((event) => event.expertOrderId === latestEvent.expertOrderId)?.follow.strategy.description
        : null) ??
      history.find((event) => event.symbol === resolvedSymbol)?.follow.strategy.description ??
      null;

    return {
      symbol: resolvedSymbol,
      strategyDescription,
      position,
      latestEvent,
      lastEvent,
      holdingDirection: positionRow?.direction ?? entryEvent?.side ?? null,
      recentEvents: scoped,
      walletUsdt: decimalString(account.walletUsdt),
    };
  }

  /** A page's hint, matched against the symbols this caller actually holds. */
  private matchSymbol(hint: string | null, known: Set<string>): string | null {
    if (!hint) return null;
    const wanted = hint.trim().toUpperCase();
    for (const symbol of known) {
      if (symbol.toUpperCase() === wanted) return symbol;
    }
    return null;
  }

  /** A symbol named in the question itself. */
  private matchSymbolFromText(query: string, known: Set<string>): string | null {
    const text = query.toUpperCase();
    for (const symbol of known) {
      const upper = symbol.toUpperCase();
      if (text.includes(upper)) return symbol;
    }
    return null;
  }
}
