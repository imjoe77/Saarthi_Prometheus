"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import {
  AlertTriangle,
  Flame,
  Loader2,
  MessageSquare,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  X,
} from "lucide-react";

import AppShell from "@/components/AppShell";
import { ExpertChatModal } from "@/components/ExpertChatModal";
import {
  ApiError,
  discoverStrategies,
  followStrategy,
  getBars,
  getCopyAggregateAccount,
  getCopyFollowAccount,
  getCopyPerformance,
  getInstruments,
  listCopyEvents,
  listCopyFollows,
  listCopyOrders,
  setCopyAllocation,
  syncCopyFollow,
  unfollowStrategy,
  type BarDto,
  type CopyAggregateAccount,
  type CopyEligibility,
  type CopyEvent,
  type CopyFollow,
  type CopyFollowAccount,
  type CopyPerformance,
  type InstrumentDto,
  type PublicStrategySummary,
} from "@/lib/api-client";
import { copyTradingStyles } from "@/lib/design/copyTrading-styles";
import { COPY_SYMBOL_COLOURS } from "@/lib/design/copyPalette";
import type { ChartMarker } from "@/components/StrategyChart";
import type { UTCTimestamp } from "lightweight-charts";

/**
 * The copy-trading desk, in the reference design's layout.
 *
 * Every number is real: the catalogue comes from `GET /strategies`, the cards
 * and the table come from `GET /copy/follows`, the pot from `GET /copy/account`,
 * and the history from `GET /copy/follows/:id/orders`. The reference design's
 * ROI, drawdown, ratings, fit score, follower profit and simulated trade feed
 * have no endpoint behind them, so they are gone rather than mocked.
 *
 * `allocationFraction` is the one control that maps directly to the engine:
 * it is the share of each expert fill this follow mirrors, in (0, 1]. The
 * slider displays it as 1–100%.
 */

type LoadStatus = "loading" | "ready" | "error";
type DetailTab = "overview" | "position" | "history" | "chart";

/** Bar timeframes the `GET /market-data/bars` endpoint accepts. */
const TIMEFRAMES = ["1m", "5m", "15m", "1h", "1d"] as const;
type Timeframe = (typeof TIMEFRAMES)[number];

/**
 * How many candles the detail-pane chart asks for. Deliberately smaller than
 * the strategy screen's 180: this pane is roughly a third of the width, and a
 * denser series would be unreadable rather than more informative.
 */
const CHART_BARS_LIMIT = 120;

/**
 * How many candles the Copy-activity chart asks for. Wider than the detail
 * pane's: the copied fills are markers on this series, so the window has to
 * be long enough to hold a fill and the move that followed it.
 */
const ACTIVITY_BARS_LIMIT = 160;

/**
 * The chart is loaded on the client only. lightweight-charts touches `window`
 * at import time, and a server render would throw before the first paint.
 */
const Chart = dynamic(
  () => import("@/components/StrategyChart").then((module) => ({ default: module.StrategyChart })),
  {
    ssr: false,
    loading: () => (
      <div className="cp-chart-msg">
        <Loader2 size={16} className="cp-spin" />
        <span>Preparing the chart…</span>
      </div>
    ),
  },
);

/**
 * The copy-activity charts, loaded the same way: lightweight-charts touches
 * `window` at import time, and a server render would throw before the first
 * paint. Two separate entries so one failing to load cannot blank the other.
 */
const ExpertTradesChart = dynamic(
  () =>
    import("@/components/CopyActivityChart").then((module) => ({
      default: module.ExpertTradesChart,
    })),
  {
    ssr: false,
    loading: () => (
      <div className="activity-empty">
        <Loader2 size={16} className="cp-spin" /> Preparing the chart…
      </div>
    ),
  },
);

const CopyPnlChart = dynamic(
  () =>
    import("@/components/CopyActivityChart").then((module) => ({
      default: module.CopyPnlChart,
    })),
  {
    ssr: false,
    loading: () => (
      <div className="activity-empty">
        <Loader2 size={16} className="cp-spin" /> Preparing the chart…
      </div>
    ),
  },
);

type ChatMessage = { who: "me" | "buddy"; text: string };

const ELIGIBILITY_LABEL: Record<CopyEligibility, string> = {
  ELIGIBLE: "Eligible — the next fill will be copied",
  FOLLOW_NOT_ACTIVE: "This follow is stopped",
  STRATEGY_ARCHIVED: "The strategy is archived",
  STRATEGY_NOT_ELIGIBLE: "The strategy is no longer public and active",
  ALLOCATION_ROUNDED_TO_ZERO: "The allocation rounds to zero at asset precision",
  INSUFFICIENT_COPY_CASH: "The copy pot does not have enough cash",
  PRICE_UNAVAILABLE: "The expert fill had no usable price",
  INSUFFICIENT_WALLET_BALANCE: "Your USDT wallet balance does not cover the copy",
};

const CHAT_SCRIPT: Array<{ match: RegExp; reply: string }> = [
  {
    match: /allocation|percent|size|how much/i,
    reply:
      "Allocation is the share of each expert fill this follow mirrors. It lives in (0, 1] and is applied to the next fill only — changing it never rewrites a fill that already happened.",
  },
  {
    match: /sync|pending|nothing/i,
    reply:
      "Sync now runs the same loop as the background worker once: it consumes the expert fills this follow has not seen and returns how many events were written. Refusals are written too, with a reason.",
  },
  {
    match: /skip|refus|reject|why|failed/i,
    reply:
      "Open the History tab. Every refusal is a row with its reason — the copy pot had no cash, your USDT balance did not cover it, the allocation rounded to zero, the expert fill had no usable price, or the strategy was not eligible. Nothing is silently dropped.",
  },
  {
    match: /roi|profit|return|sharpe|drawdown/i,
    reply:
      "I cannot show ROI, Sharpe or drawdown, because the platform does not measure them. The copy pot exposes cash, realized P&L and positions; inventing the rest would be worse than leaving it out.",
  },
  {
    match: /risk|safe|stop|unfollow|long|short/i,
    reply:
      "Risk controls are structural: each follow has its own cash pot, allocation bounds the mirrored size, a LONG spends cash and a SHORT brings the notional in, and Stop following stops new copies without liquidating anything.",
  },
];

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    return error.details?.length ? `${error.message} ${error.details.join(" ")}` : error.message;
  }
  return "Something went wrong while talking to the Prometheus API.";
}

function num(value: string | null | undefined, digits = 2): string {
  if (value === null || value === undefined) return "—";
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? parsed.toLocaleString("en-US", { maximumFractionDigits: digits })
    : value;
}

function pctFromFraction(fraction: string): number {
  const parsed = Number(fraction) * 100;
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.min(100, Math.round(parsed)));
}

/** The colour of a signed figure: green for a gain, red for a loss. */
function pnlTone(value: string | null): string | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed >= 0 ? "var(--gain)" : "var(--loss)";
}

function shortDate(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/**
 * Per-trader avatar tint. The hue is derived from the strategy name so a
 * trader keeps the same mark everywhere, but it is kept desaturated and dark:
 * the page's colour belongs to the ember accent, and a row of fully saturated
 * chips would read as decoration rather than data.
 */
function hashHue(name: string): number {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) hash = (hash * 31 + name.charCodeAt(index)) % 360;
  return hash;
}

function avatarTone(name: string): string {
  return `hsl(${hashHue(name)} 26% 32%)`;
}

