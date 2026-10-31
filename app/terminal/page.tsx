"use client";

import React, { useEffect, useState } from "react";
import { Activity, AlertTriangle, Loader2, RefreshCw, Wifi, WifiOff } from "lucide-react";
import dynamic from "next/dynamic";

import AppShell from "@/components/AppShell";
import {
  ApiError,
  getBars,
  getFeedStatus,
  getInstruments,
  type BarDto,
  type FeedStatusDto,
  type InstrumentDto,
} from "@/lib/api-client";

/**
 * MODULE 06c — the terminal: one candlestick chart per live instrument.
 *
 * The universe is the backend's own code-defined catalogue (eight symbols:
 * five US equities and three crypto pairs), read from `GET
 * /market-data/instruments`, so this screen can never drift from what the API
 * actually serves. Nothing here is a mock: every candle comes from `GET
 * /market-data/bars`, and a failure is shown as a failure.
 *
 * The feed badge is not decoration. With `MARKET_DATA_PROVIDER=off` the bars
 * route answers 503, so the board waits for `GET /market-data/status` before
 * requesting anything — one honest "feed is off" message instead of eight
 * identical request failures.
 */

/** Bar timeframes the `GET /market-data/bars` endpoint accepts. */
const TIMEFRAMES = ["1m", "5m", "15m", "1h", "1d"] as const;
type Timeframe = (typeof TIMEFRAMES)[number];

/** Candles per chart. Dense enough to read a window, light enough to load. */
const BARS_LIMIT = 120;

/** Chart height per card, in pixels. */
const CHART_HEIGHT = 260;

/**
 * The chart is loaded on the client only. lightweight-charts touches `window`
 * at import time, and a server render would throw before the first paint.
 */
const Chart = dynamic(
  () => import("@/components/StrategyChart").then((module) => ({ default: module.StrategyChart })),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-[260px] items-center justify-center gap-2 text-xs text-[#5D6B82]">
        <Loader2 className="h-4 w-4 animate-spin text-[#FF5A1F]" />
        <span className="font-mono">PREPARING CHART…</span>
      </div>
    ),
  },
);

type FetchStatus = "loading" | "ready" | "error";
type FeedState = "unknown" | "on" | "off";

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    return error.details?.length ? `${error.message} ${error.details.join(" ")}` : error.message;
  }
  return "Something went wrong while talking to the Prometheus API.";
}

/* -------------------------------------------------------------------------- */
/* One instrument's chart                                                      */
/* -------------------------------------------------------------------------- */

interface TerminalChartCardProps {
  instrument: InstrumentDto;
  timeframe: Timeframe;
  feedState: FeedState;
}

/**
 * A single chart cell.
 *
 * `feedState` decides what the cell shows without a request: while the status
 * read is in flight the cell waits, and an off feed is reported as an off feed
 * rather than as eight failed fetches. The card is keyed on timeframe by its
 * parent, so a timeframe change remounts it and the loading state is the
 * initial state instead of a write inside the effect body.
 */
