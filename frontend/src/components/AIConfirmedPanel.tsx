import React from "react";
import { useAIStore } from "../store/ai";

export default function AIConfirmedPanel() {
  const rows = useAIStore((s) => s.confirmed);
  const params = useAIStore((s) => s.lastParams);

  const list = Array.isArray(rows) ? rows : [];

  return (
    <div className="container my-3">
      <div className="card shadow-sm border-0">
        <div className="card-body">
          <div className="d-flex align-items-center gap-2 mb-2">
            <h6 className="mb-0">Sinais Confirmados</h6>
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
                  <th>Preço</th>
                  <th>Observação</th>
                </tr>
              </thead>
              <tbody>
                {list.length === 0 && (
                  <tr>
                    <td className="text-muted" colSpan={4}>
                      Sem dados. Use a barra para buscar.
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
                    <td>{r.price ?? "-"}</td>
                    <td className="text-muted">{r.note ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
              {list.length > 0 && (
                <tfoot>
                  <tr>
                    <td className="text-end text-muted" colSpan={4}>
                      {list.length} sinal(is)
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
