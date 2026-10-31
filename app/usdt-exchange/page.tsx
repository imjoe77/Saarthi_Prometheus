"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import AppShell from "@/components/AppShell";
import { usdtExchangeStyles } from "@/lib/design/usdtExchange-styles";
import {
  AlertTriangle,
  ArrowLeftRight,
  CheckCircle2,
  ExternalLink,
  Info,
  Loader2,
  RefreshCw,
  TrendingDown,
  TrendingUp,
  Wallet as WalletIcon,
  X,
} from "lucide-react";

import {
  ApiError,
  getBalances,
  getLiquidityOverview,
  getUsdtQuote,
  placeUsdtBuy,
  placeUsdtSell,
  listUsdtOrders,
  type BalanceSummary,
  type UsdtQuote,
  type UsdtOrder,
  type UsdtOrderPage,
  type UsdtSide,
} from "@/lib/api-client";

/**
 * USDT / INR exchange — the frontend of the backend settlement module, in the
 * "INR–USDT Exchange" design.
 *
 * Every number on this page comes from one of three real endpoints:
 *  - `GET /usdt/quote` — the execution price starts as a volume-weighted
 *    CoinDCX order-book VWAP for the requested quantity and is then capped
 *    (BUY) or floored (SELL) by the backend best-price guarantee, so this page
 *    is never the expensive row of its own comparison table; the reference
 *    price and the savings metric come from fresh CoinGecko venue data. A
 *    fallback quote is labelled as such and never justifies an order (orders
 *    answer 503 there).
 *  - `POST /usdt/buy` / `POST /usdt/sell` — real internal-ledger settlement:
 *    the traded wallet balances and the order record commit atomically
 *    together, and the response carries the exact prices it settled at.
 *  - `GET /usdt/orders` — the caller own settled history, keyset-paginated.
 *
 * The reference design's rate chart, 24h high/low/volume and 0.20% fee are all
 * simulated or invented, and none of them exist in the backend. They are
 * replaced here by what the pricing service actually reports: the execution
 * book (raw VWAP and the guarantee applied to it), a live venue comparison on
 * like-for-like executable prices, and the fallback status.
 *
 * DEPTH, NOT A TOY QUOTE. The headline strip and the venue table are priced for
 * {@link PROBE_USDT} rather than a single unit: a 1-unit probe reads only the
 * top of the book, which can be a handful of units wide before the price jumps
 * a whole level, so it flatters or scares on no evidence. Pricing a realistic
 * size walks the depth a real order would, and the raw VWAP it produces is
 * published next to the guaranteed price — when the two differ, the difference
 * is exactly what the best-price guarantee gave back.
 */
type SessionState = "loading" | "ready" | "signed-out" | "no-wallet" | "error";

/**
 * USDT volume the headline price and the venue table are quoted for. A single
 * unit reads only the best book level; this walks the same depth an ordinary
 * order would. Override with `NEXT_PUBLIC_USDT_PROBE_USDT` (digits, > 0) — an
 * unusable value falls back to the default rather than quoting nonsense.
 */
const PROBE_USDT = (() => {
  const raw = process.env.NEXT_PUBLIC_USDT_PROBE_USDT ?? "1000";
  return /^\d+(\.\d+)?$/.test(raw) && Number(raw) > 0 ? raw : "1000";
})();

/** The probe volume as a display label — "1,000" — never the price itself. */
const PROBE_LABEL = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 6 }).format(Number(PROBE_USDT));

interface SessionSnapshot {
  state: SessionState;
  note: string | null;
  balances: BalanceSummary[];
}

/** Result of the last completed quote fetch, keyed to the input that produced it. */
interface FetchedQuote {
  key: string;
  status: "ready" | "unavailable" | "error";
  note?: string;
  details?: string[];
  quote?: UsdtQuote;
}

/** The depth-aware probe ({@link PROBE_USDT} USDT) backing the header strip and the venue panel. */
interface MarketProbe {
  tick: number;
  side: UsdtSide;
  quote: UsdtQuote | null;
  error: string | null;
}

interface PendingOrder {
  side: UsdtSide;
  usdtAmount: string;
  inrEstimate: string;
  quotedPrice: string;
  referencePrice: string | null;
  referenceBasis: string | null;
  savings: string | null;
  guard: string | null;
  clientRequestId: string;
}

interface ExecutionOutcome {
  order: UsdtOrder;
  replay: boolean;
}

interface ExecutionFailure {
  message: string;
  details: string[];
  status: number;
}

interface HistoryState {
  /** The history read this page content answers; -1 until the first page lands. */
  tick: number;
  items: UsdtOrder[];
  nextCursor: string | null;
  appending: boolean;
  error: string | null;
}

const QUOTE_DEBOUNCE_MS = 450;
const HISTORY_PAGE_SIZE = 10;

/** Digits only, at most the USDT scale (6), strictly positive — the shape `/usdt/pricing` enforces. */
const AMOUNT_PATTERN = /^\d+(\.\d{1,6})?$/;
/** The guard field allows two more decimals than the USDT scale. */
const GUARD_PATTERN = /^\d+(\.\d{1,8})?$/;

function newRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Last resort for old runtimes: still unique in practice, and the backend
  // rejects a non-UUID with a validation error that surfaces honestly.
  return `req-${Date.now()}-${Math.floor(Math.random() * 1e12)}`;
}

function asApiError(error: unknown): ApiError | null {
  return error instanceof ApiError ? error : null;
}

function failureFrom(error: unknown, fallback: string): ExecutionFailure {
  const api = asApiError(error);
  if (api) {
    return { message: api.message, details: api.details ?? [], status: api.status };
  }
  return { message: fallback, details: [], status: 0 };
}

/** Groups the integer part in threes, leaving the fraction untouched. */
function groupDigits(value: string): string {
  const negative = value.startsWith("-");
  const digits = negative ? value.slice(1) : value;
  const [whole = "0", fraction] = digits.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

  return `${negative ? "-" : ""}${grouped}${fraction === undefined ? "" : `.${fraction}`}`;
}

/** A backend decimal string, trimmed for display and never parsed to a float. */
function formatDecimal(raw: string, maxPlaces = 6): string {
  const [whole = "0", fraction = ""] = raw.split(".");
  const trimmed = fraction.slice(0, maxPlaces).replace(/0+$/, "");

  return groupDigits(trimmed.length > 0 ? `${whole}.${trimmed}` : whole);
}

/** Formats an INR decimal with the sign before the currency symbol. */
function signedInr(value: string): string {
  const negative = value.startsWith("-");

  return `${negative ? "-" : "+"}₹${negative ? value.slice(1) : value}`;
}

/** True when a value is exactly zero at every decimal place. */
function isZero(raw: string): boolean {
  return /^-?0*(\.0*)?$/.test(raw);
}

/**
 * Humanises the backend's reference-basis tag.
 *
 * The savings figure is only meaningful next to the price it was measured
 * against, and that price can be a venue average or a CoinGecko INR aggregate
 * (a converted global figure, not an Indian venue price). The tag is shown
 * verbatim in spirit — nothing is inferred beyond what the backend reported.
 */
function referenceBasisLabel(basis: string | null): string | null {
  if (basis === null) return null;
  if (basis === "coingecko_aggregate") return "CoinGecko aggregate (INR-converted)";

  const single = /^single_venue\((.+)\)$/.exec(basis);
  if (single) return `single venue · ${single[1]}`;

  const average = /^average_of_(\d+)_venues\((.+)\)$/.exec(basis);
  if (average) return `average of ${average[1]} venues · ${average[2]}`;

  return basis;
}

