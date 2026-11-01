/**
 * The built-in knowledge behind `POST /ai-doubt-solver` (design-integration
 * task).
 *
 * The trade-buddy widget ships with an answer contract — a `concept` plus five
 * sections — and an operator is expected to point it at a model later
 * (`AI_MODEL_URL`). Until then, and as a fallback when the model is unreachable,
 * the endpoint answers from here: a small, curated, offline glossary of the
 * platform and the trading concepts its pages talk about. Deterministic, free,
 * and honest — an entry either covers the question or the fallback says so.
 *
 * Matching rules:
 *  - Every string is normalized (lowercase, alphanumeric + spaces) before
 *    comparison, and keywords are matched as whole words/phrases so `il` never
 *    matches "portfolio".
 *  - A hit in the question itself counts triple; a hit only in the inspected
 *    element or page context counts once, so clicking a labelled widget still
 *    finds its entry without overriding what the visitor actually typed.
 *  - Longer keywords score higher, so "impermanent loss" beats a stray "loss".
 */

export interface KnowledgeEntry {
  /** Stable identifier, used by tests and logs. */
  id: string;
  /** Heading shown by the widget. Hard limit: 120 characters. */
  concept: string;
  /** Normalized whole-word phrases that select this entry. */
  keywords: string[];
  /** What the thing is, formally. */
  what: string;
  /** The same thing in one plain sentence — the widget types this into chat. */
  simple: string;
  /** How it actually behaves, mechanically. */
  howItWorks: string;
  /** A concrete example. */
  example: string;
  /** The caveat worth remembering. */
  remember: string;
}

/** Lowercase, collapse whitespace, drop punctuation — the form keywords are stored in. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Whole-word phrase test: padding both sides makes boundaries symmetric. */
function mentions(corpus: string, keyword: string): boolean {
  return ` ${corpus} `.includes(` ${keyword} `);
}

