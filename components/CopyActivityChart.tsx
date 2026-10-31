"use client";

import { useEffect, useRef } from "react";
import {
  AreaSeries,
  ColorType,
  CrosshairMode,
  LineSeries,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type SeriesMarker,
  type UTCTimestamp,
} from "lightweight-charts";

/**
 * MODULE 07 - the two charts of the copy book.
 *
 * WHAT THEY SHOW, AND WHY IT IS THE SAME DATA. A follower who copies two
 * experts has two questions: "what did they trade" and "what did that do to
 * my money". Both are answered from the copy events, which are the one
 * record of what actually happened - the expert's committed fills, the price
 * they executed at, the share this follow took, and what the fill realised.
 * Nothing here is sampled, smoothed or interpolated.
 *
 * THE PRICE PATH IS THE EXPERT'S OWN, NOT A MARKET SERIES. The line is the
 * price each expert fill executed at, in the order it executed. It is not a
 * candle series and does not claim to be one: a candle chart would be a
 * different fact about the market, read from a feed that may not even be
 * configured, and the copy engine's own prices are the ones this book was
 * actually filled at.
 *
 * A SEPARATE MODULE, AS WITH THE OTHER CHART. lightweight-charts touches
 * `window` at import time, so this file is only ever reached through
 * `next/dynamic` with `ssr: false`.
 */

export interface ExpertTrade {
  /** When the expert's fill committed. */
  at: string;
  symbol: string;
  side: "BUY" | "SELL";
  /** The price the fill executed at. */
  price: number;
  /** The quantity that was executed. */
  quantity: number;
}

export interface PnlPoint {
  /** When the fill that produced this figure was consumed. */
  at: string;
  /** The running realised profit and loss. */
  value: number;
}

const CHART_BG = "#0E1219";
const GRID = "#161B24";
const AXIS = "#1E2532";
const TEXT = "#7B8799";
const BRAND = "#FF5A1F";
const GAIN = "#00D26A";
const LOSS = "#FF4D4D";

/**
 * The colour list lives outside this module: the page needs it to write the
 * legend, and importing it from here would pull this browser-only library
 * into the server render.
 */
import { COPY_SYMBOL_COLOURS } from "@/lib/design/copyPalette";

interface MergedTrade {
  time: UTCTimestamp;
  price: number;
  side: "BUY" | "SELL";
  quantity: number;
  fills: number;
}

/**
 * Collapses the fills of one instrument into the points a time series can
 * hold: one point per instant, priced at the last fill there.
 *
 * lightweight-charts requires strictly ascending, unique times, and two fills
 * of the same instrument in the same millisecond would break that. Collapsing
 * them is also the honest reading: at one instant there is one price, and the
 * chart is about the price path, not about how many orders produced it. The
 * fill count rides along so a collapsed point can say so.
 */
function mergeTrades(trades: ExpertTrade[]): MergedTrade[] {
  const byTime = new Map<number, MergedTrade>();

  for (const trade of trades) {
    const timeMs = Date.parse(trade.at);
    if (Number.isNaN(timeMs)) continue;
    if (!Number.isFinite(trade.price) || !Number.isFinite(trade.quantity)) continue;

    const time = Math.floor(timeMs / 1000) as UTCTimestamp;
    const existing = byTime.get(time);

    if (existing === undefined) {
      byTime.set(time, {
        time,
        price: trade.price,
        side: trade.side,
        quantity: trade.quantity,
        fills: 1,
      });
    } else {
      existing.price = trade.price;
      existing.side = trade.side;
      existing.quantity += trade.quantity;
      existing.fills += 1;
    }
  }

  return [...byTime.values()].sort((left, right) => left.time - right.time);
}

function markerFor(merge: MergedTrade): SeriesMarker<UTCTimestamp> {
  const isBuy = merge.side === "BUY";
  const amount = merge.quantity.toLocaleString(undefined, { maximumFractionDigits: 8 });

  return {
    time: merge.time,
    position: isBuy ? "belowBar" : "aboveBar",
    color: isBuy ? GAIN : LOSS,
    shape: isBuy ? "arrowUp" : "arrowDown",
    text:
      `${isBuy ? "BUY" : "SELL"} ${amount}` +
      (merge.fills > 1 ? ` (${merge.fills} fills)` : ""),
  };
}

/**
 * The expert's trades: one price path per instrument, with a marker on every
 * buy and every sell.
 */
