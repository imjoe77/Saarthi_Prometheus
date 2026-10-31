"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import dynamic from "next/dynamic";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowLeft, Loader2, RefreshCw, Wifi, WifiOff } from "lucide-react";

import AppShell from "@/components/AppShell";
import {
  ApiError,
  followStrategy,
  getBars,
  getCopyFollowAccount,
  getCopyFollowStatus,
  getFeedStatus,
  getInstruments,
  getPaperSummary,
  getQuote,
  getStrategy,
  listCopyOrders,
  listPaperOrders,
  listStrategyFollowers,
  placePaperOrder,
  setCopyAllocation,
  syncCopyFollow,
  unfollowStrategy,
  type BarDto,
  type CopyEvent,
  type CopyFollowAccount,
  type CopyFollowStatus,
  type CopyFollowerPage,
  type FeedStatusDto,
  type InstrumentDto,
  type PaperOrderResponse,
  type PaperSummaryDto,
  type QuoteDto,
  type StrategySummary,
} from "@/lib/api-client";

/**
 * MODULE 06c — the expert's live market and paper-trading screen.
 *
 * WHAT THIS SCREEN PROMISES. Every price it draws comes from the configured
 * market-data provider, read through the Prometheus BFF. When the provider has
 * nothing to say, this screen says so; it never invents a candle, a quote or a
 * fill to fill a gap. The paper order ticket writes to the paper ledger only —
 * no real order is ever placed, and the client never supplies a price.
 *
 * THE FEED LABEL IS PART OF THE DATA. A banner states whether the feed is
 * live, deterministic demo data, or disabled, so a number on this screen can
 * never be mistaken for a market observation the user did not actually receive.
 *
 * MODULE 07 — the same screen also carries the follower's copy controls for
 * this strategy: follow, allocation, sync, copy cash and copy history. All of
 * it is simulated, and every balance it shows is Module 07's own pot — never
 * Module 03's wallet and never the expert's paper account above. The owner
 * cannot follow their own strategy, so the panel says that instead of offering
 * a button whose submit would fail with a 409.
 */

const TIMEFRAMES = ["1m", "5m", "15m", "1h", "1d"] as const;
type Timeframe = (typeof TIMEFRAMES)[number];

/** How often the quote panel re-reads the latest observation. */
const QUOTE_POLL_MS = 15_000;

/**
 * How many candles the chart asks for. Roughly one trading day of 1-minute
 * bars, which is dense enough to read a session and light enough to load fast.
 */
const BARS_LIMIT = 180;

/** Copy history rows read with the panel. The API's own default page size. */
const COPY_HISTORY_LIMIT = 20;

/* -------------------------------------------------------------------------- */
/* Chart                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The chart is loaded on the client only. lightweight-charts touches `window`
 * at import time, and a server render would throw before the first paint.
 */
