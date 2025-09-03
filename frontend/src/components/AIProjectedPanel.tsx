import React from "react";
import { useAIStore } from "../store/ai";

export default function AIProjectedPanel() {
  const rows = useAIStore((s) => s.projected);
  const params = useAIStore((s) => s.lastParams);

  const list = Array.isArray(rows) ? rows : [];

  return (
    <div className="container my-3">
      <div className="card shadow-sm border-0">
        <div className="card-body">
          <div className="d-flex align-items-center gap-2 mb-2">
            <h6 className="mb-0">Sinais Projetados</h6>
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

          <div className="table-responsive">
            <table className="table table-sm align-middle mb-0">
              <thead>
                <tr>
                  <th style={{ width: 180 }}>Data/Hora</th>
                  <th style={{ width: 80 }}>Lado</th>
                  <th>Entrada</th>
                  <th>SL</th>
                  <th>TP</th>
                  <th>Prob</th>
                  <th>EV (pts)</th>
                  <th>Condição</th>
                </tr>
              </thead>
              <tbody>
                {list.length === 0 && (
                  <tr>
                    <td className="text-muted" colSpan={8}>
                      Sem dados. Use/aguarde a atualização automática.
                    </td>
                  </tr>
                )}
                {list.map((r, i) => (
                  <tr key={i}>
                    <td>
                      <code>
                        {r.time?.replace("T", " ").replace("Z", "") ?? "-"}
                      </code>
                    </td>
                    <td>
                      <span
                        className={
                          "badge " +
                          (r.side === "BUY"
                            ? "text-bg-success"
                            : r.side === "SELL"
                            ? "text-bg-danger"
                            : "text-bg-secondary")
                        }
                      >
                        {r.side}
                      </span>
                    </td>
                    <td>{r.suggestedEntry ?? "-"}</td>
                    <td>{r.stopSuggestion ?? "-"}</td>
                    <td>{r.takeProfitSuggestion ?? "-"}</td>
                    <td>
                      {r.probHit != null
                        ? (r.probHit * 100).toFixed(1) + "%"
                        : "-"}
                    </td>
                    <td>
                      {r.expectedValuePoints != null
                        ? r.expectedValuePoints.toFixed(2)
                        : "-"}
                    </td>
                    <td className="text-muted">{r.conditionText ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
              {list.length > 0 && (
                <tfoot>
                  <tr>
                    <td className="text-end text-muted" colSpan={8}>
                      {list.length} projeção(ões)
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