export default function USDTExchangePage() {
  const [session, setSession] = useState<SessionSnapshot>({
    state: "loading",
    note: null,
    balances: [],
  });
  const [amountText, setAmountText] = useState("");
  const [guardText, setGuardText] = useState("");
  const [direction, setDirection] = useState<UsdtSide>("BUY");

  const [fetchedQuote, setFetchedQuote] = useState<FetchedQuote | null>(null);
  const [quoteTick, setQuoteTick] = useState(0);

  const [probe, setProbe] = useState<MarketProbe>({
    tick: -1,
    side: "BUY",
    quote: null,
    error: null,
  });
  const [probeTick, setProbeTick] = useState(0);

  const [liquidity, setLiquidity] = useState<{
    loaded: boolean;
    availableUsdt: string | null;
    belowThreshold: boolean;
    note: string | null;
  }>({ loaded: false, availableUsdt: null, belowThreshold: false, note: null });

  const [pendingOrder, setPendingOrder] = useState<PendingOrder | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<ExecutionOutcome | null>(null);
  const [failure, setFailure] = useState<ExecutionFailure | null>(null);
  const failureRequestIdRef = useRef<string | null>(null);

  const [history, setHistory] = useState<HistoryState>({
    tick: -1,
    items: [],
    nextCursor: null,
    appending: false,
    error: null,
  });
  const [historyTick, setHistoryTick] = useState(0);

  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setClock(Date.now()), 1_000);
    return () => clearInterval(tick);
  }, []);

  /** Reads the session snapshot. Sets no state, so an effect can call it freely. */
  const loadSession = useCallback(async (): Promise<SessionSnapshot> => {
    try {
      const rows = await getBalances();
      return { state: "ready", note: null, balances: rows };
    } catch (error) {
      const api = asApiError(error);
      if (api && (api.status === 401 || api.status === 403)) {
        return {
          state: "signed-out",
          note: "Sign in to read your Prometheus balances and place orders.",
          balances: [],
        };
      }
      if (api && api.status === 404) {
        return {
          state: "no-wallet",
          note: "No wallet yet — it appears with your first balance movement.",
          balances: [],
        };
      }
      return { state: "error", note: "Balances could not be read right now.", balances: [] };
    }
  }, []);

  /** Re-reads the session snapshot; only ever called from event handlers. */
  const refreshSession = useCallback(async () => {
    setSession(await loadSession());
  }, [loadSession]);

  // State lands inside the promise callback, never synchronously in the
  // effect body — the repo-wide rule for effects.
  useEffect(() => {
    let active = true;
    void loadSession().then((snapshot) => {
      if (active) setSession(snapshot);
    });
    return () => {
      active = false;
    };
  }, [loadSession]);

  // Programme liquidity (MODULE 09) — a read the page tolerates failing: a
  // blocked liquidity read must not block quoting or trading.
  useEffect(() => {
    if (session.state !== "ready") return;
    let active = true;
    void getLiquidityOverview()
      .then((overview) => {
        if (!active) return;
        setLiquidity({
          loaded: true,
          availableUsdt: overview.aggregateAvailableUsdt,
          belowThreshold: overview.belowThreshold,
          note: overview.belowThreshold
            ? "Liquidity is at or below the programme threshold — large buys may be refused."
            : null,
        });
      })
      .catch(() => {
        if (!active) return;
        setLiquidity({
          loaded: true,
          availableUsdt: null,
          belowThreshold: false,
          note: "Liquidity status could not be read right now.",
        });
      });
    return () => {
      active = false;
    };
  }, [session.state, outcome]);

  // The header and venue panel price PROBE_USDT in the current direction: a
  // realistic depth, not a single unit, so the figure reflects the levels an
  // ordinary order actually consumes. It is still a real observation of the
  // same book the ticket uses, never a synthetic tick.
  useEffect(() => {
    if (session.state !== "ready") return;
    let active = true;
    const tick = probeTick;
    void getUsdtQuote(direction, PROBE_USDT)
      .then((quote) => {
        if (active) setProbe({ tick, side: direction, quote, error: null });
      })
      .catch((error: unknown) => {
        if (!active) return;
        const api = asApiError(error);
        setProbe({
          tick,
          side: direction,
          quote: null,
          error: api?.message ?? `The ${PROBE_LABEL} USDT price could not be read right now.`,
        });
      });
    return () => {
      active = false;
    };
  }, [session.state, direction, probeTick, outcome]);

  const trimmedAmount = amountText.trim();

  // Validation and "what is being priced right now" are derived, not stored,
  // so no effect ever has to write state just to classify the input.
  const amountStatus: { kind: "idle" | "invalid" | "ok"; note: string } = useMemo(() => {
    if (trimmedAmount.length === 0) {
      return { kind: "idle", note: "Enter a USDT volume to price it." };
    }
    if (!AMOUNT_PATTERN.test(trimmedAmount) || Number(trimmedAmount) <= 0) {
      return { kind: "invalid", note: "Enter digits only, up to 6 decimal places, greater than zero." };
    }
    return { kind: "ok", note: "" };
  }, [trimmedAmount]);

  // The debounced quote: every accepted amount re-prices at the backend, so
  // the figures shown are the exchange own figures, never arithmetic here.
  const quoteKey = `${direction}|${trimmedAmount}|${quoteTick}`;
  const quoteBusy =
    session.state === "ready" &&
    amountStatus.kind === "ok" &&
    (fetchedQuote === null || fetchedQuote.key !== quoteKey);

  useEffect(() => {
    if (session.state !== "ready" || amountStatus.kind !== "ok") return;
    const key = quoteKey;
    let cancelled = false;
    const timer = setTimeout(() => {
      void getUsdtQuote(direction, trimmedAmount)
        .then((quote) => {
          if (cancelled) return;
          setFetchedQuote({ key, status: "ready", quote });
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          const api = asApiError(error);
          if (api && api.status === 503) {
            setFetchedQuote({ key, status: "unavailable", note: api.message, details: api.details ?? [] });
          } else if (api && (api.status === 401 || api.status === 403)) {
            setSession({
              state: "signed-out",
              note: "Your session expired — sign in again to continue.",
              balances: [],
            });
          } else if (api && api.status === 404) {
            setSession({ state: "no-wallet", note: "No wallet yet — it appears with your first balance movement.", balances: [] });
          } else if (api) {
            setFetchedQuote({ key, status: "error", note: api.message, details: api.details ?? [] });
          } else {
            setFetchedQuote({ key, status: "error", note: "The quote could not be fetched right now." });
          }
        });
    }, QUOTE_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [session.state, direction, trimmedAmount, amountStatus.kind, quoteKey]);

  // Order history: the first page loads with the session; deeper pages append
  // through the cursor. Loading is derived from the tick this content answers.
  useEffect(() => {
    if (session.state !== "ready") return;
    let active = true;
    const requestTick = historyTick;
    void listUsdtOrders({ limit: HISTORY_PAGE_SIZE })
      .then((page: UsdtOrderPage) => {
        if (!active) return;
        setHistory({
          tick: requestTick,
          items: page.items,
          nextCursor: page.nextCursor,
          appending: false,
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (!active) return;
        const api = asApiError(error);
        setHistory({
          tick: requestTick,
          items: [],
          nextCursor: null,
          appending: false,
          error:
            api && (api.status === 401 || api.status === 403)
              ? "Sign in to read your order history."
              : api && api.status === 404
                ? "No wallet yet — there is no history to read."
                : "Order history could not be read right now.",
        });
      });
    return () => {
      active = false;
    };
  }, [session.state, historyTick]);

  const loadMoreHistory = useCallback(async () => {
    const cursor = history.nextCursor;
    if (cursor === null) return;
    setHistory((current) => ({ ...current, appending: true }));
    try {
      const page: UsdtOrderPage = await listUsdtOrders({ limit: HISTORY_PAGE_SIZE, cursor });
      setHistory((current) => ({
        ...current,
        items: [...current.items, ...page.items],
        nextCursor: page.nextCursor,
        appending: false,
        error: null,
      }));
    } catch {
      setHistory((current) => ({ ...current, appending: false, error: "The next page could not be read right now." }));
    }
  }, [history.nextCursor]);

  const inrBalance = useMemo(
    () => session.balances.find((row) => row.asset.symbol === "INR")?.available ?? null,
    [session.balances],
  );
  const usdtBalance = useMemo(
    () => session.balances.find((row) => row.asset.symbol === "USDT")?.available ?? null,
    [session.balances],
  );

  const quote =
    fetchedQuote !== null && fetchedQuote.key === quoteKey && fetchedQuote.status === "ready"
      ? (fetchedQuote.quote ?? null)
      : null;
  const quoteExecutable = quote !== null && quote.pricing.status === "live" && session.state === "ready";

  const guardValid = guardText.trim().length === 0 || GUARD_PATTERN.test(guardText.trim());
  const guardNumber = guardValid && guardText.trim().length > 0 ? Number(guardText.trim()) : null;

  // Local affordability pre-check — the backend remains the authority; this
  // only spares the user a round trip they cannot win.
  const affordability = useMemo(() => {
    if (amountStatus.kind !== "ok") return { ok: true, needed: null, available: null };
    if (direction === "BUY") {
      if (quote === null) return { ok: true, needed: null, available: null };
      if (inrBalance === null) return { ok: false, needed: quote.inrAmount, available: "0" };
      const available = Number(inrBalance);
      return { ok: Number(quote.inrAmount) <= available + 0.005, needed: quote.inrAmount, available: inrBalance };
    }
    if (usdtBalance === null) return { ok: false, needed: trimmedAmount, available: "0" };
    const available = Number(usdtBalance);
    return { ok: Number(trimmedAmount) <= available, needed: trimmedAmount, available: usdtBalance };
  }, [direction, quote, inrBalance, usdtBalance, amountStatus.kind, trimmedAmount]);

  const guardViolation = useMemo(() => {
    if (quote === null || guardNumber === null) return null;
    const price = Number(quote.prometheusPrice);
    if (direction === "BUY" && price > guardNumber) {
      return "The quoted price is already above your maximum — a fresh price could be too. Leave the guard empty or raise it.";
    }
    if (direction === "SELL" && price < guardNumber) {
      return "The quoted price is already below your minimum — a fresh price could be too. Leave the guard empty or lower it.";
    }
    return null;
  }, [quote, guardNumber, direction]);

  const canProceed = quoteExecutable && guardValid && affordability.ok && guardViolation === null && !submitting;

  const applyPreset = (fraction: number) => {
    if (session.state !== "ready") return;
    if (direction === "SELL") {
      if (usdtBalance === null) return;
      const value = Math.floor(Number(usdtBalance) * fraction * 1e6) / 1e6;
      setAmountText(value > 0 ? value.toFixed(6) : "");
      return;
    }
    if (quote === null || inrBalance === null) return;
    const usdtAtQuote = (Number(inrBalance) * fraction) / Number(quote.prometheusPrice);
    // A BUY settles at a fresh price that can rise above the quoted one, so
    // MAX deliberately leaves a sliver of headroom rather than promising a
    // figure the next request could refuse.
    const headroom = fraction === 1 ? 0.999 : 1;
    const value = Math.floor(usdtAtQuote * headroom * 1e6) / 1e6;
    setAmountText(value > 0 ? value.toFixed(6) : "");
  };

  const beginOrder = () => {
    if (!canProceed || quote === null) return;
    setOutcome(null);
    setFailure(null);
    failureRequestIdRef.current = null;
    setPendingOrder({
      side: direction,
      usdtAmount: trimmedAmount,
      inrEstimate: quote.inrAmount,
      quotedPrice: quote.prometheusPrice,
      referencePrice: quote.referencePrice,
      referenceBasis: quote.pricing.referenceBasis,
      savings: quote.savings,
      guard: guardNumber !== null ? guardNumber.toString() : null,
      clientRequestId: newRequestId(),
    });
  };

  const confirmOrder = useCallback(async () => {
    if (!pendingOrder || submitting) return;
    setSubmitting(true);
    setFailure(null);
    try {
      const input = {
        usdtAmount: pendingOrder.usdtAmount,
        ...(pendingOrder.guard !== null
          ? pendingOrder.side === "BUY"
            ? { maxExecutionPrice: pendingOrder.guard }
            : { minExecutionPrice: pendingOrder.guard }
          : {}),
      };
      const order =
        pendingOrder.side === "BUY"
          ? await placeUsdtBuy(pendingOrder.clientRequestId, input)
          : await placeUsdtSell(pendingOrder.clientRequestId, input);

      // A replay carries no pricing block: the original order figures are the
      // truth and no balance moved a second time.
      const replay = order.pricing === undefined;
      setOutcome({ order, replay });
      setPendingOrder(null);
      setAmountText("");
      setQuoteTick((tick) => tick + 1);
      setProbeTick((tick) => tick + 1);
      setHistoryTick((tick) => tick + 1);
      void refreshSession();
    } catch (error) {
      setFailure(failureFrom(error, "The order could not be placed right now."));
      failureRequestIdRef.current = pendingOrder.clientRequestId;
      const api = asApiError(error);
      if (api && api.status === 401) {
        setSession({
          state: "signed-out",
          note: "Your session expired — sign in again to continue.",
          balances: [],
        });
        setPendingOrder(null);
      }
    } finally {
      setSubmitting(false);
    }
  }, [pendingOrder, submitting, refreshSession]);

  const cancelPending = () => {
    setPendingOrder(null);
    setFailure(null);
    failureRequestIdRef.current = null;
  };

  const retryFailed = () => {
    if (!pendingOrder || failureRequestIdRef.current === null) return;
    // The same clientRequestId is reused deliberately: idempotency means a
    // retry can never double-settle, and any earlier uncertain attempt that
    // actually landed answers as a replay of the original order.
    setPendingOrder({ ...pendingOrder, clientRequestId: failureRequestIdRef.current });
    setFailure(null);
    void confirmOrder();
  };

  const formatUpdatedAt = (iso: string) => {
    const ageSeconds = Math.max(0, Math.floor((clock - new Date(iso).getTime()) / 1000));
    if (ageSeconds < 60) return `${ageSeconds}s ago`;
    const ageMinutes = Math.floor(ageSeconds / 60);
    if (ageMinutes < 60) return `${ageMinutes}m ago`;
    return `${Math.floor(ageMinutes / 60)}h ago`;
  };

  // What the pricing panels show, resolved once instead of re-derived per card.
  const pricingNote = (() => {
    if (session.state !== "ready") return session.note;
    if (amountStatus.kind !== "ok") return amountStatus.note;
    if (quoteBusy) return "pricing…";
    if (fetchedQuote !== null && fetchedQuote.key === quoteKey) return fetchedQuote.note ?? null;
    return null;
  })();

  const historyBusy = session.state === "ready" && (history.tick !== historyTick || history.appending);

  // The header strip describes the current direction only; while the probe for
  // the other side is in flight the previous side's figures are not shown.
  const market = probe.side === direction ? probe.quote : null;
  const probeBusy =
    session.state === "loading" ||
    (session.state === "ready" && (probe.tick !== probeTick || probe.side !== direction));
  const marketError = probe.side === direction ? probe.error : null;

  // Venue bars: what Prometheus charges plus what each comparison venue would
  // actually transact at for this side — two executable figures in one
  // currency, not an offer measured against a trade print. Bar length is a
  // display scale between the lowest and highest observed price, not a time
  // series.
  const venueRows = useMemo(() => {
    if (market === null) return [];

    const guarantee = market.pricing.guarantee;
    const rows = [
      {
        venue: "Prometheus",
        price: market.prometheusPrice,
        self: true,
        meta:
          guarantee !== null && guarantee.applied
            ? `guaranteed · book said ₹${market.pricing.execution?.bookVwap ?? "—"}`
            : `order-book VWAP · ${PROBE_LABEL} USDT`,
      },
      ...market.pricing.competitors.map((competitor) => ({
        venue: competitor.venue,
        price: competitor.venuePrice,
        self: false,
        meta:
          competitor.venuePriceBasis === "derived_from_spread"
            ? `${direction === "BUY" ? "buy" : "sell"} price · spread ${competitor.bidAskSpreadPct}%`
            : "last price · no spread reported",
      })),
    ];

    const prices = rows.map((row) => Number(row.price)).filter((value) => Number.isFinite(value));
    const low = Math.min(...prices);
    const high = Math.max(...prices);
    const spread = high - low;

    return rows.map((row) => {
      const price = Number(row.price);
      const width = spread > 0 && Number.isFinite(price) ? 14 + ((price - low) / spread) * 86 : 100;
      return { ...row, width };
    });
  }, [market, direction]);

  // How much better than each venue Prometheus is for the customer, in percent.
  // Positive always means "Prometheus is the better side of this trade", for
  // either direction: a BUY is won by being lower and a SELL by being higher,
  // so the sign flips with the side and the colour never lies about who wins.
  const competitorRows = useMemo(() => {
    if (market === null) return [];

    const execution = Number(market.prometheusPrice);

    return market.pricing.competitors.map((competitor) => {
      const price = Number(competitor.venuePrice);
      const advantage =
        Number.isFinite(execution) && execution > 0 && Number.isFinite(price) && price > 0
          ? (direction === "BUY" ? (price - execution) / execution : (execution - price) / price) * 100
          : null;

      return { ...competitor, advantage };
    });
  }, [market, direction]);

  return (
    <AppShell>
      <style dangerouslySetInnerHTML={{ __html: usdtExchangeStyles }} />

      <div className="ux-page">
        <div className="ux-head">
          <div className="ux-head-main">
            <div className="ux-eyebrow">
              <span className="dot" />
              <span>USDT / INR</span>
              <span>·</span>
              <b>Internal ledger settlement · zero brokerage</b>
            </div>
            <h1 className="ux-title">INR–USDT Exchange</h1>
            <p className="ux-sub">
              Buy or sell USDT against your Prometheus wallet. Orders settle atomically at the live
              order-book price captured when you confirm, then capped or floored by the best-price
              guarantee so the figure is at least ₹1.50 better than every comparison venue below —
              measured against fresh CoinGecko reference data. No brokerage is charged and no fee is
              estimated.
            </p>
          </div>

          <div className="ux-ticker">
            <div className="ux-tick" style={{ minWidth: 142 }}>
              <div className="ux-tick-k">
                {PROBE_LABEL} USDT · {direction === "BUY" ? "buy" : "sell"}
              </div>
              <div className="ux-tick-v acc">{market !== null ? `₹${market.prometheusPrice}` : "—"}</div>
              {probeBusy ? (
                <span className="ux-tick-badge busy">reading</span>
              ) : market !== null ? (
                <span className={`ux-tick-badge ${market.pricing.status}`}>{market.pricing.status}</span>
              ) : (
                <span className="ux-tick-badge fallback">unavailable</span>
              )}
            </div>
            <div className="ux-tick">
              <div className="ux-tick-k">Reference</div>
              <div className="ux-tick-v">
                {market !== null && market.referencePrice !== null ? `₹${market.referencePrice}` : "—"}
              </div>
              <div className="ux-tick-k" style={{ letterSpacing: ".04em" }}>
                {market?.pricing.referenceBasis ?? "no basis"}
              </div>
            </div>
            <div className="ux-tick">
              <div className="ux-tick-k">Aggregate</div>
              <div className="ux-tick-v">
                {market?.pricing.aggregate != null ? `₹${market.pricing.aggregate.priceInr}` : "—"}
              </div>
              <div className="ux-tick-k" style={{ letterSpacing: ".04em" }}>
                {market?.pricing.aggregate != null
                  ? formatUpdatedAt(market.pricing.aggregate.lastUpdatedAt)
                  : "not reported"}
              </div>
            </div>
            <div className="ux-tick" style={{ minWidth: 132 }}>
              <div className="ux-tick-k">Book source</div>
              <div className="ux-tick-v small">{market?.pricing.execution?.source ?? "—"}</div>
              <div className="ux-tick-k" style={{ letterSpacing: ".04em" }}>
                {market?.pricing.execution != null
                  ? `captured ${formatUpdatedAt(market.pricing.execution.bookTimestamp)}`
                  : "no book"}
              </div>
            </div>
          </div>
        </div>

        {session.state === "signed-out" && (
          <div className="ux-banner warn">
            <AlertTriangle className="w-4 h-4" />
            <div className="body">
              <b>Sign in to trade.</b>
              {session.note}
              <div className="mini">
                <Link className="ux-link" href="/login">
                  Go to sign in →
                </Link>
              </div>
            </div>
          </div>
        )}

        {session.state === "no-wallet" && (
          <div className="ux-banner warn">
            <AlertTriangle className="w-4 h-4" />
            <div className="body">
              <b>No wallet yet.</b>
              {session.note}
            </div>
          </div>
        )}

        {session.state === "error" && (
          <div className="ux-banner bad">
            <AlertTriangle className="w-4 h-4" />
            <div className="body">
              <b>Balances could not be read.</b>
              {session.note}
            </div>
            <button
              type="button"
              className="ux-btn sm ghost dismiss"
              onClick={() => void refreshSession()}
            >
              Retry
            </button>
          </div>
        )}

        {outcome !== null && (
          <div className="ux-banner ok">
            <CheckCircle2 className="w-4 h-4" />
            <div className="body">
              <b>{outcome.replay ? "This request had already been processed." : "Order settled."}</b>
              {outcome.order.side === "BUY" ? "Bought" : "Sold"} {formatDecimal(outcome.order.usdtAmount)} USDT
              for ₹{outcome.order.inrAmount} at ₹{outcome.order.prometheusPrice} per USDT
              {!isZero(outcome.order.savings) ? (
                <> (savings {signedInr(outcome.order.savings)} vs reference)</>
              ) : null}
              .{" "}
              {outcome.replay
                ? "The original order is shown again — no additional balance movement happened."
                : "The balance legs and this order record committed together."}
              {outcome.order.pricing !== undefined && outcome.order.pricing.execution !== null && (
                <div className="mini">
                  settled at {outcome.order.pricing.execution.source}, book captured{" "}
                  {formatUpdatedAt(outcome.order.pricing.execution.bookTimestamp)}
                </div>
              )}
              {outcome.order.liquidity !== undefined && (
                <div className="mini">
                  funded by the liquidity programme in {outcome.order.liquidity.slices.length} slice
                  {outcome.order.liquidity.slices.length === 1 ? "" : "s"} —{" "}
                  {outcome.order.liquidity.totalUsdt} USDT / ₹{outcome.order.liquidity.totalInr}
                  {outcome.order.liquidity.slices.length <= 5 && (
                    <ul>
                      {outcome.order.liquidity.slices.map((slice) => (
                        <li key={slice.commitmentId}>
                          slice {slice.usdtAmount} USDT → ₹{slice.inrAmount} @ ₹{slice.priceInr}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
            <button
              type="button"
              className="ux-icon-btn dismiss"
              aria-label="Dismiss settled-order summary"
              onClick={() => setOutcome(null)}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        <div className="ux-top">
          <div className="ux-col">
            <section className="ux-card ux-pad">
              <div className="ux-card-head">
                <div>
                  <div className="ux-card-title">
                    Price provenance <span className="badge">live market observations</span>
                  </div>
                  <p className="ux-card-sub">
                    The execution figure is a volume-weighted walk of the CoinDCX order book for{" "}
                    {PROBE_LABEL} USDT in the current direction, then capped or floored so it lands
                    at least ₹1.50 better than the best competitor on this side. Comparison venues
                    show what you would transact at there — their ask on a buy, their bid on a sell —
                    never a trade print.
                  </p>
                </div>
                {probeBusy && (
                  <span className="ux-loading">
                    <Loader2 className="w-3 h-3 ux-spin" /> re-pricing
                  </span>
                )}
              </div>

              {market === null ? (
                <div className="ux-empty">
                  {marketError ??
                    (session.state === "ready" || session.state === "loading"
                      ? "Reading the market…"
                      : "Live pricing needs a signed-in wallet.")}
                </div>
              ) : (
                <>
                  <div className="ux-price">
                    <div className="ux-price-v">
                      <span className="cur">₹</span>
                      {market.prometheusPrice}
                    </div>
                    <div className="ux-price-unit">per USDT</div>
                    <span className={`ux-price-side ${direction === "BUY" ? "buy" : "sell"}`}>
                      {direction === "BUY" ? "buying" : "selling"}
                    </span>
                  </div>
                  <p className="ux-price-note">
                    Priced for {PROBE_LABEL} USDT in this direction — a depth that walks the same
                    levels an ordinary order consumes, not a single-unit top of book. A ticket of
                    another size walks the book further and returns its own figure below.
                  </p>

                  <div className="ux-venue-list">
                    {venueRows.map((row) => (
                      <div key={`${row.self ? "self" : "venue"}-${row.venue}`} className={`ux-venue${row.self ? " self" : ""}`}>
                        <div className="ux-venue-name">
                          {row.venue}
                          {row.self && (
                            <span className="tag">
                              {market.pricing.guarantee?.applied ? "guaranteed" : "execution"}
                            </span>
                          )}
                        </div>
                        <div className="ux-venue-price">₹{row.price}</div>
                        <div className="ux-venue-track">
                          <span className="ux-venue-fill" style={{ width: `${row.width}%` }} />
                        </div>
                        <div className="ux-venue-meta">{row.meta}</div>
                      </div>
                    ))}
                    {market.pricing.competitors.length === 0 && (
                      <p className="ux-card-sub" style={{ margin: 0 }}>
                        No comparison venue reported a price for this pair right now.
                      </p>
                    )}
                  </div>

                  <div className="ux-price-foot">
                    <span>
                      execution <b>{market.pricing.execution?.source ?? "—"}</b>
                    </span>
                    <span>
                      book <b>{market.pricing.execution !== null ? formatUpdatedAt(market.pricing.execution.bookTimestamp) : "—"}</b>
                    </span>
                    <span>
                      ticker last{" "}
                      <b>
                        {market.pricing.execution !== null && market.pricing.execution.tickerLast !== null
                          ? `₹${market.pricing.execution.tickerLast}`
                          : "—"}
                      </b>
                    </span>
                    <span>
                      fetched <b>{market.pricing.execution !== null ? formatUpdatedAt(market.pricing.execution.fetchedAt) : "—"}</b>
                    </span>
                  </div>

                  {market.referencePrice !== null && (
                    <div className="ux-savings">
                      <span>Savings vs reference</span>
                      <b className={Number(market.savings ?? 0) >= 0 ? "up" : "down"}>
                        {market.savings !== null ? signedInr(market.savings) : "—"}
                      </b>
                    </div>
                  )}

                  {market.pricing.status === "fallback" && (
                    <div className="ux-banner warn" style={{ marginTop: 12 }}>
                      <AlertTriangle className="w-4 h-4" />
                      <div className="body">
                        <b>Indicative fallback price — orders are refused.</b>
                        {market.pricing.fallback?.note ?? "No fresh live book backed this figure."}
                        {market.pricing.reasons.length > 0 && (
                          <ul>
                            {market.pricing.reasons.map((reason, index) => (
                              <li key={index}>{reason}</li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </div>
                  )}
                </>
              )}
            </section>

            <section className="ux-card ux-pad">
              <div className="ux-card-title">
                Settlement path <span className="badge">no hidden steps</span>
              </div>
              <p className="ux-card-sub">
                What the backend does between your review and a settled balance.
              </p>
              <div className="ux-steps">
                <div className="ux-step">
                  <span className="ux-step-n">01</span>
                  <div>
                    <b>Quote the exact size</b>
                    <p>
                      The execution figure walks the live CoinDCX book for the USDT volume you
                      entered, in the direction you chose.
                    </p>
                  </div>
                </div>
                <div className="ux-step">
                  <span className="ux-step-n">02</span>
                  <div>
                    <b>Capture a fresh price</b>
                    <p>
                      Confirming takes a new observation of the same book. Your optional guard
                      refuses the order if that fresh price breaches the bound.
                    </p>
                  </div>
                </div>
                <div className="ux-step">
                  <span className="ux-step-n">03</span>
                  <div>
                    <b>Commit atomically</b>
                    <p>
                      The balance legs and the order record commit together at the fresh price. A
                      refusal leaves every balance untouched.
                    </p>
                  </div>
                </div>
              </div>
              <p className="ux-steps-note">
                There is no deposit, withdrawal or third-party custody transfer in this module —
                settlement moves balances inside the Prometheus ledger.
              </p>
            </section>
          </div>

          <div className="ux-col">
            <section className="ux-card ux-ticket">
              <div className="ux-ticket-head">
                <div className="ux-tabs" role="tablist" aria-label="Order direction">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={direction === "BUY"}
                    className={`ux-tab${direction === "BUY" ? " on-buy" : ""}`}
                    onClick={() => setDirection("BUY")}
                  >
                    Buy · INR → USDT
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={direction === "SELL"}
                    className={`ux-tab${direction === "SELL" ? " on-sell" : ""}`}
                    onClick={() => setDirection("SELL")}
                  >
                    Sell · USDT → INR
                  </button>
                </div>
              </div>

              <div className="ux-ticket-body">
                <div className="ux-balances">
                  <div className="ux-balance-row">
                    <span>Available INR</span>
                    <b>
                      {session.state === "ready"
                        ? `₹${formatDecimal(inrBalance ?? "0", 2)}`
                        : session.state === "loading"
                          ? "reading…"
                          : "—"}
                    </b>
                  </div>
                  <div className="ux-balance-row">
                    <span>Available USDT</span>
                    <b>
                      {session.state === "ready"
                        ? formatDecimal(usdtBalance ?? "0")
                        : session.state === "loading"
                          ? "reading…"
                          : "—"}
                    </b>
                  </div>
                  <div className="ux-balance-row" title="Aggregate USDT the liquidity programme can fund buys with">
                    <span>Programme liquidity</span>
                    <b className={liquidity.belowThreshold ? "down" : undefined}>
                      {liquidity.availableUsdt !== null
                        ? formatDecimal(liquidity.availableUsdt)
                        : liquidity.loaded
                          ? "—"
                          : "…"}
                    </b>
                  </div>
                  {liquidity.note !== null && (
                    <div className="ux-error warn">
                      <Info className="w-3 h-3" />
                      <span>{liquidity.note}</span>
                    </div>
                  )}
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 2 }}>
                    <Link className="ux-link" href="/wallet" style={{ fontSize: 10.5, display: "inline-flex", alignItems: "center", gap: 5 }}>
                      <WalletIcon className="w-3 h-3" /> Wallet &amp; activity
                    </Link>
                    <button
                      type="button"
                      className="ux-btn sm ghost"
                      onClick={() => {
                        void refreshSession();
                        setQuoteTick((tick) => tick + 1);
                        setProbeTick((tick) => tick + 1);
                      }}
                    >
                      <RefreshCw className="w-3 h-3" /> Refresh
                    </button>
                  </div>
                </div>

                <div className="ux-field-k">
                  <span>Amount to {direction === "BUY" ? "buy" : "sell"}</span>
                  <span className="hint">USDT · up to 6 decimals</span>
                </div>
                <div className="ux-input-wrap">
                  <input
                    type="text"
                    inputMode="decimal"
                    value={amountText}
                    onChange={(event) => setAmountText(event.target.value)}
                    placeholder="0.000000"
                    disabled={session.state !== "ready"}
                    aria-label="USDT amount"
                    className="ux-input"
                  />
                  <span className="ux-input-suffix">USDT</span>
                </div>
                <div className="ux-presets">
                  {[
                    { fraction: 0.25, label: "25%" },
                    { fraction: 0.5, label: "50%" },
                    { fraction: 1, label: "MAX" },
                  ].map((preset) => (
                    <button
                      key={preset.label}
                      type="button"
                      onClick={() => applyPreset(preset.fraction)}
                      disabled={
                        session.state !== "ready" ||
                        (direction === "BUY" && quote === null) ||
                        (direction === "SELL" && usdtBalance === null)
                      }
                      className="ux-preset"
                    >
                      {preset.label}
                    </button>
                  ))}
                  {direction === "BUY" && quote === null && session.state === "ready" && (
                    <span className="ux-preset-note">presets need a quote</span>
                  )}
                </div>

                {amountStatus.kind === "invalid" && (
                  <div className="ux-error">
                    <AlertTriangle className="w-3 h-3" />
                    <span>{amountStatus.note}</span>
                  </div>
                )}

                <div className="ux-swap">
                  <span className="ux-swap-btn">
                    <ArrowLeftRight className="w-3.5 h-3.5" />
                  </span>
                  <span className="ux-swap-rate">
                    {quote !== null ? (
                      <>
                        1 USDT ≈ <b>₹{quote.prometheusPrice}</b> for this amount
                      </>
                    ) : (
                      "quote the amount to see its rate"
                    )}
                  </span>
                </div>

                <div className="ux-readout">
                  <span className="ux-readout-k">
                    {direction === "BUY" ? "You pay" : "You receive"}
                  </span>
                  <span className="ux-readout-v">{quote !== null ? `₹${quote.inrAmount}` : "—"}</span>
                </div>

                <div className="ux-summary">
                  <div className="ux-summary-row">
                    <span>Execution rate</span>
                    <b>{quote !== null ? `₹${quote.prometheusPrice} / USDT` : "—"}</b>
                  </div>
                  <div className="ux-summary-row">
                    <span>Reference price</span>
                    <b>
                      {quote?.referencePrice != null ? `₹${quote.referencePrice}` : "—"}
                      {quote !== null && referenceBasisLabel(quote.pricing.referenceBasis) !== null && (
                        <span className="hint">{referenceBasisLabel(quote.pricing.referenceBasis)}</span>
                      )}
                    </b>
                  </div>
                  <div className="ux-summary-row">
                    <span>Savings vs reference</span>
                    <b className={quote?.savings != null && Number(quote.savings) < 0 ? "down" : "up"}>
                      {quote?.savings != null ? signedInr(quote.savings) : "—"}
                    </b>
                  </div>
                  <div className="ux-summary-row">
                    <span>Prometheus brokerage</span>
                    <b>₹0.00 · zero by construction</b>
                  </div>
                  <div className="ux-summary-row total">
                    <span>{direction === "BUY" ? "Total debited (est.)" : "Total credited (est.)"}</span>
                    <b>{quote !== null ? `₹${quote.inrAmount}` : "—"}</b>
                  </div>
                </div>

                <div className="ux-guard">
                  <div className="ux-field-k">
                    <span>Price guard · optional</span>
                    <span className="hint">{direction === "BUY" ? "max ₹/USDT" : "min ₹/USDT"}</span>
                  </div>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={guardText}
                    onChange={(event) => setGuardText(event.target.value)}
                    placeholder={quote !== null ? quote.prometheusPrice : "no guard"}
                    disabled={session.state !== "ready"}
                    aria-label="Optional price guard"
                    className="ux-input"
                  />
                  <p className="ux-guard-note">
                    {direction === "BUY"
                      ? "Refuses the order if the fresh price exceeds this. Empty = no guard."
                      : "Refuses the order if the fresh price falls below this. Empty = no guard."}
                  </p>
                </div>

                {!guardValid && (
                  <div className="ux-error">
                    <AlertTriangle className="w-3 h-3" />
                    <span>The guard must be digits only, up to 8 decimals.</span>
                  </div>
                )}
                {!affordability.ok && (
                  <div className="ux-error">
                    <AlertTriangle className="w-3 h-3" />
                    <span>
                      Insufficient balance — needs {affordability.needed} {direction === "BUY" ? "INR" : "USDT"},
                      you have {affordability.available ?? "—"}.
                    </span>
                  </div>
                )}
                {guardViolation !== null && (
                  <div className="ux-error warn">
                    <AlertTriangle className="w-3 h-3" />
                    <span>{guardViolation}</span>
                  </div>
                )}

                <div className="ux-ticket-actions">
                  <button
                    type="button"
                    onClick={beginOrder}
                    disabled={!canProceed}
                    className={`ux-btn wide ${direction === "BUY" ? "buy" : "sell"}`}
                  >
                    {direction === "BUY" ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
                    {direction === "BUY" ? "Review buy order" : "Review sell order"}
                  </button>

                  {session.state === "ready" &&
                    fetchedQuote !== null &&
                    fetchedQuote.key === quoteKey &&
                    fetchedQuote.status === "unavailable" && (
                      <p className="ux-ticket-note" style={{ color: "var(--amber)" }}>
                        Live pricing is unavailable right now — orders are refused without fresh prices.
                      </p>
                    )}

                  <p className="ux-ticket-note">
                    {pricingNote ?? "Quotes are indicative; the order settles at the fresh price captured when you confirm."}
                  </p>
                </div>
              </div>
            </section>
          </div>
        </div>

        <div className="ux-bottom">
          <section className="ux-card ux-pad">
            <div className="ux-card-head">
              <div>
                <div className="ux-card-title">
                  Venue comparison <span className="badge">executable prices</span>
                </div>
                <p className="ux-card-sub">
                  What you would actually transact at on each venue for the{" "}
                  {direction === "BUY" ? "buy" : "sell"} side, against what Prometheus charges —
                  every venue that reported a price (three or more, side by side), each offer on the
                  same scale and never measured against a trade print.
                </p>
              </div>
              {market?.pricing.referenceBasis !== null && market !== null && (
                <span className="ux-card-sub" style={{ margin: 0 }}>
                  reference · {market.pricing.referenceBasis}
                </span>
              )}
            </div>

            {market === null ? (
              <div className="ux-empty">No venue data to compare until a live quote lands.</div>
            ) : (
              <>
                <div className="ux-table-wrap">
                  <table className="ux-table">
                    <thead>
                      <tr>
                        <th>Venue</th>
                        <th style={{ textAlign: "right" }}>
                          {direction === "BUY" ? "Price you pay" : "Price you get"}
                        </th>
                        <th style={{ textAlign: "right" }}>24h volume</th>
                        <th style={{ textAlign: "right" }}>Spread</th>
                        <th style={{ textAlign: "right" }}>Prometheus advantage</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td className="strong">
                          Prometheus
                          <span className="ux-side sell" style={{ marginLeft: 8 }}>
                            {market.pricing.guarantee?.applied ? "guaranteed" : "execution"}
                          </span>
                        </td>
                        <td className="num strong">₹{market.prometheusPrice}</td>
                        <td className="num dim">—</td>
                        <td className="num dim">—</td>
                        <td className="num dim">—</td>
                      </tr>
                      {competitorRows.map((competitor) => (
                        <tr key={competitor.venue}>
                          <td>
                            {competitor.venue}
                            {competitor.venuePriceBasis === "last_price" && (
                              <span className="badge" style={{ marginLeft: 6 }}>
                                last only
                              </span>
                            )}
                          </td>
                          <td className="num">₹{competitor.venuePrice}</td>
                          <td className="num dim">
                            {competitor.volume24h !== null ? formatDecimal(competitor.volume24h, 2) : "—"}
                          </td>
                          <td className="num dim">
                            {competitor.bidAskSpreadPct !== null ? `${competitor.bidAskSpreadPct}%` : "—"}
                          </td>
                          <td
                            className="num"
                            style={{
                              color:
                                competitor.advantage === null
                                  ? "var(--mut)"
                                  : competitor.advantage > 0
                                    ? "var(--up)"
                                    : competitor.advantage < 0
                                      ? "var(--down)"
                                      : "var(--mut)",
                            }}
                          >
                            {competitor.advantage === null
                              ? "—"
                              : `${competitor.advantage >= 0 ? "+" : ""}${competitor.advantage.toFixed(3)}%`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="ux-table-note">
                  A positive advantage means Prometheus is the better side of the trade for you —
                  cheaper to buy, or higher to sell — and the best-price guarantee holds it at least
                  ₹1.50 better for every venue on this table, whatever the raw book said. Each venue
                  is shown at what a customer would transact at there (its ask on a buy, its bid on a
                  sell, widened by half its own live spread), never at its last trade print, which
                  nobody can deal at; a venue reporting no spread is shown at its raw last print —
                  the most favourable case for it — and marked <b>last only</b>. Volume is whatever
                  the venue reported, in its own units; nothing here is annualised or smoothed.{" "}
                  <a
                    className="ux-link"
                    href="https://www.coingecko.com/en/coins/tether"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Verify on CoinGecko <ExternalLink className="inline w-2.5 h-2.5" />
                  </a>
                </p>
              </>
            )}
          </section>

          <section className="ux-card ux-pad">
            <div className="ux-card-title" style={{ marginBottom: 12 }}>
              Pricing status
            </div>

            {market === null ? (
              <div className="ux-empty">{marketError ?? "No pricing metadata yet."}</div>
            ) : (
              <>
                <div className="ux-status-list">
                  <div className="ux-status-row">
                    <span>Status</span>
                    <b className={market.pricing.status === "live" ? "up" : "amber"}>
                      {market.pricing.status}
                    </b>
                  </div>
                  <div className="ux-status-row">
                    <span>Execution book</span>
                    <b>{market.pricing.execution?.source ?? "—"}</b>
                  </div>
                  <div className="ux-status-row">
                    <span>
                      Raw book VWAP · {PROBE_LABEL} USDT
                    </span>
                    <b>{market.pricing.execution !== null ? `₹${market.pricing.execution.bookVwap}` : "—"}</b>
                  </div>
                  <div className="ux-status-row">
                    <span>Best-price guarantee</span>
                    <b className={market.pricing.guarantee?.applied ? "up" : undefined}>
                      {market.pricing.guarantee === null
                        ? "—"
                        : market.pricing.guarantee.applied
                          ? `applied · ${market.pricing.guarantee.matchedVenue} ₹${market.pricing.guarantee.matchedPrice}`
                          : "not needed · book already best"}
                    </b>
                  </div>
                  {market.pricing.guarantee !== null && (
                    <div className="ux-status-row">
                      <span>Guarantee rule</span>
                      <b>at least ₹1.50 better than the best venue</b>
                    </div>
                  )}
                  <div className="ux-status-row">
                    <span>Book captured</span>
                    <b>{market.pricing.execution !== null ? formatUpdatedAt(market.pricing.execution.bookTimestamp) : "—"}</b>
                  </div>
                  <div className="ux-status-row">
                    <span>Reference basis</span>
                    <b>{market.pricing.referenceBasis ?? "—"}</b>
                  </div>
                  <div className="ux-status-row">
                    <span>Venues compared</span>
                    <b>{market.pricing.competitors.length}</b>
                  </div>
                  <div className="ux-status-row">
                    <span>Fallback price</span>
                    <b>{market.pricing.fallback !== null ? `₹${market.pricing.fallback.priceInr}` : "none"}</b>
                  </div>
                </div>

                {market.pricing.reasons.length > 0 && (
                  <ul className="ux-reasons">
                    {market.pricing.reasons.map((reason, index) => (
                      <li key={index}>{reason}</li>
                    ))}
                  </ul>
                )}

                {market.pricing.guarantee !== null && (
                  <p className="ux-table-note" style={{ marginTop: 10 }}>
                    <b>Best-price guarantee:</b> {market.pricing.guarantee.note}
                  </p>
                )}

                <p className="ux-fees">{market.pricing.feesNote}</p>
              </>
            )}
          </section>
        </div>

        <section className="ux-card ux-pad" style={{ marginTop: 20 }}>
          <div className="ux-card-head">
            <div>
              <div className="ux-card-title">Your settled USDT orders</div>
              <p className="ux-card-sub">
                Newest first, keyset-paginated by the backend. Only orders that actually settled are
                listed.
              </p>
            </div>
            <button
              type="button"
              className="ux-btn sm ghost"
              onClick={() => setHistoryTick((tick) => tick + 1)}
              disabled={session.state !== "ready"}
            >
              <RefreshCw className="w-3 h-3" /> Refresh
            </button>
          </div>

          {session.state !== "ready" ? (
            <div className="ux-empty">
              {session.state === "signed-out"
                ? "Sign in to read your order history."
                : session.state === "no-wallet"
                  ? "No wallet yet — there is no history to read."
                  : session.state === "loading"
                    ? "Reading history…"
                    : "Order history could not be read right now."}
            </div>
          ) : historyBusy && history.tick === -1 ? (
            <div className="ux-empty">
              <span className="ux-loading">
                <Loader2 className="w-3 h-3 ux-spin" /> reading history…
              </span>
            </div>
          ) : history.error !== null ? (
            <div className="ux-empty">{history.error}</div>
          ) : history.items.length === 0 && !historyBusy ? (
            <div className="ux-empty">No USDT orders yet — settled orders appear here.</div>
          ) : (
            <>
              <div className="ux-table-wrap">
                <table className="ux-table">
                  <thead>
                    <tr>
                      <th>Filled</th>
                      <th>Side</th>
                      <th style={{ textAlign: "right" }}>USDT</th>
                      <th style={{ textAlign: "right" }}>INR</th>
                      <th style={{ textAlign: "right" }}>Price</th>
                      <th style={{ textAlign: "right" }}>Reference</th>
                      <th style={{ textAlign: "right" }}>Savings</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.items.map((order) => (
                      <tr key={order.orderId}>
                        <td className="mono dim" style={{ whiteSpace: "nowrap" }}>
                          {new Date(order.filledAt).toLocaleString()}
                        </td>
                        <td>
                          <span className={`ux-side ${order.side === "BUY" ? "buy" : "sell"}`}>
                            {order.side}
                          </span>
                        </td>
                        <td className="num strong">{formatDecimal(order.usdtAmount)}</td>
                        <td className="num strong">₹{order.inrAmount}</td>
                        <td className="num">₹{order.prometheusPrice}</td>
                        <td className="num dim">₹{order.referencePrice}</td>
                        <td
                          className="num"
                          style={{ color: Number(order.savings) >= 0 ? "var(--up)" : "var(--down)" }}
                        >
                          {signedInr(order.savings)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="ux-table-note">
                Showing {history.items.length} settled order{history.items.length === 1 ? "" : "s"}
                {history.nextCursor !== null ? " · more available" : " · end of history"}.
              </p>
            </>
          )}

          {history.nextCursor !== null && !historyBusy && (
            <div className="ux-more">
              <button
                type="button"
                className="ux-btn sm ghost"
                onClick={() => void loadMoreHistory()}
                disabled={history.appending}
              >
                {history.appending ? <Loader2 className="w-3 h-3 ux-spin" /> : null}
                {history.appending ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </section>

        <div className="ux-foot">
          <AlertTriangle className="w-4 h-4" />
          <div>
            <b>What this rails into — and what it never claims.</b>
            <p>
              Prices are raw market observations from the backend pricing service: the execution
              figure starts as a CoinDCX order-book VWAP for your exact quantity, then the
              best-price guarantee caps or floors it so it is never worse for you than any
              comparable venue — and no provider reported a fee for this pair, so none is estimated
              or charged, because zero brokerage is a property of this module, not an offer.
              Fallback prices are display-only and orders answer 503 without fresh live data.
              Settlement moves balances inside the Prometheus internal ledger between you and the
              arranged liquidity programme; there is no third-party custody transfer in this
              module.
            </p>
          </div>
        </div>
      </div>

      {pendingOrder !== null && (
        <div className="ux-overlay" role="dialog" aria-modal="true" aria-label="Confirm order">
          <div className="ux-modal">
            <div className="ux-modal-head">
              <div>
                <h2 className="ux-modal-title">
                  Confirm {pendingOrder.side === "BUY" ? "buy" : "sell"} of{" "}
                  {formatDecimal(pendingOrder.usdtAmount)} USDT
                </h2>
                <p className="ux-modal-sub">Atomic internal-ledger settlement</p>
              </div>
              <button
                type="button"
                className="ux-icon-btn"
                aria-label="Cancel order"
                onClick={cancelPending}
                disabled={submitting}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="ux-modal-body">
              <div className="ux-modal-callout">
                <b>Settles at the fresh price, not the quoted one.</b> The figures below are the
                current quote. When you confirm, the backend captures a new order-book price and
                settles there — so the INR amount can differ.
                {pendingOrder.guard !== null
                  ? ` Your guard refuses the order unless the fresh price stays ${
                      pendingOrder.side === "BUY" ? "at or below" : "at or above"
                    } ₹${pendingOrder.guard}.`
                  : " No price guard is set."}
              </div>

              <div className="ux-modal-rows">
                <div className="ux-summary-row">
                  <span>USDT volume</span>
                  <b>{pendingOrder.usdtAmount} USDT</b>
                </div>
                <div className="ux-summary-row">
                  <span>Quoted execution price</span>
                  <b>₹{pendingOrder.quotedPrice} / USDT</b>
                </div>
                <div className="ux-summary-row">
                  <span>Reference price</span>
                  <b>
                    {pendingOrder.referencePrice !== null ? `₹${pendingOrder.referencePrice}` : "—"}
                    {referenceBasisLabel(pendingOrder.referenceBasis) !== null && (
                      <span className="hint">{referenceBasisLabel(pendingOrder.referenceBasis)}</span>
                    )}
                  </b>
                </div>
                <div className="ux-summary-row">
                  <span>Savings vs reference</span>
                  <b className={pendingOrder.savings !== null && Number(pendingOrder.savings) < 0 ? "down" : "up"}>
                    {pendingOrder.savings !== null ? signedInr(pendingOrder.savings) : "—"}
                  </b>
                </div>
                <div className="ux-summary-row">
                  <span>Prometheus brokerage</span>
                  <b>₹0.00</b>
                </div>
                <div className="ux-summary-row total">
                  <span>{pendingOrder.side === "BUY" ? "You pay (est.)" : "You receive (est.)"}</span>
                  <b>₹{pendingOrder.inrEstimate}</b>
                </div>
              </div>

              {failure !== null && (
                <div className="ux-modal-failure">
                  <b>
                    {failure.status === 409
                      ? "The order was refused — nothing settled."
                      : failure.status === 503
                        ? "Live pricing is unavailable — no order was placed."
                        : failure.status === 400
                          ? "The order was rejected as invalid."
                          : failure.status === 401
                            ? "Your session expired."
                            : "The order did not go through."}
                  </b>
                  <p>{failure.message}</p>
                  {failure.details.length > 0 && (
                    <ul>
                      {failure.details.map((detail, index) => (
                        <li key={index}>{detail}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              <div className="ux-modal-actions">
                <button
                  type="button"
                  className={`ux-btn ${pendingOrder.side === "BUY" ? "buy" : "sell"}`}
                  onClick={() => void confirmOrder()}
                  disabled={submitting}
                >
                  {submitting && <Loader2 className="w-3.5 h-3.5 ux-spin" />}
                  {submitting ? "Settling…" : "Confirm & place order"}
                </button>
                {failure !== null && failure.status !== 401 && (
                  <button
                    type="button"
                    className="ux-btn ghost"
                    onClick={retryFailed}
                    disabled={submitting}
                  >
                    Try again · same request id
                  </button>
                )}
                <button
                  type="button"
                  className="ux-btn ghost"
                  onClick={cancelPending}
                  disabled={submitting}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