const Chart = dynamic(
  () => import("@/components/StrategyChart").then((module) => ({ default: module.StrategyChart })),
  {
    ssr: false,
    loading: () => (
      <div className="h-[420px] flex items-center justify-center text-xs font-mono text-[#5D6B82]">
        LOADING CHART ENGINE…
      </div>
    ),
  },
);

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** Fixed-point display for a decimal string. Never rounds away the source digits silently. */
function money(value: string | null | undefined, digits = 2): string {
  if (value === null || value === undefined || value === "") return "—";
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  return parsed.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function clockOf(iso: string | null): string {
  if (!iso) return "—";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return "The Prometheus API could not be reached.";
}

/** Decimal quantity check. Accepts "0.5", rejects "", "abc", "-1", "0". */
function quantityError(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "Enter a quantity.";
  if (!/^\d*\.?\d*$/.test(trimmed)) return "Quantity must be a positive number.";
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return "Quantity must be a positive number.";
  if (value <= 0) return "Quantity must be greater than zero.";
  return null;
}

const REJECT_REASON_LABEL: Record<string, string> = {
  MARKET_DATA_UNAVAILABLE: "No live quote was available for this instrument.",
  STALE_MARKET_DATA: "The quote was older than this instrument's freshness limit.",
  MARKET_CLOSED: "The market for this instrument is closed right now.",
  INSUFFICIENT_PAPER_CASH: "The paper account does not hold enough cash for this buy.",
  INSUFFICIENT_POSITION: "The paper account does not hold enough of this instrument to sell.",
};

/**
 * Allocation check, mirroring the API's rule exactly: digits with at most 18
 * decimal places, strictly greater than 0 and at most 1. The client validates
 * only to give instant feedback — the same rule runs server-side and its
 * message is what a submit surfaces if the two ever disagree.
 */
function allocationError(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "Enter an allocation.";
  if (!/^\d{1,2}(?:\.\d{1,18})?$/.test(trimmed)) {
    return "Allocation must be a positive decimal with at most 18 decimal places.";
  }
  const value = Number(trimmed);
  if (value <= 0) return "Allocation must be greater than zero.";
  if (value > 1) return "Allocation cannot exceed 1 — a copy never mirrors more than the expert.";
  return null;
}

/** Why copying may or may not be happening, in the API's own vocabulary. */
const COPY_ELIGIBILITY_LABEL: Record<string, string> = {
  ELIGIBLE: "Copying — new expert fills are replicated.",
  FOLLOW_NOT_ACTIVE: "Paused — you are not following right now.",
  STRATEGY_ARCHIVED: "The strategy is archived, so nothing is copied.",
  STRATEGY_NOT_ELIGIBLE: "The strategy is not publicly copyable, so nothing is copied.",
  ALLOCATION_ROUNDED_TO_ZERO: "The next order would round to zero at this allocation.",
  INSUFFICIENT_COPY_CASH: "No copy cash is available for the next buy.",
  INSUFFICIENT_POSITION: "Nothing is held to sell.",
  PRICE_UNAVAILABLE: "The last expert fill had no usable price.",
};

/** Why one line in the copy history was refused. */
const COPY_REJECT_REASON_LABEL: Record<string, string> = {
  FOLLOW_NOT_ACTIVE: "You were not following when this fill committed.",
  STRATEGY_ARCHIVED: "The strategy was archived when this fill committed.",
  STRATEGY_NOT_ELIGIBLE: "The strategy was not publicly copyable when this fill committed.",
  ALLOCATION_ROUNDED_TO_ZERO: "The allocation rounded this order to zero.",
  INSUFFICIENT_COPY_CASH: "No copy cash was available to buy with.",
  INSUFFICIENT_POSITION: "The copy account held nothing of this symbol to sell.",
  PRICE_UNAVAILABLE: "The expert fill had no usable price.",
};

/* -------------------------------------------------------------------------- */
/* Page                                                                        */
/* -------------------------------------------------------------------------- */

export default function StrategyDetailPage() {
  const params = useParams<{ id: string }>();
  const strategyId = Array.isArray(params.id) ? params.id[0] : params.id;

  const [strategy, setStrategy] = useState<StrategySummary | null>(null);
  const [strategyError, setStrategyError] = useState<string | null>(null);
  const [strategyLoading, setStrategyLoading] = useState(true);

  const [instruments, setInstruments] = useState<InstrumentDto[]>([]);
  const [instrumentsError, setInstrumentsError] = useState<string | null>(null);
  const [symbol, setSymbol] = useState("");

  const [feed, setFeed] = useState<FeedStatusDto | null>(null);

  const [quote, setQuote] = useState<QuoteDto | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);

  const [timeframe, setTimeframe] = useState<Timeframe>("1m");
  const [bars, setBars] = useState<BarDto[]>([]);
  const [barsError, setBarsError] = useState<string | null>(null);
  const [barsLoading, setBarsLoading] = useState(true);

  const [paper, setPaper] = useState<PaperSummaryDto | null>(null);
  const [paperError, setPaperError] = useState<string | null>(null);
  const [paperForbidden, setPaperForbidden] = useState(false);

  const [orders, setOrders] = useState<PaperOrderResponse[]>([]);
  const [ordersError, setOrdersError] = useState<string | null>(null);

  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [quantity, setQuantity] = useState("1");
  const [submitting, setSubmitting] = useState(false);
  const [lastOrder, setLastOrder] = useState<PaperOrderResponse | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  /** MODULE 07 — the caller's follow of this strategy, plus its money and history. */
  const [copyFollow, setCopyFollow] = useState<CopyFollowStatus | null>(null);
  const [copyAccount, setCopyAccount] = useState<CopyFollowAccount | null>(null);
  const [copyEvents, setCopyEvents] = useState<CopyEvent[]>([]);
  const [copyEventsError, setCopyEventsError] = useState<string | null>(null);
  const [copyLoading, setCopyLoading] = useState(true);
  const [copyError, setCopyError] = useState<string | null>(null);

  /**
   * The strategy is read once. It is the page's identity, and re-reading it on
   * every poll would spend a request to learn a fact that cannot change.
   */
  useEffect(() => {
    let active = true;

    void getStrategy(strategyId)
      .then((loaded) => {
        if (!active) return;
        setStrategy(loaded);
        setStrategyError(null);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setStrategyError(messageFor(error));
      })
      .finally(() => {
        if (active) setStrategyLoading(false);
      });

    return () => {
      active = false;
    };
  }, [strategyId]);

  /**
   * The instrument catalogue is code-defined and static, so it is read once and
   * the first instrument becomes the default selection. An empty catalogue is
   * an error the screen must show, because without it nothing else can be read.
   */
  useEffect(() => {
    let active = true;

    void getInstruments()
      .then((list) => {
        if (!active) return;
        setInstruments(list);
        setSymbol((current) => current || list[0]?.symbol || "");
        setInstrumentsError(null);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setInstrumentsError(messageFor(error));
      });

    void getFeedStatus()
      .then((status) => {
        if (active) setFeed(status);
      })
      .catch(() => {
        // The banner is advisory. A screen that cannot read it still shows
        // prices with the provider reported on each quote, so a failure here
        // must not blank the page.
      });

    return () => {
      active = false;
    };
  }, []);

  /**
   * Market reads for the selected symbol and timeframe.
   *
   * State is applied inside the promise callbacks, never synchronously in the
   * effect body, so this reads as a subscription to the selected instrument
   * rather than a render that cascades into another - the same shape the
   * portfolio console uses for its one-shot ledger read. The two reads are
   * deliberately not combined: a quote is polled on a timer while a candle
   * series is not, and merging them would put the chart on the polling path.
   */
  useEffect(() => {
    if (!symbol) return;
    let active = true;

    getQuote(symbol)
      .then((result) => {
        if (!active) return;
        setQuote(result);
        setQuoteError(null);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setQuoteError(messageFor(error));
      })
      .finally(() => {
        if (active) setQuoteLoading(false);
      });

    getBars(symbol, timeframe, BARS_LIMIT)
      .then((result) => {
        if (!active) return;
        setBars(result.items);
        setBarsError(null);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setBarsError(messageFor(error));
      })
      .finally(() => {
        if (active) setBarsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [symbol, timeframe]);
  /**
   * Paper reads are owner-scoped. A 404 here means the strategy is not the
   * caller's (or does not exist), which is a legitimate state for a public
   * strategy opened from the catalogue - the panel says so rather than
   * raising a banner that looks like a fault.
   *
   * Both reads settle together so the account panel and the order blotter can
   * never disagree about whether paper trading is available for this strategy.
   */
  useEffect(() => {
    let active = true;

    void Promise.allSettled([getPaperSummary(strategyId), listPaperOrders(strategyId)]).then(
      ([summaryResult, ordersResult]) => {
        if (!active) return;

        setPaperError(null);
        setOrdersError(null);

        if (summaryResult.status === "fulfilled") {
          setPaper(summaryResult.value);
          setPaperForbidden(false);
        } else {
          setPaper(null);
          if (
            summaryResult.reason instanceof ApiError &&
            summaryResult.reason.status === 404
          ) {
            setPaperForbidden(true);
          } else {
            setPaperError(messageFor(summaryResult.reason));
          }
        }

        if (ordersResult.status === "fulfilled") {
          setOrders(ordersResult.value);
        } else {
          setOrders([]);
          if (
            !(
              ordersResult.reason instanceof ApiError &&
              ordersResult.reason.status === 404
            )
          ) {
            setOrdersError(messageFor(ordersResult.reason));
          }
        }
      },
    );

    return () => {
      active = false;
    };
  }, [strategyId]);

  /**
   * User-triggered re-reads. These live in event handlers, where setting
   * loading state synchronously is correct - the effect above only subscribes.
   */
  const refreshQuote = useCallback(() => {
    setQuoteLoading(true);
    getQuote(symbol)
      .then((result) => {
        setQuote(result);
        setQuoteError(null);
      })
      .catch((error: unknown) => {
        setQuoteError(messageFor(error));
      })
      .finally(() => setQuoteLoading(false));
  }, [symbol]);

  const refreshBars = useCallback(() => {
    setBarsLoading(true);
    getBars(symbol, timeframe, BARS_LIMIT)
      .then((result) => {
        setBars(result.items);
        setBarsError(null);
      })
      .catch((error: unknown) => {
        setBarsError(messageFor(error));
      })
      .finally(() => setBarsLoading(false));
  }, [symbol, timeframe]);

  /** Re-reads the paper account and blotter. Called after a placed order too. */
  const refreshPaper = useCallback(() => {
    setPaperError(null);
    setOrdersError(null);

    void Promise.allSettled([getPaperSummary(strategyId), listPaperOrders(strategyId)]).then(
      ([summaryResult, ordersResult]) => {
        if (summaryResult.status === "fulfilled") {
          setPaper(summaryResult.value);
          setPaperForbidden(false);
        } else {
          setPaper(null);
          if (
            summaryResult.reason instanceof ApiError &&
            summaryResult.reason.status === 404
          ) {
            setPaperForbidden(true);
          } else {
            setPaperError(messageFor(summaryResult.reason));
          }
        }

        if (ordersResult.status === "fulfilled") {
          setOrders(ordersResult.value);
        } else {
          setOrders([]);
          if (
            !(
              ordersResult.reason instanceof ApiError &&
              ordersResult.reason.status === 404
            )
          ) {
            setOrdersError(messageFor(ordersResult.reason));
          }
        }
      },
    );
  }, [strategyId]);

  /**
   * Re-reads the follow, its account and its copy history together.
   *
   * The prologue is deferred a microtask deliberately: the rule this codebase
   * lints against — no synchronous setState reachable from an effect body — is
   * satisfied only when every state write sits inside a promise callback.
   *
   * A caller who does not follow this strategy gets `follow: null` from a 404 —
   * an answer, not a fault — and the account and history reads are skipped
   * entirely, because the API would 404 them too and a screen that requested
   * them anyway would be inventing a failure out of an absence.
   */
  const refreshCopy = useCallback(() => {
    void Promise.resolve()
      .then(() => {
        setCopyError(null);
        return getCopyFollowStatus(strategyId);
      })
      .then((status) => {
        setCopyFollow(status);

        if (status === null) {
          setCopyAccount(null);
          setCopyEvents([]);
          setCopyEventsError(null);
          return null;
        }

        return Promise.allSettled([
          getCopyFollowAccount(strategyId),
          listCopyOrders(strategyId, { limit: COPY_HISTORY_LIMIT }),
        ]).then(([accountResult, eventsResult]) => {
          if (accountResult.status === "fulfilled") {
            setCopyAccount(accountResult.value);
          } else {
            setCopyAccount(null);
            setCopyError(messageFor(accountResult.reason));
          }

          if (eventsResult.status === "fulfilled") {
            setCopyEvents(eventsResult.value.items);
            setCopyEventsError(null);
          } else {
            setCopyEvents([]);
            setCopyEventsError(messageFor(eventsResult.reason));
          }
        });
      })
      .catch((error: unknown) => {
        setCopyError(messageFor(error));
      })
      .finally(() => {
        setCopyLoading(false);
      });
  }, [strategyId]);

  /**
   * The follow is read once on mount; every panel action calls refreshCopy
   * again. The callback already guards its own error paths, so the effect only
   * has to decide when a (re-)read is due: on mount, and if the strategy id
   * ever changes underneath the page.
   */
  useEffect(() => {
    refreshCopy();
  }, [refreshCopy]);

  /**
   * Quote polling only. The chart is not polled on a timer: a candle series that
   * re-shuffles every few seconds makes it impossible to read a pattern, and the
   * timeframe buttons already re-read the series when the user asks.
   */
  useEffect(() => {
    if (!symbol) return;
    const timer = setInterval(() => {
      void refreshQuote();
    }, QUOTE_POLL_MS);
    return () => clearInterval(timer);
  }, [symbol, refreshQuote]);

  const submitOrder = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setSubmitError(null);

      const invalid = quantityError(quantity);
      if (invalid) {
        setSubmitError(invalid);
        return;
      }

      setSubmitting(true);
      try {
        const result = await placePaperOrder(strategyId, {
          // A UUID per submission. The API keys idempotency on it, so it must
          // be unique per intent - not per retry of a failed render.
          clientRequestId: crypto.randomUUID(),
          symbol,
          side,
          quantity: quantity.trim(),
        });
        setLastOrder(result);
        refreshPaper();
      } catch (error: unknown) {
        setSubmitError(messageFor(error));
      } finally {
        setSubmitting(false);
      }
    },
    [quantity, refreshPaper, side, strategyId, symbol],
  );

  const feedTone = useMemo(() => {
    if (!feed) return { label: "CHECKING FEED", tone: "text-[#8E98A8]", border: "border-[#2C3748]" };
    if (feed.provider === "alpaca" && feed.enabled) {
      return { label: "LIVE FEED — ALPACA", tone: "text-[#00D26A]", border: "border-[#00D26A]/30" };
    }
    if (feed.provider === "fake") {
      return { label: "DEMO DATA — NOT A REAL MARKET", tone: "text-[#F5A623]", border: "border-[#F5A623]/40" };
    }
    return { label: "MARKET DATA DISABLED", tone: "text-[#8E98A8]", border: "border-[#2C3748]" };
  }, [feed]);

  const instrument = instruments.find((item) => item.symbol === symbol) ?? null;

  /**
   * Whether this is the caller's own strategy, read from the paper panel's
   * outcome rather than from a field the API never sends (there is no ownerId
   * in a strategy response). Only an owner gets a paper account back, so an
   * owner is exactly "paper resolved, not forbidden, account present". The
   * copy panel waits for that resolution so an owner is never shown a Follow
   * button whose submit would answer with a 409.
   */
  const paperResolved = paper !== null || paperForbidden || paperError !== null;
  const ownerView = paperResolved && !paperForbidden && paper !== null;

  if (strategyLoading) {
    return (
      <AppShell>
        <div className="p-6 max-w-[1680px] mx-auto">
          <p className="flex items-center gap-2 text-xs font-mono text-[#8E98A8]">
            <Loader2 className="w-4 h-4 animate-spin text-[#FF5A1F]" />
            <span>Loading strategy…</span>
          </p>
        </div>
      </AppShell>
    );
  }

  if (strategyError || !strategy) {
    return (
      <AppShell>
        <div className="p-6 max-w-[1680px] mx-auto space-y-4">
          <BackLink />
          <div className="flex items-start gap-3 rounded-xl border border-[#FF5A1F]/30 bg-[#FF5A1F]/5 p-5">
            <AlertTriangle className="w-4 h-4 text-[#FF5A1F] mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-semibold text-white">That strategy could not be opened</p>
              <p className="text-xs text-[#C5CFDE] mt-1">{strategyError ?? "Not found."}</p>
            </div>
          </div>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="p-6 space-y-5 max-w-[1680px] mx-auto">
        <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
          <div className="min-w-0">
            <BackLink />
            <div className="flex items-center gap-2 flex-wrap mt-2">
              <h1 className="text-2xl font-bold tracking-tight text-white truncate">{strategy.name}</h1>
              <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-[#00D26A]/10 text-[#00D26A]">
                {strategy.status}
              </span>
              <span className="px-2 py-0.5 rounded border text-[10px] font-mono font-bold bg-[#5D6B82]/10 text-[#8E98A8] border-[#2C3748]">
                {strategy.visibility}
              </span>
            </div>
            {strategy.description && (
              <p className="text-xs text-[#7B8799] mt-1.5 max-w-3xl leading-relaxed">
                {strategy.description}
              </p>
            )}
          </div>

          <div className={`flex items-center gap-2 self-start px-3 py-2 rounded-lg border bg-[#12161E] ${feedTone.border}`}>
            {feed?.enabled ? (
              <Wifi className={`w-3.5 h-3.5 ${feedTone.tone}`} />
            ) : (
              <WifiOff className="w-3.5 h-3.5 text-[#5D6B82]" />
            )}
            <span className={`text-[10px] font-mono font-bold tracking-wider ${feedTone.tone}`}>
              {feedTone.label}
            </span>
          </div>
        </div>

        {feed && feed.provider === "alpaca" && feed.enabled && (
          <p className="text-[11px] font-mono text-[#5D6B82] border-l-2 border-[#2C3748] pl-3 leading-relaxed">
            {feed.message} Equities are served from the IEX feed and may be delayed; crypto is real time.
            If a quote reads UNAVAILABLE, the provider had no observation for that symbol at that moment.
          </p>
        )}

        {instrumentsError && (
          <PanelError title="The instrument catalogue could not be loaded" message={instrumentsError} />
        )}

        <div className="grid grid-cols-12 gap-5">
          {/* ---------------------------- market ---------------------------- */}
          <section className="col-span-12 xl:col-span-8 space-y-5">
            <div className="bg-[#12161E] border border-[#202735] rounded-xl p-4 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <label className="flex items-center gap-2">
                  <span className="text-[10px] font-mono uppercase tracking-wider text-[#6E7B8E]">
                    Instrument
                  </span>
                  <select
                    value={symbol}
                    onChange={(event) => {
                      // The loading flag is raised here rather than inside the
                      // fetch effect: React's compiler rules discourage state
                      // writes in an effect body, and the handler is the honest
                      // place to say "the user just asked for something else".
                      setQuoteLoading(true);
                      setBarsLoading(true);
                      setSymbol(event.target.value);
                      // The submit button is disabled while an error is shown,
                      // so a stale rejection would otherwise lock the form
                      // closed the moment the user tries a different instrument.
                      setSubmitError(null);
                    }}
                    className="rounded-lg bg-[#0E1219] border border-[#242C3A] focus:border-[#FF5A1F]/60 px-3 py-2 text-xs font-bold text-white outline-none transition-colors"
                  >
                    {instruments.map((item) => (
                      <option key={item.symbol} value={item.symbol}>
                        {item.symbol} — {item.name}
                      </option>
                    ))}
                  </select>
                  {instrument && (
                    <span className="text-[10px] font-mono text-[#5D6B82]">
                      {instrument.kind} · {instrument.venue}
                    </span>
                  )}
                </label>

                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] font-mono uppercase tracking-wider text-[#6E7B8E] mr-1">
                    Timeframe
                  </span>
                  {TIMEFRAMES.map((frame) => (
                    <button
                      key={frame}
                      type="button"
                      onClick={() => {
                        setBarsLoading(true);
                        setTimeframe(frame);
                      }}
                      className={`px-2.5 py-1 rounded text-[11px] font-mono font-bold transition-colors ${
                        timeframe === frame
                          ? "bg-[#FF5A1F]/15 text-[#FF5A1F] border border-[#FF5A1F]/40"
                          : "bg-[#0E1219] text-[#717E91] border border-[#242C3A] hover:text-white"
                      }`}
                    >
                      {frame}
                    </button>
                  ))}
                </div>
              </div>

              <QuotePanel
                quote={quote}
                error={quoteError}
                loading={quoteLoading}
                marketKind={instrument?.kind ?? null}
              />

              <div className="bg-[#0E1219] border border-[#1E2532] rounded-lg overflow-hidden">
                {barsError ? (
                  <div className="h-[420px] flex flex-col items-center justify-center gap-2 px-6 text-center">
                    <AlertTriangle className="w-5 h-5 text-[#FF5A1F]" />
                    <p className="text-xs font-semibold text-white">The candle series could not be loaded</p>
                    <p className="text-[11px] text-[#7B8799] max-w-md">{barsError}</p>
                    <button
                      type="button"
                      onClick={refreshBars}
                      className="mt-1 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#161B24] hover:bg-[#202735] border border-[#273242] text-[11px] font-bold text-white"
                    >
                      <RefreshCw className="w-3 h-3" />
                      Retry
                    </button>
                  </div>
                ) : barsLoading && bars.length === 0 ? (
                  <div className="h-[420px] flex items-center justify-center gap-2 text-xs font-mono text-[#5D6B82]">
                    <Loader2 className="w-4 h-4 animate-spin text-[#FF5A1F]" />
                    <span>LOADING {symbol} · {timeframe}…</span>
                  </div>
                ) : bars.length === 0 ? (
                  <div className="h-[420px] flex flex-col items-center justify-center gap-2 px-6 text-center">
                    <p className="text-xs font-semibold text-white">No candles for this window</p>
                    <p className="text-[11px] text-[#7B8799] max-w-md">
                      The provider returned no {timeframe} bars for {symbol}. Nothing is drawn rather than
                      inventing a series, and no candle on this chart is fabricated.
                    </p>
                  </div>
                ) : (
                  <Chart bars={bars} height={420} />
                )}
              </div>

              <div className="flex items-center justify-between text-[10px] font-mono text-[#5D6B82]">
                <span>
                  {bars.length} BARS · {timeframe} · SOURCE: {quote?.provider?.toUpperCase() ?? feed?.provider?.toUpperCase() ?? "—"}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    refreshQuote();
                    refreshBars();
                  }}
                  className="flex items-center gap-1.5 hover:text-white transition-colors"
                >
                  <RefreshCw className={`w-3 h-3 ${barsLoading || quoteLoading ? "animate-spin" : ""}`} />
                  REFRESH
                </button>
              </div>
            </div>

            <OrdersPanel
              orders={orders}
              error={ordersError}
              forbidden={paperForbidden}
              onRetry={refreshPaper}
            />

            <CopyHistoryPanel
              follow={copyFollow}
              events={copyEvents}
              error={copyEventsError}
              onRetry={refreshCopy}
            />

            <FollowersPanel strategyId={strategyId} visible={ownerView} />
          </section>

          {/* ---------------------------- trading --------------------------- */}
          <aside className="col-span-12 xl:col-span-4 space-y-5">
            <form
              onSubmit={submitOrder}
              className="bg-[#12161E] border border-[#202735] rounded-xl p-4 space-y-3.5"
            >
              <div>
                <h2 className="text-sm font-bold text-white tracking-tight">Paper order</h2>
                <p className="text-[11px] text-[#717E91] mt-0.5">
                  Market order, long-only, simulated. The server picks the price.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-2">
                {(["BUY", "SELL"] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => {
                      setSide(option);
                      setSubmitError(null);
                    }}
                    className={`py-2.5 rounded-lg text-xs font-bold border transition-colors ${
                      side === option
                        ? option === "BUY"
                          ? "bg-[#00D26A]/12 text-[#00D26A] border-[#00D26A]/40"
                          : "bg-[#FF4D4D]/12 text-[#FF4D4D] border-[#FF4D4D]/40"
                        : "bg-[#0E1219] text-[#717E91] border-[#242C3A] hover:text-white"
                    }`}
                  >
                    {option}
                  </button>
                ))}
              </div>

              <label className="block">
                <span className="block text-[10px] font-mono uppercase tracking-wider text-[#6E7B8E] mb-1.5">
                  Symbol
                </span>
                <input
                  value={symbol}
                  readOnly
                  className="w-full rounded-lg bg-[#0E1219] border border-[#242C3A] px-3 py-2 text-xs font-bold text-[#A6B2C4] cursor-not-allowed"
                />
              </label>

              <label className="block">
                <span className="block text-[10px] font-mono uppercase tracking-wider text-[#6E7B8E] mb-1.5">
                  Quantity {instrument ? `(${instrument.kind === "CRYPTO" ? "up to 8 decimals" : "up to 4 decimals"})` : ""}
                </span>
                <input
                  value={quantity}
                  onChange={(event) => {
                    setQuantity(event.target.value);
                    // Same reason as the symbol and side handlers: the button
                    // is disabled while an error is on screen, so the error has
                    // to clear when the user changes what they are submitting.
                    setSubmitError(null);
                  }}
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="0.00"
                  className="w-full rounded-lg bg-[#0E1219] border border-[#242C3A] focus:border-[#FF5A1F]/60 px-3 py-2 text-sm font-mono text-white placeholder:text-[#3E4A5C] outline-none transition-colors"
                />
                {quantityError(quantity) && quantity.trim().length > 0 && (
                  <span className="block text-[11px] text-[#FF4D4D] mt-1.5">
                    {quantityError(quantity)}
                  </span>
                )}
              </label>

              {quote && quote.available && (side === "BUY" ? quote.ask : quote.bid) && (
                <div className="rounded-lg bg-[#0E1219] border border-[#1E2532] px-3 py-2.5 space-y-1.5">
                  <Row
                    label={side === "BUY" ? "Reference price (ask)" : "Reference price (bid)"}
                    value={money(side === "BUY" ? quote.ask : quote.bid, 4)}
                  />
                  {quantityError(quantity) === null && (
                    <Row
                      label="Estimated notional"
                      value={`$${money(
                        (Number(quantity) * Number(side === "BUY" ? quote.ask : quote.bid)).toFixed(4),
                        2,
                      )}`}
                      muted
                    />
                  )}
                </div>
              )}

              <button
                type="submit"
                disabled={submitting || !symbol || Boolean(instrumentsError)}
                className="w-full py-2.5 rounded-lg bg-[#FF5A1F] hover:bg-[#E04B14] disabled:opacity-50 disabled:hover:bg-[#FF5A1F] text-xs font-bold text-white shadow-md shadow-[#FF5A1F]/25 transition-all"
              >
                {submitting ? (
                  <span className="flex items-center justify-center gap-2">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Submitting…
                  </span>
                ) : (
                  `${side} ${symbol || ""}`.trim()
                )}
              </button>

              {submitError && (
                <p className="text-[11px] text-[#FF4D4D] leading-relaxed border-t border-[#1E2532] pt-2.5">
                  {submitError}
                </p>
              )}

              {lastOrder && <OrderResult order={lastOrder} />}
            </form>

            <AccountPanel
              paper={paper}
              error={paperError}
              forbidden={paperForbidden}
              quote={quote}
              onRetry={refreshPaper}
            />

            <CopyPanel
              strategyId={strategyId}
              follow={copyFollow}
              account={copyAccount}
              loading={copyLoading}
              error={copyError}
              resolved={paperResolved}
              ownerView={ownerView}
              onRefresh={refreshCopy}
            />
          </aside>
        </div>
      </div>
    </AppShell>
  );
}

