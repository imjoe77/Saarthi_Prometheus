/**
 * MODULE 07 - explaining a copy trade from the copy ledger.
 *
 * WHY THIS EXISTS. The trade-buddy widget can only answer general questions
 * ("what is a short position?") because a general question is all a glossary can
 * answer. But the questions a follower actually asks are about *their own*
 * book: "why was it short at this point?", "why did it sell here?", "why is my
 * quantity smaller than the expert's?". Those have answers, and the answers are
 * already recorded - `copy_events` stores every consumed expert fill with its
 * direction, prices, size, allocation, outcome and refusal reason, and
 * `copy_positions` stores the holding that resulted. So the explanation does
 * not need a trained model; it needs the ledger and a way to read it.
 *
 * THE HONESTY RULE. The ledger records what the expert DID, never why they
 * believed it. So no sentence here may claim to know an expert's reasoning.
 * The one place a rationale exists is the strategy's own description, written
 * by the expert, and it is quoted as a quote. Everything else is arithmetic on
 * rows that exist.
 *
 * PURE BY DESIGN. Everything here is a function of plain facts, with no
 * database and no clock, so the behaviour can be pinned down by tests: an
 * answer that changes when no fact changed would be the model talking, and
 * that is exactly what this module replaces.
 */

import { isClosingEffect, isOpeningEffect, type CopyFillEffect } from './copy-replay';

/** What the reader is asking about. */
export type CopyQuestionIntent =
  | 'WHY_DIRECTION'
  | 'WHY_ENTRY'
  | 'WHY_EXIT'
  | 'WHY_REJECTED'
  | 'WHY_SIZE'
  | 'POSITION_STATUS';

/** One consumed expert fill, as the ledger holds it. */
export interface CopyEventFact {
  expertOrderId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  expertQuantity: string;
  expertFillPrice: string | null;
  expertFilledAt: string;
  allocationFraction: string;
  quantity: string | null;
  fillPrice: string | null;
  gross: string | null;
  realizedPnl: string | null;
  status: 'COPIED' | 'REJECTED';
  rejectReason: string | null;
  strategyName: string;
  /** What the fill did to the holding, worked out by replaying the book. */
  effect: CopyFillEffect | null;
}

/** The holding one symbol ended up in, marked at the market when a price exists. */
export interface CopyPositionFact {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  quantity: string;
  averageEntryPrice: string;
  markPrice: string | null;
  marketValue: string | null;
  unrealizedPnl: string | null;
  stale: boolean;
  openedAt: string;
}

/** Everything the composer is allowed to know. */
export interface CopyExplanationFacts {
  /** The market the question is about, once it has been resolved. */
  symbol: string | null;
  /** The expert's own description of their strategy, if they wrote one. */
  strategyDescription: string | null;
  position: CopyPositionFact | null;
  /** The event the answer is about. Null when the question asks for a kind of
   *  event the ledger does not hold - an exit that never happened. */
  latestEvent: CopyEventFact | null;
  /** The most recent event for this market, whatever kind it was. It is what
   *  keeps "no exit was copied" from being "nothing happened". */
  lastEvent: CopyEventFact | null;
  /** Which way the holding points, when the ledger can say. */
  holdingDirection: 'LONG' | 'SHORT' | null;
  /** Newest first. The ledger's own order. */
  recentEvents: CopyEventFact[];
  /** The caller's real USDT balance - the gate on every copy. */
  walletUsdt: string | null;
}

/** The answer shape the trade-buddy widget renders. */
export interface CopyExplanation {
  concept: string;
  sections: {
    what: string;
    simple: string;
    howItWorks: string;
    example: string;
    remember: string;
  };
}

/** The widget's own caps. An answer that overflows them is truncated by the
 *  widget, so it is trimmed here where the trimming can be understood. */
const CONCEPT_MAX = 120;
const SECTION_MAX = 1800;

const DIRECTION_WORDS = [
  'short',
  'long',
  'bearish',
  'bullish',
  'direction',
  'why was it',
  'why did it go',
  'why did you go',
  'why did he choose',
  'why did they choose',
  'why choose',
  'why did he',
  'why did they',
  'why did she',
  'choose',
  'chose',
  'reason',
  'rationale',
];

const EXIT_WORDS = [
  'sold',
  'sell',
  'exit',
  'exited',
  'close',
  'closed',
  'reduce',
  'reduced',
  'take profit',
  'trimmed',
];

