import React from 'react';
import { useEffect, useRef } from 'react';
import {
  createChart,
  IChartApi,
  UTCTimestamp,
  ISeriesApi,
  IPriceLine,
} from 'lightweight-charts';

type Candle = { time: string; open: number; high: number; low: number; close: number };
type EmaPoint = { time: number; value: number | null };
type Signal = { time: string; signalType: 'ENTRY' | 'EXIT'; side: 'BUY' | 'SELL' | 'FLAT'; price: number; reason?: string };

type Props = {
  candles: Candle[];
  ema9: EmaPoint[];
  ema21: EmaPoint[];
  showFibo?: boolean;
  signals?: Signal[];
};

function toSeriesCandles(candles: Candle[]) {
  return candles.map((c) => ({
    time: Math.floor(new Date(c.time).getTime() / 1000) as UTCTimestamp,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
  }));
}

function computeSwing(candles: Candle[], lookback = 100) {
  const arr = candles.slice(-lookback);
  let swingHigh = -Infinity,
    swingLow = Infinity;
  for (const c of arr) {
    if (c.high > swingHigh) swingHigh = c.high;
    if (c.low < swingLow) swingLow = c.low;
  }
  return { swingHigh, swingLow };
}

function fmtTime(ts?: number) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  return `${hh}:${mm} (${dd}/${mo})`;
}

