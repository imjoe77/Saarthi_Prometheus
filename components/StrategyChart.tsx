"use client";

import { useEffect, useRef } from "react";
import {
  ColorType,
  CrosshairMode,
  CandlestickSeries,
  HistogramSeries,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";

import type { BarDto } from "@/lib/api-client";

/**
 * MODULE 06c — the candlestick chart behind the expert screen, now shared by
 * every surface that has a real bar series to draw (the strategy detail page,
 * the copy-trading detail pane and the `/terminal` board).
 *
 * A SEPARATE MODULE ON PURPOSE. lightweight-charts touches `window` when it is
 * imported, so this file is loaded on the client only through `next/dynamic`.
 * Keeping it apart also keeps each page's data fetching free of any chart type,
 * which is what lets a page render an empty-state panel without ever
 * constructing a chart instance.
 *
 * NOTHING IS INVENTED. The series is fed exactly the bars the API returned, in
 * the order returned, with the source's own decimal strings parsed once. A bar
 * whose time cannot be parsed is skipped rather than repositioned: a candle at
 * the wrong instant is worse than a gap.
 *
 * The volume histogram shares the time axis but not the price axis, so a large
 * equity volume number cannot compress the candles into an unreadable band.
 */

interface StrategyChartProps {
  bars: BarDto[];
  height?: number;
  /**
   * Fills drawn on the series. A price on its own is a number; a price on a
   * candle is a trade, and the arrow says which way it went.
   */
  markers?: ChartMarker[];
}

/** One fill, placed on the candle it happened in. */
export interface ChartMarker {
  /** The bar the marker sits on, in seconds since the epoch. */
  time: UTCTimestamp;
  side: "LONG" | "SHORT";
  /** The label drawn beside the marker. */
  text?: string;
}

interface CandlePoint {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface VolumePoint {
  time: UTCTimestamp;
  value: number;
  color: string;
}

const UP_COLOR = "#00D26A";
const DOWN_COLOR = "#FF4D4D";

export function StrategyChart({ bars, height = 420, markers }: StrategyChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const markerRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      height,
      layout: {
        background: { type: ColorType.Solid, color: "#0E1219" },
        textColor: "#7B8799",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      },
      grid: {
        vertLines: { color: "#161B24" },
        horzLines: { color: "#161B24" },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "#3E4A5C", labelBackgroundColor: "#FF5A1F" },
        horzLine: { color: "#3E4A5C", labelBackgroundColor: "#FF5A1F" },
      },
      rightPriceScale: { borderColor: "#1E2532" },
      timeScale: {
        borderColor: "#1E2532",
        timeVisible: true,
        secondsVisible: false,
      },
      handleScale: { axisPressedMouseMove: true },
    });

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: UP_COLOR,
      downColor: DOWN_COLOR,
      borderVisible: false,
      wickUpColor: UP_COLOR,
      wickDownColor: DOWN_COLOR,
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
    });

    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
      lastValueVisible: false,
      priceLineVisible: false,
    });

    // The volume scale is pinned to the bottom fifth of the pane so it never
    // competes with the candles for vertical room.
    chart.priceScale("volume").applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
    });

    chartRef.current = chart;
    candleRef.current = candles;
    volumeRef.current = volume;
    markerRef.current = createSeriesMarkers(candles, []);

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width && width > 0) {
        chart.applyOptions({ width, height });
      }
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volumeRef.current = null;
      markerRef.current = null;
    };
  }, [height]);

  /**
   * Data is applied in a separate effect so a new bar batch does not tear down
   * the chart - doing that on every poll would reset the user's pan and zoom.
   */
  useEffect(() => {
    const candles = candleRef.current;
    const volume = volumeRef.current;
    const chart = chartRef.current;
    if (!candles || !volume || !chart) return;

    const candleData: CandlePoint[] = [];
    const volumeData: VolumePoint[] = [];
    let previousClose: number | null = null;

    for (const bar of bars) {
      const timeMs = Date.parse(bar.time);
      if (Number.isNaN(timeMs)) continue;

      const open = Number(bar.open);
      const high = Number(bar.high);
      const low = Number(bar.low);
      const close = Number(bar.close);
      const size = Number(bar.volume);
      if (![open, high, low, close].every((value) => Number.isFinite(value))) continue;

      const time = Math.floor(timeMs / 1000) as UTCTimestamp;
      candleData.push({ time, open, high, low, close });
      volumeData.push({
        time,
        value: Number.isFinite(size) ? size : 0,
        color: previousClose !== null && close < previousClose ? DOWN_COLOR : UP_COLOR,
      });
      previousClose = close;
    }

    candles.setData(candleData);
    volume.setData(volumeData);
    chart.timeScale().fitContent();
  }, [bars]);

  /**
   * The fills are drawn on the series, not beside it. A marker whose time is
   * outside the loaded window is simply not drawn - the chart never stretches
   * a window to make a marker fit.
   */
  useEffect(() => {
    const plugin = markerRef.current;
    if (!plugin) return;

    const list: SeriesMarker<Time>[] = (markers ?? []).map((marker) => {
      const isLong = marker.side === "LONG";
      return {
        time: marker.time,
        position: isLong ? "belowBar" : "aboveBar",
        shape: isLong ? "arrowUp" : "arrowDown",
        color: isLong ? UP_COLOR : DOWN_COLOR,
        text: marker.text ?? marker.side,
      };
    });

    plugin.setMarkers(list);
  }, [markers]);

  return <div ref={containerRef} style={{ width: "100%", height }} aria-label="Candlestick chart" />;
}