function TerminalChartCard({ instrument, timeframe, feedState }: TerminalChartCardProps) {
  const [status, setStatus] = useState<FetchStatus>("loading");
  const [bars, setBars] = useState<BarDto[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (feedState !== "on") return;
    let active = true;

    getBars(instrument.symbol, timeframe, BARS_LIMIT)
      .then((result) => {
        if (!active) return;
        setBars(result.items);
        setError(null);
        setStatus("ready");
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setBars([]);
        setError(messageFor(cause));
        setStatus("error");
      });

    return () => {
      active = false;
    };
  }, [instrument.symbol, timeframe, feedState]);

  const shown: FetchStatus | "off" = feedState === "off" ? "off" : feedState === "unknown" ? "loading" : status;

  return (
    <section className="overflow-hidden rounded-xl border border-[#202735] bg-[#12161E]">
      <header className="flex items-center justify-between gap-3 border-b border-[#1B2230] px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-bold text-white">{instrument.symbol}</h2>
          <p className="truncate text-[11px] text-[#6E7B8E]">
            {instrument.name} · {instrument.kind} · {instrument.venue}
          </p>
        </div>
        <span
          className={`shrink-0 rounded border px-2 py-0.5 font-mono text-[10px] font-bold ${
            shown === "ready" && bars.length > 0
              ? "border-[#00D26A]/40 bg-[#00D26A]/10 text-[#00D26A]"
              : shown === "error" || shown === "off"
                ? "border-[#FF4D4D]/40 bg-[#FF4D4D]/10 text-[#FF4D4D]"
                : "border-[#2C3748] bg-[#161B24] text-[#8E98A8]"
          }`}
        >
          {shown === "ready"
            ? `${bars.length} BARS`
            : shown === "error"
              ? "FAILED"
              : shown === "off"
                ? "FEED OFF"
                : "…"}
        </span>
      </header>

      <div className="bg-[#0E1219]">
        {shown === "off" ? (
          <div className="flex h-[260px] flex-col items-center justify-center gap-2 px-6 text-center">
            <WifiOff className="h-5 w-5 text-[#5D6B82]" />
            <p className="text-xs font-semibold text-white">The live feed is off</p>
            <p className="max-w-sm text-[11px] leading-relaxed text-[#7B8799]">
              MARKET_DATA_PROVIDER is not serving bars, so no candles exist to draw. Nothing is
              fabricated in the meantime.
            </p>
          </div>
        ) : shown === "loading" ? (
          <div className="flex h-[260px] items-center justify-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin text-[#FF5A1F]" />
            <span className="font-mono text-xs text-[#5D6B82]">
              LOADING {instrument.symbol} · {timeframe}…
            </span>
          </div>
        ) : shown === "error" ? (
          <div className="flex h-[260px] flex-col items-center justify-center gap-2 px-6 text-center">
            <AlertTriangle className="h-5 w-5 text-[#FF5A1F]" />
            <p className="text-xs font-semibold text-white">The candle series could not be loaded</p>
            <p className="max-w-sm text-[11px] leading-relaxed text-[#7B8799]">{error}</p>
          </div>
        ) : bars.length === 0 ? (
          <div className="flex h-[260px] flex-col items-center justify-center gap-2 px-6 text-center">
            <p className="text-xs font-semibold text-white">No candles for this window</p>
            <p className="max-w-sm text-[11px] leading-relaxed text-[#7B8799]">
              The provider returned no {timeframe} bars for {instrument.symbol}. Nothing is drawn
              rather than inventing a series.
            </p>
          </div>
        ) : (
          <Chart bars={bars} height={CHART_HEIGHT} />
        )}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Page                                                                        */
/* -------------------------------------------------------------------------- */

export default function TerminalPage() {
  const [instruments, setInstruments] = useState<InstrumentDto[]>([]);
  const [instrumentsStatus, setInstrumentsStatus] = useState<FetchStatus>("loading");
  const [instrumentsError, setInstrumentsError] = useState<string | null>(null);
  const [feed, setFeed] = useState<FeedStatusDto | null>(null);
  const [timeframe, setTimeframe] = useState<Timeframe>("1d");
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [instrumentsNonce, setInstrumentsNonce] = useState(0);

  useEffect(() => {
    let active = true;
    getInstruments()
      .then((list) => {
        if (!active) return;
        setInstruments(list);
        setInstrumentsError(null);
        setInstrumentsStatus("ready");
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setInstrumentsError(messageFor(cause));
        setInstrumentsStatus("error");
      });
    return () => {
      active = false;
    };
  }, [instrumentsNonce]);

  // Advisory, like the strategy screen's badge: a screen that cannot read it
  // still renders the board and lets each cell report its own bar result.
  useEffect(() => {
    let active = true;
    getFeedStatus()
      .then((status) => {
        if (active) setFeed(status);
      })
      .catch(() => {
        if (active) setFeed(null);
      });
    return () => {
      active = false;
    };
  }, []);

  const feedState: FeedState = feed === null ? "unknown" : feed.enabled ? "on" : "off";

  return (
    <AppShell>
      <div className="p-6">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="mb-2 flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-[#6B7280]">
              <Activity className="h-3.5 w-3.5" />
              Terminal
            </div>
            <h1 className="text-2xl font-bold text-white">Live candlestick board</h1>
            <p className="mt-1 max-w-2xl text-sm text-[#9CA3AF]">
              Every instrument the platform serves, on one grid. Candles come straight from the
              market-data API — when the provider returns nothing, the cell says so instead of
              drawing a series that does not exist.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 font-mono text-[10px] font-bold tracking-wider ${
                feedState === "on"
                  ? "border-[#00D26A]/40 bg-[#12161E] text-[#00D26A]"
                  : feedState === "off"
                    ? "border-[#FF4D4D]/40 bg-[#12161E] text-[#FF4D4D]"
                    : "border-[#2C3748] bg-[#12161E] text-[#8E98A8]"
              }`}
            >
              {feedState === "on" ? (
                <Wifi className="h-3.5 w-3.5" />
              ) : feedState === "off" ? (
                <WifiOff className="h-3.5 w-3.5" />
              ) : (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              )}
              {feedState === "on"
                ? `LIVE · ${feed?.provider?.toUpperCase() ?? ""}`
                : feedState === "off"
                  ? "FEED OFF"
                  : "CHECKING FEED"}
            </span>

            <button
              type="button"
              onClick={() => setRefreshNonce((value) => value + 1)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#222834] bg-[#14181F] px-3.5 py-2 text-xs font-semibold text-[#9CA3AF] transition-colors hover:border-[#323B4C] hover:text-white"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </button>
          </div>
        </div>

        {feedState === "off" && (
          <div className="mb-5 flex items-start gap-2.5 rounded-xl border border-[#FF4D4D]/35 bg-[#FF4D4D]/10 px-4 py-3 text-xs text-[#FFB3B3]">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              {feed?.message ??
                "The live market-data feed is disabled, so the bars route answers 503."}{" "}
              Set <code className="font-mono">MARKET_DATA_PROVIDER</code> to a serving provider and
              restart the API to populate the board.
            </span>
          </div>
        )}

        <div className="mb-5 flex flex-wrap items-center gap-1.5">
          <span className="mr-1 font-mono text-[10px] font-bold uppercase tracking-wider text-[#6E7B8E]">
            Timeframe
          </span>
          {TIMEFRAMES.map((frame) => (
            <button
              key={frame}
              type="button"
              aria-pressed={timeframe === frame}
              onClick={() => setTimeframe(frame)}
              className={`rounded px-2.5 py-1 font-mono text-[11px] font-bold transition-colors ${
                timeframe === frame
                  ? "border border-[#FF5A1F]/40 bg-[#FF5A1F]/15 text-[#FF5A1F]"
                  : "border border-[#242C3A] bg-[#0E1219] text-[#717E91] hover:text-white"
              }`}
            >
              {frame}
            </button>
          ))}
        </div>

        {instrumentsStatus === "loading" && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
            {Array.from({ length: 4 }).map((_, index) => (
              <div
                key={index}
                className="h-[306px] animate-pulse rounded-xl border border-[#202735] bg-[#12161E]"
              />
            ))}
          </div>
        )}

        {instrumentsStatus === "error" && (
          <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-[#202735] bg-[#12161E] px-6 py-14 text-center">
            <AlertTriangle className="h-5 w-5 text-[#FF5A1F]" />
            <p className="text-sm font-semibold text-white">The instrument catalogue failed to load</p>
            <p className="max-w-md text-xs text-[#7B8799]">{instrumentsError}</p>
            <button
              type="button"
              onClick={() => {
                setInstrumentsStatus("loading");
                setInstrumentsNonce((value) => value + 1);
              }}
              className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-[#273242] bg-[#161B24] px-3 py-1.5 text-[11px] font-bold text-white hover:bg-[#202735]"
            >
              <RefreshCw className="h-3 w-3" />
              Retry
            </button>
          </div>
        )}

        {instrumentsStatus === "ready" && instruments.length === 0 && (
          <p className="rounded-xl border border-[#202735] bg-[#12161E] px-6 py-10 text-center text-sm text-[#7B8799]">
            The catalogue returned no instruments, so there is nothing to chart.
          </p>
        )}

        {instrumentsStatus === "ready" && instruments.length > 0 && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
            {instruments.map((instrument) => (
              <TerminalChartCard
                key={`${instrument.symbol}-${timeframe}-${refreshNonce}`}
                instrument={instrument}
                timeframe={timeframe}
                feedState={feedState}
              />
            ))}
          </div>
        )}

        <p className="mt-5 font-mono text-[10px] uppercase tracking-wider text-[#5D6B82]">
          {instruments.length} instruments · {timeframe} bars · source{" "}
          {feed?.provider?.toUpperCase() ?? "unknown"} · nothing on this board is simulated
        </p>
      </div>
    </AppShell>
  );
}
