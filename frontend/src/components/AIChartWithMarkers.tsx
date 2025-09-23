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

// usado nos tooltips de candle
function timeFormatterBRT(time: any /* Time */): string {
  if (typeof time === "number") {
    const d = new Date(time * 1000);
    return fmtDateShortBRT.format(d) + " " + fmtTimeBRT.format(d);
  }
  if (time && typeof time === "object" && "year" in time) {
    const d = new Date(Date.UTC(time.year, time.month - 1, time.day));
    return fmtDateShortBRT.format(d) + " 00:00:00";
  }
  return String(time ?? "");
}

// usado nos rótulos do tooltip custom
function timeToLabelBRT(time: any /* Time */): string {
  if (typeof time === "number") {
    const d = new Date(time * 1000);
    return fmtDateShortBRT.format(d) + " " + fmtTimeNoSecBRT.format(d); // dd/mm/aa HH:mm
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

// ----- QS helpers (usar mesmos flags do painel) -----
function parseQS() {
  const sp =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search)
      : new URLSearchParams();
  const entriesOnly = (sp.get("entriesOnly") ?? "1").trim() !== "0";
  const reStr = sp.get("reEntryBars");
  const reEntryBars =
    reStr != null && reStr !== "" && Number.isFinite(Number(reStr))
      ? Number(reStr)
      : NaN;
  const syncWithTrades = (sp.get("syncWithTrades") ?? "1").trim() !== "0";
  const nextOpenEntry = (sp.get("nextOpenEntry") ?? "1").trim() !== "0";
  return { entriesOnly, reEntryBars, syncWithTrades, nextOpenEntry };
}

function tfToMinutes(tf?: string | null) {
  const s = String(tf || "").trim().toUpperCase();
  if (s === "M1") return 1;
  if (s === "M5") return 5;
  if (s === "M15") return 15;
  if (s === "M30") return 30;
  if (s === "H1") return 60;
  const m = s.match(/^M(\d+)$/);
  if (m) return Math.max(1, Number(m[1]));
  return 1;
}

function minutesBetween(a?: string | null, b?: string | null) {
  if (!a || !b) return Infinity;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return Infinity;
  return Math.abs(tb - ta) / 60000;
}

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
    shape:
    | "circle"
    | "square"
    | "arrowUp"
    | "arrowDown"
    | "arrowUp"
    | "arrowDown";
    text?: string;
    size?: number;
  }
  : never;