const REJECTION_WORDS = [
  'rejected',
  'refused',
  'not copied',
  'was not copied',
  'wasnt copied',
  'no copy',
  'nothing copied',
  'why did i not',
  'why didnt i',
  'why did not',
  'missing',
];

const SIZE_WORDS = [
  'smaller',
  'bigger',
  'size',
  'sized',
  'quantity',
  'how much',
  'allocation',
  'percentage',
  'percent',
  'fraction',
  'less than',
  'notional',
];

const STATUS_WORDS = [
  'my position',
  'unrealised',
  'unrealized',
  'profit',
  'loss',
  'pnl',
  'p and l',
  'how am i doing',
  'how am i',
  'worth',
  'worth now',
  'status',
  'open position',
  'current position',
];

/** Words that put the reader's own book into the question. */
const FIRST_PERSON_WORDS = ['my', 'mine', 'i', 'me', 'myself'];

/** Words that point at something the reader can see. */
const POINTING_WORDS = ['this', 'it', 'here', 'now', 'that', 'tht'];

/** The things a copy book is made of. */
const BOOK_SUBJECT_WORDS = [
  'position',
  'positions',
  'trade',
  'trades',
  'traded',
  'copy',
  'copies',
  'order',
  'orders',
  'fill',
  'fills',
  'holding',
  'portfolio',
  'balance',
  'pnl',
  'expert',
  'strategy',
  'quantity',
  'allocation',
  'entry',
  'exit',
  'sell',
  'sold',
  'buy',
  'bought',
  'choose',
  'chose',
];

/** Openers that mark a question about something that happened. */
const QUESTION_OPENER_WORDS = ['why', 'how did', 'how much', 'how was'];

/**
 * Words that name a direction outright.
 *
 * "Why was it short at this point?" is a question about the short, and the
 * short is one specific trade among the ones the reader can see. So the side
 * the question names decides which row answers it.
 */
const SIDE_WORDS: Array<['LONG' | 'SHORT', string[]]> = [
  ['SHORT', ['short', 'bearish', 'sell', 'sold', 'selling']],
  ['LONG', ['long', 'bullish', 'buy', 'bought', 'buying']],
];

/**
 * Whether the question is about the reader's own book rather than about a
 * concept in general.
 *
 * The ledger can answer "why was it short at this point" precisely, but "what
 * is a short position" is a question about the words, and answering it from a
 * ledger would trade a true general answer for a true but irrelevant specific
 * one. So the ledger only answers when the question points at the reader's own
 * trades: by speaking in the first person, by pointing at something on the
 * page, or by naming a market the reader actually holds.
 */
export function isBookQuestion(query: string, knownSymbols: string[]): boolean {
  const text = ` ${query.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()} `;
  const words = text.trim().split(' ').filter(Boolean);

  const firstPerson = words.some((word) => FIRST_PERSON_WORDS.includes(word));
  const pointing = POINTING_WORDS.some((word) => text.includes(` ${word} `));
  const subject = words.some((word) => BOOK_SUBJECT_WORDS.includes(word));
  const namesSymbol = knownSymbols.some((symbol) => text.includes(symbol.toLowerCase()));
  const opensAQuestion = QUESTION_OPENER_WORDS.some((word) => text.includes(` ${word} `));

  if (namesSymbol) return true;
  if (firstPerson && (subject || pointing)) return true;
  if (pointing && subject) return true;
  if (opensAQuestion && (firstPerson || pointing || subject)) return true;

  return false;
}

/**
 * Picks the intent from the wording alone.
 *
 * Split out from {@link classifyCopyQuestion} because the ledger is needed to
 * answer the question *and* to choose which row to answer about: "why did it
 * sell" asks for a reducing fill, and the row that carries it is not the row
 * the question would otherwise land on.
 */
export function classifyCopyWording(query: string): { intent: CopyQuestionIntent; score: number; side: 'LONG' | 'SHORT' | null } {
  const text = ` ${query.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()} `;

  const scores: Array<[CopyQuestionIntent, number]> = [
    ['WHY_REJECTED', score(text, REJECTION_WORDS)],
    ['WHY_EXIT', score(text, EXIT_WORDS)],
    ['WHY_SIZE', score(text, SIZE_WORDS)],
    ['WHY_DIRECTION', score(text, DIRECTION_WORDS)],
    ['POSITION_STATUS', score(text, STATUS_WORDS)],
  ];

  scores.sort((left, right) => right[1] - left[1]);
  const [bestIntent, bestScore] = scores[0] ?? (['POSITION_STATUS', 0] as const);

  let side: 'LONG' | 'SHORT' | null = null;
  for (const [direction, words] of SIDE_WORDS) {
    if (score(text, words) > 0) {
      side = direction;
      break;
    }
  }

  return { intent: bestIntent, score: bestScore, side };
}