/* -------------------------------------------------------------------------- */
/* Pieces                                                                      */
/* -------------------------------------------------------------------------- */

function BackLink() {
  return (
    <Link
      href="/strategies"
      className="inline-flex items-center gap-1.5 text-xs font-medium text-[#7B8799] hover:text-white transition-colors"
    >
      <ArrowLeft className="w-3.5 h-3.5" />
      <span>All strategies</span>
    </Link>
  );
}

function Row({
  label,
  value,
  muted,
  tone,
}: {
  label: string;
  value: string;
  muted?: boolean;
  tone?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[10px] font-mono uppercase tracking-wider text-[#6E7B8E]">{label}</span>
      <span className={`text-xs font-mono ${tone ?? (muted ? "text-[#8E98A8]" : "text-white")}`}>
        {value}
      </span>
    </div>
  );
}

function PanelError({ title, message, onRetry }: { title: string; message: string; onRetry?: () => void }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-[#FF5A1F]/30 bg-[#FF5A1F]/5 p-4">
      <AlertTriangle className="w-4 h-4 text-[#FF5A1F] mt-0.5 shrink-0" />
      <div className="flex-1">
        <p className="text-xs font-semibold text-white">{title}</p>
        <p className="text-[11px] text-[#C5CFDE] mt-0.5 leading-relaxed">{message}</p>
      </div>
      {onRetry && (
        <button type="button" onClick={onRetry} className="text-xs font-bold text-[#FF5A1F] hover:underline">
          Retry
        </button>
      )}
    </div>
  );
}

/**
 * The quote panel. UNAVAILABLE is a real answer and is drawn as one: a blank
 * panel would read as a rendering fault rather than as the provider having no
 * observation.
 */
function QuotePanel({
  quote,
  error,
  loading,
  marketKind,
}: {
  quote: QuoteDto | null;
  error: string | null;
  loading: boolean;
  marketKind: string | null;
}) {
  if (error) {
    return (
      <div className="rounded-lg border border-[#FF5A1F]/30 bg-[#FF5A1F]/5 px-3 py-2.5 text-[11px] text-[#FF4D4D]">
        Quote unavailable: {error}
      </div>
    );
  }

  if (!quote) {
    return (
      <div className="rounded-lg border border-[#1E2532] bg-[#0E1219] px-3 py-2.5 text-[11px] font-mono text-[#5D6B82]">
        {loading ? "READING QUOTE…" : "NO QUOTE YET"}
      </div>
    );
  }

  const mid = quote.bid && quote.ask ? (Number(quote.bid) + Number(quote.ask)) / 2 : null;
  const statusLabel = !quote.available
    ? "UNAVAILABLE"
    : quote.stale
      ? "STALE"
      : quote.provider === "alpaca"
        ? "LIVE"
        : quote.provider.toUpperCase();

  const statusTone = !quote.available
    ? "text-[#FF4D4D]"
    : quote.stale
      ? "text-[#F5A623]"
      : "text-[#00D26A]";

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
      <Stat label="Bid" value={money(quote.bid, 4)} />
      <Stat label="Ask" value={money(quote.ask, 4)} />
      <Stat label="Mid" value={mid === null ? "—" : money(String(mid), 4)} />
      <Stat label="As of" value={clockOf(quote.asOf)} />
      <Stat
        label="Session"
        value={quote.marketState}
        tone={quote.marketState === "OPEN" ? "text-[#00D26A]" : "text-[#F5A623]"}
        caption={marketKind ?? undefined}
      />
      <Stat label="Feed" value={statusLabel} tone={statusTone} caption={loading ? "refreshing" : undefined} />
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
  caption,
}: {
  label: string;
  value: string;
  tone?: string;
  caption?: string;
}) {
  return (
    <div className="rounded-lg bg-[#0E1219] border border-[#1E2532] px-2.5 py-2 min-w-0">
      <p className="text-[10px] font-mono uppercase tracking-wider text-[#6E7B8E]">{label}</p>
      <p className={`text-sm font-mono font-bold truncate ${tone ?? "text-white"}`}>{value}</p>
      {caption && <p className="text-[9px] font-mono text-[#5D6B82] truncate">{caption}</p>}
    </div>
  );
}