export default function CandleChart({ candles, ema9, ema21, showFibo, signals = [] }: Props) {
  const divRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const ema9Ref = useRef<ISeriesApi<'Line'> | null>(null);
  const ema21Ref = useRef<ISeriesApi<'Line'> | null>(null);
  const fiboLinesRef = useRef<IPriceLine[]>([]);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);

  // Init / Destroy
  useEffect(() => {
    if (!divRef.current) return;

    const chart = createChart(divRef.current, {
      height: 380,
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false },
      layout: { background: { type: 'Solid', color: 'white' } },
      crosshair: { mode: 1 }, // Normal
    });

    const candleSeries = chart.addCandlestickSeries();
    const ema9Series = chart.addLineSeries({ lineWidth: 2 });
    const ema21Series = chart.addLineSeries({ lineWidth: 2 });

    chartRef.current = chart;
    candleRef.current = candleSeries;
    ema9Ref.current = ema9Series;
    ema21Ref.current = ema21Series;

    // Tooltip overlay (mais compacto p/ não "zoar" layout)
    const tip = document.createElement('div');
    tip.style.position = 'absolute';
    tip.style.bottom = '8px';
    tip.style.right = '8px';
    tip.style.padding = '4px 8px';
    tip.style.background = 'rgba(0,0,0,0.7)';
    tip.style.color = '#fff';
    tip.style.fontSize = '11px';
    tip.style.borderRadius = '6px';
    tip.style.pointerEvents = 'none';
    tip.style.whiteSpace = 'nowrap';
    tip.style.zIndex = '2';
    tip.style.transition = 'opacity 100ms ease';
    tip.style.opacity = '0';
    (divRef.current as HTMLDivElement).appendChild(tip);
    tooltipRef.current = tip;

    chart.subscribeCrosshairMove((param) => {
      if (!tooltipRef.current || !candleRef.current) return;

      const seriesData = param.seriesData.get(candleRef.current as any) as any;
      const time = typeof param.time === 'number' ? (param.time as number) : undefined;

      if (seriesData && time) {
        const o = seriesData.open ?? '';
        const h = seriesData.high ?? '';
        const l = seriesData.low ?? '';
        const c = seriesData.close ?? '';
        tooltipRef.current.textContent = `${fmtTime(time)} • O:${o} H:${h} L:${l} C:${c}`;
        tooltipRef.current.style.opacity = '1';
      } else {
        tooltipRef.current.style.opacity = '0';
      }
    });

    // Responsive width
    const ro = new ResizeObserver(() => {
      if (!divRef.current || !chartRef.current) return;
      const w = divRef.current.clientWidth || 0;
      if (w > 0) chartRef.current.applyOptions({ width: w });
    });
    ro.observe(divRef.current);
    resizeObserverRef.current = ro;

    // Initial width
    const w = divRef.current.clientWidth || 0;
    if (w > 0) chart.applyOptions({ width: w });

    return () => {
      try {
        fiboLinesRef.current.forEach((l) => candleSeries.removePriceLine(l));
      } catch {}
      fiboLinesRef.current = [];
      if (resizeObserverRef.current && divRef.current) {
        resizeObserverRef.current.unobserve(divRef.current);
        resizeObserverRef.current.disconnect();
      }
      if (tooltipRef.current && divRef.current?.contains(tooltipRef.current)) {
        divRef.current.removeChild(tooltipRef.current);
      }
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      ema9Ref.current = null;
      ema21Ref.current = null;
      resizeObserverRef.current = null;
      tooltipRef.current = null;
    };
  }, []);

  // Update data + Fibonacci + Markers (sinais)
  useEffect(() => {
    if (!candleRef.current) return;

    // Candles
    const cs = toSeriesCandles(candles);
    candleRef.current.setData(cs);

    // EMA 9
    if (ema9Ref.current) {
      const data = ema9
        .filter((p) => p.value != null)
        .map((p) => ({ time: p.time as UTCTimestamp, value: p.value as number }));
      ema9Ref.current.setData(data);
    }

    // EMA 21
    if (ema21Ref.current) {
      const data = ema21
        .filter((p) => p.value != null)
        .map((p) => ({ time: p.time as UTCTimestamp, value: p.value as number }));
      ema21Ref.current.setData(data);
    }

    // Clear previous Fibonacci lines
    try {
      fiboLinesRef.current.forEach((l) => candleRef.current?.removePriceLine(l));
    } catch {}
    fiboLinesRef.current = [];

    // Draw Fibonacci retracements
    if (showFibo && candles.length > 2) {
      const { swingHigh, swingLow } = computeSwing(candles, 100);
      if (isFinite(swingHigh) && isFinite(swingLow) && swingHigh > swingLow) {
        const range = swingHigh - swingLow;
        const levels = [
          { label: '23.6%', price: swingHigh - range * 0.236 },
          { label: '38.2%', price: swingHigh - range * 0.382 },
          { label: '50%',   price: swingHigh - range * 0.5 },
          { label: '61.8%', price: swingHigh - range * 0.618 },
          { label: '78.6%', price: swingHigh - range * 0.786 },
        ];
        for (const lvl of levels) {
          const line = candleRef.current.createPriceLine({
            price: lvl.price,
            title: `Fibo ${lvl.label}`,
            lineWidth: 1,
          });
          fiboLinesRef.current.push(line);
        }
      }
    }

    // ---- Markers de Sinais (compactos p/ não "quebrar" o layout) ----
    const markers = (signals || []).map((s) => {
      const t = Math.floor(new Date(s.time).getTime() / 1000) as UTCTimestamp;

      if (s.signalType === 'ENTRY' && s.side === 'BUY') {
        return {
          time: t,
          position: 'belowBar' as const,
          color: '#22c55e',
          shape: 'arrowUp' as const,
          text: 'B', // curto
        };
      }
      if (s.signalType === 'ENTRY' && s.side === 'SELL') {
        return {
          time: t,
          position: 'aboveBar' as const,
          color: '#ef4444',
          shape: 'arrowDown' as const,
          text: 'S', // curto
        };
      }
      // EXIT
      return {
        time: t,
        position: 'inBar' as const,
        color: '#6b7280',
        shape: 'circle' as const,
        text: 'X',
      };
    });

    candleRef.current.setMarkers(markers);
  }, [candles, ema9, ema21, showFibo, signals]);

  return (
    <div
      ref={divRef}
      style={{
        width: '100%',
        height: 380,
        position: 'relative',
        overflow: 'hidden', // evita que tooltip/markers causem overflow no card
      }}
    />
  );
}