/**
 * Picks the intent from the question and the facts.
 *
 * The question decides; the facts only break ties. A refusal is recognised
 * from the ledger rather than guessed from wording, so "what happened to my
 * BTC/USD order" against a refused fill is answered as a refusal.
 */
export function classifyCopyQuestion(query: string, facts: CopyExplanationFacts): CopyQuestionIntent {
  const wording = classifyCopyWording(query);
  if (wording.score > 0) return wording.intent;

  // No wording signal. A refused fill is a refusal whatever it is called.
  if (facts.latestEvent?.status === 'REJECTED') return 'WHY_REJECTED';

  // Otherwise the question is about the trade itself.
  return facts.latestEvent !== null || facts.position !== null ? 'WHY_DIRECTION' : 'POSITION_STATUS';
}

/**
 * An event that opened or added to a holding.
 *
 * The ledger does not record this - it is worked out by replaying the book -
 * so an event whose effect could not be established is neither an opening nor
 * a closing, and no answer claims it is.
 */
function isEntry(event: CopyEventFact): boolean {
  return isOpeningEffect(event.effect);
}

/** An event that closed part of a holding against it. */
function isExit(event: CopyEventFact): boolean {
  return isClosingEffect(event.effect);
}

/**
 * Chooses the row the question is about.
 *
 * The events arrive newest first. A question about a direction wants the fill
 * that opened the holding; a question about an exit wants the fill that closed
 * part of it; a question about a refusal wants the refusal. An exit question
 * that the ledger cannot answer returns null rather than the entry that
 * precedes it, because "you did not sell" and "you sold here" are different
 * answers.
 */
export function selectEventForIntent(
  intent: CopyQuestionIntent | null,
  events: CopyEventFact[],
  side: 'LONG' | 'SHORT' | null = null,
): CopyEventFact | null {
  if (events.length === 0) return null;

  if (intent === 'WHY_EXIT') return events.find(isExit) ?? null;
  if (intent === 'WHY_REJECTED') return events.find((event) => event.status === 'REJECTED') ?? null;
  if (intent === 'WHY_DIRECTION' || intent === 'WHY_ENTRY') {
    // The question names a side, and the trade it is about is the one that
    // carried that side - not the newest trade of any kind.
    if (side !== null) {
      const named = events.find((event) => event.status === 'COPIED' && event.side === side);
      if (named !== undefined) return named;
    }
    return (
      events.find((event) => event.status === 'COPIED' && isEntry(event)) ??
      events.find((event) => event.status === 'COPIED') ??
      events[0] ??
      null
    );
  }
  if (intent === 'WHY_SIZE') {
    return events.find((event) => event.status === 'COPIED') ?? events[0] ?? null;
  }
  return events[0] ?? null;
}

function score(text: string, words: string[]): number {
  let total = 0;
  for (const word of words) {
    if (text.includes(` ${word} `)) total += 1;
  }
  return total;
}

/**
 * Composes the explanation.
 *
 * Returns null when there is nothing at all to say - no symbol, no position and
 * no event - so the caller can fall back to the general knowledge base rather
 * than invent an answer about a book that does not exist.
 */
