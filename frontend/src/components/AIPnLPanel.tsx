import React from "react";
import { useAIStore } from "../store/ai";

function pct(x: number) {
  return (x * 100).toFixed(1) + "%";
}

export default function AIPnLPanel() {
  const pnl = useAIStore((s) => s.pnl);
  const params = useAIStore((s) => s.lastParams);

  return (
    <div className="container my-3">
      <div className="card shadow-sm border-0">
        <div className="card-body">
          <div className="d-flex align-items-center gap-2 mb-2">
            <h6 className="mb-0">PnL (Backtest)</h6>
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

          {!pnl ? (
            <div className="text-muted">
              Sem dados. Clique em <strong>Calcular PnL</strong> na barra.
            </div>
          ) : (
            <div className="row g-3">
              <div className="col-6 col-md-3">
                <div className="p-3 border rounded-3">
                  <div className="text-muted small">Trades</div>
                  <div className="fs-5">{pnl.trades}</div>
                </div>
              </div>
              <div className="col-6 col-md-3">
                <div className="p-3 border rounded-3">
                  <div className="text-muted small">Win Rate</div>
                  <div className="fs-5">{pct(pnl.winRate || 0)}</div>
                </div>
              </div>
              <div className="col-6 col-md-3">
                <div className="p-3 border rounded-3">
                  <div className="text-muted small">PnL (pts)</div>
                  <div
                    className={
                      "fs-5 " +
                      ((pnl.pnlPoints ?? 0) >= 0
                        ? "text-success"
                        : "text-danger")
                    }
                  >
                    {(pnl.pnlPoints ?? 0).toFixed(2)}
                  </div>
                </div>
              </div>
              <div className="col-6 col-md-3">
                <div className="p-3 border rounded-3">
                  <div className="text-muted small">Profit Factor</div>
                  <div className="fs-5">
                    {(pnl.profitFactor ?? 0).toString()}
                  </div>
                </div>
              </div>

              <div className="col-6 col-md-3">
                <div className="p-3 border rounded-3">
                  <div className="text-muted small">Média por trade</div>
                  <div className="fs-5">{(pnl.avgPnL ?? 0).toFixed(2)} pts</div>
                </div>
              </div>
              <div className="col-6 col-md-3">
                <div className="p-3 border rounded-3">
                  <div className="text-muted small">Máx. Drawdown</div>
                  <div className="fs-5">
                    {(pnl.maxDrawdown ?? 0).toFixed(2)} pts
                  </div>
                </div>
              </div>
              {"pnlMoney" in (pnl as any) && (pnl as any).pnlMoney != null && (
                <div className="col-6 col-md-3">
                  <div className="p-3 border rounded-3">
                    <div className="text-muted small">PnL (R$)</div>
                    <div
                      className={
                        "fs-5 " +
                        (((pnl as any).pnlMoney ?? 0) >= 0
                          ? "text-success"
                          : "text-danger")
                      }
                    >
                      {(pnl as any).pnlMoney.toFixed?.(2) ??
                        (pnl as any).pnlMoney}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