function AIChartWithMarkers() {
  // Controles locais para alternar entriesOnly via URL e re-renderizar
  const [, __forceRerender] = React.useReducer((c) => c + 1, 0);
  const { entriesOnly, reEntryBars, syncWithTrades, nextOpenEntry } = parseQS();
  const setQS = React.useCallback((patch: Partial<{ entriesOnly: boolean; reEntryBars: number | string | null; syncWithTrades: boolean; nextOpenEntry: boolean; }>) => {
    if (typeof window === "undefined") return;
    const sp = new URLSearchParams(window.location.search);
    if (patch.entriesOnly !== undefined) sp.set("entriesOnly", patch.entriesOnly ? "1" : "0");
    if (patch.syncWithTrades !== undefined) sp.set("syncWithTrades", patch.syncWithTrades ? "1" : "0");
    if (patch.nextOpenEntry !== undefined) sp.set("nextOpenEntry", patch.nextOpenEntry ? "1" : "0");
    if (patch.reEntryBars !== undefined) {
      const v: any = patch.reEntryBars;
      if (v === null || v === "" || (typeof v === "number" && !Number.isFinite(v))) sp.delete("reEntryBars");
      else sp.set("reEntryBars", String(v));
    }
    const url = window.location.pathname + "?" + sp.toString();
    window.history.replaceState(null, "", url);
    __forceRerender();
  }, []);

  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const chartRef = React.useRef<IChartApi | null>(null);
  const seriesRef = React.useRef<ReturnType<IChartApi["addCandlestickSeries"]> | null>(null);

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
      },
    });

    const series = chart.addCandlestickSeries({
      upColor: "#16a34a",
      downColor: "#ef4444",
      borderVisible: false,
      wickUpColor: "#16a34a",
      wickDownColor: "#ef4444",
    });

    chart.timeScale().fitContent();

    chartRef.current = chart;
    seriesRef.current = series;

    // resize
    const ro = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect();
      chart.applyOptions({ width: Math.floor(rect.width) });
    });
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
        console.warn("[AIChartWithMarkers] erro carregando candles", e)
      }
    })();
  }, [params?.symbol, params?.timeframe, params?.from, params?.to]);

  // Snap de um timestamp (seg UTC) ao candle mais próximo existente
  const snapToExistingBar = React.useCallback(
    (tsRaw: UTCTimestamp | null) => {
      if (tsRaw == null) return null;
      const arr = candleTimesRef.current;
      if (!arr || arr.length === 0) return null;

      // clamp a [first,last]
      const first = arr[0] as number;
      const last = arr[arr.length - 1] as number;
      const ts = Math.max(first, Math.min(last, tsRaw as number));

      // busca binária: candle mais próximo
      let lo = 0,
        hi = arr.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const v = arr[mid] as number;
        if (v === (ts as number)) return v as UTCTimestamp;
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

    // Aplica filtro "Só entradas" opcional (básico, sem sincronização de next-open no gráfico)
    let confSrcFiltered = confSrc;
    if (entriesOnly) {
      const tfMin = tfToMinutes(params?.timeframe);
      const reEntryBarsEff = Number.isFinite(reEntryBars) ? Math.max(0, Number(reEntryBars)) : (tfMin <= 1 ? 4 : 3);
      const asc = [...confSrc].sort((a: any, b: any) => {
        const ta = (a && a.time) ? Date.parse(a.time) : 0;
        const tb = (b && b.time) ? Date.parse(b.time) : 0;
        return ta - tb;
      });
      const out: any[] = [];
      let flat = true;
      let lastSide: "BUY" | "SELL" | null = null;
      let lastCloseTime: string | null = null;
      for (const s of asc) {
        const t = s?.time ? String(s.time) : null;
        const side = normSide((s as any).side);
        if (!t || side === "FLAT") continue;
        if (flat) {
          if (lastCloseTime && minutesBetween(lastCloseTime, t) < reEntryBarsEff * tfMin) continue;
          out.push(s);
          flat = false;
          lastSide = side as any;
        } else {
          if (side !== String(lastSide)) {
            flat = true;
            lastSide = null;
            lastCloseTime = t;
          } else {
            // mesmo lado durante posição -> ignora
          }
        }
      }
      confSrcFiltered = out;
    }

    // Contadores de origem (do store) — antes de qualquer transformação
    let srcBuy = 0,
      srcSell = 0;

    // Limites temporais: agora (UTC) e extremos da série de candles
    const nowTs = Math.floor(Date.now() / 1000) as UTCTimestamp;
    const firstTs = candleTimesRef.current[0] ?? null;
    const lastTs =
      candleTimesRef.current[candleTimesRef.current.length - 1] ?? null;

    const inRange = (ts: UTCTimestamp | null) => {
      if (ts == null) return false;
      if (firstTs != null && (ts as number) < (firstTs as number)) return false;
      if (lastTs != null && (ts as number) > (lastTs as number)) return false;
      if ((ts as number) > (nowTs as number)) return false;
      return true;
    };

    // Projetados -> setas
    type Marker = any;
    const projMarkers: Marker[] = projSrc
      .map((s, idx) => {
        const side = normSide((s as any).side);
        const tsRaw = isoToUtcTs((s as any).time);
        if (!inRange(tsRaw)) return null;
        const ts = snapToExistingBar(tsRaw);
        if (ts == null) return null;

        const isBuy = side === "BUY";
        if (isBuy) srcBuy++;
        else if (side === "SELL") srcSell++;

        return {
          time: ts,
          position: isBuy ? ("belowBar" as const) : ("aboveBar" as const),
          color: isBuy ? "#16a34a" : "#ef4444",
          shape: isBuy ? ("arrowUp" as any) : ("arrowDown" as any),
          text: `PROJ ${isBuy ? "BUY" : "SELL"}${(s as any).note ? ` • ${(s as any).note}` : ""
            }`,
          size: 1,
          // @ts-ignore
          __k: `p#${idx}`,
          // @ts-ignore
          __isBuy: isBuy,
        } as any;
      })
      .filter(Boolean) as any;

    // Confirmados -> bolinhas
    const confMarkers: Marker[] = confSrcFiltered
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
          __k: `c#${idx}`,
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
      // fallback em caso de out-of-range
      seriesRef.current.setMarkers(onlyGood as any);
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
  }, [projectedRaw, confirmedRaw, snapToExistingBar, entriesOnly, reEntryBars, params?.timeframe]);

  return (
    <div className="container my-3">
      <div className="card shadow-sm border-0">
        <div className="card-body">
          <div className="d-flex align-items-center gap-2 mb-2">
            <h6 className="mb-0">
              Gráfico de Candles &nbsp;
              <small className="text-muted">com sinais projetados/confirmados</small>
            </h6>
            <span className="ms-3 text-muted small">
              Projetados: <span className="text-success">BUY ↑</span> /{" "}
              <span className="text-danger">SELL ↓</span>
            </span>
            <span>
              Confirmados: <span style={{ color: "#2563eb" }}>BUY ●</span> /{" "}
              <span style={{ color: "#f59e0b" }}>SELL ●</span>
            </span>
            <div className="ms-auto">
              <div className="form-check form-switch">
                <input
                  id="swChartEntriesOnly"
                  className="form-check-input"
                  type="checkbox"
                  checked={entriesOnly}
                  onChange={(e) => setQS({ entriesOnly: e.target.checked })}
                />
                <label className="form-check-label" htmlFor="swChartEntriesOnly">
                  Só entradas
                </label>
              </div>
            </div>
          </div>

          <div ref={containerRef} />

          <div className="mt-2 text-muted small">
            <span className="me-3">src: BUY={diag.srcBuy} SELL={diag.srcSell}</span>
            <span className="me-3">plotted: BUY={diag.plottedBuy} SELL={diag.plottedSell}</span>
            <span>descartados por tempo={diag.droppedByTime}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default AIChartWithMarkers;