export function composeCopyExplanation(
  facts: CopyExplanationFacts,
  query: string,
): CopyExplanation | null {
  const event = facts.latestEvent;
  const position = facts.position;

  if (event === null && position === null && facts.lastEvent === null) return null;

  const intent = classifyCopyQuestion(query, facts);
  const symbol = facts.symbol ?? event?.symbol ?? position?.symbol ?? 'this market';

  // A fill that reduced the holding is the other side of the book: the expert
  // was against the holding, not with it. Telling it as "the expert went
  // long" would say the opposite of what happened, so a direction question
  // about such a fill is answered as the exit it was.
  const reduction = event !== null && event.status === 'COPIED' && isClosingEffect(event.effect);

  const answer =
    intent === 'WHY_REJECTED'
      ? explainRejection(event, symbol)
      : intent === 'WHY_EXIT'
        ? explainExit(event, position, symbol, facts)
        : intent === 'WHY_ENTRY'
          ? explainEntry(event, position, symbol, facts)
          : intent === 'WHY_SIZE'
            ? explainSize(event, position, symbol)
            : intent === 'POSITION_STATUS'
              ? explainStatus(position, event, symbol, facts)
              : reduction
                ? explainExit(event, position, symbol, facts)
                : explainDirection(event, position, symbol, facts);

  return {
    concept: answer.concept.slice(0, CONCEPT_MAX),
    sections: {
      what: answer.sections.what.slice(0, SECTION_MAX),
      simple: answer.sections.simple.slice(0, SECTION_MAX),
      howItWorks: answer.sections.howItWorks.slice(0, SECTION_MAX),
      example: answer.sections.example.slice(0, SECTION_MAX),
      remember: answer.sections.remember.slice(0, SECTION_MAX),
    },
  };
}

/** "a short position" / "a long position", in words a newcomer can follow. */
function directionWord(direction: 'LONG' | 'SHORT'): string {
  return direction === 'SHORT' ? 'a short position' : 'a long position';
}

/** What a LONG and a SHORT mean, without pretending it is advice. */
function directionMeaning(direction: 'LONG' | 'SHORT'): string {
  return direction === 'SHORT'
    ? 'A short means you sell first and buy back later. You make money if the price falls and lose if it rises.'
    : 'A long means you buy first and sell later. You make money if the price rises and lose if it falls.';
}

/** The expert's own words, when they wrote any. Never paraphrased. */
function expertRationale(facts: CopyExplanationFacts): string {
  const description = facts.strategyDescription?.trim();
  if (!description) {
    return 'The platform records what the expert did, not what they were thinking. Nothing in the ledger explains the reasoning behind the trade.';
  }
  return `The strategy's own description, written by the expert, says: "${description}"`;
}

/** `2026-10-31 17:12 UTC` - unambiguous, and identical on every machine. */
function stamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
  );
}

/** The mark, stated as "not priced" rather than as a zero. */
function markSentence(position: CopyPositionFact | null): string {
  if (position === null) return '';
  if (position.markPrice === null) {
    return `The market price for ${position.symbol} is not available right now, so the holding has no honest market value at this moment.`;
  }
  const stale = position.stale ? ' (this price is stale)' : '';
  const value = position.marketValue ?? 'not available';
  const pnl = position.unrealizedPnl ?? 'not available';
  return (
    `It is marked at ${position.markPrice}${stale}, worth ${value}, ` +
    `for an unrealised profit or loss of ${pnl}.`
  );
}

// ---------------------------------------------------------------------------
// The four answers
// ---------------------------------------------------------------------------

function explainDirection(
  event: CopyEventFact | null,
  position: CopyPositionFact | null,
  symbol: string,
  facts: CopyExplanationFacts,
): CopyExplanation {
  // The direction being explained is the one the trade itself carried. The
  // holding's direction is what the reader holds now, and the two differ when
  // the expert has traded against the holding since.
  const side = event?.side ?? facts.holdingDirection ?? position?.direction ?? 'LONG';
  const holding = facts.holdingDirection ?? position?.direction ?? side;

  const what = event
    ? `On ${stamp(event.expertFilledAt)} the expert behind "${event.strategyName}" ` +
      (event.effect === 'OPEN'
        ? `opened a ${side.toLowerCase()} position in ${event.symbol}, `
        : event.effect === 'ADD'
          ? `added to their ${side.toLowerCase()} position in ${event.symbol}, `
          : `went ${side} on ${event.symbol}, `) +
      `filling ${event.expertQuantity} at ${event.expertFillPrice ?? 'no price'}. ` +
      (event.status === 'REJECTED'
        ? `Your copy of that fill was refused, so it did not open this holding.`
        : `Your copy mirrored that fill` +
          (event.quantity !== null
            ? `: ${event.quantity} at ${event.fillPrice ?? 'no price'}, sized as ${event.allocationFraction} of the expert's order.`
            : '.'))
    : `Your holding in ${symbol} is ${holding}. There is no copied fill recorded against it yet.`;

  return {
    concept: `Why ${symbol} is ${side}`,
    sections: {
      what,
      simple:
        (event === null
          ? `Your holding in ${symbol} is ${holding === 'SHORT' ? 'short' : 'long'}. `
          : `The expert traded ${side} on ${symbol}, so your copy traded ${side} too. `) +
        (side === 'SHORT'
          ? 'In trading, taking a short position reflects a thesis that the asset price will decline, aiming to buy it back cheaper later.'
          : 'In trading, taking a long position reflects a thesis that the asset price will appreciate, aiming to sell it higher later.') +
        ' The copy engine mirrors the expert\'s direction automatically - it does not make its own directional calls.' +
        (holding !== side
          ? ` Your holding now points ${holding.toLowerCase()}, because a later fill went the other way.`
          : ''),
      howItWorks:
        directionMeaning(side) +
        (event
          ? ` Your order was sized as the expert's ${event.expertQuantity} times your allocation of ${event.allocationFraction}, producing ${event.quantity ?? 'a scaled'} fill.`
          : '') +
        (event?.effect === 'ADD'
          ? ` Because the expert was adding to an existing position, this fill increased your exposure and blended into your average entry price.`
          : event?.effect === 'OPEN'
            ? ` This was an initial entry opening a new directional holding in your copy pot.`
            : ''),
      example:
        (position
          ? `You hold ${position.quantity} of ${position.symbol}, entered at an average price of ${position.averageEntryPrice}. `
          : '') + markSentence(position),
      remember:
        `${expertRationale(facts)} A copy is a mirror, not advice: the expert's timing is copied, and the profit or loss is yours to carry.`,
    },
  };
}