export const KNOWLEDGE_BASE: KnowledgeEntry[] = [
  {
    id: 'copy-trading',
    concept: 'Copy trading',
    keywords: ['copy trading', 'copy trade', 'copy trader', 'mirror trading', 'follower', 'lead trader', 'strategy provider', 'copies'],
    what: 'Copy trading lets an account follow another trader\'s public strategy and mirror its allocations automatically.',
    simple: 'Copy trading means your capital follows a strategy another trader publishes, in proportion you choose.',
    howItWorks: 'A trader publishes a strategy on the platform. Followers allocate capital to it; the platform computes sizing from the strategy\'s rules and the follower\'s allocation, records every mirrored position in the follower\'s own ledger, and the follower keeps the decision to stop at any time.',
    example: 'A strategy opens a position sized at 5% of its capital. A follower with half the allocation sees the same trade reflected at the corresponding size in their own portfolio.',
    remember: 'Following a strategy is not handing over your account: the trades are recorded in your ledger and you can stop following whenever you choose.',
  },
  {
    id: 'liquidity-pool',
    concept: 'Liquidity pool',
    keywords: ['liquidity pool', 'providing liquidity', 'liquidity provider', 'lp token', 'pool share', 'provide liquidity', 'add liquidity'],
    what: 'A liquidity pool is a reserve of assets that a decentralised market uses to let others trade against it.',
    simple: 'A liquidity pool is money other people lock up so trades can happen without waiting for a specific buyer or seller.',
    howItWorks: 'Providers deposit a pair of assets into a pool. Traders pay a fee to swap against that reserve, and the fee is distributed to providers in proportion to their share. The pool\'s ratio is what sets the executed price.',
    example: 'A pool holds 100 EMBER and 1,000 USDC. A trader buying EMBER shifts the ratio, and the fee they paid is split among the providers who made the swap possible.',
    remember: 'Pool returns come from trading fees, not from a promise — and the value of what you deposited can drift while your tokens are in the pool.',
  },
  {
    id: 'impermanent-loss',
    concept: 'Impermanent loss',
    keywords: ['impermanent loss', 'impermanent', 'divergence loss'],
    what: 'Impermanent loss is the value a liquidity provider gives up versus simply holding, when the pool\'s assets move apart in price.',
    simple: 'If the two assets you provided change price relative to each other, you end up with less than if you had just kept them.',
    howItWorks: 'A pool forces a fixed ratio between its assets. When one asset rises, the pool sells part of it on the way up, so a provider ends up holding more of the falling asset and less of the rising one than plain holding would. Fees earned offset this; the loss is "impermanent" only while prices may still return.',
    example: 'ETH doubles against USDC while you provide ETH/USDC. The pool has rebalanced you into more USDC and less ETH, so your pool balance is worth less than holding both tokens untouched.',
    remember: 'Fees can beat it, but they are not guaranteed to — and once you withdraw, what looked impermanent is simply your result.',
  },
  {
    id: 'staking',
    concept: 'Staking EMBER',
    keywords: ['staking', 'stake', 'staked', 'lock period', 'lock up', 'locked tokens', 'unlock', 'unstake'],
    what: 'Staking locks EMBER for a chosen period so its holder participates in simulated protocol reward distributions.',
    simple: 'Staking locks your EMBER for a set time and shows you simulated rewards for doing so.',
    howItWorks: 'An eligible balance moves from available to locked in the wallet ledger for the configured lock period. Rewards are computed at read time from the configured APR and are displayed, never credited. Unstaking before the lock expires is refused rather than penalised.',
    example: 'Locking 500 EMBER shows a position with its unlock date and a reward figure accruing at the configured APR — the EMBER itself stays yours, just unavailable until the lock ends.',
    remember: 'Staking is a real lock on real tokens; the reward number beside it is a simulation for display.',
  },
  {
    id: 'apr-apy',
    concept: 'APR and APY',
    keywords: ['apr', 'apy', 'annual percentage rate', 'annual percentage yield', 'yield', 'interest rate', 'compounding'],
    what: 'APR is a yearly rate without compounding; APY is a yearly rate that includes compounding.',
    simple: 'APR is what a rate looks like in a straight line, APY is what it looks like when the earnings also earn.',
    howItWorks: 'APR multiplies the period return by the number of periods in a year. APY additionally assumes each period\'s return is reinvested, so it grows slightly faster: APY = (1 + APR/n)^n − 1.',
    example: 'A 12% APR compounded monthly is an APY of about 12.68% — the extra 0.68% is the effect of the monthly returns themselves earning returns.',
    remember: 'Any figure without a period or a compounding convention attached is not comparable to another one.',
  },
  {
    id: 'ember-token',
    concept: 'EMBER token',
    keywords: ['ember', 'ember token', 'prometheus token', 'torch', 'ember price', 'what is ember'],
    what: 'EMBER is Prometheus\'s platform token: it is what staking locks, liquidity slabs are denominated in and tokenomics allocates.',
    simple: 'EMBER is the Prometheus platform token used for staking, liquidity commitments and the burn/buyback split.',
    howItWorks: 'EMBER lives on-chain and is mirrored in the platform ledger. Wallet balances back the UI, staking locks it, liquidity commitments require it, and tokenomics routes a configured share of platform activity into burns and buybacks.',
    example: 'Committing EMBER against a liquidity slab moves it from available to committed in the ledger, and the tier you qualify for is read back from that ledger.',
    remember: 'The ledger mirror is what the app reads; the chain is what settles it — reconciliation between the two is a first-class page in the admin surface.',
  },
  {
    id: 'tokenomics',
    concept: 'Tokenomics: burn and buyback',
    keywords: ['tokenomics', 'burn', 'buyback', 'token burn', 'burn rate', 'supply reduction', 'allocation', 'direct burn', 'deflation'],
    what: 'Tokenomics describes how EMBER\'s supply is managed: a configured split routes activity into direct burns and buybacks.',
    simple: 'Part of the platform\'s activity buys EMBER and destroys it, and the split between burning and buying back is a configured rule.',
    howItWorks: 'A configuration sets the direct-burn percentage against the buyback percentage (with an adaptive option that tunes the split from platform health). Each cycle records a burn or buyback entry with its transaction reference, and allocations move value to their configured destinations — all auditable in the operations page.',
    example: 'With a 60/40 split, ₹10,000 of routed activity destroys ₹6,000 of EMBER directly and uses ₹4,000 to buy and retire tokens from the market.',
    remember: 'The percentages are configuration, not law — read the current split on the operations page rather than assuming a remembered one.',
  },
  {
    id: 'slippage',
    concept: 'Slippage',
    keywords: ['slippage', 'price impact', 'execution price', 'expected price', 'price moved'],
    what: 'Slippage is the difference between the price you expected and the price you actually got.',
    simple: 'Slippage is the gap between the price shown and the price that fills, usually because your trade moved the market.',
    howItWorks: 'Quotes come from an order book or pool depth at one instant; a trade consumes that depth in sequence, so larger orders walk through worse prices. The quote response shows expected and worst-acceptable prices, and a fill outside the tolerance is refused.',
    example: 'A quote says 85.10 with a 0.5% tolerance. If the fill lands at 85.60 or worse, the order is rejected instead of quietly costing you more.',
    remember: 'The larger the order relative to available depth, the more the second half of it costs — size is the main driver of slippage.',
  },
  {
    id: 'order-book',
    concept: 'Order book, limit and market orders',
    keywords: ['order book', 'limit order', 'market order', 'bid', 'ask', 'spread', 'limit price', 'order type', 'fill'],
    what: 'The order book lists resting buy and sell orders; a market order takes the best available prices, a limit order waits for a set price.',
    simple: 'A market order trades immediately at the current best price; a limit order only trades at the price you named.',
    howItWorks: 'Makers post bids and asks at chosen prices; takers cross the spread. Book depth shows how much sits at each price — the more depth near the top, the less a trade moves the price.',
    example: 'Bids at 84.99 (50 units) and asks at 85.01 (40 units): a market buy of 100 units fills 40 at 85.01 and the rest deeper up the book.',
    remember: 'Market orders guarantee execution, not price; limit orders guarantee price, not execution.',
  },
  {
    id: 'candlestick',
    concept: 'Candlestick charts',
    keywords: ['candlestick', 'candle', 'chart', 'timeframe', 'wick', 'ohlc', 'open high low close', 'green candle', 'red candle'],
    what: 'A candlestick shows a period\'s open, high, low and close as one bar: body between open and close, wick to the extremes.',
    simple: 'Each candle is one slice of time showing where the price started, how far it wandered, and where it ended.',
    howItWorks: 'A bullish candle closes above its open, a bearish one below it; the wicks mark the extremes that were touched but not held. Shorter timeframes compress the same information into more, noisier bars.',
    example: 'A daily candle opening at 84, dipping to 83, rallying to 86 and closing at 85.5 draws a small lower wick, a green body from 84 to 85.5, and an upper wick to 86.',
    remember: 'Candles describe what price did, never why — patterns are observations, not predictions.',
  },
  {
    id: 'tvl',
    concept: 'TVL (total value locked)',
    keywords: ['tvl', 'total value locked', 'locked value', 'assets locked'],
    what: 'TVL is the total value of assets deposited in a protocol or platform at a given moment.',
    simple: 'TVL is how much money is currently sitting inside the platform.',
    howItWorks: 'Deposits are summed at current prices and subtracted on withdrawal; movement in TVL mixes new deposits, price changes and exits. Anywhere Prometheus shows a headline locked figure, it is computed from ledger positions rather than estimated.',
    example: 'If 10,000 EMBER at $2.10 and 5,000 USDC are committed to liquidity, the locked value of those positions is $26,000.',
    remember: 'TVL rising can mean deposits or just a higher token price — the two need separating before it says anything.',
  },
  {
    id: 'drawdown',
    concept: 'Drawdown',
    keywords: ['drawdown', 'max drawdown', 'peak to trough', 'down from high', 'loss from peak'],
    what: 'Drawdown measures how far an account or strategy has fallen from its highest value so far.',
    simple: 'Drawdown is how much you are down from the best point you reached.',
    howItWorks: 'Track the running peak of the equity curve; drawdown at any moment is (peak − current) ÷ peak. Maximum drawdown is the worst such reading over a period — the standard way to describe a strategy\'s bad stretch.',
    example: 'An account peaks at $12,000, then falls to $10,200: that is a 15% drawdown, and it stays at least 15% until a new high is made.',
    remember: 'Two strategies with identical returns can feel completely different if one gets there through deeper drawdowns.',
  },
  {
    id: 'volatility',
    concept: 'Volatility',
    keywords: ['volatility', 'volatile', 'price swing', 'how much it moves', 'risk of large moves'],
    what: 'Volatility describes how much and how fast an asset\'s price moves, historically or expected.',
    simple: 'Volatility is how jumpy a price is — big frequent swings mean high volatility.',
    howItWorks: 'Historical volatility is the standard deviation of returns over a window; implied volatility is what options pricing expects forward. Position sizing and stop distances are usually derived from it.',
    example: 'Two assets both average +1% a day differ completely if one does it with ±0.5% daily moves and the other with ±5%.',
    remember: 'Volatility measures size of moves, not direction — an asset can be violently flat on average.',
  },
  {
    id: 'hedging',
    concept: 'Hedging',
    keywords: ['hedge', 'hedging', 'offset a position', 'protect against', 'insurance position'],
    what: 'Hedging is taking an opposing or uncorrelated position whose gains offset the risk of the first one.',
    simple: 'A hedge is a second bet that pays off if your first bet goes wrong.',
    howItWorks: 'The hedge reduces net exposure rather than seeking profit: a long holding paired with a short or an uncorrelated asset narrows the range of outcomes, usually at the cost of some upside and a premium.',
    example: 'Holding EMBER while short an equivalent notional of a correlated asset leaves the net position far less sensitive to a broad crypto sell-off.',
    remember: 'A hedge costs money by design — the question it answers is how much certainty you want to buy, not how to trade for free.',
  },
  {
    id: 'rebalancing',
    concept: 'Portfolio rebalancing',
    keywords: ['rebalance', 'rebalancing', 'allocation drift', 'asset allocation', 'too heavy', 'trim back', 'portfolio mix'],
    what: 'Rebalancing restores a portfolio to its target weights after prices have drifted them.',
    simple: 'Rebalancing sells a little of what has grown and buys a little of what has shrunk so your mix matches your plan again.',
    howItWorks: 'Set target weights; when drift exceeds a threshold (a band or a percentage of the target), trades move the portfolio back. The discipline enforces "sell high, buy low" mechanically and caps unintended concentration.',
    example: 'A 60/40 mix becomes 72/28 after an equity run-up; rebalancing trims the 72 back to 60, taking profit and restoring the planned risk.',
    remember: 'Rebalancing is a risk decision first — it routinely gives up some of a rally to keep your exposure where you agreed it should be.',
  },
  {
    id: 'stablecoins',
    concept: 'Stablecoins',
    keywords: ['stablecoin', 'usdt', 'usdc', 'tether', 'peg', 'dollar backed', 'stable value'],
    what: 'Stablecoins are tokens designed to hold a steady value, usually against the US dollar.',
    simple: 'A stablecoin is a crypto token engineered to stay worth about one dollar.',
    howItWorks: 'Issuers back tokens with reserves (dollars, short-term debt) or algorithmic mechanisms; redemptions and arbitrage keep the market price near the peg. They settle fast without leaving the crypto ecosystem.',
    example: 'USDC trades within a fraction of a cent of $1; a 20% crypto drawdown typically leaves stablecoin balances nominally unchanged.',
    remember: '"Stable" describes the target, not a guarantee — reserve quality and redemption rules are what actually hold the peg.',
  },
  {
    id: 'paper-trading',
    concept: 'Paper trading',
    keywords: ['paper trading', 'paper account', 'demo account', 'simulated trading', 'practice trading', 'play money', 'fake trades'],
    what: 'Paper trading records simulated fills against a virtual balance, using real market prices.',
    simple: 'Paper trading lets you trade with pretend money at real prices, so you can learn without losing capital.',
    howItWorks: 'Quotes and bars come from the live feed; orders fill against them and update a simulated balance and position list with full ledger history. No funds move and nothing reaches a venue.',
    example: 'A paper order of 10 shares at the live quote moves the virtual cash balance and opens a position that P&L tracks against the real market from then on.',
    remember: 'The prices are real and the money is not — results prove your process, not your costs, fees or fills at size.',
  },
  {
    id: 'sentinel',
    concept: 'Sentinel alerts',
    keywords: ['sentinel', 'price alert', 'voice call', 'phone alert', 'alert call', 'ring me', 'notification call', 'alert'],
    what: 'Sentinel watches price conditions and can place a simulated voice call when one is met.',
    simple: 'Sentinel watches prices for you and rings your phone when your condition is met.',
    howItWorks: 'An alert stores symbol, condition and target; a monitor evaluates it against the feed, and with voice enabled the platform places a call speaking the alert (verification and quiet hours apply). Alerts expire on their own schedule and can be cancelled at any time.',
    example: 'Set "AAPL falls below 185.00 with voice on": when the feed prints it, Sentinel queues a call that says exactly which condition fired.',
    remember: 'Sentinel places calls, never trades — the decision always stays with the person who answers.',
  },
  {
    id: 'dca',
    concept: 'Dollar-cost averaging',
    keywords: ['dca', 'dollar cost averaging', 'average in', 'buying regularly', 'fixed amount regularly', 'divide it up'],
    what: 'Dollar-cost averaging invests a fixed amount on a schedule regardless of price.',
    simple: 'DCA means buying the same amount on a schedule instead of trying to pick the perfect moment.',
    howItWorks: 'A fixed currency amount buys more units when prices are low and fewer when high, so the average cost per unit ends up below the simple average price over the period — timing risk is spread out instead of concentrated.',
    example: '$100 monthly buys 10 units at $10, then 12.5 units at $8 — an average of $8.89 per unit against an average price of $9.',
    remember: 'DCA removes timing risk, not market risk: it works for accumulating steadily, it does not guarantee a profit.',
  },
  {
    id: 'market-cycle',
    concept: 'Bull and bear markets',
    keywords: ['bull market', 'bear market', 'bullish', 'bearish', 'market cycle', 'rally', 'correction', 'crash', 'dip'],
    what: 'A bull market is a sustained rise in prices; a bear market is a sustained fall, conventionally 20% or more.',
    simple: 'Bull markets climb, bear markets fall — they are labels for extended directions, not schedules.',
    howItWorks: 'Trend is judged from peak-to-trough moves over months: a 20%+ decline defines a bear, a recovery from it a bull. Timeframes and sentiment fill in the rest, and neither is knowable in advance from the current chart.',
    example: 'An index topping at 100 and grinding to 78 is a bear market; the subsequent recovery past 100 begins a bull phase.',
    remember: 'Labels describe the past — acting as though a cycle must continue is where the money goes missing.',
  },
  {
    id: 'risk-tolerance',
    concept: 'Risk tolerance',
    keywords: ['risk tolerance', 'risk appetite', 'conservative', 'aggressive investor', 'how much risk', 'comfortable losing', 'drawdown comfort'],
    what: 'Risk tolerance is how much loss and volatility an investor can accept in both plan and practice.',
    simple: 'Risk tolerance is the honest answer to how much of a drop you could sit through without panic-selling.',
    howItWorks: 'It combines capacity (capital, time horizon, income stability) with temperament (reaction to losses). Prometheus captures it in onboarding — risk, drawdown and volatility answers — as preference data that shapes what the interface surfaces.',
    example: 'Someone marking 30% drawdown comfort but selling at −8% has answered about capacity rather than temperament; the second answer is the binding one.',
    remember: 'A risk score only helps if it is honest — it is a preference, never a prediction of returns.',
  },
  {
    id: 'gas-fees',
    concept: 'Network (gas) fees',
    keywords: ['gas fee', 'gas', 'network fee', 'transaction fee', 'miner fee', 'why does transfer cost'],
    what: 'Gas fees pay the network to include a transaction in a block; they price block space, not the amount moved.',
    simple: 'A gas fee is the network\'s charge to process your transaction, based on congestion rather than how much you send.',
    howItWorks: 'Every operation in a transaction has a cost; fees rise when many users compete for the same block space and fall when it is quiet. Layer-2s and newer execution layers batch the same work for lower fees.',
    example: 'Sending $10 or $10,000 of the same token costs the same gas — the fee buys computation and block space, not value transferred.',
    remember: 'Fees are a fixed cost against small balances, so they matter disproportionately for tiny transactions.',
  },
  {
    id: 'long-short-position',
    concept: 'Long and short positions',
    keywords: [
      'long position',
      'short position',
      'long and short',
      'long vs short',
      'go long',
      'go short',
      'long trade',
      'short trade',
      'short selling',
      'short sale',
      'directional position',
      'being long',
      'being short',
      'sell first',
      'buy first',
    ],
    what: 'A long position is held after buying, in the expectation of a rise; a short position is held after selling, in the expectation of a fall.',
    simple: 'A long means you buy first and sell later; a short means you sell first and buy back later.',
    howItWorks: 'Both are held against a cash balance: a long spends it, a short receives the notional and sets aside what it will cost to buy the asset back. The profit is the price move times the quantity, signed by the direction — up for a long, down for a short — and the position is closed by an opposite trade, which is when the result becomes realised.',
    example: 'Buying 1 unit at 100 and selling it at 120 realises 20 on a long. Selling 1 unit at 100 and buying it back at 80 realises 20 on a short, and loses 20 if the price instead reaches 120.',
    remember: 'A short is not a smaller long: it is the other direction, and it wins when the price falls and loses when it rises.',
  },
  {
    id: 'stop-loss-take-profit',
    concept: 'Stop loss and take profit',
    keywords: [
      'stop loss',
      'stop-loss',
      'take profit',
      'take-profit',
      'trailing stop',
      'target price',
      'lock in profit',
      'cut the loss',
      'exit plan',
    ],
    what: 'A stop loss is an order that closes a position once the price reaches a chosen level; a take profit is an order that closes it once the price reaches a chosen target.',
    simple: 'A stop loss decides in advance where to get out if you are wrong, and a take profit decides in advance where to get out if you are right.',
    howItWorks: 'Both are resting orders tied to a trigger price, so they execute without you watching the screen. The gap between the entry and the trigger is the amount of loss or gain the trade is allowed to produce, and a trailing stop moves its trigger with the price so it protects a gain that has already run.',
    example: 'Entering a long at 100 with a stop at 95 caps the loss at 5 per unit; the same trade with a take profit at 110 closes at 110 for a gain of 10 per unit.',
    remember: 'A stop loss caps a loss but can also cut a winner short, and a take profit locks a gain but can leave more on the table — they trade certainty against upside.',
  },
  {
    id: 'leverage-liquidation',
    concept: 'Leverage, margin and liquidation',
    keywords: [
      'leverage',
      'margin',
      'liquidation',
      'liquidated',
      'margin call',
      'borrowed money',
      'cross margin',
      'isolated margin',
      'position multiplier',
    ],
    what: 'Leverage is borrowed money used to open a position larger than the capital committed; a liquidation is the forced close of that position when the loss reaches the margin.',
    simple: 'Leverage multiplies your gains and your losses, and if the loss gets big enough the exchange takes the position away from you.',
    howItWorks: 'The margin committed is compared against the position notional to give the effective multiple. The closer that multiple is to 1, the less room there is before the loss consumes the margin, and the forced close happens at a threshold rather than at a price you chose.',
    example: 'With $100 of margin on a $500 position the effective leverage is 5x, so a 20% move against the position wipes out the margin — far less than the 100% move the full position would need.',
    remember: 'Leverage does not create a return; it only changes how much of your own money the move is measured against, and it makes a forced exit more likely.',
  },
  {
    id: 'smart-contract',
    concept: 'Smart contracts',
    keywords: ['smart contract', 'on chain', 'onchain', 'immutable code', 'audit', 'blockchain', 'web3', 'decentralised'],
    what: 'A smart contract is program code deployed on a blockchain that executes deterministically when transactions reach it.',
    simple: 'A smart contract is a program on the blockchain that runs itself when someone sends it a transaction.',
    howItWorks: 'Deployed code and state live on-chain and cannot be edited by their authors; anyone can verify what it will do before calling it. Because execution is permanent, audited code and upgrade patterns are how risk is managed.',
    example: 'A staking contract holds tokens and applies its rules on deposit and withdrawal: whoever calls it within those rules gets the same deterministic result.',
    remember: 'On-chain means verifiable, not safe — the code you can read is still code that can be wrong.',
  },
];

