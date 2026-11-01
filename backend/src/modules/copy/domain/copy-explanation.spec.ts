import {
  classifyCopyQuestion,
  composeCopyExplanation,
  isBookQuestion,
  selectEventForIntent,
  type CopyEventFact,
  type CopyExplanationFacts,
  type CopyPositionFact,
} from './copy-explanation';

/**
 * MODULE 07 - explaining a copy trade, tested with no database and no clock.
 *
 * The thing being pinned down here is honesty. An explanation that reads well
 * but says something the ledger does not support is worse than no explanation
 * at all, so the tests below are mostly about what the composer must NOT say:
 * that it knows the expert's reasoning when no description exists, that a
 * position it could not price is worth zero, or that a refusal is a fill.
 */
const COPIED_EVENT: CopyEventFact = {
  expertOrderId: 'order-1',
  symbol: 'BTC/USD',
  side: 'SHORT',
  expertQuantity: '2',
  expertFillPrice: '77273.84',
  expertFilledAt: '2026-10-31T17:12:00.000Z',
  allocationFraction: '0.25',
  quantity: '0.5',
  fillPrice: '77273.84',
  gross: '38636.92',
  realizedPnl: null,
  status: 'COPIED',
  rejectReason: null,
  strategyName: 'Volatility Harvest',
  effect: 'OPEN',
};

const REJECTED_EVENT: CopyEventFact = {
  ...COPIED_EVENT,
  expertOrderId: 'order-2',
  status: 'REJECTED',
  quantity: null,
  fillPrice: null,
  gross: null,
  rejectReason: 'INSUFFICIENT_WALLET_BALANCE',
  effect: 'NONE',
};

/** A reducing fill: the expert closed the short, so the copy realised P&L. */
const EXIT_EVENT: CopyEventFact = {
  ...COPIED_EVENT,
  expertOrderId: 'order-3',
  side: 'LONG',
  expertFillPrice: '76000',
  expertFilledAt: '2026-11-01T09:00:00.000Z',
  fillPrice: '76000',
  gross: '38000',
  realizedPnl: '636.92',
  effect: 'CLOSE',
};

const SHORT_POSITION: CopyPositionFact = {
  symbol: 'BTC/USD',
  direction: 'SHORT',
  quantity: '0.5',
  averageEntryPrice: '77273.84',
  markPrice: '77270.93',
  marketValue: '38635.47',
  unrealizedPnl: '-1.46',
  stale: false,
  openedAt: '2026-10-31T17:12:00.000Z',
};

function facts(overrides: Partial<CopyExplanationFacts> = {}): CopyExplanationFacts {
  return {
    symbol: 'BTC/USD',
    strategyDescription: null,
    position: SHORT_POSITION,
    latestEvent: COPIED_EVENT,
    lastEvent: COPIED_EVENT,
    holdingDirection: 'SHORT',
    recentEvents: [COPIED_EVENT],
    walletUsdt: '10',
    ...overrides,
  };
}

describe('classifyCopyQuestion', () => {
  it('reads a question about direction as a question about direction', () => {
    expect(classifyCopyQuestion('why was it short at this point', facts())).toBe('WHY_DIRECTION');
  });

  it('reads a question about an exit as a question about an exit', () => {
    expect(classifyCopyQuestion('why did it sell at this point', facts())).toBe('WHY_EXIT');
  });

  it('reads a question about a refusal as a question about a refusal', () => {
    expect(classifyCopyQuestion('why was my order rejected', facts())).toBe('WHY_REJECTED');
  });

  it('reads a question about size as a question about size', () => {
    expect(classifyCopyQuestion('why is my quantity smaller than the expert', facts())).toBe('WHY_SIZE');
  });

  it('reads a question about the holding as a question about the holding', () => {
    expect(classifyCopyQuestion('what is my unrealised profit on this', facts())).toBe('POSITION_STATUS');
  });

  it('falls back to the refusal when the ledger records one and the wording does not', () => {
    const refused = facts({ latestEvent: REJECTED_EVENT, recentEvents: [REJECTED_EVENT] });
    expect(classifyCopyQuestion('what happened here', refused)).toBe('WHY_REJECTED');
  });
});

