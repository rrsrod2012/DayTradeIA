import React from "react";
import { useAIStore } from "../store/ai";
import { fetchCandles } from "../services/api";
import OrderLogsModal from "./OrderLogsModal";

/** ======= Helpers de formatação ======= */
function fmtTime(iso?: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}
function fmtNum(v: any, digits = 2) {
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

/** ======= Config dinâmica ======= */
declare global {
  interface Window {
    DAYTRADE_CFG?: {
      pointValueBySymbol?: Record<string, number>;
      defaultRiskPoints?: number;
    };
  }
}
function envPointValue(symbol: string): number | null {
  const key = `VITE_POINT_VALUE_${symbol}`;
  const env: any = (import.meta as any)?.env ?? {};
  const val = env[key] ?? env[key.toUpperCase()];
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}
function envDefaultRiskPoints(): number | null {
  const env: any = (import.meta as any)?.env ?? {};
  const n = Number(env.VITE_DEFAULT_RISK_POINTS);
  return Number.isFinite(n) ? n : null;
}
function getPointValue(symbol?: string): { value: number; source: string } {
  const sym = String(symbol || "").toUpperCase();
  const byWin = window?.DAYTRADE_CFG?.pointValueBySymbol?.[sym];
  if (byWin != null && Number.isFinite(Number(byWin))) {
    return { value: Number(byWin), source: "window" };
  }
  const fromEnv = envPointValue(sym);
  if (fromEnv != null) return { value: fromEnv, source: "env" };
  return { value: 1, source: "fallback" };
}
function getDefaultRiskPoints(): { value: number; source: string } {
  const byWin = window?.DAYTRADE_CFG?.defaultRiskPoints;
  if (byWin != null && Number.isFinite(Number(byWin))) {
    return { value: Number(byWin), source: "window" };
  }
  const fromEnv = envDefaultRiskPoints();
  if (fromEnv != null) return { value: fromEnv, source: "env" };
  return { value: 100, source: "fallback" };
}

/** ======= Helpers locais ======= */
function tfToMinutes(tf?: string | null) {
  const s = String(tf || "").trim().toUpperCase();
  if (s === "M1") return 1;
  if (s === "M5") return 5;
  if (s === "M15") return 15;
  if (s === "M30") return 30;
  if (s === "H1") return 60;
  const m = s.match(/^M(\d+)$/);
  if (m) return Math.max(1, Number(m[1]));
  const h = s.match(/^H(\d+)$/);
  if (h) return Math.max(1, Number(h[1]) * 60);
  return 5;
}
function toTs(iso?: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}
function parseQS() {
  const sp =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search)
      : new URLSearchParams();
  // Mantém compat: ativo por padrão, mas agora só reconstrói se não houver backtest, a menos que force=1
  const nextOpenEntry = (sp.get("nextOpenEntry") ?? "1").trim() !== "0";
  const forceNextOpen =
    (sp.get("forceNextOpen") ?? sp.get("force") ?? "0").trim() === "1";
  const reStr = sp.get("reEntryBars");
  const reEntryBars =
    reStr != null && reStr !== "" && Number.isFinite(Number(reStr))
      ? Number(reStr)
      : NaN;
  return { nextOpenEntry, forceNextOpen, reEntryBars };
}
function pickSigName(s: any) {
  return (
    (s?.note && String(s.note)) ||
    (s?.signalType && String(s.signalType)) ||
    (s?.type && String(s.type)) ||
    ""
  );
}