/**
 * Used when nothing in the base matches. Honest by construction: it says the
 * entry does not exist yet instead of inventing an answer, which is exactly the
 * contract the widget asks for (`sections.simple` is required to be a string).
 */
export const FALLBACK_ENTRY: KnowledgeEntry = {
  id: 'fallback',
  concept: 'No knowledge-base entry yet',
  keywords: [],
  what: 'The built-in knowledge base answers from a curated list of platform and trading concepts.',
  simple:
    "I don't have an entry for that. I am Pyrus, your Prometheus trading buddy, and I only answer questions about trading, copy strategies, markets, and this platform. Please ask me about a trade, metric, chart, or concept on your screen!",
  howItWorks:
    'Questions outside of financial trading, copy trading books, and Prometheus platform features are declined so answers remain safe and relevant.',
  example: 'Try "why was this trade short?", "how does copy trading work?", or "what is impermanent loss?".',
  remember: 'Pyrus is a dedicated trading assistant, not a general-purpose chat bot.',
};

export interface MatchInput {
  query: string;
  /** Free text from the inspected element / visible page, if the widget sent any. */
  context?: string;
}

/** Whether the question is an element pointer without naming a concept. */
const GENERIC_POINTER_WORDS = ['this', 'it', 'here', 'that', 'selected', 'component', 'element', 'part'];