function explainEntry(
  event: CopyEventFact | null,
  position: CopyPositionFact | null,
  symbol: string,
  facts: CopyExplanationFacts,
): CopyExplanation {
  const side = event?.side ?? position?.direction ?? 'LONG';
  const price = event?.expertFillPrice ?? event?.fillPrice ?? position?.averageEntryPrice ?? 'no price';

  return {
    concept: `Why ${symbol} was entered at ${price}`,
    sections: {
      what:
        event === null
          ? `There is no copied fill recorded for ${symbol}.`
          : `On ${stamp(event.expertFilledAt)} the expert behind "${event.strategyName}" filled ${side} ${event.expertQuantity} of ${event.symbol} at ${event.expertFillPrice ?? 'no price'}. ` +
            `Your copy filled at ${event.fillPrice ?? 'no price'}${event.quantity !== null ? ` for ${event.quantity}` : ''}.`,
      simple:
        'Your copy fills at the same price the expert filled at. The engine mirrors committed fills - it does not re-price them, and it does not wait for a better moment.',
      howItWorks:
        `The copy is scaled by your allocation of ${event?.allocationFraction ?? 'your chosen fraction'} of the expert's size, then filled at the expert's fill price. ` +
        (event?.gross ? `That made the notional ${event.gross}.` : ''),
      example:
        (position
          ? `Your average entry in ${position.symbol} is ${position.averageEntryPrice}. `
          : '') + markSentence(position),
      remember:
        `${expertRationale(facts)} The price you got is the expert's price, so the timing is theirs too - you cannot choose a different entry than the one you copied.`,
    },
  };
}

function explainExit(
  event: CopyEventFact | null,
  position: CopyPositionFact | null,
  symbol: string,
  facts: CopyExplanationFacts,
): CopyExplanation {
  const holding = facts.holdingDirection ?? position?.direction ?? null;
  const last = facts.lastEvent;
  const realised = event?.realizedPnl;
  // The side the expert traded. A SHORT here is a sale, and the sale is what
  // the reader saw on the tape - so it is named rather than left implicit.
  const traded = event?.side === 'SHORT' ? 'sold' : event?.side === 'LONG' ? 'bought back' : 'traded';

  const what = event
    ? `On ${stamp(event.expertFilledAt)} the expert behind "${event.strategyName}" ` +
      `${traded} ${event.expertQuantity} of ${event.symbol} at ${event.expertFillPrice ?? 'no price'}` +
      (holding === null ? '' : `, reduced or closed their ${holding.toLowerCase()} position`) +
      `. ` +
      (event.quantity !== null
        ? `Your copy took ${event.quantity} at ${event.fillPrice ?? 'no price'}.`
        : 'Your copy was refused for this fill.')
    : `No exit has been copied for ${symbol}.` +
      (last
        ? ` The last activity on this market was ${last.side} ${last.expertQuantity} on ${stamp(last.expertFilledAt)}` +
          (last.status === 'REJECTED' ? ', and that fill was refused.' : '.')
        : '');

  return {
    concept: `Why ${symbol} was ${event?.side === 'LONG' ? 'bought back' : 'sold'} at that point`,
    sections: {
      what,
      simple:
        event
          ? 'You reduced or closed because the expert did. A copy engine follows the expert\'s exits as faithfully as it follows the entries - it does not second-guess the timing.'
          : 'No exit was copied for this market. A copy closes only when the expert closes, so an exit that never happened in the expert\'s book never happens in yours.',
      howItWorks:
        event
          ? `A reducing fill is written to your copy ledger with the profit or loss it realised against the holding. ` +
            (realised !== null && realised !== undefined
              ? `That fill realised ${realised} on your copy pot. `
              : 'The engine applied it against the holding you had. ') +
            'Any quantity left over stays open.'
          : 'The engine records a reducing fill only when the expert reduced or closed. Nothing in the ledger reduces your holding on its own.',
      example:
        (position
          ? `What remains is ${position.quantity} of ${position.symbol}, entered at ${position.averageEntryPrice}. `
          : 'Nothing of this symbol is left open. ') + markSentence(position),
      remember:
        `${expertRationale(facts)} ` +
        (event
          ? "The expert's exit timing is copied verbatim, so an exit that suits their book may not suit yours."
          : 'When the expert closes, the copy closes, and when the expert does not, the copy does not either.'),
    },
  };
}

