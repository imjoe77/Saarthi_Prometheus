/**
 * MODULE 03-05 — the browser's typed window onto the Prometheus API.
 *
 * Every call goes through the BFF at `/api/backend/*`, never to the NestJS
 * service directly: the browser holds no bearer token and never learns the
 * backend's address. This module is therefore safe to import from a client
 * component (`server-only` is deliberately absent) and runs entirely with
 * same-origin `fetch`.
 *
 * Responses are typed structurally rather than generated. That is a deliberate
 * trade for a prototype: the shapes here are small, and they double as the
 * documentation the wallet and portfolio pages read against.
 */

export interface AssetRef {
  symbol: string;
  name: string;
  decimals: number;
}

export interface AssetSummary extends AssetRef {
  kind: string;
}

export interface WalletSummary {
  id: string;
  status: "ACTIVE" | "FROZEN";
  createdAt: string;
  updatedAt: string;
}

export interface BalanceSummary {
  asset: AssetRef;
  available: string;
  locked: string;
}

export type TransactionTypeName =
  | "DEPOSIT"
  | "WITHDRAWAL"
  | "TRANSFER_IN"
  | "TRANSFER_OUT"
  | "LOCK"
  | "UNLOCK"
  | "ADJUSTMENT"
  | "BURN";

export interface TransactionSummary {
  id: string;
  type: TransactionTypeName;
  status: string;
  asset: AssetRef;
  amount: string;
  availableAfter: string | null;
  lockedAfter: string | null;
  note: string | null;
  createdAt: string;
}

export interface TransactionPage {
  items: TransactionSummary[];
  nextCursor: string | null;
}

/**
 * MODULE 04 — the portfolio read model, exactly as the API sends it.
 *
 * Note what is absent: there is no `netWorth`, no `valuation`, no `allocation`
 * and no `pnl`, because no price source exists to derive them from. A field that
 * is always `null` would be worse than a missing one: it would invite the UI to
 * render a zero as though it were a measured result.
 */
export type AssetKindName = "FIAT" | "STABLECOIN" | "TOKEN";

/** Counts per category. Categorical, not a share of value. */
export type PortfolioKindCounts = Record<AssetKindName, number>;

/** Counts per ledger event type. Every key is present, zero included. */
export type PortfolioTypeCounts = Record<TransactionTypeName, number>;

export interface PortfolioAssetRef {
  id: string;
  symbol: string;
  name: string;
  kind: AssetKindName;
  decimals: number;
  isActive: boolean;
}

export interface PortfolioHolding {
  asset: PortfolioAssetRef;
  /** Fixed-point strings at the asset's own scale. Never numbers. */
  available: string;
  locked: string;
  /** available + locked, derived server-side and never stored. */
  total: string;
  isFunded: boolean;
  /** locked / total as a 0-1 number, or null when the total is zero. */
  lockedShare: number | null;
}

export interface PortfolioComposition {
  assetCount: number;
  fundedAssetCount: number;
  byKind: PortfolioKindCounts;
}

export interface PortfolioActivity {
  totalMovements: number;
  movementsLast30Days: number;
  byType: PortfolioTypeCounts;
  firstMovementAt: string;
  lastMovementAt: string;
}

export interface PortfolioSnapshotResponse {
  /** Null when the caller has no wallet. Not an error. */
  wallet: Pick<WalletSummary, "id" | "status" | "createdAt"> | null;
  holdings: PortfolioHolding[];
  composition: PortfolioComposition;
  /** Null when the ledger is empty, so the UI can say "nothing yet". */
  activity: PortfolioActivity | null;
  generatedAt: string;
}

/**
 * MODULE 05 — the strategy registry, exactly as the API sends it.
 *
 * Note the two shapes. `StrategySummary` is what the owner sees about their own
 * record, including its lifecycle state. `PublicStrategySummary` is what
 * discovery returns for everybody else's, and it is narrower by design: no
 * `ownerId`, no owner email or handle, and no `status` or `visibility` either,
 * because both are constants in that set (PUBLIC and ACTIVE) and a field the
 * client can never see differently is a field it must not offer as a filter.
 *
 * There is no ROI, P&L, Sharpe, drawdown, risk level, follower count or AUM in
 * either type. Nothing in Prometheus can measure those yet, and a field typed as
 * `number` would be rendered as a measured result.
 */
export type StrategyVisibilityName = "PRIVATE" | "PUBLIC";

export type StrategyStatusName = "ACTIVE" | "ARCHIVED";

export interface StrategySummary {
  id: string;
  name: string;
  description: string | null;
  visibility: StrategyVisibilityName;
  status: StrategyStatusName;
  createdAt: string;
  updatedAt: string;
}