export default function CopyTradingPage() {
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [strategies, setStrategies] = useState<PublicStrategySummary[]>([]);
  const [follows, setFollows] = useState<CopyFollow[]>([]);
  const [aggregate, setAggregate] = useState<CopyAggregateAccount | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const [tab, setTab] = useState<"all" | "following">("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"name" | "newest">("name");
  const [detailTab, setDetailTab] = useState<DetailTab>("overview");

  // The detail pane's Chart tab. A public strategy listing carries no symbol
  // of its own — only a name and a description — so the chart is fed from the
  // live instrument catalogue, the same picker the strategy screen uses.
  const [instruments, setInstruments] = useState<InstrumentDto[]>([]);
  const [instrumentsLoading, setInstrumentsLoading] = useState(true);
  const [instrumentsError, setInstrumentsError] = useState<string | null>(null);
  const [instrumentsNonce, setInstrumentsNonce] = useState(0);
  const [chartSymbol, setChartSymbol] = useState("");
  const [chartTimeframe, setChartTimeframe] = useState<Timeframe>("1m");
  const [bars, setBars] = useState<BarDto[]>([]);
  const [barsStatus, setBarsStatus] = useState<LoadStatus>("loading");
  const [barsError, setBarsError] = useState<string | null>(null);
  const [barsNonce, setBarsNonce] = useState(0);

  // The Copy-activity candle series. It reads the market the engine actually
  // traded, so the fills sit on the candles they were filled against.
  const [activityPick, setActivityPick] = useState("");
  const [activityTimeframe, setActivityTimeframe] = useState<Timeframe>("5m");
  const [activityBars, setActivityBars] = useState<BarDto[]>([]);
  const [activityBarsStatus, setActivityBarsStatus] = useState<LoadStatus>("loading");
  const [activityBarsError, setActivityBarsError] = useState<string | null>(null);
  const [activityBarsNonce, setActivityBarsNonce] = useState(0);

  const [allocationPct, setAllocationPct] = useState(50);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [consent, setConsent] = useState(false);

  const [accountData, setAccountData] = useState<{
    strategyId: string;
    account: CopyFollowAccount;
    orders: CopyEvent[];
  } | null>(null);

  // The copy book across every follow: the tape and the profit-and-loss path.
  const [events, setEvents] = useState<CopyEvent[]>([]);
  const [performance, setPerformance] = useState<CopyPerformance | null>(null);
  const [activityError, setActivityError] = useState<string | null>(null);

  const [expertChatOpen, setExpertChatOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      who: "buddy",
      text: "I am the scripted Trading Buddy. I can explain allocation, sync, refusals and what the copy pot records. I do not give trade advice.",
    },
  ]);

  useEffect(() => {
    let active = true;
    Promise.all([
      discoverStrategies({ limit: 100 }),
      listCopyFollows({ limit: 100 }),
      getCopyAggregateAccount(),
    ])
      .then(([strategyPage, followPage, aggregateAccount]) => {
        if (!active) return;
        setStrategies(strategyPage.items);
        setFollows(followPage.items);
        setAggregate(aggregateAccount);
        const firstFollow = followPage.items[0];
        const firstStrategy = strategyPage.items[0];
        setSelectedId(firstFollow?.strategyId ?? firstStrategy?.id ?? null);
        setAllocationPct(firstFollow ? pctFromFraction(firstFollow.allocationFraction) : 50);
        setStatus("ready");
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setError(messageFor(cause));
        setStatus("error");
      });
    return () => {
      active = false;
    };
  }, []);

  /**
   * The instrument catalogue is code-defined and static, so it is read once.
   * `instrumentsNonce` exists only for the retry in the Chart tab: a failed
   * catalogue read must be recoverable from the pane that needs it, without
   * reloading the whole page.
   */
  useEffect(() => {
    let active = true;
    getInstruments()
      .then((list) => {
        if (!active) return;
        setInstruments(list);
        setChartSymbol((current) => current || list[0]?.symbol || "");
        setInstrumentsError(null);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setInstrumentsError(messageFor(cause));
      })
      .finally(() => {
        if (active) setInstrumentsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [instrumentsNonce]);

  /**
   * The bar series behind the Chart tab.
   *
   * It runs only while that tab is open, so opening Copy Trading costs no
   * market-data request at all, and every later read is driven by the picker,
   * the timeframe buttons or the refresh — the loading flag is raised in those
   * handlers, never here, because the handler is the honest place to say the
   * user just asked for something else.
   */
  useEffect(() => {
    if (detailTab !== "chart" || !chartSymbol) return;
    let active = true;
    getBars(chartSymbol, chartTimeframe, CHART_BARS_LIMIT)
      .then((result) => {
        if (!active) return;
        setBars(result.items);
        setBarsError(null);
        setBarsStatus("ready");
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setBars([]);
        setBarsError(messageFor(cause));
        setBarsStatus("error");
      });
    return () => {
      active = false;
    };
  }, [detailTab, chartSymbol, chartTimeframe, barsNonce]);

  const retryBars = () => {
    setBarsStatus("loading");
    setBarsNonce((value) => value + 1);
  };

  const retryActivityBars = () => {
    setActivityBarsStatus("loading");
    setActivityBarsNonce((value) => value + 1);
  };

  const retryInstruments = () => {
    setInstrumentsLoading(true);
    setInstrumentsNonce((value) => value + 1);
  };

  /**
   * The copy book across every follow.
   *
   * It is read separately from the page's own data because a failure here must
   * not blank the desk: the catalogue, the follows and the pots are still
   * worth showing when the tape cannot be read, and a reader who cannot see
   * the charts can still see the history table. The error is therefore held
   * next to the section that failed rather than raised to the page.
   */
  const loadActivity = useCallback(async () => {
    try {
      const [eventPage, performanceResult] = await Promise.all([
        listCopyEvents({ limit: 60 }),
        getCopyPerformance(),
      ]);
      setEvents(eventPage.items);
      setPerformance(performanceResult);
      setActivityError(null);
    } catch (cause: unknown) {
      setActivityError(messageFor(cause));
    }
  }, []);

  useEffect(() => {
    void loadActivity();
  }, [loadActivity]);

  /**
   * The copy book, re-read on a timer so the marks stay live.
   *
   * The engine prices every open position and returns the mark, the signed
   * market value and the unrealised P&L with it. The screen does not price
   * anything itself: a second quote read here could disagree with the engine
   * between the two, and a follower would have no way to tell which one was
   * right. A failed poll is left alone - the last good book stays on screen
   * and the next tick tries again.
   */
  useEffect(() => {
    const timer = window.setInterval(() => {
      getCopyAggregateAccount()
        .then((account) => setAggregate(account))
        .catch(() => undefined);
    }, 15000);
    return () => window.clearInterval(timer);
  }, []);

  /**
   * The expert's trades, as the charts need them.
   *
   * Only copied fills become a point: a refusal is a record of a fill that was
   * not taken, and drawing it would put a price on the book that never moved.
   */
  const trades = useMemo(
    () =>
      events
        .filter((event) => event.status === "COPIED" && event.fillPrice !== null)
        .map((event) => ({
          at: event.processedAt,
          symbol: event.symbol,
          side: event.side,
          price: Number(event.fillPrice),
          quantity: Number(event.quantity ?? 0),
        })),
    [events],
  );

  /**
   * The legend beside the chart.
   *
   * It has to name the colours the chart actually drew, so it is built from
   * the same trades the chart receives, in the same order the chart sorts
   * them: instruments alphabetically, each taking the next colour of the
   * shared palette. Both sides read one list, so they cannot disagree.
   */
  const legend = useMemo(() => {
    const symbols = [...new Set(trades.map((trade) => trade.symbol))].sort((left, right) =>
      left.localeCompare(right),
    );
    return symbols.map((symbol, index) => ({
      symbol,
      colour: COPY_SYMBOL_COLOURS[index % COPY_SYMBOL_COLOURS.length],
    }));
  }, [trades]);

  /** The running realised profit and loss, one point per copied fill. */
  const pnlPoints = useMemo(
    () =>
      (performance?.points ?? []).map((point) => ({
        at: point.processedAt,
        value: Number(point.cumulativePnl),
      })),
    [performance],
  );

  /**
   * The open positions, as the engine marked them.
   *
   * `total` is null whenever any held position has no price, because a total
   * that silently omits an unmarkable position is not a total - it is a
   * smaller number wearing a total's label.
   */
  const mark = useMemo(() => {
    const positions = aggregate?.positions ?? [];
    let total = 0;
    let unmarked = 0;

    for (const position of positions) {
      if (position.unrealizedPnl === null) {
        unmarked += 1;
        continue;
      }
      const value = Number(position.unrealizedPnl);
      if (!Number.isFinite(value)) {
        unmarked += 1;
        continue;
      }
      total += value;
    }

    return {
      total: positions.length === 0 || unmarked > 0 ? null : total,
    };
  }, [aggregate]);

  /**
   * The markets this book has actually traded.
   *
   * Both lists come from the ledger, so the candle chart cannot offer a
   * symbol the follower has never filled and never held.
   */
  const tradedSymbols = useMemo(() => {
    const symbols = new Set<string>();
    for (const event of events) symbols.add(event.symbol);
    for (const position of aggregate?.positions ?? []) symbols.add(position.symbol);
    return [...symbols].sort((left, right) => left.localeCompare(right));
  }, [aggregate, events]);

  /**
   * The market the candle chart shows.
   *
   * It defaults to the first market the book traded, and the reader can pick
   * another one after that. The default is derived rather than stored, so the
   * chart never has to be told what to show after a late-arriving event.
   */
  const activitySymbol = activityPick || events[0]?.symbol || aggregate?.positions[0]?.symbol || "";

  /**
   * The copied fills drawn on the candle series, so a fill can be read
   * against the candles it happened in.
   *
   * The marker's time is the expert's own fill time - the market moment the
   * price was struck - and not the moment the copy engine consumed it.
   */
  const activityMarkers = useMemo<ChartMarker[]>(() => {
    if (!activitySymbol) return [];
    const list: ChartMarker[] = [];

    for (const event of events) {
      if (event.symbol !== activitySymbol) continue;
      if (event.status !== "COPIED" || event.fillPrice === null) continue;
      const timeMs = Date.parse(event.expertFilledAt);
      if (Number.isNaN(timeMs)) continue;
      list.push({
        time: Math.floor(timeMs / 1000) as UTCTimestamp,
        side: event.side,
        text: `${event.side} ${num(event.quantity, 6)}`,
      });
    }

    return list;
  }, [activitySymbol, events]);

  /**
   * The symbol picker for the candle chart. The current pick stays in the
   * list even if the book has moved on, so the chart never blanks itself
   * under the reader.
   */
  const activitySymbols = useMemo(() => {
    const symbols = new Set(tradedSymbols);
    if (activitySymbol) symbols.add(activitySymbol);
    return [...symbols].sort((left, right) => left.localeCompare(right));
  }, [activitySymbol, tradedSymbols]);

  /**
   * The candle series behind the Copy-activity chart.
   *
   * It is read for the market the engine traded, at the timeframe the reader
   * picked. A market the feed cannot price is reported as such - an empty
   * chart is honest, a drawn one would not be. The loading flag is raised by
   * the handler that asked for the series, never here, because the handler is
   * the honest place to say the user just asked for something else.
   */
  useEffect(() => {
    if (!activitySymbol) return;
    let active = true;
    getBars(activitySymbol, activityTimeframe, ACTIVITY_BARS_LIMIT)
      .then((result) => {
        if (!active) return;
        setActivityBars(result.items);
        setActivityBarsError(null);
        setActivityBarsStatus("ready");
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setActivityBars([]);
        setActivityBarsError(messageFor(cause));
        setActivityBarsStatus("error");
      });
    return () => {
      active = false;
    };
  }, [activitySymbol, activityTimeframe, activityBarsNonce]);

  /**
   * Re-reads the catalogue, the follows and the aggregate without touching the
   * user's selection or the allocation slider. Called after an action so the
   * cards and table reflect what the backend actually did.
   */
  const refreshData = useCallback(async () => {
    const [strategyPage, followPage, aggregateAccount] = await Promise.all([
      discoverStrategies({ limit: 100 }),
      listCopyFollows({ limit: 100 }),
      getCopyAggregateAccount(),
    ]);
    setStrategies(strategyPage.items);
    setFollows(followPage.items);
    setAggregate(aggregateAccount);
  }, []);

  const selected = useMemo(
    () => strategies.find((strategy) => strategy.id === selectedId) ?? null,
    [strategies, selectedId],
  );
  const selectedFollow = useMemo(
    () => follows.find((follow) => follow.strategyId === selectedId) ?? null,
    [follows, selectedId],
  );

  const chartInstrument = useMemo(
    () => instruments.find((item) => item.symbol === chartSymbol) ?? null,
    [instruments, chartSymbol],
  );

  const followedNow = selectedFollow?.status === "ACTIVE";
  const detailForSelected = accountData?.strategyId === selectedId ? accountData : null;
  const detailLoading = followedNow && detailForSelected === null;

  useEffect(() => {
    if (!selectedId || !followedNow) return;
    let active = true;
    Promise.all([getCopyFollowAccount(selectedId), listCopyOrders(selectedId, { limit: 25 })])
      .then(([followAccount, orderPage]) => {
        if (!active) return;
        setAccountData({
          strategyId: selectedId,
          account: followAccount,
          orders: orderPage.items,
        });
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setAccountData({
          strategyId: selectedId,
          account: { account: null, positions: [], walletUsdt: "0" },
          orders: [],
        });
        setActionError(messageFor(cause));
      });
    return () => {
      active = false;
    };
  }, [selectedId, followedNow, refreshKey]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const [focusedEventId, setFocusedEventId] = useState<string | null>(null);

  /**
   * Tells the trade-buddy which market this page is looking at.
   *
   * The widget reads the pointer and asks the ledger about it, so the answer
   * comes from the server's own records. The page sends no price and no
   * quantity - a pointer is all a page is allowed to say.
   */
  useEffect(() => {
    const detailSymbol = detailForSelected?.account?.positions[0]?.symbol ?? detailForSelected?.orders[0]?.symbol ?? null;
    const potSymbol = accountData?.account.positions[0]?.symbol ?? null;
    const symbol = detailSymbol ?? potSymbol ?? events[0]?.symbol ?? aggregate?.positions[0]?.symbol ?? null;
    const defaultEventId = detailForSelected?.orders[0]?.expertOrderId ?? events[0]?.expertOrderId ?? null;
    const activeFocusId = focusedEventId ? `copy-event:${focusedEventId}` : (defaultEventId ? `copy-event:${defaultEventId}` : null);
    window.PROMETHEUS_PAGE_CONTEXT = { page: "copy-trading", symbol, focusId: activeFocusId };
    return () => {
      delete window.PROMETHEUS_PAGE_CONTEXT;
    };
  }, [accountData, events, aggregate, detailForSelected, focusedEventId]);

  const selectStrategy = (id: string) => {
    setSelectedId(id);
    setDetailTab("overview");
    setActionError(null);
    const follow = follows.find((entry) => entry.strategyId === id);
    setAllocationPct(follow ? pctFromFraction(follow.allocationFraction) : 50);
  };

  const visibleStrategies = useMemo(() => {
    const followedIds = new Set(follows.filter((follow) => follow.status === "ACTIVE").map((follow) => follow.strategyId));
    const needle = query.trim().toLowerCase();
    return strategies
      .filter((strategy) => (tab === "all" ? true : followedIds.has(strategy.id)))
      .filter((strategy) => strategy.name.toLowerCase().includes(needle))
      .sort((left, right) => {
        if (sort === "newest") {
          return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
        }
        return left.name.localeCompare(right.name);
      });
  }, [strategies, follows, tab, query, sort]);

  const activeFollows = follows.filter((follow) => follow.status === "ACTIVE");
  const copiedTotal = follows.reduce((sum, follow) => sum + follow.copiedCount, 0);
  const refusedTotal = follows.reduce((sum, follow) => sum + follow.rejectedCount, 0);

  const refreshAll = async () => {
    setActionError(null);
    try {
      await refreshData();
      await loadActivity();
      setRefreshKey((value) => value + 1);
    } catch (cause) {
      setActionError(messageFor(cause));
    }
  };

  const runAction = async (key: string, action: () => Promise<unknown>, success: string) => {
    setBusy(key);
    setActionError(null);
    try {
      await action();
      await refreshData();
      await loadActivity();
      setToast(success);
      setRefreshKey((value) => value + 1);
    } catch (cause) {
      setActionError(messageFor(cause));
    } finally {
      setBusy(null);
    }
  };

  const openFollowModal = () => {
    setConsent(false);
    setActionError(null);
    setModalOpen(true);
  };

  const confirmFollow = async () => {
    if (!selected) return;
    const fraction = (allocationPct / 100).toString();
    await runAction(
      "follow",
      () => followStrategy({ strategyId: selected.id, allocationFraction: fraction }),
      `Now copying ${selected.name} at ${allocationPct}%.`,
    );
    setModalOpen(false);
  };

  const updateAllocation = async () => {
    if (!selected) return;
    await runAction(
      "allocation",
      () => setCopyAllocation(selected.id, (allocationPct / 100).toString()),
      "Allocation saved. It applies to the next fill.",
    );
  };

  const syncNow = async () => {
    if (!selected) return;
    setBusy("sync");
    setActionError(null);
    try {
      const result = await syncCopyFollow(selected.id);
      await refreshData();
      setToast(
        result.consumed === 0
          ? "No pending expert fills right now."
          : `Consumed ${result.consumed} pending fill${result.consumed === 1 ? "" : "s"}.`,
      );
      setRefreshKey((value) => value + 1);
    } catch (cause) {
      setActionError(messageFor(cause));
    } finally {
      setBusy(null);
    }
  };

  const stopFollowing = async () => {
    if (!selected) return;
    await runAction("unfollow", () => unfollowStrategy(selected.id), "Stopped following. Positions and cash are unchanged.");
  };

  const sendChat = () => {
    const text = chatInput.trim();
    if (!text) return;
    setMessages((current) => [...current, { who: "me", text }]);
    setChatInput("");
    const scripted =
      CHAT_SCRIPT.find((entry) => entry.match.test(text))?.reply ??
      "I can explain allocation, sync, refusals and what the copy pot records. For anything else, the History and Position tabs are the source of truth.";
    window.setTimeout(() => {
      setMessages((current) => [...current, { who: "buddy", text: scripted }]);
    }, 420);
  };

  return (
    <AppShell>
      <style dangerouslySetInnerHTML={{ __html: copyTradingStyles }} />
      <style dangerouslySetInnerHTML={{ __html: COPY_OVERRIDES }} />

      <div className="content cp-page">
        <div className="top">
          <span className="cp-crumb">Copy engine · paper trading</span>
          <button type="button" className="cp-reload" onClick={() => void refreshAll()}>
            <RefreshCw size={14} />
            Reload
          </button>
        </div>

        <h1>Copy trading</h1>
        <p className="mute" style={{ maxWidth: 720 }}>
          Pick a public strategy and choose the share of each expert fill to mirror. The engine records every
          copied fill and every refusal with its reason. It does not show ROI, drawdown or win rate — the
          platform does not measure them.
        </p>

        {status === "error" && (
          <div className="cp-error">
            <AlertTriangle size={16} />
            <span>{error}</span>
          </div>
        )}

        <section className="kpi-wrap" aria-label="Your copy book">
          <div className="kpi-head">
            <div className="kpi-heading">
              Copy-book snapshot <span className="kpi-live"><i />SIMULATED</span>
            </div>
            <span className="kpi-note">Separate pots · never Module 03 money</span>
          </div>
          <div className="kpi">
            <div className="kpi-card">
              <div className="kpi-label">
                <span className="kpi-icon" aria-hidden="true">$</span>
                <small>Copy cash</small>
              </div>
              <b className="mono">{aggregate ? num(aggregate.cash) : "—"}</b>
              <span className="kpi-sub">
                {aggregate ? `${aggregate.followCount} separate pot${aggregate.followCount === 1 ? "" : "s"}` : "loading"}
              </span>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">
                <span className="kpi-icon" aria-hidden="true">±</span>
                <small>Realized P&amp;L</small>
              </div>
              <b className="mono">{aggregate ? num(aggregate.realizedPnl) : "—"}</b>
              <span className="kpi-sub">Simulated copies only</span>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">
                <span className="kpi-icon" aria-hidden="true">↗</span>
                <small>Active follows</small>
              </div>
              <b className="mono">{activeFollows.length}</b>
              <span className="kpi-sub">
                {follows.length - activeFollows.length} stopped · {strategies.length} public strategies
              </span>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">
                <span className="kpi-icon" aria-hidden="true">◎</span>
                <small>Positions</small>
              </div>
              <b className="mono">{aggregate ? aggregate.positions.length : "—"}</b>
              <span className="kpi-sub">
                {aggregate && aggregate.positions.length > 0
                  ? aggregate.positions
                      .map((position) => `${position.symbol} ${position.direction}`)
                      .join(" · ")
                  : "No open copy positions"}
              </span>
            </div>
          </div>

          {/*
            THE WALLET IS A GATE, NOT A DEBIT. The balance shown here is the
            follower's real USDT, and the server refuses a copy whose notional
            it does not cover. The copy pots are simulated, so they never spend
            this money - it only has to be there.
          */}
          <div className="cp-wallet-strip">
            <ShieldCheck size={15} aria-hidden="true" />
            <span className="cp-wallet-amount">
              <small>Wallet USDT (real)</small>
              <b className="mono">{aggregate ? num(aggregate.walletUsdt) : "—"}</b>
            </span>
            <span className="cp-wallet-note">
              A gate, not a debit. The copy pots are simulated and never spend this balance — a copy whose
              notional it cannot cover is refused, and the refusal is recorded with its reason.
            </span>
          </div>
        </section>

        <section className="activity" aria-label="Copy activity">
          <div className="hh">
            <div>
              <h2>Copy activity</h2>
              <p>
                Every fill the engine consumed, across every strategy you follow: what was copied, what was
                refused, and what it did to your copy book.
              </p>
            </div>
            <button type="button" className="go" onClick={() => void refreshAll()}>
              <RefreshCw size={14} /> Refresh
            </button>
          </div>

          {activityError && (
            <div className="cp-error" style={{ marginTop: 16 }}>
              <AlertTriangle size={16} />
              <span>{activityError}</span>
            </div>
          )}

          <div className="activity-grid">
            <div className="activity-panel">
              <div className="activity-panel-head">
                <b>Expert trades</b>
                <span>Price each expert fill executed at</span>
              </div>
              {trades.length === 0 ? (
                <div className="activity-empty">
                  No fills have been copied yet.
                  <br />
                  The chart appears once the engine consumes its first expert fill.
                </div>
              ) : (
                <ExpertTradesChart trades={trades} height={280} />
              )}
              <div className="activity-marks">
                <b>▲ LONG</b> · <b className="sell">▼ SHORT</b> — one marker per copied fill, at the price it
                executed at.
              </div>
              <div className="activity-legend">
                {legend.map((entry) => (
                  <span key={entry.symbol}>
                    <i style={{ background: entry.colour }} />
                    {entry.symbol}
                  </span>
                ))}
              </div>
            </div>

            <div className="activity-panel">
              <div className="activity-panel-head">
                <b>Realized P&amp;L</b>
                <span>Running total across every follow</span>
              </div>
              {pnlPoints.length === 0 ? (
                <div className="activity-empty">
                  No realized profit or loss yet.
                  <br />
                  A LONG moves cash into a position and realises nothing; the line moves when a fill reduces a
                  position.
                </div>
              ) : (
                <CopyPnlChart points={pnlPoints} height={220} />
              )}
              <div className="activity-marks">
                {performance ? (
                  <>
                    Realized {num(performance.realizedPnl)} · {performance.copiedCount} copied ·{" "}
                    {performance.rejectedCount} refused
                    {" · "}
                    {mark.total === null
                      ? "the positions the feed cannot price are not marked"
                      : `open positions marked by the engine: ${mark.total.toLocaleString("en-US", { maximumFractionDigits: 2 })}`}
                  </>
                ) : null}
              </div>
            </div>
          </div>

          {/*
            THE CANDLES AND THE BOOK, SIDE BY SIDE. The tape above is a list
            of prices; the chart is the market those prices were struck in,
            and the table is what the fills did to the positions they opened.
          */}
          <div className="cp-book-grid">
            <div className="activity-panel">
              <div className="activity-panel-head">
                <b>Price action</b>
                <span>Candles for the market your fills executed in</span>
              </div>

              <div className="cp-chart-head">
                <label className="cp-chart-pick">
                  <small>Market</small>
                  <select
                    aria-label="Market to chart"
                    value={activitySymbol}
                    disabled={activitySymbols.length === 0}
                    onChange={(event) => {
                      setActivityBarsStatus("loading");
                      setActivityPick(event.target.value);
                    }}
                  >
                    {activitySymbols.map((symbol) => (
                      <option key={symbol} value={symbol}>
                        {symbol}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="cp-chart-tf" role="group" aria-label="Timeframe">
                  {TIMEFRAMES.map((frame) => (
                    <button
                      key={frame}
                      type="button"
                      aria-pressed={activityTimeframe === frame}
                      className={activityTimeframe === frame ? "on" : ""}
                      onClick={() => {
                        setActivityBarsStatus("loading");
                        setActivityTimeframe(frame);
                      }}
                    >
                      {frame}
                    </button>
                  ))}
                </div>
              </div>

              {activitySymbols.length === 0 ? (
                <div className="activity-empty">
                  No market has been traded yet.
                  <br />
                  The candles appear once the engine consumes its first expert fill.
                </div>
              ) : activityBarsStatus === "error" ? (
                <div className="cp-chart-msg">
                  <AlertTriangle size={16} />
                  <b>The candle series could not be loaded</b>
                  <span>{activityBarsError}</span>
                  <button type="button" className="cp-chart-retry" onClick={retryActivityBars}>
                    <RefreshCw size={12} /> Retry
                  </button>
                </div>
              ) : activityBarsStatus === "loading" ? (
                <div className="cp-chart-msg">
                  <Loader2 size={16} className="cp-spin" />
                  <span>
                    Loading {activitySymbol} · {activityTimeframe}…
                  </span>
                </div>
              ) : activityBars.length === 0 ? (
                <div className="cp-chart-msg">
                  <b>No candles for this window</b>
                  <span>
                    The provider returned no {activityTimeframe} bars for {activitySymbol}. Nothing is drawn
                    rather than inventing a series.
                  </span>
                </div>
              ) : (
                <div className="cp-chart-frame">
                  <Chart bars={activityBars} markers={activityMarkers} height={300} />
                </div>
              )}

              <div className="cp-chart-meta">
                <span>
                  {activityBars.length} bars · {activityTimeframe} · {activitySymbol} ·{" "}
                  {activityMarkers.length} filled marker{activityMarkers.length === 1 ? "" : "s"}
                </span>
                <button
                  type="button"
                  className="cp-chart-reload"
                  disabled={activityBarsStatus === "loading"}
                  onClick={retryActivityBars}
                >
                  <RefreshCw size={11} className={activityBarsStatus === "loading" ? "cp-spin" : ""} />
                  Refresh
                </button>
              </div>
            </div>

            <div className="activity-panel">
              <div className="activity-panel-head">
                <b>Open copy positions</b>
                <span>Marked by the engine at the latest price</span>
              </div>
              {(aggregate?.positions.length ?? 0) === 0 ? (
                <div className="activity-empty">
                  No open positions.
                  <br />
                  Every copied fill so far has been closed by a later one.
                </div>
              ) : (
                <>
                  <div className="tw">
                    <table>
                      <thead>
                        <tr>
                          <th>Market</th>
                          <th>Side</th>
                          <th className="r">Quantity</th>
                          <th className="r">Avg entry</th>
                          <th className="r">Mark</th>
                          <th className="r">Value</th>
                          <th className="r">Unrealised</th>
                        </tr>
                      </thead>
                      <tbody>
                        {aggregate?.positions.map((position) => (
                          <tr
                            key={`${position.symbol}-${position.direction}`}
                            data-ai-id={`copy-position:${position.symbol}:${position.direction}`}
                          >
                            <td style={{ fontWeight: 700 }}>{position.symbol}</td>
                            <td style={{ color: position.direction === "LONG" ? "var(--gain)" : "var(--loss)" }}>
                              {position.direction}
                            </td>
                            <td className="r mono">{num(position.quantity, 8)}</td>
                            <td className="r mono">{num(position.averageEntryPrice, 8)}</td>
                            <td className="r mono">
                              {position.markPrice === null ? "—" : num(position.markPrice, 4)}
                            </td>
                            <td className="r mono">
                              {position.marketValue === null ? "—" : num(position.marketValue, 2)}
                            </td>
                            <td className="r mono" style={{ color: pnlTone(position.unrealizedPnl) }}>
                              {position.unrealizedPnl === null ? "—" : num(position.unrealizedPnl, 2)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {aggregate?.positions.some((position) => position.stale) && (
                    <p className="cp-fine">
                      A row marked with a stale price was valued with the last price the feed produced - the
                      engine could not get a fresh one.
                    </p>
                  )}
                  <div className="activity-marks">
                    {mark.total === null
                      ? "the positions the feed cannot price are not marked"
                      : `Open positions marked by the engine: ${mark.total.toLocaleString("en-US", { maximumFractionDigits: 2 })}`}
                  </div>
                </>
              )}
            </div>
          </div>

          <div className="ht">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Strategy</th>
                  <th>Market</th>
                  <th>Side</th>
                  <th className="r">Expert qty</th>
                  <th className="r">Copied qty</th>
                  <th className="r">Price</th>
                  <th className="r">Gross</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {events.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="mute" style={{ padding: "18px 10px" }}>
                      Nothing has been copied or refused yet.
                    </td>
                  </tr>
                ) : (
                  events.map((event) => {
                    const isFocused = focusedEventId === event.expertOrderId;
                    return (
                      <tr
                        key={`${event.strategyId}-${event.expertOrderId}`}
                        data-ai-id={`copy-event:${event.expertOrderId}`}
                        onClick={() => setFocusedEventId(event.expertOrderId)}
                        className={isFocused ? "cp-row-focused" : undefined}
                        style={{ cursor: "pointer" }}
                        title="Click to focus Pyrus on this trade"
                      >
                        <td>{shortDate(event.processedAt)}</td>
                        <td className="activity-strategy">{event.strategyName}</td>
                        <td style={{ fontWeight: 700 }}>{event.symbol}</td>
                        <td style={{ color: event.side === "LONG" ? "var(--gain)" : "var(--loss)" }}>
                          {event.side}
                        </td>
                        <td className="r mono">{num(event.expertQuantity, 8)}</td>
                        <td className="r mono">
                          {event.status === "COPIED" ? num(event.quantity, 8) : "—"}
                        </td>
                        <td className="r mono">
                          {event.status === "COPIED" ? num(event.fillPrice, 4) : "—"}
                        </td>
                        <td className="r mono">
                          {event.status === "COPIED" ? num(event.gross, 2) : "—"}
                        </td>
                        <td style={{ color: event.status === "COPIED" ? "var(--gain)" : "var(--amber)" }}>
                          {event.status === "COPIED"
                            ? "Copied"
                            : ELIGIBILITY_LABEL[event.rejectReason ?? "STRATEGY_NOT_ELIGIBLE"]}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
          <p className="note">
            Copy pots are simulated and separate from ledger money. Realized P&amp;L is the ledger&rsquo;s own
            figure, replayed from the fills the engine consumed — it is not a rate of return, and no page on
            this platform measures one.
          </p>
        </section>

        <div className="main" style={{ marginTop: 30 }}>
          <section>
            <h2>Public strategies</h2>
            <div className="tabs" role="tablist">
              <button
                type="button"
                className={tab === "all" ? "on" : ""}
                onClick={() => setTab("all")}
                role="tab"
                aria-selected={tab === "all"}
              >
                All strategies
              </button>
              <button
                type="button"
                className={tab === "following" ? "on" : ""}
                onClick={() => setTab("following")}
                role="tab"
                aria-selected={tab === "following"}
              >
                Following ({activeFollows.length})
              </button>
            </div>

            <div className="tools">
              <div className="strategy-search">
                <span className="strategy-search-button" aria-hidden="true">
                  <Search size={16} />
                </span>
                <input
                  type="search"
                  id="q"
                  placeholder="Search by strategy name…"
                  aria-label="Search strategies by name"
                  autoComplete="off"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
              <select aria-label="Sort" value={sort} onChange={(event) => setSort(event.target.value as "name" | "newest")}>
                <option value="name">Name A–Z</option>
                <option value="newest">Newest first</option>
              </select>
            </div>

            {status === "loading" && (
              <div className="cp-skeletons" aria-busy="true">
                {Array.from({ length: 4 }).map((_, index) => (
                  <div key={index} className="cp-skeleton" />
                ))}
              </div>
            )}

            {status === "ready" && visibleStrategies.length === 0 && (
              <p className="mute" style={{ padding: "20px 0" }}>
                {tab === "following"
                  ? "You are not following any strategy yet. Pick one from All strategies."
                  : "No public strategies match that name."}
              </p>
            )}

            {visibleStrategies.map((strategy) => {
              const follow = follows.find((entry) => entry.strategyId === strategy.id);
              const active = follow?.status === "ACTIVE";
              const share = follow ? pctFromFraction(follow.allocationFraction) : 0;
              return (
                <div
                  key={strategy.id}
                  className={`card ${selectedId === strategy.id ? "sel" : ""}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => selectStrategy(strategy.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      selectStrategy(strategy.id);
                    }
                  }}
                >
                  <div className="ava" style={{ background: avatarTone(strategy.name) }}>
                    {strategy.name.slice(0, 1).toUpperCase()}
                  </div>
                  <div>
                    <h3>{strategy.name}</h3>
                    <p>{strategy.description ?? "No description was given for this strategy."}</p>
                    <div className="met">
                      <span>
                        <small>Allocation</small>
                        <b>{follow ? `${share}%` : "—"}</b>
                      </span>
                      <span>
                        <small>Copied</small>
                        <b className="gain">{follow ? follow.copiedCount : 0}</b>
                      </span>
                      <span>
                        <small>Refused</small>
                        <b style={{ color: "var(--amber)" }}>{follow ? follow.rejectedCount : 0}</b>
                      </span>
                    </div>
                    <div className="badges">
                      {active ? (
                        <span className="b fol">
                          <i className="live" />
                          Copying at {share}%
                        </span>
                      ) : (
                        <span className="b">{follow ? "Stopped" : "Not following"}</span>
                      )}
                      <span className="b">Updated {shortDate(strategy.updatedAt)}</span>
                    </div>
                  </div>
                  <div>
                    <div className="ring" style={{ "--m": follow ? share : 0, "--c": "var(--ember)" } as React.CSSProperties}>
                      <span>{follow ? `${share}%` : "—"}</span>
                    </div>
                    <div className="ringl">alloc</div>
                  </div>
                </div>
              );
            })}
          </section>

          <aside className={`detail ${selected ? "detail-reveal" : ""}`} aria-live="polite">
            {!selected ? (
              <div style={{ padding: 28 }}>
                <h2>Select a strategy</h2>
                <p className="mute" style={{ marginTop: 8 }}>
                  Pick a card to see its allocation control, copy pot and fill history.
                </p>
              </div>
            ) : (
              <>
                <div className="dh">
                  <div
                    className="ava"
                    style={{ width: 52, height: 52, background: avatarTone(selected.name) }}
                  >
                    {selected.name.slice(0, 1).toUpperCase()}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <h2>{selected.name}</h2>
                    <span className="mute" style={{ fontSize: 13 }}>
                      {selected.description ?? "Public strategy"}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="cp-connect-expert-btn"
                    onClick={() => setExpertChatOpen(true)}
                    title="Connect and chat directly with this expert trader (10 EMBER)"
                  >
                    <Flame size={14} className="cp-flame-icon" />
                    <span>Chat with Expert</span>
                    <span className="cp-ember-chip">10 EMBER</span>
                  </button>
                </div>

                <div className="dtabs" role="tablist">
                  {(
                    [
                      ["overview", "Overview"],
                      ["position", "Copy pot"],
                      ["history", "History"],
                      ["chart", "Chart"],
                    ] as Array<[DetailTab, string]>
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      role="tab"
                      aria-selected={detailTab === key}
                      className={detailTab === key ? "on" : ""}
                      onClick={() => {
                        setDetailTab(key);
                        // The bars effect refires on every activation, so the
                        // pane says "loading" here rather than showing the
                        // previous series as if it were the new one.
                        if (key === "chart") setBarsStatus("loading");
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                <div className="pane">
                  {actionError && (
                    <div className="cp-error" style={{ marginBottom: 14 }}>
                      <AlertTriangle size={15} />
                      <span>{actionError}</span>
                    </div>
                  )}

                  {detailTab === "overview" && (
                    <>
                      <div className="facts">
                        <div>
                          <small>Status</small>
                          <b style={{ color: followedNow ? "var(--gain)" : "var(--mute)" }}>
                            {followedNow ? "ACTIVE" : selectedFollow ? "STOPPED" : "—"}
                          </b>
                        </div>
                        <div>
                          <small>Followed</small>
                          <b>{selectedFollow ? shortDate(selectedFollow.followedAt) : "—"}</b>
                        </div>
                        <div>
                          <small>Copied</small>
                          <b>{selectedFollow ? selectedFollow.copiedCount : 0}</b>
                        </div>
                        <div>
                          <small>Refused</small>
                          <b>{selectedFollow ? selectedFollow.rejectedCount : 0}</b>
                        </div>
                      </div>

                      <div className="cp-note">
                        <ShieldCheck size={16} />
                        <div>
                          <b>Eligibility right now</b>
                          <p>
                            {selectedFollow
                              ? ELIGIBILITY_LABEL[selectedFollow.eligibility]
                              : "Follow this strategy to make it eligible for the next expert fill."}
                          </p>
                          {selectedFollow?.lastProcessedAt && (
                            <p className="cp-fine">
                              Last processed {new Date(selectedFollow.lastProcessedAt).toLocaleString()}
                            </p>
                          )}
                        </div>
                      </div>

                      <p className="cp-copy">
                        A follow copies the expert&apos;s committed paper fills at your allocation. Your pot starts
                        empty and is provisioned on the first eligible fill, so &quot;no pot yet&quot; never looks
                        like a spent balance. A LONG spends cash to open or add to a long position; a SHORT
                        brings the notional in and opens or adds to a short.
                      </p>
                    </>
                  )}

                  {detailTab === "position" && (
                    <>
                      {!followedNow ? (
                        <p className="cp-copy">
                          No copy pot is open. Follow the strategy to start mirroring fills; the pot appears after
                          the first eligible one.
                        </p>
                      ) : detailLoading ? (
                        <div className="cp-inline-loading">
                          <Loader2 size={16} className="cp-spin" /> Reading the copy pot…
                        </div>
                      ) : !detailForSelected?.account.account ? (
                        <p className="cp-copy">
                          The pot has not been provisioned yet. It is created on the first eligible fill — not at
                          follow time, and not with a made-up starting balance.
                        </p>
                      ) : (
                        <>
                          <div className="facts">
                            <div>
                              <small>Cash</small>
                              <b>{num(detailForSelected.account.account.cash)}</b>
                            </div>
                            <div>
                              <small>Realized</small>
                              <b
                                className={
                                  Number(detailForSelected.account.account.realizedPnl) >= 0 ? "gain" : "loss"
                                }
                              >
                                {num(detailForSelected.account.account.realizedPnl)}
                              </b>
                            </div>
                            <div>
                              <small>Opened</small>
                              <b>{shortDate(detailForSelected.account.account.openedAt)}</b>
                            </div>
                            <div>
                              <small>Positions</small>
                              <b>{detailForSelected.account.positions.length}</b>
                            </div>
                          </div>
                          {detailForSelected.account.positions.length === 0 ? (
                            <p className="cp-copy">No open positions in this pot.</p>
                          ) : (
                            <div className="tw">
                              <table>
                                <thead>
                                  <tr>
                                    <th>Market</th>
                                    <th>Side</th>
                                    <th className="r">Quantity</th>
                                    <th className="r">Avg entry</th>
                                    <th className="r">Mark</th>
                                    <th className="r">Value</th>
                                    <th className="r">Unrealised</th>
                                    <th>Last activity</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {detailForSelected.account.positions.map((position) => (
                                    <tr
                                      key={position.symbol}
                                      data-ai-id={`copy-position:${position.symbol}:${position.direction}`}
                                    >
                                      <td style={{ fontWeight: 700 }}>{position.symbol}</td>
                                      <td style={{ color: position.direction === "LONG" ? "var(--gain)" : "var(--loss)" }}>
                                        {position.direction}
                                      </td>
                                      <td className="r mono">{num(position.quantity, 8)}</td>
                                      <td className="r mono">{num(position.averageEntryPrice, 8)}</td>
                                      <td className="r mono">
                                        {position.markPrice === null ? "—" : num(position.markPrice, 4)}
                                      </td>
                                      <td className="r mono">
                                        {position.marketValue === null ? "—" : num(position.marketValue, 2)}
                                      </td>
                                      <td className="r mono" style={{ color: pnlTone(position.unrealizedPnl) }}>
                                        {position.unrealizedPnl === null ? "—" : num(position.unrealizedPnl, 2)}
                                      </td>
                                      <td>{shortDate(position.lastActivityAt)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                          <p className="cp-fine" style={{ marginTop: 12 }}>
                            Wallet USDT (real): {num(detailForSelected.account.walletUsdt)} — a gate, not a debit.
                            The pot is simulated and never spends it; a copy this balance cannot cover is
                            refused.
                          </p>
                        </>
                      )}
                    </>
                  )}

                  {detailTab === "history" && (
                    <>
                      {!followedNow ? (
                        <p className="cp-copy">Follow the strategy to start building a fill history.</p>
                      ) : detailLoading ? (
                        <div className="cp-inline-loading">
                          <Loader2 size={16} className="cp-spin" /> Reading fill history…
                        </div>
                      ) : (detailForSelected?.orders.length ?? 0) === 0 ? (
                        <div className="cp-empty-history">
                          <p className="cp-copy" style={{ marginTop: 0 }}>
                            No fills consumed yet. Use <b>Sync now</b> to run the engine once against any pending
                            expert fills.
                          </p>
                        </div>
                      ) : (
                        <div className="tw">
                          <table>
                            <thead>
                              <tr>
                                <th>Processed</th>
                                <th>Market</th>
                                <th>Side</th>
                                <th className="r">Expert qty</th>
                                <th className="r">Copied qty</th>
                                <th>Result</th>
                              </tr>
                            </thead>
                            <tbody>
                              {detailForSelected?.orders.map((order) => {
                                const isFocused = focusedEventId === order.expertOrderId;
                                return (
                                  <tr
                                    key={`${order.expertOrderId}-${order.processedAt}`}
                                    data-ai-id={`copy-event:${order.expertOrderId}`}
                                    onClick={() => setFocusedEventId(order.expertOrderId)}
                                    className={isFocused ? "cp-row-focused" : undefined}
                                    style={{ cursor: "pointer" }}
                                    title="Click to focus Pyrus on this trade"
                                  >
                                    <td>{shortDate(order.processedAt)}</td>
                                    <td style={{ fontWeight: 700 }}>{order.symbol}</td>
                                    <td style={{ color: order.side === "LONG" ? "var(--gain)" : "var(--loss)" }}>
                                      {order.side}
                                    </td>
                                    <td className="r mono">{num(order.expertQuantity, 8)}</td>
                                    <td className="r mono">{order.status === "COPIED" ? num(order.quantity, 8) : "—"}</td>
                                    <td style={{ color: order.status === "COPIED" ? "var(--gain)" : "var(--amber)" }}>
                                      {order.status === "COPIED"
                                        ? "Copied"
                                        : ELIGIBILITY_LABEL[order.rejectReason ?? "STRATEGY_NOT_ELIGIBLE"]}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </>
                  )}

                  {detailTab === "chart" && (
                    <>
                      <div className="cp-chart-head">
                        <label className="cp-chart-pick">
                          <small>Instrument</small>
                          <select
                            aria-label="Instrument"
                            value={chartSymbol}
                            disabled={instruments.length === 0}
                            onChange={(event) => {
                              setBarsStatus("loading");
                              setChartSymbol(event.target.value);
                            }}
                          >
                            {instruments.map((item) => (
                              <option key={item.symbol} value={item.symbol}>
                                {item.symbol} — {item.name}
                              </option>
                            ))}
                          </select>
                        </label>

                        <div className="cp-chart-tf" role="group" aria-label="Timeframe">
                          {TIMEFRAMES.map((frame) => (
                            <button
                              key={frame}
                              type="button"
                              aria-pressed={chartTimeframe === frame}
                              className={chartTimeframe === frame ? "on" : ""}
                              onClick={() => {
                                setBarsStatus("loading");
                                setChartTimeframe(frame);
                              }}
                            >
                              {frame}
                            </button>
                          ))}
                        </div>
                      </div>

                      {instrumentsError ? (
                        <div className="cp-chart-msg">
                          <AlertTriangle size={16} />
                          <b>The instrument catalogue could not be loaded</b>
                          <span>{instrumentsError}</span>
                          <button type="button" className="cp-chart-retry" onClick={retryInstruments}>
                            <RefreshCw size={12} /> Retry
                          </button>
                        </div>
                      ) : instrumentsLoading && instruments.length === 0 ? (
                        <div className="cp-chart-msg">
                          <Loader2 size={16} className="cp-spin" />
                          <span>Loading the instrument catalogue…</span>
                        </div>
                      ) : barsStatus === "error" ? (
                        <div className="cp-chart-msg">
                          <AlertTriangle size={16} />
                          <b>The candle series could not be loaded</b>
                          <span>{barsError}</span>
                          <button type="button" className="cp-chart-retry" onClick={retryBars}>
                            <RefreshCw size={12} /> Retry
                          </button>
                        </div>
                      ) : barsStatus === "loading" ? (
                        <div className="cp-chart-msg">
                          <Loader2 size={16} className="cp-spin" />
                          <span>
                            Loading {chartSymbol || "…"} · {chartTimeframe}…
                          </span>
                        </div>
                      ) : bars.length === 0 ? (
                        <div className="cp-chart-msg">
                          <b>No candles for this window</b>
                          <span>
                            The provider returned no {chartTimeframe} bars for {chartSymbol}. Nothing is
                            drawn rather than inventing a series.
                          </span>
                        </div>
                      ) : (
                        <div className="cp-chart-frame">
                          <Chart bars={bars} height={300} />
                        </div>
                      )}

                      <div className="cp-chart-meta">
                        <span>
                          {bars.length} bars · {chartTimeframe}
                          {chartInstrument ? ` · ${chartInstrument.kind} · ${chartInstrument.venue}` : ""}
                        </span>
                        <button
                          type="button"
                          className="cp-chart-reload"
                          disabled={barsStatus === "loading"}
                          onClick={retryBars}
                        >
                          <RefreshCw size={11} className={barsStatus === "loading" ? "cp-spin" : ""} />
                          Refresh
                        </button>
                      </div>
                    </>
                  )}
                </div>

                <div className="foot">
                  <div className="r">
                    <span>{followedNow ? "Current allocation" : "Allocation to copy"}</span>
                    <b className="mono">{allocationPct}%</b>
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={100}
                    step={1}
                    value={allocationPct}
                    aria-label="Share of each expert fill to mirror"
                    onChange={(event) => setAllocationPct(Number(event.target.value))}
                  />
                  <p className="cp-fine" style={{ marginTop: 6 }}>
                    {allocationPct}% of every expert fill, in a separate simulated pot.
                  </p>

                  {followedNow ? (
                    <div className="da">
                      <button
                        type="button"
                        className="go"
                        disabled={busy !== null || allocationPct === pctFromFraction(selectedFollow?.allocationFraction ?? "0.01")}
                        onClick={() => void updateAllocation()}
                      >
                        {busy === "allocation" ? <Loader2 size={15} className="cp-spin" /> : null}
                        Update allocation
                      </button>
                      <div className="cp-foot-row">
                        <button type="button" className="go stop" onClick={() => void stopFollowing()} disabled={busy !== null}>
                          {busy === "unfollow" ? <Loader2 size={15} className="cp-spin" /> : null}
                          Stop following
                        </button>
                        <button type="button" className="cp-sync" onClick={() => void syncNow()} disabled={busy !== null}>
                          {busy === "sync" ? <Loader2 size={15} className="cp-spin" /> : <RefreshCw size={14} />}
                          Sync now
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="da">
                      <button type="button" className="go" onClick={openFollowModal} disabled={busy !== null}>
                        {busy === "follow" ? <Loader2 size={15} className="cp-spin" /> : null}
                        Review and copy
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}
          </aside>
        </div>

        <section className="history" aria-labelledby="follows-table">
          <div className="hh">
            <div>
              <h2 id="follows-table">Your copy follows</h2>
              <p>Every follow, read from the copy service. No closed-trade feed is simulated on this page.</p>
            </div>
            <button type="button" className="go" onClick={() => void refreshAll()}>
              <RefreshCw size={14} /> Refresh
            </button>
          </div>
          <div className="hs">
            <div className="st">
              <small>Follows</small>
              <b>{follows.length}</b>
            </div>
            <div className="st">
              <small>Copied fills</small>
              <b className="gain">{copiedTotal}</b>
            </div>
            <div className="st">
              <small>Refused fills</small>
              <b style={{ color: "var(--amber)" }}>{refusedTotal}</b>
            </div>
          </div>
          <div className="ht">
            <table>
              <thead>
                <tr>
                  <th>Strategy</th>
                  <th>Status</th>
                  <th className="r">Allocation</th>
                  <th className="r">Copied</th>
                  <th className="r">Refused</th>
                  <th>Eligibility</th>
                </tr>
              </thead>
              <tbody>
                {follows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="mute" style={{ padding: "18px 10px" }}>
                      You are not following any strategy yet.
                    </td>
                  </tr>
                ) : (
                  follows.map((follow) => (
                    <tr
                      key={follow.strategyId}
                      onClick={() => selectStrategy(follow.strategyId)}
                      style={{ cursor: "pointer" }}
                    >
                      <td style={{ fontWeight: 700 }}>{follow.strategyName}</td>
                      <td>
                        <span style={{ color: follow.status === "ACTIVE" ? "var(--gain)" : "var(--mute)" }}>
                          {follow.status}
                        </span>
                        {follow.status === "ACTIVE" && follow.hasPendingEvents ? (
                          <span className="pending-tag">Not yet copied</span>
                        ) : null}
                      </td>
                      <td className="r mono">{pctFromFraction(follow.allocationFraction)}%</td>
                      <td className="r mono">{follow.copiedCount}</td>
                      <td className="r mono">{follow.rejectedCount}</td>
                      <td>{ELIGIBILITY_LABEL[follow.eligibility]}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <p className="note">
            Copy pots are simulated and separate from ledger money. Allocation changes apply to the next fill
            only; stopping a follow never liquidates cash or positions.
          </p>
        </section>
      </div>

      {modalOpen && selected && (
        <div className="modal">
          <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="copy-review-title">
            <h3 id="copy-review-title">Review before you copy</h3>
            <div className="row">
              <span className="mute">Strategy</span>
              <b>{selected.name}</b>
            </div>
            <div className="row">
              <span className="mute">Allocation</span>
              <b>{allocationPct}% of each expert fill</b>
            </div>
            <div className="row">
              <span className="mute">Cash pot</span>
              <b>provisioned on first eligible fill</b>
            </div>
            <div className="row">
              <span className="mute">Execution</span>
              <b>simulated · no external venue</b>
            </div>
            <label className="ck">
              <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
              <span>
                I understand this is paper trading, past behaviour is not a promise, and the copy pot is separate
                from my wallet balance.
              </span>
            </label>
            <div className="mact">
              <button type="button" onClick={() => setModalOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="go"
                disabled={!consent || busy !== null}
                onClick={() => void confirmFollow()}
              >
                {busy === "follow" ? <Loader2 size={15} className="cp-spin" /> : null}
                Confirm and copy
              </button>
            </div>
          </div>
        </div>
      )}

      {selected && (
        <ExpertChatModal
          strategyId={selected.id}
          strategyName={selected.name}
          isOpen={expertChatOpen}
          onClose={() => setExpertChatOpen(false)}
        />
      )}

      <button
        type="button"
        className="cfab"
        aria-label="Open Trading Buddy chat"
        aria-expanded={chatOpen}
        onClick={() => setChatOpen((open) => !open)}
      >
        {chatOpen ? <X size={22} /> : <MessageSquare size={22} />}
      </button>

      <section className={`cchat ${chatOpen ? "on" : ""}`} aria-label="Trading Buddy chat" hidden={!chatOpen}>
        <header className="cch">
          <span className="av" aria-hidden="true">
            <ShieldCheck size={16} />
          </span>
          <div className="ti">
            <b>Trading Buddy</b>
            <small>Scripted assistant · not AI</small>
          </div>
          <button type="button" onClick={() => setChatOpen(false)} aria-label="Close chat">
            ×
          </button>
        </header>
        <div className="cbody" role="log" aria-live="polite">
          {messages.map((message, index) => (
            <div key={`${message.who}-${index}`} className={`msg ${message.who}`}>
              {message.text}
            </div>
          ))}
        </div>
        <div className="cchips">
          {["How does allocation work?", "Why was a fill skipped?", "Can I see ROI?"].map((chip) => (
            <button key={chip} type="button" onClick={() => setChatInput(chip)}>
              {chip}
            </button>
          ))}
        </div>
        <form
          className="cin"
          onSubmit={(event) => {
            event.preventDefault();
            sendChat();
          }}
        >
          <input
            type="text"
            placeholder="Ask about allocation, sync or refusals…"
            aria-label="Message Trading Buddy"
            autoComplete="off"
            value={chatInput}
            onChange={(event) => setChatInput(event.target.value)}
          />
          <button type="submit" aria-label="Send message">
            <Send size={16} />
          </button>
        </form>
      </section>

      <div className={`toast ${toast ? "on" : ""}`} role="status">
        {toast}
      </div>
    </AppShell>
  );
}

/**
 * Page-local corrections: a top bar that fits inside the application shell,
 * the app's own type scale, and compact table/status helpers the reference
 * did not need because its numbers were generated in the browser.
 */
const COPY_OVERRIDES = `
.cp-page {
  min-height: 100%;
  background: var(--bg);
  color: var(--ink);
  padding: 0 34px 70px;
}
.cp-page .top { justify-content: space-between; }
.cp-crumb { color: var(--dim); font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.cp-reload, .cp-sync {
  display: inline-flex; align-items: center; gap: 7px;
  background: transparent; border: 1px solid var(--line); border-radius: 10px;
  color: var(--mute); font: inherit; font-size: 12px; font-weight: 600;
  padding: 7px 11px; cursor: pointer;
}
.cp-reload:hover, .cp-sync:hover { color: var(--ink); border-color: var(--line-light); }
.cp-page h1 { margin: 22px 0 6px; font-size: 28px; font-weight: 700; letter-spacing: -.025em; }
.cp-page h2 { font-size: 17px; font-weight: 600; letter-spacing: -.015em; margin-bottom: 12px; }
.cp-page .kpi-note { color: var(--dim); font-size: 10px; font-weight: 700; letter-spacing: .06em; }
.cp-error {
  display: flex; align-items: flex-start; gap: 9px;
  border: 1px solid rgba(255,77,77,.35); background: var(--loss-soft);
  color: #ffb3b3; border-radius: 12px; padding: 11px 13px; font-size: 12.5px; margin: 16px 0;
}
.cp-page .card { width: 100%; text-align: left; color: inherit; font: inherit; }
.cp-page .met b.gain { color: var(--gain); }
.cp-page .facts b { overflow-wrap: anywhere; }
.cp-page .detail h2 { margin: 0; font-size: 19px; font-weight: 700; letter-spacing: -.02em; }
.cp-page .dtabs { margin-top: 18px; }
.cp-page .pane { padding-bottom: 16px; }
.cp-note {
  display: flex; gap: 10px; align-items: flex-start;
  border: 1px solid var(--line); border-left: 2px solid var(--ember);
  background: var(--soft); border-radius: 0 12px 12px 0; padding: 13px 15px; margin-bottom: 16px;
  color: var(--mute); font-size: 12px;
}
.cp-note svg { color: var(--ember); flex: none; margin-top: 2px; }
.cp-note b { display: block; color: var(--ink); font-size: 12.5px; margin-bottom: 2px; }
.cp-note p { margin: 0; }
.cp-fine { color: var(--dim); font-size: 10.5px; margin-top: 4px; }
.cp-copy { color: var(--mute); font-size: 12.5px; line-height: 1.65; }
.cp-inline-loading { display: flex; align-items: center; gap: 8px; color: var(--mute); font-size: 12px; padding: 18px 0; }
.cp-empty-history { border: 1px dashed var(--line); border-radius: 12px; padding: 14px; }
.cp-spin { animation: cp-spin 1s linear infinite; }
@keyframes cp-spin { to { transform: rotate(360deg); } }
.cp-page .tw table { min-width: 560px; }
.cp-page .tw th { font-size: 10.5px; text-transform: uppercase; letter-spacing: .07em; font-weight: 700; color: var(--dim); }
.cp-page .tw td { font-size: 12px; }
.cp-page .foot .go { display: inline-flex; align-items: center; justify-content: center; gap: 7px; width: 100%; }
.cp-foot-row { display: grid; grid-template-columns: 1fr auto; gap: 9px; margin-top: 9px; }
.cp-foot-row .go.stop { margin: 0; }
.cp-page .history { margin-top: 34px; }
.cp-page .history button.go { display: inline-flex; align-items: center; gap: 7px; padding: 8px 14px; font-size: 12px; }
.cp-page .cfab, .cp-page .cchat { display: none !important; }
.cp-connect-expert-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  background: rgba(255, 90, 31, 0.12);
  border: 1px solid rgba(255, 90, 31, 0.35);
  border-radius: 10px;
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  transition: all 0.2s ease;
  white-space: nowrap;
}
.cp-connect-expert-btn:hover {
  background: rgba(255, 90, 31, 0.22);
  border-color: rgba(255, 90, 31, 0.6);
  transform: translateY(-1px);
}
.cp-connect-expert-btn .cp-flame-icon {
  color: #ff5a1f;
}
.cp-ember-chip {
  display: inline-block;
  padding: 2px 6px;
  background: rgba(255, 90, 31, 0.25);
  border-radius: 6px;
  font-size: 10px;
  font-family: monospace;
  font-weight: 700;
  color: #ff9166;
}
.cp-row-focused {
  background: rgba(255, 107, 0, 0.12) !important;
  box-shadow: inset 3px 0 0 var(--ember);
}
.cp-page .toast.on { opacity: 1; transform: translate(-50%, 0); }
.cp-skeletons { display: grid; gap: 14px; }
.cp-skeleton { height: 118px; border-radius: 16px; background: var(--side); border: 1px solid var(--line); opacity: .55; animation: cp-pulse 1.4s ease-in-out infinite; }
@keyframes cp-pulse { 50% { opacity: .25; } }

/* ── The wallet gate, and the book grid beside the charts ── */
.cp-wallet-strip {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  margin-top: 12px; padding: 11px 14px;
  border: 1px solid var(--line); border-left: 2px solid var(--ember);
  border-radius: 0 12px 12px 0; background: var(--soft);
  color: var(--mute); font-size: 11.5px; line-height: 1.6;
}
.cp-wallet-strip svg { color: var(--ember); flex: none; }
.cp-wallet-amount { display: flex; align-items: baseline; gap: 8px; flex: none; }
.cp-wallet-amount small { color: var(--dim); font-size: 10px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; }
.cp-wallet-amount b { color: var(--ink); font-size: 14px; }
.cp-wallet-note { flex: 1 1 320px; min-width: 0; }
.cp-book-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; margin-top: 16px; }
.cp-page .activity-panel .tw table { min-width: 520px; }
@media (min-width: 1500px) { .cp-book-grid { grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr); } }

/* ── Detail pane: candlestick chart tab ─────────────── */
.cp-chart-head { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-end; justify-content: space-between; margin-bottom: 12px; }
.cp-chart-pick { display: flex; flex-direction: column; gap: 5px; flex: 1 1 150px; min-width: 0; }
.cp-chart-pick small { color: var(--dim); font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .07em; }
.cp-chart-pick select { width: 100%; min-width: 0; background: var(--side); border: 1px solid var(--line); border-radius: var(--radius-sm); color: var(--ink); font: inherit; font-size: 12.5px; padding: 7px 9px; cursor: pointer; transition: border-color .18s ease, box-shadow .18s ease; }
.cp-chart-pick select:hover { border-color: var(--line-light); }
.cp-chart-pick select:focus { border-color: var(--ember); outline: none; box-shadow: 0 0 0 3px var(--ember-glow); }
.cp-chart-pick select:disabled { opacity: .55; cursor: progress; }
.cp-chart-pick option { background: var(--side); color: var(--ink); }
.cp-page .cp-chart-tf button { padding: 6px 8px; font: 700 11px/1 var(--mono); color: var(--mute); background: var(--side); }
.cp-page .cp-chart-tf button:hover { color: var(--ink); border-color: var(--line-light); }
.cp-page .cp-chart-tf button.on { color: var(--ember); border-color: var(--ember); background: transparent; }
.cp-chart-frame { border: 1px solid var(--line); border-radius: var(--radius-md); overflow: hidden; background: #0E1219; }
.cp-chart-msg { min-height: 300px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 7px; text-align: center; padding: 22px 16px; border: 1px dashed var(--line); border-radius: var(--radius-md); background: var(--p2); }
.cp-chart-msg svg { color: var(--ember); flex: none; }
.cp-chart-msg b { color: var(--ink); font-size: 12.5px; }
.cp-chart-msg span { color: var(--mute); font-size: 11.5px; line-height: 1.55; max-width: 34ch; }
.cp-page .cp-chart-retry { display: inline-flex; align-items: center; gap: 6px; margin-top: 4px; padding: 6px 12px; font-size: 11.5px; font-weight: 700; color: var(--ink); background: var(--side); border-color: var(--line-light); }
.cp-page .cp-chart-retry:hover { color: var(--ember); border-color: var(--ember); }
.cp-chart-meta { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px; font: 700 10px/1.5 var(--mono); color: var(--dim); text-transform: uppercase; letter-spacing: .05em; }
.cp-page .cp-chart-reload { display: inline-flex; align-items: center; gap: 5px; padding: 0; border: 0; background: none; color: var(--dim); font: inherit; letter-spacing: inherit; text-transform: inherit; }
.cp-page .cp-chart-reload:hover { color: var(--ember); }
.cp-page .cp-chart-reload:disabled { opacity: .5; cursor: progress; }
@media (max-width: 900px) {
  .cp-page { padding: 0 18px 60px; }
  .cp-page .main { grid-template-columns: 1fr; }
}
`;