describe('isBookQuestion', () => {
  const known = ['BTC/USD'];

  it('treats a question about the reader\'s own trade as a book question', () => {
    expect(isBookQuestion('why was it short at this point', known)).toBe(true);
    expect(isBookQuestion('why did it sell at this point', known)).toBe(true);
    expect(isBookQuestion('why is my quantity smaller than the expert', known)).toBe(true);
    expect(isBookQuestion('what is my unrealised profit on this', known)).toBe(true);
  });

  it('treats a question naming a market the reader holds as a book question', () => {
    expect(isBookQuestion('why did the expert sell BTC/USD', known)).toBe(true);
  });

  it('leaves a question about the words to the general knowledge base', () => {
    expect(isBookQuestion('what is a short position', known)).toBe(false);
    expect(isBookQuestion('what is impermanent loss', known)).toBe(false);
    expect(isBookQuestion('how does a limit order work', known)).toBe(false);
    expect(isBookQuestion('why is the price dropping', known)).toBe(false);
  });
});

describe('selectEventForIntent', () => {
  it('answers a question about an exit with the fill that reduced the holding', () => {
    const events = [EXIT_EVENT, COPIED_EVENT];
    expect(selectEventForIntent('WHY_EXIT', events)?.expertOrderId).toBe('order-3');
  });

  it('answers a question about a direction with the fill that opened the holding', () => {
    const events = [EXIT_EVENT, COPIED_EVENT];
    expect(selectEventForIntent('WHY_DIRECTION', events)?.expertOrderId).toBe('order-1');
  });

  it('answers a question about a refusal with the refusal', () => {
    const events = [COPIED_EVENT, REJECTED_EVENT];
    expect(selectEventForIntent('WHY_REJECTED', events)?.expertOrderId).toBe('order-2');
  });

  it('returns nothing for an exit the ledger does not hold, rather than the entry before it', () => {
    expect(selectEventForIntent('WHY_EXIT', [COPIED_EVENT])).toBeNull();
  });

  it('treats a fill that reduced the holding as an exit even when it realised nothing', () => {
    // A break-even close realises zero, so the stored figure cannot say it
    // was an exit. The replayed effect can.
    const breakEven: CopyEventFact = { ...EXIT_EVENT, expertOrderId: 'order-4', realizedPnl: null };
    expect(selectEventForIntent('WHY_EXIT', [breakEven, COPIED_EVENT])?.expertOrderId).toBe('order-4');
  });

  it('does not call a fill an opening when the ledger could not establish it', () => {
    const unknown: CopyEventFact = { ...COPIED_EVENT, expertOrderId: 'order-5', effect: null };
    expect(selectEventForIntent('WHY_DIRECTION', [unknown])?.expertOrderId).toBe('order-5');
  });

  it('answers a question that names a side with the trade that carried that side', () => {
    const events = [COPIED_EVENT, EXIT_EVENT];
    expect(selectEventForIntent('WHY_DIRECTION', events, 'SHORT')?.expertOrderId).toBe('order-1');
    expect(selectEventForIntent('WHY_DIRECTION', events, 'LONG')?.expertOrderId).toBe('order-3');
  });
});