function OrderResult({ order }: { order: PaperOrderResponse }) {
  const filled = order.status === "FILLED";
  return (
    <div
      className={`rounded-lg border px-3 py-2.5 space-y-1.5 ${
        filled ? "border-[#00D26A]/30 bg-[#00D26A]/5" : "border-[#F5A623]/30 bg-[#F5A623]/5"
      }`}
    >
      <div className="flex items-center justify-between">
        <span className={`text-[10px] font-mono font-bold tracking-wider ${filled ? "text-[#00D26A]" : "text-[#F5A623]"}`}>
          {order.status}
        </span>
        <span className="text-[10px] font-mono text-[#717E91]">{clockOf(order.placedAt)}</span>
      </div>
      <Row label="Order" value={`${order.side} ${order.quantity} ${order.symbol}`} />
      {order.fillPrice && <Row label="Filled at" value={money(order.fillPrice, 4)} />}
      {!filled && order.rejectReason && (
        <p className="text-[11px] text-[#C5CFDE] leading-relaxed pt-0.5">
          {REJECT_REASON_LABEL[order.rejectReason] ?? order.rejectReason}
        </p>
      )}
    </div>
  );
}

/**
 * Cash, realized P&L and open positions.
 *
 * POSITION VALUE IS A MARK, AND SAYS SO. Market value and unrealised P&L are
 * computed against the quote this screen already holds. They are labelled as a
 * mark because the ledger does not store them - a value that looks measured but
 * was computed in the browser must never present itself as a recorded result.
 */