function isGenericPointer(query: string): boolean {
  if (!query) return true;
  const words = query.split(' ').filter(Boolean);
  const hasPointer = words.some((w) => GENERIC_POINTER_WORDS.includes(w));
  return hasPointer && words.length <= 5;
}

/**
 * Picks the entry for a question. Never returns null: a question the base does
 * not cover gets {@link FALLBACK_ENTRY}.
 */
export function matchKnowledgeEntry(input: MatchInput): KnowledgeEntry {
  const query = normalize(input.query ?? '');
  const context = normalize(input.context ?? '');

  const generic = isGenericPointer(query);

  let best: KnowledgeEntry = FALLBACK_ENTRY;
  let bestScore = 0;

  for (const entry of KNOWLEDGE_BASE) {
    let queryScore = 0;
    let contextScore = 0;
    for (const keyword of entry.keywords) {
      if (mentions(query, keyword)) queryScore += keyword.length * 3;
      if (context && mentions(context, keyword)) contextScore += keyword.length;
    }

    // Only allow context to score when the user specifically asks a generic
    // pointer question (e.g. "explain this") or when the query itself matches keywords.
    // An unrelated question (e.g. "who is ansar") must NEVER match simply because of page context.
    const score = queryScore > 0 ? queryScore + contextScore : (generic ? contextScore : 0);

    if (score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }

  return best;
}