function explainSize(
  event: CopyEventFact | null,
  position: CopyPositionFact | null,
  symbol: string,
): CopyExplanation {
  const allocation = event?.allocationFraction ?? 'your chosen fraction';

  return {
    concept: `Why your ${symbol} copy is smaller than the expert's`,
    sections: {
      what: event
        ? `The expert filled ${event.expertQuantity} of ${event.symbol} at ${event.expertFillPrice ?? 'no price'}. ` +
          `Your copy took ${event.quantity ?? 'nothing'} at ${event.fillPrice ?? 'no price'}, from an allocation of ${allocation}.`
        : `Your holding in ${symbol} is ${position?.quantity ?? 'unknown'}.`,
      simple:
        'Your copy is a fraction of the expert\'s trade, because you chose how much of each fill to mirror. The direction and the price are the same; only the size is yours.',
      howItWorks:
        `Size = expert size x allocation. ${event ? `${event.expertQuantity} x ${allocation} = ${event.quantity ?? '0'}.` : ''} ` +
        'The fraction is fixed when the fill is consumed, so changing it later never rewrites a trade you already made.',
      example: position
        ? `You hold ${position.quantity} of ${position.symbol} at an average entry of ${position.averageEntryPrice}.`
        : 'Change the allocation on the follow to change the size of the next copied fill.',
      remember:
        'A smaller copy means a smaller profit and a smaller loss. The engine refuses a copy it cannot fund rather than shrinking it silently.',
    },
  };
}