function AccountPanel({
  paper,
  error,
  forbidden,
  quote,
  onRetry,
}: {
  paper: PaperSummaryDto | null;
  error: string | null;
  forbidden: boolean;
  quote: QuoteDto | null;
  onRetry: () => void;
}) {
  if (forbidden) {
    return (
      <div className="bg-[#12161E] border border-[#202735] rounded-xl p-4">
        <h2 className="text-sm font-bold text-white tracking-tight">Paper account</h2>
        <p className="text-[11px] text-[#717E91] mt-2 leading-relaxed">
          Paper trading is owner-only. This strategy belongs to another account, so its cash,
          positions and order history are not readable here.
        </p>
      </div>
    );
  }

  if (error) {
    return <PanelError title="The paper account could not be loaded" message={error} onRetry={onRetry} />;
  }

  if (!paper) {
    return (
      <div className="bg-[#12161E] border border-[#202735] rounded-xl p-4">
        <p className="flex items-center gap-2 text-xs font-mono text-[#8E98A8]">
          <Loader2 className="w-3.5 h-3.5 animate-spin text-[#FF5A1F]" />
          <span>LOADING PAPER ACCOUNT…</span>
        </p>
      </div>
    );
  }

  const markPrice = quote?.available && quote.price ? Number(quote.price) : null;

  return (
    <div className="bg-[#12161E] border border-[#202735] rounded-xl p-4 space-y-3.5">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-bold text-white tracking-tight">Paper account</h2>
        <span className="text-[10px] font-mono text-[#5D6B82]">USD · SIMULATED</span>
      </div>

      {paper.account === null ? (
        <p className="text-[11px] text-[#717E91] leading-relaxed">
          No paper account yet. It is provisioned with $100,000.00 of simulated cash on the first
          order you place for this strategy.
        </p>
      ) : (
        <div className="rounded-lg bg-[#0E1219] border border-[#1E2532] px-3 py-2.5 space-y-1.5">
          <Row label="Cash" value={`$${money(paper.account.cash)}`} />
          <Row
            label="Realized P&L (closed sells)"
            value={formatSigned(paper.account.realizedPnl)}
            tone={signTone(paper.account.realizedPnl)}
          />
          <Row label="Opened" value={clockOf(paper.account.openedAt)} muted />
        </div>
      )}

      <div>
        <p className="text-[10px] font-mono uppercase tracking-wider text-[#6E7B8E] mb-2">
          Open positions ({paper.positions.length})
        </p>
        {paper.positions.length === 0 ? (
          <p className="text-[11px] text-[#717E91] leading-relaxed">
            No open positions. Zero rows are never stored, so an empty list means nothing is held.
          </p>
        ) : (
          <div className="space-y-2">
            {paper.positions.map((position) => {
              const canMark = position.symbol === quote?.symbol && markPrice !== null;
              const value = canMark ? Number(position.quantity) * markPrice : null;
              const cost = Number(position.quantity) * Number(position.averageEntryPrice);
              const unrealised = value === null ? null : value - cost;

              return (
                <div key={position.symbol} className="rounded-lg bg-[#0E1219] border border-[#1E2532] px-3 py-2.5 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-white">{position.symbol}</span>
                    <span className="text-xs font-mono text-[#A6B2C4]">{money(position.quantity, 8)}</span>
                  </div>
                  <Row label="Avg entry" value={money(position.averageEntryPrice, 4)} />
                  <Row
                    label={canMark ? "Market value (mark)" : "Market value"}
                    value={value === null ? "—" : `$${money(String(value))}`}
                    muted={!canMark}
                  />
                  {unrealised !== null ? (
                    <Row
                      label="Unrealised P&L (mark)"
                      value={formatSigned(String(unrealised))}
                      tone={signTone(String(unrealised))}
                    />
                  ) : (
                    <Row label="Unrealised P&L" value="—" muted />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function OrdersPanel({
  orders,
  error,
  forbidden,
  onRetry,
}: {
  orders: PaperOrderResponse[];
  error: string | null;
  forbidden: boolean;
  onRetry: () => void;
}) {
  if (forbidden) {
    return null;
  }

  return (
    <div className="bg-[#12161E] border border-[#202735] rounded-xl p-4 space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-bold text-white tracking-tight">Order history</h2>
        <span className="text-[10px] font-mono text-[#5D6B82]">MOST RECENT FIRST</span>
      </div>

      {error && <PanelError title="Order history could not be loaded" message={error} onRetry={onRetry} />}

      {!error && orders.length === 0 && (
        <p className="text-[11px] text-[#717E91] leading-relaxed">
          No paper orders have been placed on this strategy yet.
        </p>
      )}

      {!error && orders.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-[#1E2532]">
                {["Time", "Side", "Symbol", "Qty", "Price", "Status"].map((head) => (
                  <th
                    key={head}
                    className="text-[10px] font-mono uppercase tracking-wider text-[#6E7B8E] pb-2 pr-3 font-medium"
                  >
                    {head}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr key={order.orderId} className="border-b border-[#161B24] last:border-0">
                  <td className="py-2 pr-3 text-[11px] font-mono text-[#8E98A8] whitespace-nowrap">
                    {clockOf(order.filledAt ?? order.placedAt)}
                  </td>
                  <td
                    className={`py-2 pr-3 text-[11px] font-mono font-bold ${
                      order.side === "BUY" ? "text-[#00D26A]" : "text-[#FF4D4D]"
                    }`}
                  >
                    {order.side}
                  </td>
                  <td className="py-2 pr-3 text-[11px] font-bold text-white whitespace-nowrap">
                    {order.symbol}
                  </td>
                  <td className="py-2 pr-3 text-[11px] font-mono text-[#A6B2C4] whitespace-nowrap">
                    {money(order.quantity, 8)}
                  </td>
                  <td className="py-2 pr-3 text-[11px] font-mono text-[#A6B2C4] whitespace-nowrap">
                    {order.fillPrice ? money(order.fillPrice, 4) : "—"}
                  </td>
                  <td className="py-2 text-[11px] font-mono whitespace-nowrap">
                    {order.status === "FILLED" ? (
                      <span className="text-[#00D26A]">FILLED</span>
                    ) : (
                      <span
                        className="text-[#F5A623]"
                        title={REJECT_REASON_LABEL[order.rejectReason ?? ""] ?? order.rejectReason ?? ""}
                      >
                        REJECTED
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * MODULE 07 — the follower's copy controls for this strategy.
 *
 * THE PANEL NEVER DECIDES ELIGIBILITY ITSELF. `follow.eligibility` arrives
 * recomputed from the API on every read, because a strategy archived a second
 * ago has to read as archived now, not at the last write. Every action ends by
 * re-reading the follow rather than patching it locally: the counts and the
 * cursor belong to the engine, not to the form.
 *
 * SIMULATED ONLY. Copy cash is Module 07's own pot, distinct from Module 03's
 * wallet and from the expert's paper account shown above it on this screen.
 */
function CopyPanel({
  strategyId,
  follow,
  account,
  loading,
  error,
  resolved,
  ownerView,
  onRefresh,
}: {
  strategyId: string;
  follow: CopyFollowStatus | null;
  account: CopyFollowAccount | null;
  loading: boolean;
  error: string | null;
  resolved: boolean;
  ownerView: boolean;
  onRefresh: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  if (!resolved) return null;

  if (ownerView) {
    return (
      <div className="bg-[#12161E] border border-[#202735] rounded-xl p-4">
        <h2 className="text-sm font-bold text-white tracking-tight">Copy trading</h2>
        <p className="text-[11px] text-[#717E91] mt-2 leading-relaxed">
          This is your strategy, so you cannot follow it — copy trading mirrors another
          account&apos;s committed fills, and following yourself would copy your own orders.
          Your followers are listed below the order history.
        </p>
      </div>
    );
  }

  if (loading && follow === null && error === null) {
    return (
      <div className="bg-[#12161E] border border-[#202735] rounded-xl p-4">
        <p className="flex items-center gap-2 text-xs font-mono text-[#8E98A8]">
          <Loader2 className="w-4 h-4 animate-spin text-[#FF5A1F]" />
          <span>READING COPY STATE…</span>
        </p>
      </div>
    );
  }

  if (follow === null && error !== null) {
    return <PanelError title="Your copy state could not be read" message={error} onRetry={onRefresh} />;
  }

  // A non-follower returns the form here; every handler below is therefore
  // narrowed to a present follow.
  if (follow === null) {
    return (
      <FollowForm
        strategyId={strategyId}
        onFollowed={() => {
          setNotice(
            "Following. Fills the expert commits from now on will be copied; fills that already exist are never back-filled.",
          );
          onRefresh();
        }}
      />
    );
  }

  const begin = () => {
    setBusy(true);
    setActionError(null);
    setNotice(null);
  };

  const fail = (reason: unknown) => {
    setActionError(messageFor(reason));
    setBusy(false);
  };

  const runSync = () => {
    begin();
    syncCopyFollow(strategyId)
      .then((result) => {
        setNotice(
          result.consumed === 0
            ? "Synced. No unconsumed expert fills were waiting."
            : `Synced. ${result.consumed} expert fill${result.consumed === 1 ? "" : "s"} consumed.`,
        );
        onRefresh();
        setBusy(false);
      })
      .catch(fail);
  };

  const runUnfollow = () => {
    begin();
    unfollowStrategy(strategyId)
      .then(() => {
        setNotice(
          "Stopped copying. Cash and positions are kept as they are — nothing is liquidated without a price to sell at.",
        );
        onRefresh();
        setBusy(false);
      })
      .catch(fail);
  };

  const runResume = () => {
    begin();
    // The stored fraction, not anything on screen: resume re-enters the
    // relationship exactly as it was left, and the stored value is the one the
    // API has already validated.
    followStrategy({ strategyId, allocationFraction: follow.allocationFraction })
      .then(() => {
        setNotice(
          "Resumed. The cursor was kept, so fills committed while paused are recorded as refused rather than copied.",
        );
        onRefresh();
        setBusy(false);
      })
      .catch(fail);
  };

  const runAllocation = (value: string) => {
    const invalid = allocationError(value);
    if (invalid) {
      setActionError(invalid);
      return;
    }

    begin();
    setCopyAllocation(strategyId, value.trim())
      .then(() => {
        setNotice(
          "Allocation saved. It applies to the next fill the engine consumes; events already in the history keep the fraction they were sized with.",
        );
        onRefresh();
        setBusy(false);
      })
      .catch(fail);
  };

  const eligible = follow.eligibility === "ELIGIBLE";
  const active = follow.status === "ACTIVE";

  return (
    <div className="bg-[#12161E] border border-[#202735] rounded-xl p-4 space-y-3.5">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-bold text-white tracking-tight">Copy trading</h2>
        <span
          className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold ${
            active ? "bg-[#00D26A]/10 text-[#00D26A]" : "bg-[#F5A623]/10 text-[#F5A623]"
          }`}
        >
          {follow.status}
        </span>
      </div>

      <p
        className={`text-[11px] leading-relaxed ${eligible ? "text-[#00D26A]" : "text-[#F5A623]"}`}
      >
        {COPY_ELIGIBILITY_LABEL[follow.eligibility] ?? follow.eligibility}
      </p>

      {active && follow.hasPendingEvents && (
        <p className="text-[11px] text-[#F5A623] leading-relaxed">
          The expert has committed fills this follow has not consumed yet. Sync now, or let the
          background worker pick them up on its next pass.
        </p>
      )}

      <div className="rounded-lg bg-[#0E1219] border border-[#1E2532] px-3 py-2.5 space-y-1.5">
        <Row label="Allocation" value={`${follow.allocationFraction} × each expert order`} />
        <Row label="Copied" value={String(follow.copiedCount)} />
        <Row label="Refused" value={String(follow.rejectedCount)} />
        <Row label="Last processed" value={clockOf(follow.lastProcessedAt)} muted />
      </div>

      <AllocationEditor
        key={`${follow.strategyId}-${follow.allocationFraction}`}
        stored={follow.allocationFraction}
        disabled={busy}
        onSave={runAllocation}
        onValueChange={() => setActionError(null)}
      />

      <div>
        <p className="text-[10px] font-mono uppercase tracking-wider text-[#6E7B8E] mb-2">
          Copy cash (simulated)
        </p>
        {account === null || account.account === null ? (
          <p className="text-[11px] text-[#717E91] leading-relaxed">
            No copy account yet. It is provisioned with $100,000.00 of simulated cash when the
            first eligible fill is copied — never Module 03 money, and never the expert&apos;s
            paper balance.
          </p>
        ) : (
          <div className="rounded-lg bg-[#0E1219] border border-[#1E2532] px-3 py-2.5 space-y-1.5">
            <Row label="Cash" value={`$${money(account.account.cash)}`} />
            <Row
              label="Realized P&L (closed sells)"
              value={formatSigned(account.account.realizedPnl)}
              tone={signTone(account.account.realizedPnl)}
            />
            {account.positions.length === 0 ? (
              <Row label="Open positions" value="None" muted />
            ) : (
              account.positions.map((position) => (
                <Row
                  key={position.symbol}
                  label={position.symbol}
                  value={`${money(position.quantity, 8)} @ ${money(position.averageEntryPrice, 4)}`}
                />
              ))
            )}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-0.5">
        <button
          type="button"
          onClick={runSync}
          disabled={busy}
          className="px-3 py-1.5 rounded-lg bg-[#FF5A1F] hover:bg-[#E04B14] disabled:opacity-50 text-xs font-bold text-white shadow-sm transition-all"
        >
          Sync now
        </button>
        {active ? (
          <button
            type="button"
            onClick={runUnfollow}
            disabled={busy}
            className="px-3 py-1.5 rounded-lg bg-[#FF4D4D]/10 hover:bg-[#FF4D4D]/20 border border-[#FF4D4D]/30 disabled:opacity-50 text-xs font-bold text-[#FF4D4D] transition-colors"
          >
            Stop copying
          </button>
        ) : (
          <button
            type="button"
            onClick={runResume}
            disabled={busy}
            className="px-3 py-1.5 rounded-lg bg-[#00D26A]/10 hover:bg-[#00D26A]/20 border border-[#00D26A]/30 disabled:opacity-50 text-xs font-bold text-[#00D26A] transition-colors"
          >
            Resume copying
          </button>
        )}
      </div>

      {error && (
        <PanelError title="The copy account could not be refreshed" message={error} onRetry={onRefresh} />
      )}

      {notice && (
        <p className="text-[11px] text-[#00D26A] leading-relaxed border-t border-[#1E2532] pt-2.5">
          {notice}
        </p>
      )}

      {actionError && (
        <p className="text-[11px] text-[#FF4D4D] leading-relaxed border-t border-[#1E2532] pt-2.5">
          {actionError}
        </p>
      )}
    </div>
  );
}

/**
 * The follow form for a strategy the caller does not follow yet.
 *
 * ALLOCATION IS TYPED, NEVER PREFILLED. The API refuses a follow without one
 * precisely so that mirroring the expert in full cannot be the number a form
 * happened to ship with. The input mirrors the server's validation rule for
 * instant feedback; the server's message is still what a failure surfaces.
 */
function FollowForm({
  strategyId,
  onFollowed,
}: {
  strategyId: string;
  onFollowed: () => void;
}) {
  const [allocation, setAllocation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const invalid = allocationError(allocation);

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (invalid !== null) {
      setError(invalid);
      return;
    }

    setBusy(true);
    setError(null);
    followStrategy({ strategyId, allocationFraction: allocation.trim() })
      .then(() => {
        setBusy(false);
        onFollowed();
      })
      .catch((reason: unknown) => {
        setError(messageFor(reason));
        setBusy(false);
      });
  };

  return (
    <form onSubmit={submit} className="bg-[#12161E] border border-[#202735] rounded-xl p-4 space-y-3">
      <div>
        <h2 className="text-sm font-bold text-white tracking-tight">Copy trading</h2>
        <p className="text-[11px] text-[#717E91] mt-1 leading-relaxed">
          Mirror this strategy&apos;s committed paper fills at an allocation you choose.
          Simulated only: each follow gets its own $100,000.00 paper pot, separate from your
          wallet and from the expert&apos;s paper account. No real order is ever placed.
        </p>
      </div>

      <label className="block">
        <span className="block text-[10px] font-mono uppercase tracking-wider text-[#6E7B8E] mb-1.5">
          Allocation — share of each expert order, in (0, 1]
        </span>
        <input
          value={allocation}
          onChange={(event) => {
            setAllocation(event.target.value);
            setError(null);
          }}
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.25"
          className="w-full rounded-lg bg-[#0E1219] border border-[#242C3A] focus:border-[#FF5A1F]/60 px-3 py-2 text-sm font-mono text-white placeholder:text-[#3E4A5C] outline-none transition-colors"
        />
        <span className="block text-[10px] text-[#5D6B82] mt-1.5 leading-relaxed">
          1 mirrors the expert exactly; 0.25 copies a quarter of each order. Stated per follow,
          never defaulted.
        </span>
        {allocation.trim().length > 0 && invalid !== null && (
          <span className="block text-[11px] text-[#FF4D4D] mt-1.5">{invalid}</span>
        )}
      </label>

      <button
        type="submit"
        disabled={busy || invalid !== null}
        className="w-full py-2.5 rounded-lg bg-[#FF5A1F] hover:bg-[#E04B14] disabled:opacity-50 disabled:hover:bg-[#FF5A1F] text-xs font-bold text-white shadow-md shadow-[#FF5A1F]/25 transition-all"
      >
        {busy ? "Following…" : "Follow this strategy"}
      </button>

      {error && (
        <p className="text-[11px] text-[#FF4D4D] leading-relaxed border-t border-[#1E2532] pt-2.5">
          {error}
        </p>
      )}
    </form>
  );
}

/**
 * The allocation editor for an existing follow.
 *
 * Keyed on the stored fraction by its caller, so the state inside is seeded
 * when the follow arrives and re-seeded whenever the stored value changes —
 * without an effect that writes state, which this codebase's lint rules forbid
 * inside an effect body.
 */
function AllocationEditor({
  stored,
  disabled,
  onSave,
  onValueChange,
}: {
  stored: string;
  disabled: boolean;
  onSave: (value: string) => void;
  onValueChange?: () => void;
}) {
  const [value, setValue] = useState(stored);
  const invalid = allocationError(value);
  const unchanged = value.trim() === stored;

  return (
    <div className="space-y-1.5">
      <div className="flex items-end gap-2">
        <label className="flex-1 min-w-0">
          <span className="block text-[10px] font-mono uppercase tracking-wider text-[#6E7B8E] mb-1.5">
            Allocation
          </span>
          <input
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              onValueChange?.();
            }}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.25"
            className="w-full rounded-lg bg-[#0E1219] border border-[#242C3A] focus:border-[#FF5A1F]/60 px-3 py-2 text-sm font-mono text-white placeholder:text-[#3E4A5C] outline-none transition-colors"
          />
        </label>
        <button
          type="button"
          onClick={() => onSave(value)}
          disabled={disabled || invalid !== null || unchanged}
          className="px-3 py-2 rounded-lg bg-[#161B24] hover:bg-[#202735] border border-[#273242] disabled:opacity-50 text-xs font-bold text-white transition-colors"
        >
          Save
        </button>
      </div>
      {value.trim().length > 0 && invalid !== null && (
        <p className="text-[11px] text-[#FF4D4D]">{invalid}</p>
      )}
      <p className="text-[10px] text-[#5D6B82] leading-relaxed">
        Applies to the next fill the engine consumes; events already in the history keep the
        fraction they were sized with.
      </p>
    </div>
  );
}

/**
 * MODULE 07 — what the engine did with this follow's expert fills.
 *
 * Refusals sit in the same table as copies, each with its reason. A gap in the
 * copies with no explanation would be worse than a row that says why nothing
 * was copied, which is the whole point of the history.
 */
function CopyHistoryPanel({
  follow,
  events,
  error,
  onRetry,
}: {
  follow: CopyFollowStatus | null;
  events: CopyEvent[];
  error: string | null;
  onRetry: () => void;
}) {
  if (follow === null) return null;

  return (
    <div className="bg-[#12161E] border border-[#202735] rounded-xl p-4 space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-bold text-white tracking-tight">Copy history</h2>
        <span className="text-[10px] font-mono text-[#5D6B82]">MOST RECENT FIRST</span>
      </div>

      {error && (
        <PanelError title="Copy history could not be loaded" message={error} onRetry={onRetry} />
      )}

      {!error && events.length === 0 && (
        <p className="text-[11px] text-[#717E91] leading-relaxed">
          No expert fills have been consumed for this follow yet. The engine records every fill it
          sees — copied or refused — so this list fills in as the expert trades.
        </p>
      )}

      {!error && events.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-[#1E2532]">
                {["Time", "Side", "Symbol", "Expert qty", "Your qty", "Filled at", "Result", "Reason"].map(
                  (head) => (
                    <th
                      key={head}
                      className="text-[10px] font-mono uppercase tracking-wider text-[#6E7B8E] pb-2 pr-3 font-medium"
                    >
                      {head}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.expertOrderId} className="border-b border-[#161B24] last:border-0">
                  <td className="py-2 pr-3 text-[11px] font-mono text-[#8E98A8] whitespace-nowrap">
                    {clockOf(event.processedAt)}
                  </td>
                  <td
                    className={`py-2 pr-3 text-[11px] font-mono font-bold ${
                      event.side === "BUY" ? "text-[#00D26A]" : "text-[#FF4D4D]"
                    }`}
                  >
                    {event.side}
                  </td>
                  <td className="py-2 pr-3 text-[11px] font-bold text-white whitespace-nowrap">
                    {event.symbol}
                  </td>
                  <td className="py-2 pr-3 text-[11px] font-mono text-[#A6B2C4] whitespace-nowrap">
                    {money(event.expertQuantity, 8)}
                  </td>
                  <td className="py-2 pr-3 text-[11px] font-mono text-[#A6B2C4] whitespace-nowrap">
                    {event.quantity === null ? "—" : money(event.quantity, 8)}
                  </td>
                  <td className="py-2 pr-3 text-[11px] font-mono text-[#A6B2C4] whitespace-nowrap">
                    {event.fillPrice ? money(event.fillPrice, 4) : "—"}
                  </td>
                  <td className="py-2 pr-3 text-[11px] font-mono whitespace-nowrap">
                    {event.status === "COPIED" ? (
                      <span className="text-[#00D26A]">COPIED</span>
                    ) : (
                      <span className="text-[#F5A623]">REFUSED</span>
                    )}
                  </td>
                  <td className="py-2 text-[11px] text-[#8E98A8]">
                    {event.rejectReason
                      ? (COPY_REJECT_REASON_LABEL[event.rejectReason] ?? event.rejectReason)
                      : `Sized at ${event.allocationFraction}×`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * MODULE 07 — the owner's view of their audience.
 *
 * 404 hides the panel instead of showing it: a non-owner must not learn that a
 * strategy id has followers, and the same posture Module 05 applies to reads
 * applies here. The address arrives already masked from the API; this screen
 * never sees an unmasked one to leak.
 */
function FollowersPanel({ strategyId, visible }: { strategyId: string; visible: boolean }) {
  const [page, setPage] = useState<CopyFollowerPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!visible) return;
    let active = true;

    void listStrategyFollowers(strategyId, { limit: COPY_HISTORY_LIMIT })
      .then((result) => {
        if (!active) return;
        setPage(result);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        if (reason instanceof ApiError && reason.status === 404) {
          setHidden(true);
        } else {
          setError(messageFor(reason));
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [strategyId, visible]);

  if (!visible || hidden) return null;

  return (
    <div className="bg-[#12161E] border border-[#202735] rounded-xl p-4 space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-bold text-white tracking-tight">Followers</h2>
        <span className="text-[10px] font-mono text-[#5D6B82]">ADDRESSES MASKED</span>
      </div>

      {error && <PanelError title="Followers could not be loaded" message={error} />}

      {!error && loading && (
        <p className="flex items-center gap-2 text-xs font-mono text-[#8E98A8]">
          <Loader2 className="w-4 h-4 animate-spin text-[#FF5A1F]" />
          <span>LOADING FOLLOWERS…</span>
        </p>
      )}

      {!error && !loading && page !== null && page.items.length === 0 && (
        <p className="text-[11px] text-[#717E91] leading-relaxed">
          Nobody follows this strategy yet. Followers appear here once they choose an allocation
          for it.
        </p>
      )}

      {!error && !loading && page !== null && page.items.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-[#1E2532]">
                {["Follower", "Status", "Allocation", "Following since", "Copied", "Refused"].map(
                  (head) => (
                    <th
                      key={head}
                      className="text-[10px] font-mono uppercase tracking-wider text-[#6E7B8E] pb-2 pr-3 font-medium"
                    >
                      {head}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {page.items.map((follower) => (
                <tr key={follower.followerId} className="border-b border-[#161B24] last:border-0">
                  <td className="py-2 pr-3 text-[11px] font-mono font-bold text-white whitespace-nowrap">
                    {follower.maskedEmail}
                  </td>
                  <td className="py-2 pr-3 text-[11px] font-mono whitespace-nowrap">
                    {follower.status === "ACTIVE" ? (
                      <span className="text-[#00D26A]">ACTIVE</span>
                    ) : (
                      <span className="text-[#F5A623]">UNFOLLOWED</span>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-[11px] font-mono text-[#A6B2C4] whitespace-nowrap">
                    {follower.allocationFraction}×
                  </td>
                  <td className="py-2 pr-3 text-[11px] font-mono text-[#8E98A8] whitespace-nowrap">
                    {dateOf(follower.followedAt)}
                  </td>
                  <td className="py-2 pr-3 text-[11px] font-mono text-[#00D26A] whitespace-nowrap">
                    {follower.copiedCount}
                  </td>
                  <td className="py-2 text-[11px] font-mono text-[#F5A623] whitespace-nowrap">
                    {follower.rejectedCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function dateOf(iso: string | null): string {
  if (!iso) return "—";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatSigned(value: string): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  const sign = parsed > 0 ? "+" : "";
  return `${sign}$${money(String(parsed))}`;
}

function signTone(value: string): string | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed === 0) return undefined;
  return parsed > 0 ? "text-[#00D26A]" : "text-[#FF4D4D]";
}