/** ======= Painel ======= */
export default function AIPnLPanel() {
  const pnl = useAIStore((s) => s.pnl);
  const tradesStore = useAIStore((s) => s.trades); // backtest
  const confirmed = useAIStore((s) => s.confirmed);
  const params = useAIStore((s) => s.lastParams);

  const symbol = String(params?.symbol || "").toUpperCase();
  const timeframe = String(params?.timeframe || "").toUpperCase();
  const tfMin = tfToMinutes(timeframe);
  const { nextOpenEntry, forceNextOpen, reEntryBars } = parseQS();

  const { value: pointValue, source: pvSource } = getPointValue(symbol);
  const { value: defaultRiskPoints, source: rrSource } = getDefaultRiskPoints();

  const reEntryBarsEff = Number.isFinite(reEntryBars)
    ? Math.max(0, Number(reEntryBars))
    : tfMin <= 1
      ? 4
      : 3;

  // ===== Modal de LOG =====
  const [openTaskId, setOpenTaskId] = React.useState<string | null>(null);

  /** ======= Carrega candles (para reconstrução quando necessário) ======= */
  const [candles, setCandles] = React.useState<
    { time: string; open: number; high: number; low: number; close: number }[]
  >([]);

  React.useEffect(() => {
    let alive = true;
    (async () => {
      // Só baixa candles se for usar reconstrução (quando não houver backtest ou houver força explícita)
      const hasBacktest = Array.isArray(tradesStore) && tradesStore.length > 0;
      const willReconstruct = nextOpenEntry && (!hasBacktest || forceNextOpen);
      if (!params || !willReconstruct) {
        setCandles([]);
        return;
      }
      try {
        const rows = await fetchCandles({
          symbol,
          timeframe,
          from: params.from,
          to: params.to,
          limit: 5000,
        });
        if (!alive) return;
        const asc = [...rows].sort((a, b) => {
          const ta = toTs(a.time) ?? 0;
          const tb = toTs(b.time) ?? 0;
          return ta - tb;
        });
        setCandles(asc);
      } catch (_e) {
        if (!alive) return;
        setCandles([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [symbol, timeframe, params?.from, params?.to, nextOpenEntry, forceNextOpen, tradesStore]);

  /** ======= tradesView: prioriza BACKTEST; reconstrói só se preciso/forçado ======= */
  const { tradesView, policyUsed } = React.useMemo(() => {
    type T = {
      side: "BUY" | "SELL";
      entryTime: string;
      exitTime: string;
      entryPrice: number;
      exitPrice: number;
      pnlPoints: number;
      pnlMoney?: number;
      rr?: number;
      note?: string;
      /** chave para abrir logs (taskId/entrySignalId) */
      taskKey?: string | null;
    };

    const hasBacktest = Array.isArray(tradesStore) && tradesStore.length > 0;
    const preferBacktest = hasBacktest && !forceNextOpen;

    if (preferBacktest) {
      // Mapeia trades do backtest para a mesma forma, tentando extrair um identificador para logs
      const rows: T[] = (tradesStore as any[]).map((r: any) => {
        const pnlPts =
          Number(r.pnl ?? (r.exitPrice - r.entryPrice) * (r.side === "BUY" ? 1 : -1)) || 0;
        const note =
          r.movedToBE
            ? (r.note ? String(r.note) + " (BE)" : "be/stop")
            : (r.note ?? undefined);

        // 🔑 tentativas de chave: taskId > entrySignalId > (fallback sintético)
        const taskKey =
          (r as any).taskId ??
          (r as any).entrySignalId ??
          `${symbol}|${timeframe}|${r.entryTime}|${r.side}`;

        return {
          side: r.side,
          entryTime: r.entryTime,
          exitTime: r.exitTime,
          entryPrice: Number(r.entryPrice),
          exitPrice: Number(r.exitPrice),
          pnlPoints: pnlPts,
          pnlMoney: Number.isFinite(Number(r.pnlMoney)) ? Number(r.pnlMoney) : pnlPts * Number(pointValue),
          rr: defaultRiskPoints !== 0 ? pnlPts / Number(defaultRiskPoints) : undefined,
          note,
          taskKey,
        };
      });
      // ordena por entrada
      rows.sort((a, b) => (toTs(a.entryTime)! - toTs(b.entryTime)!));
      return { tradesView: rows, policyUsed: "backtest" as const };
    }

    // Se não há backtest (ou forceNextOpen=1), reconstrói via “próximo open”
    if (!nextOpenEntry) {
      const rows: T[] = Array.isArray(tradesStore) ? (tradesStore as any[]).map((r: any) => ({
        side: r.side,
        entryTime: r.entryTime,
        exitTime: r.exitTime,
        entryPrice: Number(r.entryPrice),
        exitPrice: Number(r.exitPrice),
        pnlPoints: Number(r.pnl ?? 0),
        pnlMoney: Number.isFinite(Number(r.pnlMoney)) ? Number(r.pnlMoney) : Number(r.pnl ?? 0) * Number(pointValue),
        rr: defaultRiskPoints !== 0 ? Number(r.pnl ?? 0) / Number(defaultRiskPoints) : undefined,
        note: r.note ?? undefined,
        taskKey: (r as any).taskId ?? (r as any).entrySignalId ?? `${symbol}|${timeframe}|${r.entryTime}|${r.side}`,
      })) : [];
      rows.sort((a, b) => (toTs(a.entryTime)! - toTs(b.entryTime)!));
      return { tradesView: rows, policyUsed: "store" as const };
    }

    const confAsc = (Array.isArray(confirmed) ? confirmed : [])
      .filter((r: any) => r && r.time && (r.side === "BUY" || r.side === "SELL"))
      .sort((a: any, b: any) => (toTs(a.time) ?? 0) - (toTs(b.time) ?? 0));

    if (confAsc.length === 0 || candles.length === 0) {
      // nada para reconstruir
      const rows: T[] = Array.isArray(tradesStore) ? (tradesStore as any[]).map((r: any) => ({
        side: r.side,
        entryTime: r.entryTime,
        exitTime: r.exitTime,
        entryPrice: Number(r.entryPrice),
        exitPrice: Number(r.exitPrice),
        pnlPoints: Number(r.pnl ?? 0),
        pnlMoney: Number.isFinite(Number(r.pnlMoney)) ? Number(r.pnlMoney) : Number(r.pnl ?? 0) * Number(pointValue),
        rr: defaultRiskPoints !== 0 ? Number(r.pnl ?? 0) / Number(defaultRiskPoints) : undefined,
        note: r.note ?? undefined,
        taskKey: (r as any).taskId ?? (r as any).entrySignalId ?? `${symbol}|${timeframe}|${r.entryTime}|${r.side}`,
      })) : [];
      rows.sort((a, b) => (toTs(a.entryTime)! - toTs(b.entryTime)!));
      return { tradesView: rows, policyUsed: "store" as const };
    }

    // Índices auxiliares
    const times = candles.map((c) => toTs(c.time) as number);
    const idxByTs = new Map<number, number>();
    for (let i = 0; i < times.length; i++) idxByTs.set(times[i], i);
    function findIndexForTs(ts: number): number | null {
      if (!Number.isFinite(ts) || times.length === 0) return null;
      let lo = 0, hi = times.length - 1;
      if (ts <= times[lo]) return lo;
      if (ts >= times[hi]) return hi;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const v = times[mid];
        if (v === ts) return mid;
        if (v < ts) lo = mid + 1; else hi = mid - 1;
      }
      return hi >= 0 ? hi : lo;
    }

    const out: T[] = [];
    let position: null | {
      side: "BUY" | "SELL";
      entryIdx: number;
      entryTime: string;
      entryPrice: number;
      entrySigName: string;
      entrySigTimeISO: string;
      entrySignalId?: string | number | null;
    } = null;
    let lastCloseIdx: number | null = null;

    for (const s of confAsc) {
      const st = toTs(s.time);
      if (st == null) continue;
      let idx = idxByTs.get(st) ?? findIndexForTs(st);
      if (idx == null) continue;

      const nextIdx = idx + 1;
      if (nextIdx >= candles.length) continue;

      const openBar = candles[nextIdx];
      const openIdx = nextIdx;

      if (position === null && lastCloseIdx != null) {
        if (openIdx - lastCloseIdx < reEntryBarsEff) {
          continue;
        }
      }

      const side = String(s.side).toUpperCase() as "BUY" | "SELL";
      const sigName = pickSigName(s);

      // tente detectar um id do sinal confirmado (vindo do backend/prisma, se houver)
      const sigId =
        (s as any).id ??
        (s as any).signalId ??
        (s as any).entrySignalId ??
        (s as any).taskId ??
        null;

      if (position === null) {
        position = {
          side,
          entryIdx: openIdx,
          entryTime: openBar.time,
          entryPrice: Number(openBar.open),
          entrySigName: sigName,
          entrySigTimeISO: String(s.time),
          entrySignalId: sigId ?? undefined,
        };
      } else if (side !== position.side) {
        const exitBar = openBar;
        const exitIdx = openIdx;
        const exitPrice = Number(exitBar.open);
        const pnlPts =
          position.side === "BUY"
            ? exitPrice - position.entryPrice
            : position.entryPrice - exitPrice;

        const holdBars = Math.max(1, exitIdx - position.entryIdx);
        const holdMin = holdBars * tfMin;
        const exitSigName = sigName;

        const noteRich =
          `entrada: ${position.entrySigName || "sinal"} • ` +
          `saída: reversão${exitSigName ? ` (${exitSigName})` : ""} — próx. abertura • ` +
          `hold: ${holdBars} barra${holdBars === 1 ? "" : "s"} (${holdMin}min)`;

        // 🔑 chave de logs preferindo id real do sinal
        const taskKey =
          (position.entrySignalId != null ? String(position.entrySignalId) : null) ??
          `${symbol}|${timeframe}|${position.entryTime}|${position.side}`;

        out.push({
          side: position.side,
          entryTime: position.entryTime,
          exitTime: exitBar.time,
          entryPrice: position.entryPrice,
          exitPrice,
          pnlPoints: pnlPts,
          pnlMoney: pnlPts * Number(pointValue),
          rr: defaultRiskPoints !== 0 ? pnlPts / Number(defaultRiskPoints) : undefined,
          note: noteRich,
          taskKey,
        });

        lastCloseIdx = exitIdx;
        position = null;
      }
    }

    return { tradesView: out, policyUsed: "next-open" as const };
  }, [
    tradesStore,
    confirmed,
    candles,
    nextOpenEntry,
    forceNextOpen,
    reEntryBarsEff,
    tfMin,
    pointValue,
    defaultRiskPoints,
    symbol,
    timeframe,
  ]);

  const totals = React.useMemo(() => {
    const count = tradesView.length;
    const buy = tradesView.filter((t) => t.side === "BUY").length;
    const sell = tradesView.filter((t) => t.side === "SELL").length;

    let pts = 0;
    let money = 0;
    for (const t of tradesView) {
      const pnlPts = Number(t.pnlPoints) || 0;
      pts += pnlPts;
      const pnl$ = Number.isFinite(Number(t.pnlMoney))
        ? Number(t.pnlMoney)
        : pnlPts * pointValue;
      money += pnl$;
    }

    const wins = tradesView.filter((t) => (Number(t.pnlPoints) || 0) > 0).length;
    const losses = tradesView.filter((t) => (Number(t.pnlPoints) || 0) < 0).length;
    const ties = count - wins - losses;
    const winRate = count > 0 ? wins / count : 0;

    let grossProfit = 0;
    let grossLoss = 0;
    let equity = 0;
    let peak = 0;
    let maxDD = 0;

    for (const t of tradesView) {
      const p = Number(t.pnlPoints) || 0;
      if (p > 0) grossProfit += p;
      else if (p < 0) grossLoss += -p;
      equity += p;
      if (equity > peak) peak = equity;
      const dd = peak - equity;
      if (dd > maxDD) maxDD = dd;
    }
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

    return {
      count,
      buy,
      sell,
      pts,
      money,
      wins,
      losses,
      ties,
      winRate,
      profitFactor,
      maxDrawdown: maxDD,
    };
  }, [tradesView, pointValue]);

  React.useEffect(() => {
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.log("[AIPnLPanel] pnl & trades", {
        pnl,
        tradesCountStore: Array.isArray(tradesStore) ? tradesStore.length : 0,
        tradesCountView: tradesView.length,
        example: tradesView[0] || null,
        pointValue,
        defaultRiskPoints,
        pvSource,
        rrSource,
        policyUsed,
      });
    }
  }, [
    pnl,
    tradesStore,
    tradesView,
    pointValue,
    defaultRiskPoints,
    pvSource,
    rrSource,
    policyUsed,
  ]);

  const onClickSide = (t: any) => {
    const key = t?.taskKey;
    if (key) setOpenTaskId(String(key));
  };

  return (
    <div className="container my-3">
      <div className="card shadow-sm border-0">
        <div className="card-body">
          <div className="d-flex align-items-center justify-content-between mb-2">
            <h6 className="mb-0">Resumo & Trades</h6>
            <div className="text-muted small">
              {params ? (
                <>
                  <code>{params.symbol}</code> · <code>{params.timeframe}</code>
                  {params.from ? <> · de <code>{params.from}</code></> : null}
                  {params.to ? <> até <code>{params.to}</code></> : null}
                  {" · "}
                  <em>fonte: {policyUsed === "backtest" ? "/backtest (com BE)" : policyUsed}</em>
                </>
              ) : "—"}
            </div>
          </div>

          {/* Resumo PnL */}
          <div className="row g-2 mb-3">
            <div className="col-auto">
              <span className="badge bg-secondary">Trades: {totals.count}</span>
            </div>
            <div className="col-auto">
              <span className="badge bg-success">Wins: {totals.wins}</span>
            </div>
            <div className="col-auto">
              <span className="badge bg-danger">Losses: {totals.losses}</span>
            </div>
            <div className="col-auto">
              <span className="badge bg-warning text-dark">Ties: {totals.ties}</span>
            </div>
            <div className="col-auto">
              <span className="badge bg-info text-dark">
                WinRate: {fmtNum(Number(totals.winRate) * 100, 1)}%
              </span>
            </div>
            <div className="col-auto">
              <span className="badge bg-dark">PnL pts: {fmtNum(totals.pts, 2)}</span>
            </div>
            <div className="col-auto">
              <span className="badge bg-dark">PnL $: {fmtNum(totals.money, 2)}</span>
            </div>
            <div className="col-auto">
              <span className="badge bg-dark">PF: {fmtNum(totals.profitFactor, 2)}</span>
            </div>
            <div className="col-auto">
              <span className="badge bg-dark">MaxDD: {fmtNum(totals.maxDrawdown, 2)}</span>
            </div>
          </div>

          {/* Info de fonte usada */}
          {(pvSource !== "window" || rrSource !== "window") && (
            <div className="text-muted small mb-2">
              <em>
                PnL($) calculado com pointValue=<code>{pointValue}</code> ({pvSource});
                R/R com defaultRiskPoints=<code>{defaultRiskPoints}</code> ({rrSource}).
                Política efetiva: <code>{policyUsed}</code>.
              </em>
            </div>
          )}

          {/* Totais rápidos por direção */}
          <div className="mb-2">
            <span className="badge bg-success me-2">BUY: {totals.buy}</span>
            <span className="badge bg-danger">SELL: {totals.sell}</span>
            <span className="ms-3 text-muted small">dica: clique no <b>Lado</b> para ver o LOG</span>
          </div>

          {/* Tabela de trades */}
          <div className="table-responsive">
            <table className="table table-sm align-middle mb-0">
              <thead className="table-light">
                <tr>
                  <th style={{ width: 80 }}>Lado</th>
                  <th style={{ width: 110 }}>Entrada</th>
                  <th style={{ width: 110 }}>Saída</th>
                  <th style={{ width: 120 }}>Entry</th>
                  <th style={{ width: 120 }}>Exit</th>
                  <th style={{ width: 110 }}>PnL (pts)</th>
                  <th style={{ width: 110 }}>PnL ($)</th>
                  <th style={{ width: 90 }}>R/R</th>
                  <th>Nota</th>
                </tr>
              </thead>
              <tbody>
                {tradesView.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="text-muted">
                      Nenhum trade encontrado para os filtros atuais.
                    </td>
                  </tr>
                ) : (
                  tradesView.map((t: any, idx: number) => {
                    const sideBg = t.side === "BUY" ? "#16a34a" : "#dc2626";
                    const pnlPts = Number.isFinite(Number(t.pnlPoints)) ? Number(t.pnlPoints) : NaN;
                    const pnlMoney = Number.isFinite(Number(t.pnlMoney))
                      ? Number(t.pnlMoney)
                      : Number.isFinite(pnlPts)
                        ? pnlPts * pointValue
                        : NaN;
                    const rr = Number.isFinite(Number(t.rr))
                      ? Number(t.rr)
                      : Number.isFinite(pnlPts) && defaultRiskPoints !== 0
                        ? pnlPts / defaultRiskPoints
                        : NaN;

                    const clickable = !!t.taskKey;

                    return (
                      <tr key={`${t.entryTime ?? "t"}_${idx}`}>
                        <td>
                          <button
                            type="button"
                            className="badge border-0"
                            style={{
                              backgroundColor: sideBg,
                              color: "#fff",
                              fontWeight: 600,
                              cursor: clickable ? "pointer" : "not-allowed",
                              opacity: clickable ? 1 : 0.7,
                            }}
                            title={clickable ? "Ver LOG da ordem" : "Sem id para logs"}
                            onClick={() => clickable && onClickSide(t)}
                          >
                            {t.side}
                          </button>
                        </td>
                        <td><code>{fmtTime(t.entryTime)}</code></td>
                        <td><code>{fmtTime(t.exitTime)}</code></td>
                        <td>{fmtNum(t.entryPrice, 2)}</td>
                        <td>{fmtNum(t.exitPrice, 2)}</td>
                        <td>{fmtNum(pnlPts, 2)}</td>
                        <td>{fmtNum(pnlMoney, 2)}</td>
                        <td>{fmtNum(rr, 2)}</td>
                        <td className="text-truncate" style={{ maxWidth: 420 }}>
                          {t.note ?? "—"}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          <div className="text-muted small mt-2">
            Exibindo trades com política <code>{policyUsed}</code>.
            Quando “<code>backtest</code>”, os resultados incluem Break-even/Trailing calculados no servidor.
          </div>
        </div>
      </div>

      {/* Modal de Logs */}
      {openTaskId && (
        <OrderLogsModal taskId={openTaskId} onClose={() => setOpenTaskId(null)} />
      )}
    </div>
  );
}