function explainStatus(
  position: CopyPositionFact | null,
  event: CopyEventFact | null,
  symbol: string,
  facts: CopyExplanationFacts,
): CopyExplanation {
  const wallet = facts.walletUsdt;

  return {
    concept: position ? `Your ${position.symbol} position` : `Your ${symbol} activity`,
    sections: {
      what: position
        ? `You hold ${position.quantity} of ${position.symbol}, ${position.direction}, entered at an average price of ${position.averageEntryPrice} on ${stamp(position.openedAt)}.`
        : event
          ? `Your last copied fill was ${event.side} ${event.quantity ?? 'nothing'} of ${event.symbol} on ${stamp(event.expertFilledAt)}.`
          : `Nothing is recorded for ${symbol}.`,
      simple: position
        ? position.direction === 'SHORT'
          ? 'You are short this market: you sold first and will buy back later, so you win if the price falls.'
          : 'You are long this market: you bought first and will sell later, so you win if the price rises.'
        : 'There is nothing open in this market on your copy book.',
      howItWorks:
        'Every copied fill is written to your own copy ledger with the price and the time it happened. The holding you see is that ledger, marked at the current market price.',
      example:
        (position ? markSentence(position) : 'No open holding to mark.') +
        (wallet !== null ? ` Your real USDT wallet balance is ${wallet}, and it gates whether another copy can be funded.` : ''),
      remember:
        'A copy pot is simulated money held separately from your real wallet balance. The copy can only be refused for cash, never spend your wallet.',
    },
  };
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/** Why one fill was not copied, in the ledger's own vocabulary. */
const REJECTION_EXPLANATIONS: Record<string, { plain: string; mechanism: string; action: string }> = {
  FOLLOW_NOT_ACTIVE: {
    plain: 'You had stopped following that strategy when the expert traded, so there was nothing to copy.',
    mechanism:
      'A follow copies only while it is active. Unfollowing stops new fills immediately, and the positions and cash you already had stay where they are.',
    action: 'Follow the strategy again and the next expert fill will be copied.',
  },
  STRATEGY_ARCHIVED: {
    plain: 'The expert had archived that strategy, so it was no longer eligible to copy.',
    mechanism:
      'Archiving retires a strategy. Its history stays readable, but it stops being something a follower can copy from.',
    action: 'Follow a strategy that is still published and active.',
  },
  STRATEGY_NOT_ELIGIBLE: {
    plain:
      'The strategy was no longer public and active at that moment, so it stopped being eligible to copy.',
    mechanism:
      'Only a public, active strategy can be copied. The engine records the refusal rather than dropping the fill silently, so the history always explains the gap.',
    action: 'Follow a strategy that is published and active.',
  },
  ALLOCATION_ROUNDED_TO_ZERO: {
    plain:
      'Your allocation scaled the expert\'s size down below one whole unit, so there was nothing left to copy.',
    mechanism:
      'The copy size is the expert\'s size multiplied by your allocation, rounded to eight places. An allocation that small against a small expert order rounds to zero, and a zero-size order is not an order.',
    action: 'Raise the allocation on the follow if you want smaller trades to be copied.',
  },
  INSUFFICIENT_COPY_CASH: {
    plain:
      'Your copy pot did not have enough simulated cash to fund even one unit of the scaled order.',
    mechanism:
      'Each follow holds its own simulated pot. The engine checks the pot before it writes a fill and refuses rather than borrowing from another follow or from your real wallet.',
    action: 'Free cash in this copy pot, or lower your allocation.',
  },
  INSUFFICIENT_POSITION: {
    plain: 'You held none of this symbol, so there was nothing to reduce.',
    mechanism:
      'A fill that reduces a position needs a position to reduce. With none open, the engine has nothing to close and refuses the fill.',
    action: 'This only happens if the position was already closed.',
  },
  PRICE_UNAVAILABLE: {
    plain: 'That fill carried no usable execution price, so there was nothing to mirror.',
    mechanism:
      'A copy needs both sides of the trade - a size and a price. A fill the market could not price is recorded with no price, and a copy cannot be made from a price nobody knows.',
    action: 'Nothing to do - the expert\'s own fill will be priced when it can be.',
  },
  INSUFFICIENT_WALLET_BALANCE: {
    plain:
      'Your real USDT wallet balance could not cover the mirrored notional, so the copy was refused.',
    mechanism:
      'Every copy has to pass your real wallet balance as a gate, even though the copy pot is simulated. The wallet is not spent by a copy - it decides whether one is allowed.',
    action: 'Add funds to your wallet, or lower the allocation so the notional fits.',
  },
};

function explainRejection(event: CopyEventFact | null, symbol: string): CopyExplanation {
  const reason = event?.rejectReason ?? null;
  const known = reason === null ? undefined : REJECTION_EXPLANATIONS[reason];

  const what = event
    ? `On ${stamp(event.expertFilledAt)} the expert behind "${event.strategyName}" filled ${event.side} ${event.expertQuantity} of ${event.symbol} at ${event.expertFillPrice ?? 'no price'}. ` +
      `Your copy was refused: ${reason ?? 'no reason was recorded'}.`
    : `Nothing was refused for ${symbol}.`;

  return {
    concept: `Why the ${event?.symbol ?? symbol} fill was not copied`,
    sections: {
      what,
      simple: known?.plain ?? 'The engine refused to copy that fill and recorded the reason.',
      howItWorks:
        known?.mechanism ??
        'The copy engine applies the eligibility and sizing rules before it writes a fill, and records a refusal with its reason rather than leaving a silent gap in the history.',
      example: event
        ? `The expert's order was ${event.expertQuantity} at ${event.expertFillPrice ?? 'no price'}, which your allocation of ${event.allocationFraction} would have scaled to ${event.quantity ?? 'nothing'}. ` +
          `Nothing was written to your copy pot, and no position changed.`
        : 'No refused fill is recorded for this market.',
      remember: known?.action ?? 'Every refusal is recorded with its reason, so the history always explains itself.',
    },
  };
}