export function ExpertTradesChart({ trades, height = 300 }: { trades: ExpertTrade[]; height?: number }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<Array<{ series: ISeriesApi<"Line"> }>>([]);
  const tradesRef = useRef(trades);
  tradesRef.current = trades;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      height,
      layout: {
        background: { type: ColorType.Solid, color: CHART_BG },
        textColor: TEXT,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      },
      grid: {
        vertLines: { color: GRID },
        horzLines: { color: GRID },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "#3E4A5C", labelBackgroundColor: BRAND },
        horzLine: { color: "#3E4A5C", labelBackgroundColor: BRAND },
      },
      rightPriceScale: { borderColor: AXIS },
      timeScale: { borderColor: AXIS, timeVisible: true, secondsVisible: false },
      handleScale: { axisPressedMouseMove: true },
    });

    chartRef.current = chart;

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width && width > 0) chart.applyOptions({ width, height });
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = [];
    };
  }, [height]);

  /**
   * The data effect rebuilds the series rather than updating them: an
   * instrument the book stops trading has to lose its line, and a series set
   * cannot be emptied without also emptying the chart.
   */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    for (const entry of seriesRef.current) {
      chart.removeSeries(entry.series);
    }
    seriesRef.current = [];

    const bySymbol = new Map<string, ExpertTrade[]>();
    for (const trade of tradesRef.current) {
      const list = bySymbol.get(trade.symbol) ?? [];
      list.push(trade);
      bySymbol.set(trade.symbol, list);
    }

    const ordered = [...bySymbol.entries()].sort((left, right) =>
      left[0].localeCompare(right[0]),
    );

    ordered.forEach(([symbol, symbolTrades], index) => {
      const colour = COPY_SYMBOL_COLOURS[index % COPY_SYMBOL_COLOURS.length];
      const merged = mergeTrades(symbolTrades);

      const series = chart.addSeries(LineSeries, {
        color: colour,
        lineWidth: 2,
        priceFormat: { type: "price", precision: 2, minMove: 0.01 },
        title: symbol,
        lastValueVisible: true,
      });

      series.setData(merged.map((merge) => ({ time: merge.time, value: merge.price })));

      createSeriesMarkers(
        series,
        merged.map((merge) => markerFor(merge)),
      );

      seriesRef.current.push({ series });
    });

    if (ordered.length > 0) chart.timeScale().fitContent();
  }, [trades]);

  return (
    <div
      ref={containerRef}
      style={{ width: "100%", height }}
      aria-label="Expert trades chart"
    />
  );
}

/**
 * The copy book's realised profit and loss over time.
 *
 * Every point is a consumed fill, and the value on it is the running total
 * after that fill. A buy realises nothing, so it lands on the same value as
 * the fill before it: the line stays flat across it rather than stepping, and
 * the flatness is the honest reading - the money moved from cash into a
 * position, it did not appear or vanish.
 */
export function CopyPnlChart({ points, height = 220 }: { points: PnlPoint[]; height?: number }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Area"> | null>(null);
  const pointsRef = useRef(points);
  pointsRef.current = points;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      height,
      layout: {
        background: { type: ColorType.Solid, color: CHART_BG },
        textColor: TEXT,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      },
      grid: {
        vertLines: { color: GRID },
        horzLines: { color: GRID },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "#3E4A5C", labelBackgroundColor: BRAND },
        horzLine: { color: "#3E4A5C", labelBackgroundColor: BRAND },
      },
      rightPriceScale: { borderColor: AXIS },
      timeScale: { borderColor: AXIS, timeVisible: true, secondsVisible: false },
      handleScale: { axisPressedMouseMove: true },
    });

    const series = chart.addSeries(AreaSeries, {
      lineColor: BRAND,
      lineWidth: 2,
      topColor: "rgba(255, 90, 31, 0.28)",
      bottomColor: "rgba(255, 90, 31, 0.02)",
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
    });

    chartRef.current = chart;
    seriesRef.current = series;

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width && width > 0) chart.applyOptions({ width, height });
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [height]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;

    const byTime = new Map<UTCTimestamp, number>();
    for (const point of pointsRef.current) {
      const timeMs = Date.parse(point.at);
      if (Number.isNaN(timeMs)) continue;
      if (!Number.isFinite(point.value)) continue;
      byTime.set(Math.floor(timeMs / 1000) as UTCTimestamp, point.value);
    }

    const data = [...byTime.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([time, value]) => ({ time, value }));

    series.setData(data);
    if (data.length > 0) chartRef.current?.timeScale().fitContent();
  }, [points]);

  return (
    <div
      ref={containerRef}
      style={{ width: "100%", height }}
      aria-label="Realised profit and loss chart"
    />
  );
}
