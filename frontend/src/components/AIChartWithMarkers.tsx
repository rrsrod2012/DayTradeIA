import React from "react";
import { createChart, IChartApi, UTCTimestamp } from "lightweight-charts";
import { fetchCandles } from "../services/api";
import * as AIStoreModule from "../store/ai";
const useAIStore: any =
  (AIStoreModule as any).useAIStore ?? (AIStoreModule as any).default;

const TZ = "America/Sao_Paulo";

/* ---------- Formatadores de data/hora em BRT ---------- */
const fmtDateShortBRT = new Intl.DateTimeFormat("pt-BR", {
  timeZone: TZ,
  year: "2-digit",
  month: "2-digit",
  day: "2-digit",
});
const fmtTimeBRT = new Intl.DateTimeFormat("pt-BR", {
  timeZone: TZ,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
const fmtTimeNoSecBRT = new Intl.DateTimeFormat("pt-BR", {
  timeZone: TZ,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

// usado pelo crosshair/tooltip
function timeFormatterBRT(t: any): string {
  if (typeof t === "number") {
    const d = new Date(t * 1000);
    return fmtTimeBRT.format(d); // HH:mm:ss em BRT
  }
  if (t && typeof t === "object" && "year" in t && "month" in t && "day" in t) {
    const d = new Date(Date.UTC((t as any).year, (t as any).month - 1, (t as any).day));
    return fmtDateShortBRT.format(d); // dd/mm/aa em BRT
  }
  return String(t ?? "");
}

// usado pelos rótulos do eixo de tempo
function tickMarkFormatterBRT(time: any /* Time */, _tickType: any): string {
  if (typeof time === "number") {
    // time = UTCTimestamp (segundos)
    const d = new Date(time * 1000);
    return fmtTimeNoSecBRT.format(d); // HH:mm
  }
  if (time && typeof time === "object" && "year" in time) {
    // BusinessDay
    const d = new Date(Date.UTC(time.year, time.month - 1, time.day));
    return fmtDateShortBRT.format(d); // dd/mm/aa
  }
  return String(time ?? "");
}

function isoToUtcTs(iso: string | undefined | null): UTCTimestamp | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.floor(t / 1000) as UTCTimestamp;
}

// Normaliza SELL/BUY de forma agressiva (não deixa SELL virar outra coisa)
function normSide(raw: any): "BUY" | "SELL" | "FLAT" {
  const s = String(raw ?? "")
    .trim()
    .toUpperCase();
  if (
    s === "SELL" ||
    s === "SHORT" ||
    s === "S" ||
    s === "-1" ||
    s === "DOWN" ||
    s.includes("SELL") ||
    s.includes("SHORT")
  )
    return "SELL";
  if (
    s === "BUY" ||
    s === "LONG" ||
    s === "B" ||
    s === "1" ||
    s === "UP" ||
    s.includes("BUY") ||
    s.includes("LONG")
  )
    return "BUY";
  if (s === "FLAT" || s === "NEUTRAL" || s === "0") return "FLAT";
  // fallback: se não reconheceu, não elimina; assume BUY para não sumir
  return "BUY";
}

type Marker = ReturnType<
  ReturnType<IChartApi["addCandlestickSeries"]>["setMarkers"]
> extends void
  ? {
    time: UTCTimestamp;
    position: "aboveBar" | "belowBar";
    color: string;
    shape: any;
    text?: string;
    size?: number;
  }
  : never;

export default function AIChartWithMarkers() {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const chartRef = React.useRef<IChartApi | null>(null);
  const seriesRef = React.useRef<ReturnType<
    IChartApi["addCandlestickSeries"]
  > | null>(null);

  // Tempos existentes na série (em segundos UTC), em ordem asc
  const candleTimesRef = React.useRef<UTCTimestamp[]>([]);

  const projectedRaw = useAIStore((s) => s.projected);
  const confirmedRaw = useAIStore((s) => s.confirmed);
  const params = useAIStore((s) => s.lastParams);

  React.useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;

    const chart = createChart(el, {
      height: 420,
      layout: {
        textColor: "#222",
        background: {
          color:
            getComputedStyle(document.body).getPropertyValue("--bs-body-bg") ||
            "#fff",
        },
      },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      rightPriceScale: { borderVisible: false },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: { mode: 0 },
      // crosshair/tooltip (não afeta eixo)
      localization: {
        locale: "pt-BR",
        timeFormatter: (t: any) => timeFormatterBRT(t),
      } as any,
    });

    // >>> AQUI: rótulos do eixo de tempo em BRT
    chart.timeScale().applyOptions({
      tickMarkFormatter: (time: any, tickType: any, _locale?: string) =>
        tickMarkFormatterBRT(time, tickType),
    } as any);

    const series = chart.addCandlestickSeries({
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderUpColor: "#22c55e",
      borderDownColor: "#ef4444",
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444",
    });

    chartRef.current = chart;
    seriesRef.current = series;

    const ro = new ResizeObserver(() =>
      chart.applyOptions({ width: el.clientWidth })
    );
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      candleTimesRef.current = [];
    };
  }, []);

  // Carrega candles e garante ordenação por tempo
  React.useEffect(() => {
    (async () => {
      if (!params || !seriesRef.current) return;
      const { symbol, timeframe, from, to } = params;
      try {
        const candles = await fetchCandles({
          symbol,
          timeframe,
          from,
          to,
          limit: 5000,
        });
        const data = candles
          .map((c) => ({
            time: isoToUtcTs(c.time),
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
          }))
          .filter((d) => d.time !== null) as Array<{
            time: UTCTimestamp;
            open: number;
            high: number;
            low: number;
            close: number;
          }>;

        data.sort((a, b) => (a.time as number) - (b.time as number));
        seriesRef.current!.setData(data);
        candleTimesRef.current = data.map((d) => d.time);
        chartRef.current?.timeScale().fitContent();

        if (process.env.NODE_ENV !== "production") {
          const first = candleTimesRef.current[0];
          const last =
            candleTimesRef.current[candleTimesRef.current.length - 1];
          // eslint-disable-next-line no-console
          console.log("[AIChart] candles range (UTC seconds)", {
            count: candleTimesRef.current.length,
            first,
            last,
            first_brt: first ? fmtTimeBRT.format(new Date((first as number) * 1000)) : null,
            last_brt: last ? fmtTimeBRT.format(new Date((last as number) * 1000)) : null,
          });
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("[AIChartWithMarkers] erro carregando candles", e);
      }
    })();
  }, [params?.symbol, params?.timeframe, params?.from, params?.to]);

  // Snap do timestamp para um candle existente (se necessário)
  const snapToExistingBar = React.useCallback(
    (ts: UTCTimestamp | null): UTCTimestamp | null => {
      if (ts == null) return null;
      const arr = candleTimesRef.current;
      if (!arr.length) return null;
      // caso mais comum: se já existir exatamente, retorna
      let lo = 0,
        hi = arr.length - 1;
      if (ts <= arr[lo]) return arr[lo];
      if (ts >= arr[hi]) return arr[hi];
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const v = arr[mid] as number;
        if (v === ts) return arr[mid];
        if (v < (ts as number)) lo = mid + 1;
        else hi = mid - 1;
      }
      const prev = arr[Math.max(0, hi)];
      const next = arr[Math.min(arr.length - 1, lo)];
      return Math.abs((prev as number) - (ts as number)) <=
        Math.abs((next as number) - (ts as number))
        ? prev
        : next;
    },
    []
  );

  // Aplica markers (Projetados + Confirmados) com clamp de futuro
  const [diag, setDiag] = React.useState<{
    srcBuy: number;
    srcSell: number;
    plottedBuy: number;
    plottedSell: number;
    droppedByTime: number;
  }>({
    srcBuy: 0,
    srcSell: 0,
    plottedBuy: 0,
    plottedSell: 0,
    droppedByTime: 0,
  });

  React.useEffect(() => {
    if (!seriesRef.current) return;

    const projSrc = Array.isArray(projectedRaw) ? projectedRaw : [];
    const confSrc = Array.isArray(confirmedRaw) ? confirmedRaw : [];

    // Contadores de origem (do store) — antes de qualquer transformação
    let srcBuy = 0,
      srcSell = 0;

    // Limites temporais: agora (UTC) e extremos da série de candles
    const nowTs = Math.floor(Date.now() / 1000) as UTCTimestamp;
    const arr = candleTimesRef.current;
    const firstBar = arr.length ? (arr[0] as number) : null;
    const lastBar = arr.length ? (arr[arr.length - 1] as number) : null;

    const inRange = (ts: UTCTimestamp | null) => {
      if (ts == null) return false;
      if (firstBar != null && ts < firstBar) return false;
      if (lastBar != null && ts > lastBar) return false;
      if (ts > (nowTs as number)) return false; // clamp “no futuro”
      return true;
    };

    // ---------- Projetados ----------
    const projMarkers: Marker[] = projSrc
      .map((r, idx) => {
        const side = normSide((r as any).side);
        if (side === "BUY") srcBuy++;
        else if (side === "SELL") srcSell++;
        const tsRaw = isoToUtcTs((r as any).time);
        if (!inRange(tsRaw)) return null;
        const ts = snapToExistingBar(tsRaw);
        if (ts == null) return null;

        const isBuy = side === "BUY";
        const color = isBuy ? "#16a34a" : "#dc2626";
        const shape = isBuy ? "arrowUp" : "arrowDown";

        const prob =
          (r as any).probHit != null
            ? `${((r as any).probHit * 100).toFixed(1)}%`
            : "-";
        const ev =
          (r as any).expectedValuePoints != null
            ? `${Number((r as any).expectedValuePoints).toFixed(2)} pts`
            : "-";

        return {
          time: ts,
          position: isBuy ? ("belowBar" as const) : ("aboveBar" as const),
          color,
          shape: shape as any,
          text: `PROJ ${isBuy ? "BUY" : "SELL"} • Prob ${prob} • EV ${ev}`,
          size: 1,
          // @ts-ignore
          __k: `p${idx}`,
          // @ts-ignore
          __isBuy: isBuy,
        } as any;
      })
      .filter(Boolean) as any;

    // ---------- Confirmados ----------
    const confMarkers: Marker[] = confSrc
      .map((s, idx) => {
        const side = normSide((s as any).side);
        const tsRaw = isoToUtcTs((s as any).time);
        if (!inRange(tsRaw)) return null;
        const ts = snapToExistingBar(tsRaw);
        if (ts == null) return null;

        const isBuy = side === "BUY";
        const color = isBuy ? "#2563eb" : "#f59e0b";
        return {
          time: ts,
          position: isBuy ? ("belowBar" as const) : ("aboveBar" as const),
          color,
          shape: "circle" as any,
          text: `CONF ${isBuy ? "BUY" : "SELL"}${(s as any).note ? ` • ${(s as any).note}` : ""
            }`,
          size: 1,
          // @ts-ignore
          __k: `c${idx}`,
          // @ts-ignore
          __isBuy: isBuy,
        } as any;
      })
      .filter(Boolean) as any;

    // Junta e ordena (asc); em empate, circles (confirmados) antes de setas (projetados)
    const all: (Marker & any)[] = [...projMarkers, ...confMarkers];
    all.sort((a, b) => {
      const dt = (a.time as number) - (b.time as number);
      if (dt !== 0) return dt;
      const ash = String(a.shape);
      const bsh = String(b.shape);
      if (ash === bsh) {
        return String(a.__k || "").localeCompare(String(b.__k || "")); // estável
      }
      if (ash === "circle") return -1;
      if (bsh === "circle") return 1;
      return 0;
    });

    // Limpa campos internos
    const clean = all.map(({ __k, __isBuy, ...rest }) => rest);

    // Aplica
    try {
      seriesRef.current.setMarkers(clean as any);
    } catch (err) {
      const onlyGood = clean.filter((m) => Number.isFinite(m.time as any));
      onlyGood.sort((a, b) => (a.time as number) - (b.time as number));
      seriesRef.current.setMarkers(onlyGood as any);
      // eslint-disable-next-line no-console
      console.warn(
        "[AIChartWithMarkers] fallback markers por tempo inválido",
        err
      );
    }

    // Diagnóstico (considerando projetados para manter compat com seu log atual)
    const plottedBuy = projMarkers.filter(
      (m: any) => m.__isBuy === true
    ).length;
    const plottedSell = projMarkers.filter(
      (m: any) => m.__isBuy === false
    ).length;
    const droppedByTime =
      projSrc.filter((r: any) => r && r.time).length - projMarkers.length;

    setDiag({ srcBuy, srcSell, plottedBuy, plottedSell, droppedByTime });

    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.log("[AIChart] diag", {
        srcBuy,
        srcSell,
        plottedBuy,
        plottedSell,
        droppedByTime,
      });
    }
  }, [projectedRaw, confirmedRaw, snapToExistingBar]);

  return (
    <div className="container my-3">
      <div className="card shadow-sm border-0">
        <div className="card-body">
          <div className="d-flex align-items-center gap-2 mb-2">
            <h6 className="mb-0">
              Candles + Marcadores (Projetados & Confirmados)
            </h6>
            <div className="text-muted small">
              {/* params apenas informativo */}
            </div>
          </div>
          <div ref={containerRef} style={{ width: "100%", height: 420 }} />
          <div className="text-muted small mt-2 d-flex flex-wrap gap-3">
            <span className="me-3">
              Projetados: <span className="text-success">BUY ↑</span> /{" "}
              <span className="text-danger">SELL ↓</span>
            </span>
            <span>
              Confirmados: <span style={{ color: "#2563eb" }}>BUY ●</span> /{" "}
              <span style={{ color: "#f59e0b" }}>SELL ●</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