describe('composeCopyExplanation', () => {
  it('answers nothing when there is no book to answer from', () => {
    const empty = facts({ symbol: null, position: null, latestEvent: null, lastEvent: null, recentEvents: [] });
    expect(composeCopyExplanation(empty, 'why was it short')).toBeNull();
  });

  it('states the expert\'s own fill, the copy\'s size and the direction', () => {
    const answer = composeCopyExplanation(facts(), 'why was it short at this point');
    expect(answer).not.toBeNull();
    expect(answer?.concept).toBe('Why BTC/USD is SHORT');
    expect(answer?.sections.what).toContain('Volatility Harvest');
    expect(answer?.sections.what).toContain('77273.84');
    expect(answer?.sections.what).toContain('0.5');
    expect(answer?.sections.example).toContain('-1.46');
  });

  it('does not claim to know the expert\'s reasoning when no description was written', () => {
    const answer = composeCopyExplanation(facts(), 'why was it short');
    expect(answer?.sections.remember).toContain('not what they were thinking');
    expect(answer?.sections.remember).not.toContain('says:');
  });

  it('quotes the expert\'s description as a quote, and only when there is one', () => {
    const answer = composeCopyExplanation(
      facts({ strategyDescription: 'Sell rallies into liquidity' }),
      'why was it short',
    );
    expect(answer?.sections.remember).toContain('Sell rallies into liquidity');
    expect(answer?.sections.remember).toContain('says:');
  });

  it('explains a refusal in plain words and names the recorded reason', () => {
    const refused = facts({ latestEvent: REJECTED_EVENT, recentEvents: [REJECTED_EVENT] });
    const answer = composeCopyExplanation(refused, 'why was this not copied');
    expect(answer?.sections.what).toContain('INSUFFICIENT_WALLET_BALANCE');
    expect(answer?.sections.simple).toContain('real USDT wallet balance');
  });

  it('never describes a refusal as something that was executed', () => {
    const refused = facts({ latestEvent: REJECTED_EVENT, recentEvents: [REJECTED_EVENT] });
    const answer = composeCopyExplanation(refused, 'why was this not copied');
    expect(answer?.sections.example).toContain('Nothing was written to your copy pot');
  });

  it('reports an unpriceable holding as unpriced rather than as worth zero', () => {
    const unpriced = facts({
      position: { ...SHORT_POSITION, markPrice: null, marketValue: null, unrealizedPnl: null },
    });
    const answer = composeCopyExplanation(unpriced, 'what is my position worth');
    expect(answer?.sections.example).toContain('not available');
    expect(answer?.sections.example).not.toContain('unrealised profit or loss of 0');
  });

  it('shows the arithmetic behind a smaller copy', () => {
    const answer = composeCopyExplanation(facts(), 'why is my quantity smaller');
    expect(answer?.sections.howItWorks).toContain('2 x 0.25 = 0.5');
  });

  it('names the wallet balance as a gate, never as money a copy spends', () => {
    const answer = composeCopyExplanation(facts(), 'what is my position');
    expect(answer?.sections.example).toContain('gates whether another copy can be funded');
  });

  it('keeps every section inside the widget\'s caps', () => {
    const answer = composeCopyExplanation(facts(), 'why was it short at this point');
    expect(answer?.concept.length).toBeLessThanOrEqual(120);
    for (const section of Object.values(answer?.sections ?? {})) {
      expect(section.length).toBeLessThanOrEqual(1800);
    }
  });

  it('explains an exit as an exit, with the profit or loss it realised', () => {
    const exited = facts({ latestEvent: EXIT_EVENT, lastEvent: EXIT_EVENT, recentEvents: [EXIT_EVENT] });
    const answer = composeCopyExplanation(exited, 'why did it sell at this point');
    expect(answer?.sections.what).toContain('reduced or closed their short position');
    expect(answer?.sections.howItWorks).toContain('636.92');
  });

  it('says no exit was copied when the ledger holds no reducing fill', () => {
    const answer = composeCopyExplanation(
      facts({ latestEvent: null, lastEvent: COPIED_EVENT }),
      'why did it sell at this point',
    );
    expect(answer?.sections.what).toContain('No exit has been copied for BTC/USD');
    expect(answer?.sections.what).toContain('The last activity on this market');
  });

  it('never describes a refused fill as one that was mirrored', () => {
    const refused = facts({ latestEvent: REJECTED_EVENT, lastEvent: REJECTED_EVENT, recentEvents: [REJECTED_EVENT] });
    const answer = composeCopyExplanation(refused, 'why was it short at this point');
    expect(answer?.sections.what).not.toContain('Your copy mirrored that fill');
    expect(answer?.sections.what).toContain('was refused');
  });

  it('answers a direction question about a reducing fill as the exit it was', () => {
    const exited = facts({ latestEvent: EXIT_EVENT, lastEvent: EXIT_EVENT, recentEvents: [EXIT_EVENT] });
    const answer = composeCopyExplanation(exited, 'why was it short at this point');
    expect(answer?.sections.what).toContain('reduced or closed their short position');
    expect(answer?.sections.howItWorks).toContain('636.92');
  });
});
