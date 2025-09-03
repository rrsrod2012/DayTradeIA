import React from "react";
import { createChart, IChartApi, UTCTimestamp } from "lightweight-charts";
import { fetchCandles } from "../services/api";
import { useAIStore } from "../store/ai";

function isoToUtcTs(iso: string | undefined | null): UTCTimestamp | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.floor(t / 1000) as UTCTimestamp;
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

  const projected = useAIStore((s) => s.projected);
  const confirmed = useAIStore((s) => s.confirmed);
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
    });
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

        // Ordena por tempo asc
        data.sort((a, b) => (a.time as number) - (b.time as number));

        seriesRef.current!.setData(data);
        chartRef.current?.timeScale().fitContent();
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("[AIChartWithMarkers] erro carregando candles", e);
      }
    })();
  }, [params?.symbol, params?.timeframe, params?.from, params?.to]);

  // Aplica markers (Projetados + Confirmados) com ordenação estável
  React.useEffect(() => {
    if (!seriesRef.current) return;

    const projMarkers: Marker[] = (projected || [])
      .filter((r) => r?.time)
      .map((r, idx) => {
        const ts = isoToUtcTs(r.time!);
        if (ts == null) return null;
        const isBuy = r.side === "BUY";
        const color = isBuy ? "#16a34a" : "#dc2626";
        const shape = isBuy ? "arrowUp" : "arrowDown";
        const prob =
          r.probHit != null ? `${(r.probHit * 100).toFixed(1)}%` : "-";
        const ev =
          r.expectedValuePoints != null
            ? `${r.expectedValuePoints.toFixed(2)} pts`
            : "-";
        return {
          time: ts,
          position: isBuy ? ("belowBar" as const) : ("aboveBar" as const),
          color,
          shape: shape as any,
          text: `PROJ ${r.side} • Prob ${prob} • EV ${ev}`,
          size: 1,
          // @ts-ignore (apenas para desempate estável)
          __k: `p${idx}`,
        } as any;
      })
      .filter(Boolean) as any;

    const confMarkers: Marker[] = (confirmed || [])
      .filter((s) => s?.time)
      .map((s, idx) => {
        const ts = isoToUtcTs(s.time!);
        if (ts == null) return null;
        const isBuy = s.side === "BUY";
        const color = isBuy ? "#2563eb" : "#f59e0b";
        return {
          time: ts,
          position: isBuy ? ("belowBar" as const) : ("aboveBar" as const),
          color,
          shape: "circle" as any,
          text: `CONF ${s.side}${s.note ? ` • ${s.note}` : ""}`,
          size: 1,
          // @ts-ignore
          __k: `c${idx}`,
        } as any;
      })
      .filter(Boolean) as any;

    // Junta e ordena por tempo asc; em empate, garante ordem determinística (CONF antes de PROJ, por exemplo)
    const all: (Marker & any)[] = [...projMarkers, ...confMarkers];
    all.sort((a, b) => {
      const dt = (a.time as number) - (b.time as number);
      if (dt !== 0) return dt;
      // empate: circles (confirmados) antes das setas (projetados)
      const ash = String(a.shape);
      const bsh = String(b.shape);
      if (ash === bsh) {
        // último desempate: pela chave estável
        return String(a.__k || "").localeCompare(String(b.__k || ""));
      }
      if (ash === "circle") return -1;
      if (bsh === "circle") return 1;
      return 0;
    });

    // Remove campos internos antes de enviar
    const clean = all.map(({ __k, ...rest }) => rest);

    try {
      seriesRef.current.setMarkers(clean as any);
    } catch (err) {
      // Se ainda falhar por algum tempo inválido, faz uma última filtragem conservadora
      const onlyGood = clean.filter((m) => Number.isFinite(m.time as any));
      onlyGood.sort((a, b) => (a.time as number) - (b.time as number));
      seriesRef.current.setMarkers(onlyGood as any);
      // eslint-disable-next-line no-console
      console.warn(
        "[AIChartWithMarkers] markers reordenados por fallback devido a tempo inválido.",
        err
      );
    }
  }, [projected, confirmed]);

  return (
    <div className="container my-3">
      <div className="card shadow-sm border-0">
        <div className="card-body">
          <div className="d-flex align-items-center gap-2 mb-2">
            <h6 className="mb-0">
              Candles + Marcadores (Projetados & Confirmados)
            </h6>
            <div className="text-muted small">
              {params ? (
                <>
                  <code>{params.symbol}</code> · <code>{params.timeframe}</code>
                  {params.from ? (
                    <>
                      {" "}
                      · de <code>{params.from}</code>
                    </>
                  ) : null}
                  {params.to ? (
                    <>
                      {" "}
                      até <code>{params.to}</code>
                    </>
                  ) : null}
                </>
              ) : (
                "—"
              )}
            </div>
          </div>
          <div ref={containerRef} style={{ width: "100%", height: 420 }} />
          <div className="text-muted small mt-2">
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