export interface PublicStrategySummary {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StrategyPage {
  items: StrategySummary[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface PublicStrategyPage {
  items: PublicStrategySummary[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface CreateStrategyInput {
  name: string;
  description?: string | null;
  visibility?: StrategyVisibilityName;
}

/**
 * Archiving is the only status change the API accepts, and it is one-way: the
 * type admits `ARCHIVED` alone, so an unarchive cannot be expressed here either.
 */
export interface UpdateStrategyInput {
  name?: string;
  description?: string | null;
  visibility?: StrategyVisibilityName;
  status?: "ARCHIVED";
}

export interface StrategyListQuery {
  page?: number;
  limit?: number;
  /** Owner listing only. Absent means ACTIVE and ARCHIVED together. */
  status?: StrategyStatusName;
  /** Owner listing only. Absent means both. */
  visibility?: StrategyVisibilityName;
}

const API_PREFIX = "/api/backend";

interface ApiErrorBody {
  code?: string;
  message?: string;
  details?: string[];
}

/** A failure the API described, carrying its stable code and status. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: string[];
  readonly requestId?: string;

  constructor(
    status: number,
    code: string,
    message: string,
    options?: { details?: string[]; requestId?: string },
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = options?.details;
    this.requestId = options?.requestId;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_PREFIX}/${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init?.body ? { "content-type": "application/json" } : {}),
    },
    // A cached answer on a wallet read is a wrong answer.
    cache: "no-store",
  });

  const text = await response.text();
  let body: unknown = null;

  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  if (!response.ok) {
    const error = (body ?? {}) as ApiErrorBody;

    throw new ApiError(
      response.status,
      error.code ?? "UNKNOWN",
      error.message ?? `The request failed with status ${response.status}.`,
      { details: error.details, requestId: response.headers.get("x-request-id") ?? undefined },
    );
  }

  return body as T;
}

/** Returns the caller's wallet, or null when they do not have one yet. */
export async function getWallet(): Promise<WalletSummary | null> {
  try {
    return await request<WalletSummary>("wallets/me");
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return null;
    }

    throw error;
  }
}

/** Creates the caller's wallet. Idempotent: an existing wallet is returned. */
export async function createWallet(): Promise<WalletSummary> {
  return request<WalletSummary>("wallets", { method: "POST" });
}

export async function getBalances(): Promise<BalanceSummary[]> {
  return request<BalanceSummary[]>("wallets/me/balances");
}

export async function getTransactions(
  options: { cursor?: string; limit?: number } = {},
): Promise<TransactionPage> {
  const params = new URLSearchParams();

  if (options.limit) params.set("limit", String(options.limit));
  if (options.cursor) params.set("cursor", options.cursor);

  const query = params.toString();

  return request<TransactionPage>(`wallets/me/transactions${query ? `?${query}` : ""}`);
}

export async function getAssets(): Promise<AssetSummary[]> {
  return request<AssetSummary[]>("assets");
}

/**
 * MODULE 03b — wallet top-ups.
 *
 * A deposit is the only way money enters a Prometheus wallet, and the amount it
 * credits is a real ledger movement: the balance the user then spends is the
 * ledger's own number, read back through `getBalances`.
 *
 * `status` is the deposit's lifecycle, which is not the same as the ledger's:
 * PENDING means the payment was started but not confirmed and holds no money
 * yet, SUCCEEDED is the only state in which the wallet holds it.
 */
export type DepositStatusName = "PENDING" | "SUCCEEDED" | "FAILED";

/**
 * The Razorpay checkout the browser must open.
 *
 * `keyId` is Razorpay's publishable key; it is safe in the browser because
 * Razorpay's checkout script needs it. The key secret never appears here.
 */
export interface DepositCheckout {
  keyId: string;
  orderId: string;
  amountPaise: number;
  currency: string;
  depositId: string;
}

export interface DepositSummary {
  id: string;
  asset: AssetRef;
  amount: string;
  status: DepositStatusName;
  provider: string;
  createdAt: string;
  checkout: DepositCheckout | null;
}

export interface PaymentsProviderInfo {
  provider: "simulated" | "razorpay";
  maxDepositInr: string;
  requiresCheckout: boolean;
}

/** Which rail a top-up would use, and how large a single top-up may be. */
export async function getPaymentsProvider(): Promise<PaymentsProviderInfo> {
  return request<PaymentsProviderInfo>("payments/provider");
}

/**
 * Starts a top-up.
 *
 * `clientRequestId` makes the call idempotent on (user, clientRequestId): a
 * retried request returns the original deposit instead of crediting the wallet
 * a second time. The caller keeps the same id for the same intent.
 */
export async function createDeposit(input: {
  clientRequestId: string;
  amountInr: string;
}): Promise<DepositSummary> {
  return request<DepositSummary>("payments/deposits", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** The caller's top-ups, newest first. */
export async function getDeposits(): Promise<DepositSummary[]> {
  return request<DepositSummary[]>("payments/deposits");
}

/**
 * Confirms a Razorpay payment. The backend recomputes the signature from the
 * order and payment ids, so a client cannot assert a payment it never made.
 */
export async function verifyDeposit(
  id: string,
  input: {
    razorpayOrderId: string;
    razorpayPaymentId: string;
    razorpaySignature: string;
  },
): Promise<DepositSummary> {
  return request<DepositSummary>(`payments/deposits/${encodeURIComponent(id)}/verify`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * MODULE 04 — the caller's portfolio: holdings, composition and activity.
 *
 * One request, no parameters, and never a 404 for "no wallet": the portfolio
 * resource always exists, it is simply empty. A user who has not created a wallet
 * yet receives `wallet: null` with zeroed counts.
 */
export async function getPortfolio(): Promise<PortfolioSnapshotResponse> {
  return request<PortfolioSnapshotResponse>("portfolio");
}

/** MODULE 05 — the caller's own strategies, newest first. */
export async function getStrategies(query: StrategyListQuery = {}): Promise<StrategyPage> {
  return request<StrategyPage>(`strategies/me${toQuery(query)}`);
}

/**
 * MODULE 05 — the public catalogue: other people's PUBLIC, ACTIVE strategies.
 *
 * `status` and `visibility` are not offered here, because the API pins both and
 * would ignore them. Sending them would suggest a filter that does not exist.
 */
export async function discoverStrategies(
  query: { page?: number; limit?: number } = {},
): Promise<PublicStrategyPage> {
  return request<PublicStrategyPage>(`strategies${toQuery(query)}`);
}

/** Creates a strategy for the signed-in user. The owner is never a parameter. */
export async function createStrategy(input: CreateStrategyInput): Promise<StrategySummary> {
  return request<StrategySummary>("strategies", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Changes one of the caller's strategies, or archives it for good. */
export async function updateStrategy(
  id: string,
  input: UpdateStrategyInput,
): Promise<StrategySummary> {
  return request<StrategySummary>(`strategies/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

/**
 * MODULE 05 — one strategy, resolved against the caller.
 *
 * 404 is returned both for "no such strategy" and "not yours", so this read
 * cannot be used to discover whether an id exists.
 */
export async function getStrategy(id: string): Promise<StrategySummary> {
  return request<StrategySummary>(`strategies/${encodeURIComponent(id)}`);
}


function toQuery(params: object): string {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }

  const encoded = search.toString();

  return encoded ? `?${encoded}` : "";
}



// ---------------------------------------------------------------------------
// MODULE 06c — live market data and expert paper trading.
// ---------------------------------------------------------------------------

export interface InstrumentDto {
  symbol: string;
  kind: "STOCK" | "CRYPTO";
  name: string;
  venue: string;
  quoteCurrency: string;
  quantityPrecision: number;
}

export interface QuoteDto {
  symbol: string;
  provider: "off" | "fake" | "alpaca";
  available: boolean;
  price: string | null;
  bid: string | null;
  ask: string | null;
  asOf: string | null;
  stale: boolean;
  marketState: "OPEN" | "CLOSED";
  isDemo: boolean;
}

export interface BarDto {
  symbol: string;
  timeframe: string;
  time: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

export interface BarsDto {
  items: BarDto[];
  isDemo: boolean;
}

export interface FeedStatusDto {
  provider: "off" | "fake" | "alpaca";
  enabled: boolean;
  isDemo: boolean;
  message: string;
}

export async function getInstruments(): Promise<InstrumentDto[]> {
  return request<InstrumentDto[]>("market-data/instruments");
}

export async function getFeedStatus(): Promise<FeedStatusDto> {
  return request<FeedStatusDto>("market-data/status");
}

export async function getQuote(symbol: string): Promise<QuoteDto> {
  return request<QuoteDto>("market-data/quotes" + toQuery({ symbol }));
}

export async function getBars(
  symbol: string,
  timeframe: "1m" | "5m" | "15m" | "1h" | "1d" = "1m",
  limit = 60,
): Promise<BarsDto> {
  return request<BarsDto>("market-data/bars" + toQuery({ symbol, timeframe, limit }));
}

export interface PaperOrderRequest {
  clientRequestId: string;
  symbol: string;
  side: "LONG" | "SHORT";
  quantity: string;
}

export interface PaperOrderResponse {
  orderId: string;
  strategyId: string;
  symbol: string;
  side: "LONG" | "SHORT";
  quantity: string;
  status: "FILLED" | "REJECTED";
  rejectReason: string | null;
  fillPrice: string | null;
  /** Realised by this fill against the position it reduced. Null when it realised nothing. */
  realizedPnl: string | null;
  placedAt: string;
  filledAt: string | null;
  clientRequestId: string;
}

export async function placePaperOrder(
  strategyId: string,
  input: PaperOrderRequest,
): Promise<PaperOrderResponse> {
  return request<PaperOrderResponse>(
    "strategies/" + encodeURIComponent(strategyId) + "/paper/orders",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

/**
 * Closes an open position at the live market price.
 *
 * The close is an ordinary order in the opposite direction at the position's
 * own quantity, so it fills under the same price and wallet rules as any other
 * order. A strategy that holds nothing for the symbol answers 404.
 */
export async function closePaperPosition(
  strategyId: string,
  symbol: string,
): Promise<PaperOrderResponse> {
  return request<PaperOrderResponse>(
    "strategies/" +
      encodeURIComponent(strategyId) +
      "/paper/positions/" +
      encodeURIComponent(symbol) +
      "/close",
    { method: "POST" },
  );
}

export async function listPaperOrders(strategyId: string): Promise<PaperOrderResponse[]> {
  return request<PaperOrderResponse[]>(
    "strategies/" + encodeURIComponent(strategyId) + "/paper/orders",
  );
}

// ---------------------------------------------------------------------------
// The paper cash account and open positions behind the expert's account panel.
// ---------------------------------------------------------------------------

/**
 * One open paper holding, priced at the market.
 *
 * `direction` says which way the holding points and `quantity` is its
 * magnitude, always greater than zero. The three marked figures are null
 * together: without a price there is no market value and no unrealised P&L,
 * and a zero would claim the position is worth nothing rather than that it
 * could not be priced.
 */
export interface PaperPositionDto {
  symbol: string;
  direction: "LONG" | "SHORT";
  quantity: string;
  averageEntryPrice: string;
  markPrice: string | null;
  marketValue: string | null;
  unrealizedPnl: string | null;
  stale: boolean;
  openedAt: string;
  lastActivityAt: string;
}

/**
 * The paper cash account for one strategy.
 *
 * `realizedPnl` is the ledger figure for closed positions only. There is no
 * unrealised P&L here on purpose: it lives on the positions, where the mark is.
 */
export interface PaperAccountDto {
  currency: string;
  cash: string;
  realizedPnl: string;
  openedAt: string;
  lastActivityAt: string;
}

/**
 * `account` is null until the first order provisions the paper account. That is
 * a legitimate answer, not an error, and a screen that treats it as one would
 * show a scary banner to every user who has simply not traded yet.
 *
 * `walletUsdt` is the trader's real USDT balance - the capital gate every
 * order's notional has to be covered by. It is a gate and not a debit: paper
 * trading is simulated and never spends real ledger money.
 */
export interface PaperSummaryDto {
  account: PaperAccountDto | null;
  positions: PaperPositionDto[];
  walletUsdt: string;
}

export async function getPaperSummary(strategyId: string): Promise<PaperSummaryDto> {
  return request<PaperSummaryDto>(
    "strategies/" + encodeURIComponent(strategyId) + "/paper/account",
  );
}

// ---------------------------------------------------------------------------
// MODULE 07 — copy trading: follows, allocation, engine history, copy cash.
// ---------------------------------------------------------------------------

export type CopyFollowStatusName = "ACTIVE" | "UNFOLLOWED";

/**
 * Why a follow is or is not copying right now - the same vocabulary the copy
 * history uses, so a refusal in the past and a stall in the present can be read
 * against one list. `ELIGIBLE` is the only state in which the engine copies.
 */
export type CopyEligibility =
  | "ELIGIBLE"
  | "FOLLOW_NOT_ACTIVE"
  | "STRATEGY_ARCHIVED"
  | "STRATEGY_NOT_ELIGIBLE"
  | "ALLOCATION_ROUNDED_TO_ZERO"
  | "INSUFFICIENT_COPY_CASH"
  | "PRICE_UNAVAILABLE"
  | "INSUFFICIENT_WALLET_BALANCE";

export type CopyRejectReason = Exclude<CopyEligibility, "ELIGIBLE">;

export interface CopyFollow {
  strategyId: string;
  strategyName: string;
  strategyStatus: "ACTIVE" | "ARCHIVED";
  status: CopyFollowStatusName;
  /** Share of each expert order mirrored, in (0, 1]. Exact decimal string. */
  allocationFraction: string;
  followedAt: string;
  unfollowedAt: string | null;
  lastProcessedAt: string | null;
  copiedCount: number;
  rejectedCount: number;
  eligibility: CopyEligibility;
  /**
   * True when the expert has committed a fill this follow's cursor has not
   * reached yet - the copy is behind, not broken.
   */
  hasPendingEvents: boolean;
}

/**
 * The follow plus the one live question that is not stored: whether the expert
 * has committed a fill this follow's cursor has not reached yet.
 *
 * The same shape the list now carries, kept as its own name because the
 * single-follow read is still what a strategy screen asks for.
 */
export type CopyFollowStatus = CopyFollow;

export interface CopyFollowPage {
  items: CopyFollow[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/**
 * One consumed expert fill: what was copied, or why it was not.
 *
 * `quantity`, `fillPrice` and `gross` are null - never zero - for a refusal,
 * because "executed nothing" and "executed zero" are different claims. A screen
 * must branch on `status` rather than add these up blindly.
 */
export interface CopyEvent {
  /** The strategy whose fill this event mirrors. */
  strategyId: string;
  /** Name of the strategy whose fill this event mirrors. */
  strategyName: string;
  expertOrderId: string;
  symbol: string;
  side: "LONG" | "SHORT";
  expertQuantity: string;
  expertFillPrice: string | null;
  expertFilledAt: string;
  allocationFraction: string;
  quantity: string | null;
  fillPrice: string | null;
  gross: string | null;
  /** Realised by this copy against the position it reduced. Null when it realised nothing. */
  realizedPnl: string | null;
  status: "COPIED" | "REJECTED";
  rejectReason: CopyRejectReason | null;
  processedAt: string;
}

export interface CopyEventPage {
  items: CopyEvent[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/**
 * One follow's simulated cash pot. Null until the first eligible fill provisions
 * it - "no account yet" is not a zero balance. Never Module 03 money.
 */
export interface CopyAccount {
  currency: string;
  cash: string;
  realizedPnl: string;
  openedAt: string;
  lastActivityAt: string;
}

/** One open copy holding: a direction, a magnitude, and the mark it was priced at. */
export interface CopyPosition {
  symbol: string;
  direction: "LONG" | "SHORT";
  quantity: string;
  averageEntryPrice: string;
  markPrice: string | null;
  marketValue: string | null;
  unrealizedPnl: string | null;
  stale: boolean;
  openedAt: string;
  lastActivityAt: string;
}

/**
 * One follow's copy money.
 *
 * `walletUsdt` is the caller's real, spendable USDT balance - the gate every
 * further copy has to pass. The copy pot is simulated and separate from it.
 */
export interface CopyFollowAccount {
  account: CopyAccount | null;
  positions: CopyPosition[];
  walletUsdt: string;
}

/** A sum of separate pots, not one pooled balance - hence `followCount`. */
export interface CopyAggregateAccount {
  followCount: number;
  cash: string;
  realizedPnl: string;
  walletUsdt: string;
  positions: Array<{
    symbol: string;
    direction: "LONG" | "SHORT";
    quantity: string;
    averageEntryPrice: string;
    markPrice: string | null;
    marketValue: string | null;
    unrealizedPnl: string | null;
    stale: boolean;
    followCount: number;
  }>;
}

export interface CopySyncResult {
  consumed: number;
  status: CopyFollowStatus;
}

/** One follower, as the strategy's owner sees them: address masked. */
export interface CopyFollower {
  followerId: string;
  maskedEmail: string;
  status: CopyFollowStatusName;
  allocationFraction: string;
  followedAt: string;
  unfollowedAt: string | null;
  copiedCount: number;
  rejectedCount: number;
}

export interface CopyFollowerPage {
  items: CopyFollower[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface CopyPageQuery {
  page?: number;
  limit?: number;
}

/** The caller's follows, newest first, with outcome counts. */
export async function listCopyFollows(
  query: CopyPageQuery = {},
): Promise<CopyFollowPage> {
  return request<CopyFollowPage>("copy/follows" + toQuery(query));
}

/**
 * One follow and its processing state, or null when the caller does not
 * follow this strategy - a 404 here is an answer ("not following"), not a
 * failure, which is why it resolves to null instead of throwing.
 */
export async function getCopyFollowStatus(strategyId: string): Promise<CopyFollowStatus | null> {
  try {
    return await request<CopyFollowStatus>(
      "copy/follows/" + encodeURIComponent(strategyId),
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/**
 * Follows a strategy. `allocationFraction` is required with no default, for
 * the reason the API requires it: mirroring the expert in full should be a
 * decision, not the number a form happened to ship with.
 *
 * 409 - already following, or it is the caller's own strategy. 404 - not a
 * strategy this caller may see. 400 - allocation outside (0, 1].
 */
export async function followStrategy(input: {
  strategyId: string;
  allocationFraction: string;
}): Promise<CopyFollow> {
  return request<CopyFollow>("copy/follows", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Changes an existing follow's allocation. Applies to the next fill only. */
export async function setCopyAllocation(
  strategyId: string,
  allocationFraction: string,
): Promise<CopyFollow> {
  return request<CopyFollow>("copy/follows/" + encodeURIComponent(strategyId), {
    method: "PATCH",
    body: JSON.stringify({ allocationFraction }),
  });
}

/** Stops copying. Idempotent. Cash and positions are never liquidated. */
export async function unfollowStrategy(strategyId: string): Promise<CopyFollow> {
  return request<CopyFollow>("copy/follows/" + encodeURIComponent(strategyId), {
    method: "DELETE",
  });
}

/**
 * Consumes this follow's pending fills now: the same loop the background worker
 * runs, once, returning how many events were written plus the state after.
 */
export async function syncCopyFollow(strategyId: string): Promise<CopySyncResult> {
  return request<CopySyncResult>(
    "copy/follows/" + encodeURIComponent(strategyId) + "/sync",
    { method: "POST" },
  );
}

/** Copy history for one follow, newest first. Refusals included, with reasons. */
export async function listCopyOrders(
  strategyId: string,
  query: CopyPageQuery = {},
): Promise<CopyEventPage> {
  return request<CopyEventPage>(
    "copy/follows/" + encodeURIComponent(strategyId) + "/orders" + toQuery(query),
  );
}

/** One follow's copy cash and positions. Account null before the first copy. */
export async function getCopyFollowAccount(strategyId: string): Promise<CopyFollowAccount> {
  return request<CopyFollowAccount>(
    "copy/follows/" + encodeURIComponent(strategyId) + "/account",
  );
}

/** The caller's copy cash across every follow: a sum of separate pots. */
export async function getCopyAggregateAccount(): Promise<CopyAggregateAccount> {
  return request<CopyAggregateAccount>("copy/account");
}

/**
 * Every copy the caller has made, across every follow, newest first.
 *
 * The per-follow history answers "what did this strategy do to my book". This
 * answers the question a follower actually asks most often - "what did the
 * experts I follow do to my book" - in one list. Refusals are included, with
 * their reasons, for the same reason they are in the per-follow history.
 */
export async function listCopyEvents(
  query: CopyPageQuery = {},
): Promise<CopyEventPage> {
  return request<CopyEventPage>("copy/events" + toQuery(query));
}

/**
 * One point of the copy book's profit-and-loss path.
 *
 * `realizedPnl` is what that single fill realised - zero for a buy, because a
 * buy moves cash into a position and realises nothing - and `cumulativePnl`
 * is the running total up to and including it.
 */
export interface CopyPerformancePoint {
  strategyId: string;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: string;
  fillPrice: string;
  gross: string;
  realizedPnl: string;
  cumulativePnl: string;
  processedAt: string;
}

/**
 * The caller's realised profit and loss, and the path that reached it.
 *
 * `realizedPnl` is the ledger's own figure. There is no unrealised mark in
 * this payload: pricing an open position needs a live quote, and this route
 * does not fetch one.
 */
export interface CopyPerformance {
  followCount: number;
  realizedPnl: string;
  cash: string;
  copiedCount: number;
  rejectedCount: number;
  points: CopyPerformancePoint[];
}

/** The caller's realised profit and loss, with one point per executed fill. */
export async function getCopyPerformance(): Promise<CopyPerformance> {
  return request<CopyPerformance>("copy/performance");
}

/**
 * Who follows one of the caller's strategies, addresses masked. 404 when the
 * caller does not own the strategy - the Module 05 posture, so the id cannot be
 * probed through this route.
 */
export async function listStrategyFollowers(
  strategyId: string,
  query: CopyPageQuery = {},
): Promise<CopyFollowerPage> {
  return request<CopyFollowerPage>(
    "copy/strategies/" + encodeURIComponent(strategyId) + "/followers" + toQuery(query),
  );
}

export interface ConnectExpertResult {
  success: boolean;
  strategyId: string;
  strategyName: string;
  fee: string;
  asset: string;
  remainingBalance: string;
  unlockedAt: string;
}

export interface ExpertChatResult {
  strategyId: string;
  expertName: string;
  reply: string;
  timestamp: string;
}

/** Directly connects and unlocks 1-on-1 consultation with an expert trader for 10 EMBER. */
export async function connectExpertTrader(strategyId: string): Promise<ConnectExpertResult> {
  return request<ConnectExpertResult>(
    "copy/strategies/" + encodeURIComponent(strategyId) + "/connect-expert",
    { method: "POST" },
  );
}

/** Sends a message to the expert trader in an unlocked consultation session. */
export async function sendExpertChatMessage(
  strategyId: string,
  message: string,
): Promise<ExpertChatResult> {
  return request<ExpertChatResult>(
    "copy/strategies/" + encodeURIComponent(strategyId) + "/expert-chat",
    {
      method: "POST",
      body: JSON.stringify({ message }),
    },
  );
}

// ---------------------------------------------------------------------------
// MODULE 11 - EMBER tokenomics
// ---------------------------------------------------------------------------

/** The configured split every reference amount is divided by. */
export interface TokenomicsConfig {
  /** Share of every reference amount allocated to direct burn, in percent. */
  directBurnPct: number;
  /** Share of every reference amount allocated to simulated buyback, in percent. */
  buybackPct: number;
}

/**
 * A computed split of one reference amount. Computation only: the preview
 * route persists nothing, so these figures are never a record.
 */
export interface TokenomicsPreview {
  referenceAmount: string;
  emberPrice: string;
  directBurnPct: number;
  buybackPct: number;
  directBurnInr: string;
  buybackInr: string;
  directBurnEmber: string;
  buybackEmber: string;
  /** Sum of both floored quantities. Illustrative, never a recorded figure. */
  potentialBurnEmber: string;
}

/** A recorded allocation proposal: the split, frozen at proposal time. */
export interface TokenAllocationRecord {
  allocationId: string;
  referenceAmount: string;
  emberPrice: string;
  directBurnPct: number;
  buybackPct: number;
  directBurnInr: string;
  buybackInr: string;
  directBurnEmber: string;
  buybackEmber: string;
  clientRequestId: string;
  allocatedAt: string;
}

/**
 * Lifecycle stage: SIMULATED (proposed) or RECORDED_SIMULATED_EXECUTION.
 * Actual execution is deliberately not a state - Module 11 simulates only.
 */
export type TokenBuybackStatusName = "SIMULATED" | "RECORDED_SIMULATED_EXECUTION";

/** A simulated buyback. It moves nothing until a burn record is written. */
export interface TokenBuybackRecord {
  buybackId: string;
  allocationId: string;
  status: TokenBuybackStatusName;
  buybackInr: string;
  emberPrice: string;
  emberQuantity: string;
  executedPrice: string | null;
  executedEmber: string | null;
  simulatedAt: string;
  executedAt: string | null;
  clientRequestId: string;
}

/** A completed burn: the only operation that destroys EMBER. */
export interface TokenBurnRecord {
  burnId: string;
  source: "DIRECT" | "BUYBACK";
  buybackId: string | null;
  amount: string;
  clientRequestId: string;
  burnedAt: string;
}

/** The caller's own tokenomics records, newest first, capped at 50 per type. */
export interface TokenomicsRecords {
  allocations: TokenAllocationRecord[];
  buybacks: TokenBuybackRecord[];
  burns: TokenBurnRecord[];
}

/** MODULE 10 — ledger-derived EMBER supply figures, 18dp strings. */
export interface EmberSupply {
  asset: string;
  totalIssuedSupply: string;
  circulatingSupply: string;
  lockedSupply: string;
  availableSupply: string;
  burnedSupply: string;
}

/** MODULE 11 — the configured direct-burn / buyback split. */
export async function getTokenomicsConfig(): Promise<TokenomicsConfig> {
  return request<TokenomicsConfig>("tokenomics/config");
}

/**
 * MODULE 11 — computes a split without persisting anything. The same inputs
 * and configuration always produce the same figures.
 */
export async function previewTokenAllocation(input: {
  referenceAmount: string;
  emberPrice: string;
}): Promise<TokenomicsPreview> {
  return request<TokenomicsPreview>("tokenomics/preview", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * MODULE 11 — records an allocation proposal. Re-sending the same
 * `clientRequestId` replays the original record instead of writing a second one.
 */
export async function createTokenAllocation(input: {
  referenceAmount: string;
  emberPrice: string;
  clientRequestId: string;
}): Promise<TokenAllocationRecord> {
  return request<TokenAllocationRecord>("tokenomics/allocations", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** MODULE 11 — proposes a SIMULATED buyback against a recorded allocation. */
export async function createTokenBuyback(input: {
  allocationId: string;
  clientRequestId: string;
}): Promise<TokenBuybackRecord> {
  return request<TokenBuybackRecord>("tokenomics/buybacks", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * MODULE 11 — records the simulated execution of a buyback. Replaying the
 * same price returns the original record; a different price is refused: the
 * recording is one-way and never overwritten.
 */
export async function executeTokenBuyback(
  buybackId: string,
  input: { executedPrice: string },
): Promise<TokenBuybackRecord> {
  return request<TokenBuybackRecord>(
    "tokenomics/buybacks/" + encodeURIComponent(buybackId) + "/execute",
    { method: "POST", body: JSON.stringify(input) },
  );
}

/**
 * MODULE 11 — records a burn: the one operation that destroys EMBER. DIRECT
 * burns state an `amount`; BUYBACK burns name an executed `buybackId` and take
 * its quantity exactly.
 */
export async function createTokenBurn(input: {
  source: "DIRECT" | "BUYBACK";
  buybackId?: string;
  amount?: string;
  clientRequestId: string;
}): Promise<TokenBurnRecord> {
  return request<TokenBurnRecord>("tokenomics/burns", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** MODULE 11 — the caller's own allocations, simulated buybacks and burns. */
export async function getTokenomicsRecords(): Promise<TokenomicsRecords> {
  return request<TokenomicsRecords>("tokenomics/records");
}

/** MODULE 10 — EMBER supply derived from the ledger, read-only. */
export async function getEmberSupply(): Promise<EmberSupply> {
  return request<EmberSupply>("ember/supply");
}

// ---------------------------------------------------------------------------
// MODULE 08 x MODULE 11 - settled USDT orders feeding the buyback & burn engine.
// ---------------------------------------------------------------------------

/**
 * Why an order has the status it has — the backend's `EXCHANGE_REVENUE_REASON`
 * set, mirrored. A blank would be indistinguishable from a bug, so every row
 * carries one, including the reasons nothing was allocated.
 */
export type ExchangeRevenueReason =
  | "ATTRIBUTED"
  | "VOLUME_SIZED"
  | "SELL_OUT_OF_SCOPE"
  | "LEGACY_NO_LP_BACKING"
  | "POLICY_DISABLED"
  | "POLICY_RATE_ZERO"
  | "NO_RETAINED_MARGIN"
  | "BELOW_INR_SCALE"
  | "PIPELINE_COMPLETED"
  | "TREASURY_RESERVE_FLOOR"
  | "TREASURY_INSUFFICIENT_BALANCE"
  | "RETRY_SCHEDULED"
  | "RETRIES_EXHAUSTED"
  | "POLICY_ERROR";

export type ExchangeRevenueStatus =
  | "INELIGIBLE"
  | "PENDING"
  | "PROCESSING"
  | "COMPLETED"
  | "BLOCKED"
  | "FAILED";

/** `NOT_REQUIRED` means the ledger recorded the burn and the chain never saw it. */
export type OnChainBurnState = "NOT_REQUIRED" | "PENDING" | "SUBMITTED" | "CONFIRMED" | "FAILED";

export interface ExchangeRevenueBurnRef {
  burnId: string;
  amount: string;
  onChainStatus: OnChainBurnState;
  onChainTxHash: string | null;
}

/** The split Module 11 actually applied to one order, read off its allocation row. */
export interface ExchangeRevenueAllocationRef {
  allocationId: string;
  directBurnPct: number;
  buybackPct: number;
  directBurnEmber: string;
  buybackEmber: string;
}

export interface ExchangeRevenueEventRecord {
  eventId: string;
  orderId: string;
  userId: string;
  side: string;
  status: ExchangeRevenueStatus;
  reasonCode: ExchangeRevenueReason;
  detail: string | null;
  customerInr: string;
  lpInrSettled: string;
  retainedInr: string;
  /** INR the platform earned from this order. Zero under a volume basis. */
  revenueInr: string;
  /**
   * INR the burn engine was sized against. Equals `revenueInr` under
   * RETAINED_BPS and the order's own value under VOLUME_LINKED — which is the
   * whole difference between turnover and income, so the page shows both.
   */
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
  allocation: ExchangeRevenueAllocationRef | null;
  buybackId: string | null;
  /** SIMULATED or RECORDED_SIMULATED_EXECUTION. Neither says EMBER was bought. */
  buybackStatus: "SIMULATED" | "RECORDED_SIMULATED_EXECUTION" | null;
  buybackExecutedEmber: string | null;
  directBurn: ExchangeRevenueBurnRef | null;
  buybackBurn: ExchangeRevenueBurnRef | null;
}

export interface ExchangeRevenueSummary {
  policy: {
    mode: "NONE" | "RETAINED_BPS" | "VOLUME_LINKED";
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
    /** What the engine was sized against in total — see `basisInr` per event. */
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
  byStatus: Record<
    string,
    { count: number; revenueInr: string; basisInr: string; customerInr: string }
  >;
  recent: ExchangeRevenueEventRecord[];
}

/**
 * MODULE 08 x MODULE 11 — what settled USDT orders fed the burn engine, and
 * what the engine made of each one.
 *
 * The policy travels with the figures on purpose: "0 EMBER burned" has at
 * least three causes, and the page cannot tell them apart from the totals.
 */
export async function getExchangeRevenue(limit = 20): Promise<ExchangeRevenueSummary> {
  return request<ExchangeRevenueSummary>(
    `tokenomics/exchange-revenue?limit=${encodeURIComponent(String(limit))}`,
  );
}

/**
 * MODULE 08 x MODULE 11 — drain the settled-order queue now instead of waiting
 * for the worker's next tick. PLATFORM_ADMIN only; the backend refuses anyone
 * else, so the page offers it to admins and nothing else.
 */
export async function runExchangeRevenueOnce(): Promise<{ processed: number }> {
  return request<{ processed: number }>("tokenomics/exchange-revenue/run-once", {
    method: "POST",
  });
}

// ---------------------------------------------------------------------------
// MODULE 12 - treasury guardrails & dashboard (read-only).
// ---------------------------------------------------------------------------

export interface TreasuryBalanceBlock {
  available: string;
  locked: string;
  total: string;
}

/**
 * The owner-approved reserve policy, computed by the backend: a 30% floor
 * over cumulative qualifying treasury EMBER funding (DEPOSIT ledger legs),
 * with the discretionary capacity above it and a floor-relative status.
 * UNPROVISIONED means no treasury account exists yet - nothing is fabricated.
 */
export interface TreasuryReservePolicy {
  floorPercent: number;
  floorBase: "QUALIFYING_TREASURY_FUNDING";
  floorBaseAmount: string | null;
  floorAmount: string | null;
  discretionaryCapacity: string | null;
  status: "UNPROVISIONED" | "OK" | "AT_FLOOR" | "BELOW_FLOOR";
  note: string;
}

/**
 * Monthly USDT capacity, kept separate from the EMBER reserve by design.
 * Reporting-only: the backend never claims spending is blocked, because no
 * treasury USDT spending operation enforces the capacity.
 */
export interface TreasuryUsdtCapacity {
  configured: boolean;
  /** The approved prototype/demo figure rather than real operating capital. */
  demo: boolean;
  /** Approved capacity in INR (default 300000000 = ₹30 crore). */
  capacityInr: string | null;
  /** The same capacity in USDT, converted at the display-only rate; null when no rate. */
  capacity: string | null;
  utilization: string;
  remaining: string | null;
  /** The tracked calendar month, as YYYY-MM (UTC). */
  window: string;
  timezone: "UTC";
  utilizationBasis: "TREASURY_WALLET_USDT_OUTFLOWS";
  /** Where the INR->USDT display conversion got its rate, or why it is unavailable. */
  conversion: {
    source: "USDT_FALLBACK_PRICE_INR";
    priceInr: string | null;
    reason: "CONVERSION_RATE_UNAVAILABLE" | null;
  } | null;
  exhaustion: "AVAILABLE" | "EXHAUSTED" | "UNAVAILABLE" | "NOT_CONFIGURED";
  note: string;
}

/** Platform-wide recorded tokenomics activity (display aggregates only). */
export interface TreasuryActivity {
  burns: { count: number; recordedEmber: string };
  buybacks: { count: number; executedCount: number; recordedEmber: string };
  allocations: { count: number };
}

export interface TreasurySummary {
  treasury: {
    email: string;
    provisioned: boolean;
    userId: string | null;
    walletId: string | null;
    walletStatus: "ACTIVE" | "FROZEN" | null;
  };
  ember: TreasuryBalanceBlock | null;
  usdt: TreasuryBalanceBlock | null;
  /** Lifetime EMBER inflows - informational history, broader than the floor base. */
  emberLifetimeFundedIn: string | null;
  reserve: TreasuryReservePolicy;
  usdtCapacity: TreasuryUsdtCapacity;
  activity: TreasuryActivity;
}

/** MODULE 12 - the platform treasury snapshot, read-only. */
export async function getTreasurySummary(): Promise<TreasurySummary> {
  return request<TreasurySummary>("treasury/summary");
}

// ---------------------------------------------------------------------------
// MODULE 13 - RBAC: roles, self-serve requests, admin surface, profile.
// ---------------------------------------------------------------------------

export type RoleName = "USER" | "EXPERT_TRADER" | "LIQUIDITY_PROVIDER" | "PLATFORM_ADMIN";

export type RoleRequestStatusName = "PENDING" | "APPROVED" | "REJECTED";

/** What `GET /rbac/me` returns: the caller's roles and what they may still request. */
export interface MyRolesResponse {
  userId: string;
  /**
   * Effective roles for this session: the held roles narrowed to the persona
   * the user signed in as (null `activeRole` = unscoped, all held roles).
   * Everything that gates UI reads this set.
   */
  roles: RoleName[];
  /** Every role the account holds, regardless of which persona it signed in as. */
  heldRoles: RoleName[];
  /** The persona this session signed in as, or null when none was chosen. */
  activeRole: RoleName | null;
  /** Roles the account may still request — computed from held, not scoped. */
  requestable: RoleName[];
}

export interface RoleRequest {
  id: string;
  role: RoleName;
  status: RoleRequestStatusName;
  note: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface AdminUser {
  id: string;
  email: string;
  status: string;
  roles: RoleName[];
  createdAt: string;
}

export interface AdminRoleRequest extends RoleRequest {
  user: { id: string; email: string };
}

export interface AdminAuditLog {
  id: string;
  action: string;
  targetUserId: string | null;
  detail: unknown;
  createdAt: string;
  actor: { id: string; email: string };
}

/** MODULE 13 — the caller's roles and requestable roles. */
export async function getMyRoles(): Promise<MyRolesResponse> {
  return request<MyRolesResponse>("rbac/me");
}

/**
 * MODULE 13 — submit a self-serve elevated-role request.
 *
 * PLATFORM_ADMIN is included so the Platform Admin card can take the same
 * path as every other persona, but the backend never queues it: an address
 * not listed in `PLATFORM_ADMIN_EMAILS` is refused with FORBIDDEN, and a
 * listed one is auto-approved exactly like the other allowlists.
 */
export async function createRoleRequest(input: {
  role: Exclude<RoleName, "USER">;
  note?: string;
}): Promise<{ id: string }> {
  return request<{ id: string }>("rbac/role-requests", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** What `GET /rbac/authorize` returns: whether this email may self-authorize the role. */
export interface RoleAuthorizationResponse {
  role: RoleName | null;
  authorized: boolean;
  /**
   * Why the answer is "no", when the backend has something specific to say —
   * e.g. the one-privileged-role rule's "try a different account" refusal.
   * Absent for an ordinary allowlist miss, which the denial notice words
   * generically.
   */
  reason?: string;
}

/**
 * MODULE 13 — ask the backend whether this account may take the given
 * elevated persona (allowlist + the one-privileged-role rule).
 */
export async function authorizeMyRole(
  role: Exclude<RoleName, "USER">,
): Promise<RoleAuthorizationResponse> {
  return request<RoleAuthorizationResponse>(
    `rbac/authorize?role=${encodeURIComponent(role)}`,
  );
}

/** MODULE 13 — the caller's own request history. */
export async function listMyRoleRequests(): Promise<RoleRequest[]> {
  return request<RoleRequest[]>("rbac/role-requests/me");
}

/** MODULE 13 — admin: list users with their roles. */
export async function adminListUsers(): Promise<AdminUser[]> {
  return request<AdminUser[]>("admin/users");
}

/** MODULE 13 — admin: grant EXPERT_TRADER or LIQUIDITY_PROVIDER. */
export async function adminGrantRole(
  userId: string,
  role: Exclude<RoleName, "USER" | "PLATFORM_ADMIN">,
): Promise<void> {
  await request<void>(`admin/users/${encodeURIComponent(userId)}/roles`, {
    method: "POST",
    body: JSON.stringify({ role }),
  });
}

/** MODULE 13 — admin: revoke a privileged role. USER cannot be revoked. */
export async function adminRevokeRole(userId: string, role: RoleName): Promise<void> {
  await request<void>(
    `admin/users/${encodeURIComponent(userId)}/roles/${encodeURIComponent(role)}`,
    { method: "DELETE" },
  );
}

/** MODULE 13 — admin: the role-request queue, optionally filtered by status. */
export async function adminListRoleRequests(
  status?: RoleRequestStatusName,
): Promise<AdminRoleRequest[]> {
  return request<AdminRoleRequest[]>(
    "admin/role-requests" + toQuery(status ? { status } : {}),
  );
}

/** MODULE 13 — admin: approve or reject a pending request. */
export async function adminDecideRoleRequest(
  requestId: string,
  decision: "APPROVED" | "REJECTED",
): Promise<void> {
  await request<void>(
    `admin/role-requests/${encodeURIComponent(requestId)}/decision`,
    { method: "POST", body: JSON.stringify({ decision }) },
  );
}

/** MODULE 13 — admin: recent administrative audit records. */
export async function adminListAuditLogs(): Promise<AdminAuditLog[]> {
  return request<AdminAuditLog[]>("admin/audit-logs");
}

// ---------------------------------------------------------------------------
// PLATFORM ADMIN - money and account controls (admin/platform/*)
// ---------------------------------------------------------------------------

export type UserStatusName = "ACTIVE" | "SUSPENDED" | "CLOSED";

export type WalletStatusName = "ACTIVE" | "FROZEN";

/** What an admin balance change returns: the wallet balance after it moved. */
export interface PlatformMovementResult {
  walletId: string;
  asset: { symbol: string; name: string; decimals: number };
  ledgerType: string;
  note: string;
  available: string;
  locked: string;
}

export interface PlatformUserStatusResult {
  userId: string;
  status: UserStatusName;
}

export interface PlatformWalletStatusResult {
  walletId: string;
  walletStatus: WalletStatusName;
}

/**
 * PLATFORM ADMIN - credit the treasury's system wallet with an asset.
 * This is how capital (INR/USDT) and EMBER inventory reach the platform of
 * record; every funding is an ADJUSTMENT leg plus an audit row.
 */
export async function adminFundTreasury(input: {
  assetSymbol: string;
  amount: string;
  note: string;
}): Promise<PlatformMovementResult> {
  return request<PlatformMovementResult>("admin/platform/treasury/funding", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * PLATFORM ADMIN - one manual CREDIT or DEBIT against a user's wallet.
 * The ledger records an ADJUSTMENT and the note is required, on both the
 * ledger row and the audit row.
 */
export async function adminWalletMovement(
  userId: string,
  input: {
    kind: "CREDIT" | "DEBIT";
    assetSymbol: string;
    amount: string;
    note: string;
  },
): Promise<PlatformMovementResult> {
  return request<PlatformMovementResult>(
    `admin/platform/users/${encodeURIComponent(userId)}/wallet-movements`,
    { method: "POST", body: JSON.stringify(input) },
  );
}

/** PLATFORM ADMIN - set a user's lifecycle status; SUSPENDED/CLOSED kill the account's tokens immediately. */
export async function adminSetUserStatus(
  userId: string,
  status: UserStatusName,
): Promise<PlatformUserStatusResult> {
  return request<PlatformUserStatusResult>(
    `admin/platform/users/${encodeURIComponent(userId)}/status`,
    { method: "POST", body: JSON.stringify({ status }) },
  );
}

/** PLATFORM ADMIN - freeze or unfreeze a user's wallet. A frozen wallet refuses every movement. */
export async function adminSetWalletStatus(
  userId: string,
  status: WalletStatusName,
): Promise<PlatformWalletStatusResult> {
  return request<PlatformWalletStatusResult>(
    `admin/platform/users/${encodeURIComponent(userId)}/wallet-status`,
    { method: "POST", body: JSON.stringify({ status }) },
  );
}

/** PLATFORM ADMIN - a token asset's lifecycle flag after an admin toggle. */
export interface PlatformAssetStatusResult {
  symbol: string;
  name: string;
  kind: string;
  decimals: number;
  isActive: boolean;
}

/**
 * PLATFORM ADMIN - debit the treasury's system wallet (remove capital /
 * retire inventory). Same audit-or-nothing convention as funding.
 */
export async function adminTreasuryWithdrawal(input: {
  assetSymbol: string;
  amount: string;
  note: string;
}): Promise<PlatformMovementResult> {
  return request<PlatformMovementResult>("admin/platform/treasury/withdrawal", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** PLATFORM ADMIN - retire or restore an asset; a retired asset refuses every movement. */
export async function adminSetAssetStatus(
  symbol: string,
  input: { isActive: boolean; note: string },
): Promise<PlatformAssetStatusResult> {
  return request<PlatformAssetStatusResult>(
    `admin/platform/assets/${encodeURIComponent(symbol)}/status`,
    { method: "POST", body: JSON.stringify(input) },
  );
}

/** What GET admin/platform/overview returns: the whole platform in one read. */
export interface PlatformOverview {
  users: {
    total: number;
    byStatus: Record<"ACTIVE" | "SUSPENDED" | "CLOSED", number>;
  };
  wallets: { total: number; byStatus: Record<"ACTIVE" | "FROZEN", number> };
  roles: { role: RoleName; count: number }[];
  roleRequests: { total: number; pending: number };
  activity: { strategies: { total: number; public: number }; copyFollows: number };
  assets: {
    symbol: string;
    name: string;
    kind: string;
    decimals: number;
    isActive: boolean;
    walletsHolding: number;
    totalAvailable: string;
    totalLocked: string;
  }[];
  treasury: {
    provisioned: boolean;
    userId: string | null;
    walletId: string | null;
    walletStatus: "ACTIVE" | "FROZEN" | null;
    balances: { symbol: string; decimals: number; available: string; locked: string }[];
  };
  recentAudit: {
    id: string;
    action: string;
    actorEmail: string;
    targetUserId: string | null;
    detail: unknown;
    createdAt: string;
  }[];
}

/** PLATFORM ADMIN - one read-only snapshot of accounts, wallets, assets, treasury and audit. */
export async function adminPlatformOverview(): Promise<PlatformOverview> {
  return request<PlatformOverview>("admin/platform/overview");
}

/** One account with its wallet state, balances and newest ledger legs. */
export interface PlatformUserDetail {
  user: { id: string; email: string; status: UserStatusName; createdAt: string };
  roles: RoleName[];
  counts: { strategies: number; follows: number; roleRequests: number };
  wallet:
    | null
    | {
        id: string;
        status: WalletStatusName;
        createdAt: string;
        balances: {
          symbol: string;
          name: string;
          decimals: number;
          available: string;
          locked: string;
        }[];
        ledger: {
          id: string;
          type: TransactionTypeName;
          status: string;
          amount: string;
          availableAfter: string | null;
          lockedAfter: string | null;
          note: string | null;
          createdAt: string;
          asset: { symbol: string; decimals: number };
        }[];
      };
}

/** PLATFORM ADMIN - everything the platform knows about one account. */
export async function adminUserDetail(userId: string): Promise<PlatformUserDetail> {
  return request<PlatformUserDetail>(
    `admin/platform/users/${encodeURIComponent(userId)}`,
  );
}

/** MODULE 13 — the caller's profile and questionnaire answers. */
export interface ProfileResponse {
  displayName: string | null;
  country: string | null;
  displayCurrency: string | null;
  experienceLevel: string | null;
  investmentCapitalRange: string | null;
  capitalAvailability: string | null;
  riskTolerance: string | null;
  drawdownComfort: string | null;
  volatilityComfort: string | null;
  primaryGoal: string | null;
  timeHorizon: string | null;
  expectedReturnRange: string | null;
  holdingPeriod: string | null;
  lossReaction: string | null;
  liquidityNeeds: string | null;
  contributionFrequency: string | null;
  onboardingCompletedAt: string | null;
}

/** MODULE 13 — the caller's profile. */
export async function getMyProfile(): Promise<ProfileResponse> {
  return request<ProfileResponse>("profile/me");
}

/** MODULE 13 — partial update of the caller's profile. */
export async function updateMyProfile(
  input: Partial<Omit<ProfileResponse, "onboardingCompletedAt">>,
): Promise<ProfileResponse> {
  return request<ProfileResponse>("profile/me", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

/** MODULE 13 — mark onboarding complete (idempotent; requires core answers). */
export async function completeOnboarding(): Promise<ProfileResponse> {
  return request<ProfileResponse>("profile/me/onboarding/complete", { method: "POST" });
}

// ---------------------------------------------------------------------------
// MODULE 09 / 13 - simulated liquidity provider surface.
// ---------------------------------------------------------------------------

export interface LiquidityProviderSummary {
  lpId: string;
  status: string;
  registeredAt: string;
}

export interface LiquidityCommitmentSummary {
  commitmentId: string;
  lpId: string;
  status: string;
  usdtCommitted: string;
  usdtConsumed: string;
  usdtAvailable: string;
  emberLocked: string;
  clientRequestId: string;
  committedAt: string;
  closedAt: string | null;
}

export interface LiquidityMyCommitment {
  provider: LiquidityProviderSummary | null;
  commitment: LiquidityCommitmentSummary | null;
  commitmentsEnabled: boolean;
}

export interface LiquidityTopUpNotice {
  topUpRequestId: string;
  requiredUsdt: string;
  thresholdUsdt: string;
  status: string;
  openedAt: string;
  resolvedAt: string | null;
}

export interface LiquidityOverview {
  aggregateAvailableUsdt: string;
  thresholdUsdt: string;
  shortfallUsdt: string;
  belowThreshold: boolean;
  commitmentsEnabled: boolean;
  openRequest: LiquidityTopUpNotice | null;
}

/** MODULE 09/13 — the caller's LP registration and commitment. */
export async function getMyLiquidityCommitment(): Promise<LiquidityMyCommitment> {
  return request<LiquidityMyCommitment>("liquidity/commitments/me");
}

/** MODULE 09/13 — aggregate liquidity health against the configured threshold. */
export async function getLiquidityOverview(): Promise<LiquidityOverview> {
  return request<LiquidityOverview>("liquidity/overview");
}

/** The provider's own USDT wallet, as it stands right now. */
export interface LiquidityProviderWallet {
  availableUsdt: string;
  lockedUsdt: string;
}

/** Aggregate pool facts behind the admin distribution table. */
export interface LiquidityDistributionTotals {
  totalCommittedUsdt: string;
  totalDistributedUsdt: string;
  totalRemainingUsdt: string;
  totalWithdrawnUsdt: string;
  distributedInr: string;
  allocationCount: number;
  ordersFunded: number;
  providerCount: number;
  activeProviderCount: number;
  activeRemainingUsdt: string;
  thresholdUsdt: string;
  shortfallUsdt: string;
  belowThreshold: boolean;
  commitmentsEnabled: boolean;
}

/** One provider's place in the USDT distribution - the full breakdown. */
export interface LiquidityProviderDistribution {
  lpId: string;
  userId: string;
  email: string;
  status: string;
  registeredAt: string;
  commitment: LiquidityCommitmentSummary | null;
  contributedUsdt: string;
  contributedInr: string;
  allocationCount: number;
  ordersFunded: number;
  lastAllocatedAt: string | null;
  reducedUsdt: string;
  shareOfCommittedPct: string;
  shareOfAvailablePct: string;
  wallet: LiquidityProviderWallet | null;
}

/** One recent allocation slice with its order and owning provider. */
export interface LiquidityRecentAllocation {
  allocationId: string;
  orderId: string;
  orderSide: string;
  orderUsdtAmount: string;
  commitmentId: string;
  lpId: string;
  providerEmail: string;
  usdtAmount: string;
  priceInr: string;
  inrAmount: string;
  allocatedAt: string;
}

/** MODULE 09/13 — admin-only distribution read (biggest contributor first). */
export interface LiquidityDistribution {
  generatedAt: string;
  totals: LiquidityDistributionTotals;
  providers: LiquidityProviderDistribution[];
  recentAllocations: LiquidityRecentAllocation[];
}

/**
 * MODULE 09/13 — admin-only: how USDT is distributed across liquidity
 * providers (403 for anyone else). Strictly read-only server-side.
 */
export async function getLiquidityDistribution(): Promise<LiquidityDistribution> {
  return request<LiquidityDistribution>("liquidity/distribution");
}

/**
 * One EMBER-locking slab, as the backend reports the approved table.
 *
 * A commitment at or above `minUsdt` (and below the next slab) locks exactly
 * `requiredEmber` - a flat cliff, not a rate.
 */
export interface LiquiditySlab {
  minUsdt: string;
  requiredEmber: string;
}

export interface LiquiditySlabs {
  commitmentsEnabled: boolean;
  slabs: LiquiditySlab[];
}

/** MODULE 09 — the approved EMBER-locking slabs the server will apply. */
export async function getLiquiditySlabs(): Promise<LiquiditySlabs> {
  return request<LiquiditySlabs>("liquidity/slabs");
}

export interface LiquidityCommitmentResult {
  created: boolean;
  replayed: boolean;
  commitment: LiquidityCommitmentSummary;
}

/**
 * MODULE 09 — opens or increases the caller's USDT commitment.
 *
 * `clientRequestId` makes the call idempotent: the server stores it on the
 * commitment, so a double-submitted pledge replays the original outcome
 * instead of locking the EMBER twice. The server owns the slab arithmetic -
 * the amount alone is sent.
 */
export async function createLiquidityCommitment(input: {
  usdtAmount: string;
  clientRequestId: string;
}): Promise<LiquidityCommitmentResult> {
  return request<LiquidityCommitmentResult>("liquidity/commitments", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export interface LiquidityReductionResult {
  replayed: boolean;
  reduction: {
    reductionId: string;
    commitmentId: string;
    usdtAmount: string;
    emberUnlocked: string;
    clientRequestId: string;
    reducedAt: string;
  };
}

/**
 * MODULE 09 — withdraws USDT from the caller's own commitment.
 *
 * Idempotent on (commitmentId, clientRequestId). The server refuses to
 * withdraw liquidity that orders have already consumed.
 */
export async function reduceLiquidityCommitment(input: {
  commitmentId: string;
  usdtAmount: string;
  clientRequestId: string;
}): Promise<LiquidityReductionResult> {
  return request<LiquidityReductionResult>("liquidity/commitments/reduce", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

// ---------------------------------------------------------------------------
// MODULE 08 - USDT / INR exchange (internal ledger settlement)
// ---------------------------------------------------------------------------

export type UsdtSide = "BUY" | "SELL";

/**
 * Pricing provenance attached to quotes and to fresh order-creation responses.
 * `status: "live"` means fresh market data backed every figure; `fallback`
 * means a configured indicative display price — orders are refused (503) at
 * fallback prices, so a fallback quote can never justify an execution.
 */
export interface UsdtPricingMetadata {
  status: "live" | "fallback";
  execution: {
    source: string;
    bookTimestamp: string;
    fetchedAt: string;
    tickerLast: string | null;
    /** Raw order-book VWAP for this quantity, before the best-price guarantee. */
    bookVwap: string;
  } | null;
  /**
   * The best-price guarantee verdict: `applied` means the book price moved at
   * least ₹1.50 toward the customer versus the best venue, `note` spells out
   * which venue it was measured against. Null on fallback, where there is no
   * live market to guarantee against.
   */
  guarantee: {
    applied: boolean;
    matchedVenue: string | null;
    matchedPrice: string | null;
    note: string;
  } | null;
  referenceBasis: string | null;
  /**
   * Every fresh venue the quote was measured against, in the order the
   * backend compared them. The exchange screen renders this list as its
   * side-by-side venue comparison — three rows whenever at least three
   * venues reported a price — and no row is dropped from the table.
   */
  competitors: {
    venue: string;
    /** Raw last trade print on this venue. */
    lastPrice: string;
    /**
     * What a customer would transact at on this venue for the quoted side —
     * the ask on a BUY, the bid on a SELL. This, not `lastPrice`, is what the
     * guarantee matched and what the comparison table should show.
     */
    venuePrice: string;
    venuePriceBasis: "derived_from_spread" | "last_price";
    lastTradedAt: string | null;
    volume24h: string | null;
    bidAskSpreadPct: string | null;
  }[];
  aggregate: { priceInr: string; lastUpdatedAt: string; note: string } | null;
  fallback: { priceInr: string; note: string } | null;
  feesNote: string;
  reasons: string[];
}

/** One quote: execution figure, the reference it is measured against, savings. */
export interface UsdtQuote {
  side: UsdtSide;
  usdtAmount: string;
  inrAmount: string;
  prometheusPrice: string;
  referencePrice: string | null;
  savings: string | null;
  pricing: UsdtPricingMetadata;
}

/** One settled USDT order. `pricing`/`liquidity` arrive only on creation responses. */
export interface UsdtOrder {
  orderId: string;
  side: UsdtSide;
  usdtAmount: string;
  inrAmount: string;
  prometheusPrice: string;
  referencePrice: string;
  savings: string;
  clientRequestId: string;
  placedAt: string;
  filledAt: string;
  pricing?: UsdtPricingMetadata;
  liquidity?: {
    slices: {
      commitmentId: string;
      lpId: string;
      usdtAmount: string;
      inrAmount: string;
      priceInr: string;
    }[];
    totalUsdt: string;
    totalInr: string;
  };
}

export interface UsdtOrderPage {
  items: UsdtOrder[];
  nextCursor: string | null;
}

export interface UsdtOrderInput {
  /** USDT volume, as a decimal string — the unit both sides trade in. */
  usdtAmount: string;
  /** BUY only: refuse the order if the fresh execution price exceeds this. */
  maxExecutionPrice?: string;
  /** SELL only: refuse the order if the fresh execution price falls below this. */
  minExecutionPrice?: string;
}

/** Prices a USDT volume from the backend's live CoinDCX book (or a labelled fallback). */
export async function getUsdtQuote(side: UsdtSide, usdtAmount: string): Promise<UsdtQuote> {
  return request<UsdtQuote>(`usdt/quote${toQuery({ side, usdtAmount })}`);
}

/**
 * Places a USDT buy. `clientRequestId` (a UUID generated by the caller) makes
 * the request idempotent: a replay answers the original order without a second
 * settlement. 201 = fresh execution, 200 = replay; the response shape is
 * identical, the page tells the two apart for the user.
 */
export async function placeUsdtBuy(clientRequestId: string, input: UsdtOrderInput): Promise<UsdtOrder> {
  return request<UsdtOrder>("usdt/buy", {
    method: "POST",
    body: JSON.stringify({ clientRequestId, ...input }),
  });
}

/** Places a USDT sell; idempotent and guard-supported exactly like the buy. */
export async function placeUsdtSell(clientRequestId: string, input: UsdtOrderInput): Promise<UsdtOrder> {
  return request<UsdtOrder>("usdt/sell", {
    method: "POST",
    body: JSON.stringify({ clientRequestId, ...input }),
  });
}

/** The caller's own USDT order history, newest first, keyset-paginated. */
export async function listUsdtOrders(
  options: { cursor?: string; limit?: number } = {},
): Promise<UsdtOrderPage> {
  return request<UsdtOrderPage>(`usdt/orders${toQuery(options)}`);
}

// ---------------------------------------------------------------------------
// MODULE 13 - system health (admin).
// ---------------------------------------------------------------------------

export interface HealthCheckEntry {
  name: string;
  status: "up" | "down";
  latencyMs?: number;
  error?: string;
}

export interface HealthStatus {
  status: "ok" | "error";
  checks: HealthCheckEntry[];
}

/** MODULE 13 — backend health probe (database connectivity + latency). */
export async function requestHealth(): Promise<HealthStatus> {
  return request<HealthStatus>("health");
}

// ---------------------------------------------------------------------------
// EMBER ecosystem — hub purchases, simulated staking, blockchain admin.
// ---------------------------------------------------------------------------

/**
 * The hub's terms. `baselinePriceInr`/`dailyEmberLimit`/`monthlyEmberLimit`
 * are configuration (not market observations), and `usdtRateInr` is the
 * display-only conversion rate — null when no rate is configured, in which
 * case the hub refuses purchases rather than inventing one.
 */
export interface EmberHubStatement {
  baselinePriceInr: string;
  dailyEmberLimit: string | null;
  monthlyEmberLimit: string | null;
  usdtRateInr: string | null;
  treasuryAvailableEmber: string | null;
  note: string;
}

/** A display-only cost preview; nothing is computed or recorded by reading it. */
export interface EmberHubScenario {
  label: string;
  emberAmount: string;
  totalInr: string;
  totalUsdt: string | null;
}

export interface EmberHubScenarios {
  note: string;
  scenarios: EmberHubScenario[];
}

export interface EmberPurchaseRecord {
  purchaseId: string;
  emberAmount: string;
  emberPriceInr: string;
  totalInr: string;
  usdtRateInr: string | null;
  totalUsdt: string | null;
  status: "COMPLETED" | "FAILED";
  clientRequestId: string;
  failedReason: string | null;
  purchasedAt: string;
}

export interface CreateEmberPurchaseResult {
  purchase: EmberPurchaseRecord;
  /** False on an idempotent replay of the original purchase. */
  created: boolean;
}

export interface EmberPurchaseList {
  items: EmberPurchaseRecord[];
}

/** The hub terms: configured price, limits, display rate and treasury inventory. */
export async function getEmberHubOverview(): Promise<EmberHubStatement> {
  return request<EmberHubStatement>("ember-hub/overview");
}

/** Three illustrative quantities priced at the configured rate (display-only). */
export async function getEmberHubScenarios(): Promise<EmberHubScenarios> {
  return request<EmberHubScenarios>("ember-hub/scenarios");
}

/**
 * Buys EMBER from the hub: one atomic transaction moves treasury EMBER to the
 * caller and the caller's USDT to the treasury, or nothing moves. Idempotent
 * on (caller, clientRequestId): a replay returns the original purchase.
 */
export async function createEmberPurchase(input: {
  emberAmount: string;
  clientRequestId: string;
  note?: string;
}): Promise<CreateEmberPurchaseResult> {
  return request<CreateEmberPurchaseResult>("ember-hub/purchases", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** The caller's own purchase history, newest first. */
export async function getMyEmberPurchases(limit?: number): Promise<EmberPurchaseList> {
  return request<EmberPurchaseList>(`ember-hub/purchases${toQuery({ limit })}`);
}

/** A staking position: `amount`/`status` are ledger truth, rewards are simulation. */
export interface EmberStakePosition {
  stakeId: string;
  amount: string;
  status: "ACTIVE" | "UNSTAKED";
  lockUntil: string;
  aprPercent: string;
  elapsedDays: number;
  /** SIMULATED and display-only: never credited, never minted. */
  simulatedReward: string;
  clientRequestId: string;
  stakedAt: string;
  unstakedAt: string | null;
}

export interface CreateEmberStakeResult {
  position: EmberStakePosition;
  /** False on an idempotent replay of the original stake. */
  created: boolean;
}

export interface EmberStakePositionList {
  items: EmberStakePosition[];
}

/**
 * Opens a stake position by locking real EMBER from the caller's wallet into
 * the configured lock. Idempotent on (caller, clientRequestId).
 */
export async function createEmberStake(input: {
  emberAmount: string;
  clientRequestId: string;
}): Promise<CreateEmberStakeResult> {
  return request<CreateEmberStakeResult>("ember-staking/stakes", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * Ends a position after its lock has expired (409 before that). Exactly once:
 * an already-unstaked position replays without touching balances again.
 */
export async function unstakeEmberStake(stakeId: string): Promise<CreateEmberStakeResult> {
  return request<CreateEmberStakeResult>(
    `ember-staking/stakes/${encodeURIComponent(stakeId)}/unstake`,
    { method: "POST" },
  );
}

/** The caller's own positions with read-time simulated rewards. */
export async function getEmberStakePositions(limit?: number): Promise<EmberStakePositionList> {
  return request<EmberStakePositionList>(`ember-staking/positions${toQuery({ limit })}`);
}

export interface EmberStakingConfig {
  /** Configured APR the simulated reward uses, in percent. */
  aprPercent: string;
  /** Configured lock duration in days — the only period a stake can take. */
  lockDays: number;
}

/** The program's configured lock period and APR: what a new stake really gets. */
export async function getEmberStakingConfig(): Promise<EmberStakingConfig> {
  return request<EmberStakingConfig>("ember-staking/config");
}

/** PLATFORM_ADMIN only. `rpcReachable` is null while the layer is disabled. */
export interface BlockchainStatus {
  enabled: boolean;
  network: string;
  chainId: number;
  rpcConfigured: boolean;
  tokenAddress: string | null;
  treasuryAddress: string | null;
  minterSignerConfigured: boolean;
  treasurySignerConfigured: boolean;
  maxSupplyWhole: string | null;
  deploymentBlock: number;
  confirmations: number;
  rpcReachable: boolean | null;
}

export type EmberMintStatusName = "PENDING" | "SUBMITTED" | "CONFIRMED" | "FAILED";

export interface EmberMintRequest {
  mintRequestId: string;
  requestId: string;
  amount: string;
  status: EmberMintStatusName;
  requestedBy: string;
  reason: string | null;
  chainId: number;
  network: string;
  txHash: string | null;
  blockNumber: string | null;
  errorMessage: string | null;
  requestedAt: string;
  confirmedAt: string | null;
  failedAt: string | null;
}

export interface CreateEmberMintResult {
  request: EmberMintRequest;
  /** False on an idempotent replay of the original request. */
  created: boolean;
}

export interface EmberMintList {
  items: EmberMintRequest[];
}

export interface BlockchainReconciliation {
  note: string;
  onChain: {
    totalSupply: string;
    maxSupply: string;
    treasuryBalance: string;
    mintedEventsTotal: string;
    burnedEventsTotal: string;
  };
  offChain: {
    ledgerIssuedSupply: string;
    ledgerBurnedSupply: string;
    ledgerCirculatingSupply: string;
    treasuryAvailableEmber: string | null;
    confirmedMintRequestsTotal: string;
    /** Ledger issuance with no confirmed on-chain mint behind it (seed/demo). */
    seedAndDemoIssuedEstimate: string;
    confirmedMintsWithMissingEvent: number;
    unconfirmedMintRequests: number;
  };
  differences: Array<{ kind: string; onChainValue: string; offChainValue: string }>;
}

export interface BlockchainEventSync {
  fromBlock: number;
  toBlock: string;
  scanned: number;
  ingested: number;
  linked: number;
}

export interface BlockchainRecovery {
  examined: number;
  confirmed: number;
  failed: number;
  stillOpen: number;
}

/** Blockchain layer status (503 only for chain-touching routes when disabled). */
export async function getBlockchainStatus(): Promise<BlockchainStatus> {
  return request<BlockchainStatus>("admin/blockchain/status");
}

/** Recent mint requests, newest first. */
export async function listEmberMints(limit?: number): Promise<EmberMintList> {
  return request<EmberMintList>(`admin/blockchain/mints${toQuery({ limit })}`);
}

/**
 * Requests a platform mint to the treasury. Idempotent on clientRequestId;
 * 503 SERVICE_UNAVAILABLE while BLOCKCHAIN_ENABLED is false.
 */
export async function createEmberMint(input: {
  amount: string;
  clientRequestId: string;
  reason?: string;
}): Promise<CreateEmberMintResult> {
  return request<CreateEmberMintResult>("admin/blockchain/mints", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Re-polls receipts of open mint requests; stale PENDING rows stay open. */
export async function runBlockchainRecovery(): Promise<BlockchainRecovery> {
  return request<BlockchainRecovery>("admin/blockchain/recovery", { method: "POST" });
}

/** Pull-based event ingestion from the deployment block; re-runs are no-ops. */
export async function syncBlockchainEvents(): Promise<BlockchainEventSync> {
  return request<BlockchainEventSync>("admin/blockchain/events/sync", { method: "POST" });
}

/** On-chain vs PostgreSQL comparison. Differences are reported, never mutated. */
export async function getBlockchainReconciliation(): Promise<BlockchainReconciliation> {
  return request<BlockchainReconciliation>("admin/blockchain/reconciliation");
}

// ---------------------------------------------------------------------------
// MODULE 14 — Sentinel: price alerts that place a voice call, never a trade.
// ---------------------------------------------------------------------------

export type SentinelAlertStatus =
  | "ACTIVE"
  | "TRIGGERED"
  | "CALL_QUEUED"
  | "CALLING"
  | "CALL_COMPLETED"
  | "CALL_FAILED"
  | "CANCELLED"
  | "EXPIRED";

export type SentinelCondition = "GREATER_THAN_OR_EQUAL" | "LESS_THAN_OR_EQUAL";

export type SentinelCallStatus =
  | "QUEUED"
  | "INITIATED"
  | "COMPLETED"
  | "BUSY"
  | "NO_ANSWER"
  | "REJECTED"
  | "CANCELED"
  | "FAILED";

/**
 * The first reason a call would be refused right now, as `/sentinel/status`
 * reports it. `OK` means the next qualifying trigger would dial.
 */
export type SentinelCallGate =
  | "OK"
  | "PROVIDER_OFF"
  | "VOICE_OFF"
  | "PHONE_UNVERIFIED"
  | "CONSENT_MISSING"
  | "QUIET_HOURS"
  | "USER_DAILY_LIMIT"
  | "PLATFORM_DAILY_LIMIT";

export interface SentinelCallSummary {
  callId: string;
  status: SentinelCallStatus;
  attempts: number;
  maxAttempts: number;
  /** Redacted provider reference: present as a marker, never as a value. */
  providerCallId: string | null;
  queuedAt: string;
  initiatedAt: string | null;
  completedAt: string | null;
  failReason: string | null;
  nextAttemptAt: string | null;
}

export interface SentinelAlert {
  alertId: string;
  symbol: string;
  exchange: string;
  displayName: string;
  quoteCurrency: string;
  targetPrice: string;
  condition: SentinelCondition;
  status: SentinelAlertStatus;
  voiceEnabled: boolean;
  /** The last honest observation. Null means "never observed", not zero. */
  observedPrice: string | null;
  observedAsOf: string | null;
  observedProvider: string | null;
  observedMarketState: string | null;
  observedStale: boolean | null;
  lastEvaluatedAt: string | null;
  expiresAt: string | null;
  triggeredAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  /** Why no call followed a trigger (e.g. QUIET_HOURS), or null. */
  callSkipReason: string | null;
  createdAt: string;
  updatedAt: string;
  call: SentinelCallSummary | null;
}

export interface SentinelAlertPage {
  items: SentinelAlert[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface SentinelVoiceSettings {
  /** Masked for display; the full number never leaves the backend. */
  phoneMasked: string | null;
  phoneVerified: boolean;
  consented: boolean;
  consentAt: string | null;
  consentWithdrawnAt: string | null;
  voiceDisabled: boolean;
  quietHoursStartUtc: number | null;
  quietHoursEndUtc: number | null;
}

export interface SentinelStatus {
  voiceProvider: "off" | "fake" | "twilio";
  workerEnabled: boolean;
  activeAlerts: number;
  triggeredAlerts: number;
  cancelledAlerts: number;
  expiredAlerts: number;
  pendingCalls: number;
  completedCalls: number;
  failedCalls: number;
  callsUsedTodayUtc: number;
  maxCallsPerUserPerDay: number;
  callGate: SentinelCallGate;
  voiceSettings: SentinelVoiceSettings;
}

export interface SentinelCallHistoryItem {
  call: SentinelCallSummary;
  symbol: string;
  displayName: string;
  targetPrice: string;
  condition: SentinelCondition;
  quoteCurrency: string;
}

export interface SentinelCallHistoryPage {
  items: SentinelCallHistoryItem[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface SentinelPassResult {
  monitor: {
    activeAlerts: number;
    evaluated: number;
    triggered: number;
    callsQueued: number;
    gated: number;
    expired: number;
    quoteFailures: number;
  };
  caller: { considered: number; initiated: number; retried: number; failed: number };
}

/** Creates an alert owned by the caller. Symbols must be catalogue instruments. */
export async function createSentinelAlert(input: {
  symbol: string;
  displayName: string;
  targetPrice: string;
  condition: SentinelCondition;
  expiresAt?: string | null;
  voiceEnabled: boolean;
}): Promise<SentinelAlert> {
  return request<SentinelAlert>("sentinel/alerts", { method: "POST", body: JSON.stringify(input) });
}

/** The caller's own alerts, newest first. */
export async function listSentinelAlerts(options?: { page?: number; limit?: number; status?: SentinelAlertStatus }): Promise<SentinelAlertPage> {
  const params = new URLSearchParams();
  if (options?.page !== undefined) params.set("page", String(options.page));
  if (options?.limit !== undefined) params.set("limit", String(options.limit));
  if (options?.status !== undefined) params.set("status", options.status);
  const query = params.toString();
  return request<SentinelAlertPage>(`sentinel/alerts${query ? `?${query}` : ""}`);
}

export async function getSentinelAlert(alertId: string): Promise<SentinelAlert> {
  return request<SentinelAlert>(`sentinel/alerts/${alertId}`);
}

/** Edits an ACTIVE alert; a triggered alert's history is immutable (409). */
export async function updateSentinelAlert(
  alertId: string,
  input: { targetPrice?: string; condition?: SentinelCondition; expiresAt?: string | null; voiceEnabled?: boolean; displayName?: string },
): Promise<SentinelAlert> {
  return request<SentinelAlert>(`sentinel/alerts/${alertId}`, { method: "PATCH", body: JSON.stringify(input) });
}

/** Cancels without deleting: the row and its history stay. */
export async function cancelSentinelAlert(alertId: string, reason: string): Promise<SentinelAlert> {
  return request<SentinelAlert>(`sentinel/alerts/${alertId}`, { method: "DELETE", body: JSON.stringify({ reason }) });
}

export async function getSentinelStatus(): Promise<SentinelStatus> {
  return request<SentinelStatus>("sentinel/status");
}

export async function listSentinelCalls(options?: { page?: number; limit?: number }): Promise<SentinelCallHistoryPage> {
  const params = new URLSearchParams();
  if (options?.page !== undefined) params.set("page", String(options.page));
  if (options?.limit !== undefined) params.set("limit", String(options.limit));
  const query = params.toString();
  return request<SentinelCallHistoryPage>(`sentinel/calls${query ? `?${query}` : ""}`);
}

export async function getSentinelVoiceSettings(): Promise<SentinelVoiceSettings> {
  return request<SentinelVoiceSettings>("sentinel/voice/settings");
}

/** Setting a number resets its verification. E.164 with a leading +. */
export async function setSentinelPhone(phone: string): Promise<SentinelVoiceSettings> {
  return request<SentinelVoiceSettings>("sentinel/voice/phone", { method: "PATCH", body: JSON.stringify({ phone }) });
}

/**
 * Requests a verification code. Outside production the backend also returns
 * the code itself, because no SMS provider is configured in this project.
 */
export async function requestSentinelVerification(): Promise<{ status: "ISSUED" | "ISSUED_DELIVERY_PENDING"; code?: string }> {
  return request("sentinel/voice/phone/verification", { method: "POST" });
}

export async function confirmSentinelVerification(code: string): Promise<SentinelVoiceSettings> {
  return request<SentinelVoiceSettings>("sentinel/voice/phone/verification/confirm", {
    method: "POST",
    body: JSON.stringify({ code }),
  });
}

/** Records consent to automated calls. Requires a verified number. */
export async function grantSentinelConsent(): Promise<SentinelVoiceSettings> {
  return request<SentinelVoiceSettings>("sentinel/voice/consent", { method: "POST" });
}

/** Withdraws consent immediately; already-dialled calls are not recalled. */
export async function withdrawSentinelConsent(): Promise<SentinelVoiceSettings> {
  return request<SentinelVoiceSettings>("sentinel/voice/consent", { method: "DELETE" });
}

/** Sets or clears the quiet window (minutes since UTC midnight, both ends or neither). */
export async function setSentinelQuietHours(input: { quietHoursStartUtc: number | null; quietHoursEndUtc: number | null }): Promise<SentinelVoiceSettings> {
  return request<SentinelVoiceSettings>("sentinel/voice/quiet-hours", { method: "PATCH", body: JSON.stringify(input) });
}

/** The user-level off switch: stops future calls without touching alerts. */
export async function setSentinelVoiceDisabled(disabled: boolean): Promise<SentinelVoiceSettings> {
  return request<SentinelVoiceSettings>("sentinel/voice/disabled", { method: "PATCH", body: JSON.stringify({ disabled }) });
}

// ---------------------------------------------------------------------------
// MODULE 14 — the in-app SIMULATED call (the `fake` provider's phone, in-app).
// ---------------------------------------------------------------------------

/** The alert facts a caller-ID card shows. Prices are the server's strings. */
export interface SentinelLiveCallAlert {
  alertId: string;
  symbol: string;
  displayName: string;
  quoteCurrency: string;
  targetPrice: string;
  condition: SentinelCondition;
  observedPrice: string | null;
  observedAsOf: string | null;
  status: SentinelAlertStatus;
}

/**
 * One simulated call, ringing or settled.
 *
 * `spokenText` is the exact message the monitor composed at trigger time — the
 * UI reads it aloud verbatim rather than recomposing, so what the user hears
 * matches what a real provider would have said. `simulated` is always true
 * here: this is an in-app call, never a telephone call.
 */
export interface SentinelLiveCall {
  callId: string;
  status: SentinelCallStatus;
  attempts: number;
  maxAttempts: number;
  /** True while the simulated phone is still ringing and can be answered. */
  ringing: boolean;
  queuedAt: string;
  initiatedAt: string | null;
  completedAt: string | null;
  failReason: string | null;
  nextAttemptAt: string | null;
  spokenText: string;
  simulated: boolean;
  alert: SentinelLiveCallAlert;
}

/** What the user did to the ringing simulated phone. */
export type SentinelLiveCallAction = "ANSWERED" | "DECLINED" | "ENDED";

/**
 * The caller's own ringing simulated call, or null.
 *
 * Poll this to drive the incoming-call UI. `{ call: null }` means "nothing
 * ringing" (including under the real Twilio provider, where the phone rings on
 * the PSTN instead). The envelope is explicit server-side, so a null is a real
 * answer and never an empty/failed response.
 */
export async function getSentinelLiveCall(): Promise<SentinelLiveCall | null> {
  const body = await request<{ call: SentinelLiveCall | null }>("sentinel/voice/live");
  return body.call;
}

/**
 * Reports Answer / Decline / End for the caller's own ringing simulated call.
 *
 * Owner-scoped and fake-provider-only on the server; safe to repeat — a
 * duplicate action reports the already-settled row rather than settling twice.
 * Never places a trade.
 */
export async function settleSentinelLiveCall(
  callId: string,
  action: SentinelLiveCallAction,
): Promise<SentinelLiveCall> {
  return request<SentinelLiveCall>("sentinel/voice/live", {
    method: "POST",
    body: JSON.stringify({ callId, action }),
  });
}
