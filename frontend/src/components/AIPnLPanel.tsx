import React from "react";
import { useAIStore } from "../store/ai";

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

/** ======= Leitura de configuração dinâmica (sem mudar estrutura) =======

Preferência:
1) window.DAYTRADE_CFG
2) .env (VITE_POINT_VALUE_<SÍMBOLO>, VITE_DEFAULT_RISK_POINTS)
3) fallback seguro (pointValue=1, defaultRiskPoints=100) — só para exibição
*/
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
  // 1) window
  const byWin = window?.DAYTRADE_CFG?.pointValueBySymbol?.[sym];
  if (byWin != null && Number.isFinite(Number(byWin))) {
    return { value: Number(byWin), source: "window" };
  }
  // 2) env
  const fromEnv = envPointValue(sym);
  if (fromEnv != null) return { value: fromEnv, source: "env" };
  // 3) fallback
  return { value: 1, source: "fallback" };
}

function getDefaultRiskPoints(): { value: number; source: string } {
  // 1) window
  const byWin = window?.DAYTRADE_CFG?.defaultRiskPoints;
  if (byWin != null && Number.isFinite(Number(byWin))) {
    return { value: Number(byWin), source: "window" };
  }
  // 2) env
  const fromEnv = envDefaultRiskPoints();
  if (fromEnv != null) return { value: fromEnv, source: "env" };
  // 3) fallback
  return { value: 100, source: "fallback" };
}

/** ======= Painel ======= */
export default function AIPnLPanel() {
  const pnl = useAIStore((s) => s.pnl);
  const trades = useAIStore((s) => s.trades);
  const params = useAIStore((s) => s.lastParams);

  const symbol = String(params?.symbol || "").toUpperCase();
  const { value: pointValue, source: pvSource } = getPointValue(symbol);
  const { value: defaultRiskPoints, source: rrSource } = getDefaultRiskPoints();

  const totals = React.useMemo(() => {
    const count = trades.length;
    const buy = trades.filter((t) => t.side === "BUY").length;
    const sell = trades.filter((t) => t.side === "SELL").length;

    let pts = 0;
    let money = 0;
    for (const t of trades) {
      const pnlPts = Number(t.pnlPoints) || 0;
      pts += pnlPts;
      const pnl$ = Number.isFinite(Number(t.pnlMoney))
        ? Number(t.pnlMoney)
        : pnlPts * pointValue; // calcula em exibição
      money += pnl$;
    }

    return { count, buy, sell, pts, money };
  }, [trades, pointValue]);

  React.useEffect(() => {
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.log("[AIPnLPanel] pnl & trades", {
        pnl,
        tradesCount: trades.length,
        example: trades[0] || null,
        pointValue,
        defaultRiskPoints,
        pvSource,
        rrSource,
      });
    }
  }, [pnl, trades, pointValue, defaultRiskPoints, pvSource, rrSource]);

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

          {/* Resumo PnL */}
          <div className="row g-2 mb-3">
            <div className="col-auto">
              <span className="badge bg-secondary">
                Trades: {pnl?.trades ?? totals.count}
              </span>
            </div>
            <div className="col-auto">
              <span className="badge bg-success">Wins: {pnl?.wins ?? "—"}</span>
            </div>
            <div className="col-auto">
              <span className="badge bg-danger">
                Losses: {pnl?.losses ?? "—"}
              </span>
            </div>
            <div className="col-auto">
              <span className="badge bg-warning text-dark">
                Ties: {pnl?.ties ?? "—"}
              </span>
            </div>
            <div className="col-auto">
              <span className="badge bg-info text-dark">
                WinRate:{" "}
                {pnl?.winRate != null
                  ? fmtNum(Number(pnl.winRate) * 100, 1) + "%"
                  : "—"}
              </span>
            </div>
            <div className="col-auto">
              <span className="badge bg-dark">
                PnL pts: {fmtNum(pnl?.pnlPoints ?? totals.pts, 2)}
              </span>
            </div>
            <div className="col-auto">
              <span className="badge bg-dark">
                PnL $: {fmtNum(pnl?.pnlMoney ?? totals.money, 2)}
              </span>
            </div>
            <div className="col-auto">
              <span className="badge bg-dark">
                PF: {fmtNum(pnl?.profitFactor, 2)}
              </span>
            </div>
            <div className="col-auto">
              <span className="badge bg-dark">
                MaxDD: {fmtNum(pnl?.maxDrawdown, 2)}
              </span>
            </div>
          </div>

          {/* Info de fonte usada (apenas se for fallback/env) */}
          {(pvSource !== "window" || rrSource !== "window") && (
            <div className="text-muted small mb-2">
              <em>
                PnL($) calculado com pointValue=<code>{pointValue}</code> (
                {pvSource}); R/R com defaultRiskPoints=
                <code>{defaultRiskPoints}</code> ({rrSource}).
              </em>
            </div>
          )}

          {/* Totais rápidos por direção */}
          <div className="mb-2">
            <span className="badge bg-success me-2">BUY: {totals.buy}</span>
            <span className="badge bg-danger">SELL: {totals.sell}</span>
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
                {trades.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="text-muted">
                      Nenhum trade encontrado para os filtros atuais.
                    </td>
                  </tr>
                ) : (
                  trades.map((t, idx) => {
                    const sideBg = t.side === "BUY" ? "#16a34a" : "#dc2626";

                    const pnlPts = Number.isFinite(Number(t.pnlPoints))
                      ? Number(t.pnlPoints)
                      : NaN;

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

                    return (
                      <tr key={`${t.entryTime ?? "t"}_${idx}`}>
                        <td>
                          <span
                            className="badge"
                            style={{
                              backgroundColor: sideBg,
                              color: "#fff",
                              fontWeight: 600,
                            }}
                          >
                            {t.side}
                          </span>
                        </td>
                        <td>
                          <code>{fmtTime(t.entryTime)}</code>
                        </td>
                        <td>
                          <code>{fmtTime(t.exitTime)}</code>
                        </td>
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
            A lista usa os trades do backtest. PnL($) e R/R são calculados
            quando ausentes no retorno.
          </div>
        </div>
      </div>
    </div>
  );
}
