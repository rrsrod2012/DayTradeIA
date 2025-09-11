import React from "react";
import { useAIStore } from "../store/ai";

function fmtTime(iso?: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function fmtNumber2(v: any): string {
  // Formata com 2 casas se número válido, inclusive 0; caso contrário, "—"
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(2);
}

export default function AIProjectedPanel() {
  const projected = useAIStore((s) => s.projected);
  const params = useAIStore((s) => s.lastParams);

  const rows = React.useMemo(() => {
    const arr = Array.isArray(projected) ? projected.slice() : [];
    // Ordena por tempo ascendente
    arr.sort((a, b) => {
      const ta = a.time ? Date.parse(a.time) : 0;
      const tb = b.time ? Date.parse(b.time) : 0;
      return ta - tb;
    });
    return arr;
  }, [projected]);

  const buy = rows.filter((r) => r.side === "BUY").length;
  const sell = rows.filter((r) => r.side === "SELL").length;

  // Debug opcional na UI
  const [showDebug, setShowDebug] = React.useState(false);

  // Log auxiliar
  React.useEffect(() => {
    // eslint-disable-next-line no-console
    console.log("[AIProjectedPanel] rows", {
      total: rows.length,
      buy,
      sell,
      exampleSELL: rows.find((r) => r.side === "SELL") || null,
      params,
    });
  }, [rows, buy, sell, params]);

  return (
    <div className="container my-3">
      <div className="card shadow-sm border-0">
        <div className="card-body">
          <div className="d-flex align-items-center justify-content-between mb-2">
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

          <div className="d-flex align-items-center justify-content-between mb-2">
            <div>
              <span className="badge bg-success me-2">BUY: {buy}</span>
              <span className="badge bg-danger">SELL: {sell}</span>
            </div>
            <button
              className="btn btn-sm btn-outline-secondary"
              onClick={() => setShowDebug((v) => !v)}
            >
              {showDebug ? "Ocultar debug" : "Mostrar debug"}
            </button>
          </div>

          {showDebug && (
            <pre
              className="bg-light p-2 small"
              style={{ maxHeight: 220, overflow: "auto" }}
            >
              {JSON.stringify(
                {
                  total: rows.length,
                  first5: rows.slice(0, 5),
                  firstSELL: rows.find((r) => r.side === "SELL") || null,
                },
                null,
                2
              )}
            </pre>
          )}

          <div className="table-responsive">
            <table className="table table-sm align-middle mb-0">
              <thead className="table-light">
                <tr>
                  <th style={{ width: 80 }}>Lado</th>
                  <th style={{ width: 100 }}>Hora</th>
                  <th style={{ width: 90 }}>Prob</th>
                  <th style={{ width: 110 }}>EV (pts)</th>
                  <th style={{ width: 90 }}>Score</th>
                  <th>Condição / Nota</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="text-muted">
                      Nenhum sinal projetado para os filtros atuais.
                    </td>
                  </tr>
                ) : (
                  rows.map((r, idx) => {
                    const sideColor =
                      r.side === "BUY"
                        ? "#16a34a"
                        : r.side === "SELL"
                        ? "#dc2626"
                        : "#6b7280";

                    const prob =
                      r.probHit != null && Number.isFinite(Number(r.probHit))
                        ? `${(Number(r.probHit) * 100).toFixed(1)}%`
                        : "—";

                    // EV já vem “normalizado” no store (SELL positivado). Ainda assim, tratamos robusto:
                    const evText = fmtNumber2(r.expectedValuePoints);

                    // SCORE: se não vier, usamos probCalibrated ou probHit como fallback
                    const scoreRaw =
                      r.score ??
                      (r.probCalibrated != null
                        ? Number(r.probCalibrated)
                        : r.probHit != null
                        ? Number(r.probHit)
                        : null);
                    const scoreText = fmtNumber2(scoreRaw);

                    return (
                      <tr key={`${r.time ?? "t"}_${idx}`}>
                        <td>
                          <span
                            className="badge"
                            style={{
                              backgroundColor: sideColor,
                              color: "#fff",
                              fontWeight: 600,
                            }}
                          >
                            {r.side}
                          </span>
                        </td>
                        <td>
                          <code>{fmtTime(r.time)}</code>
                        </td>
                        <td>{prob}</td>
                        <td>{evText}</td>
                        <td>{scoreText}</td>
                        <td className="text-truncate" style={{ maxWidth: 560 }}>
                          {r.conditionText ?? "—"}
                          {r.suggestedEntry != null ||
                          r.stopSuggestion != null ||
                          r.takeProfitSuggestion != null ? (
                            <div className="text-muted small mt-1">
                              {r.suggestedEntry != null && (
                                <span className="me-2">
                                  Entry: <code>{Number(r.suggestedEntry)}</code>
                                </span>
                              )}
                              {r.stopSuggestion != null && (
                                <span className="me-2">
                                  SL: <code>{Number(r.stopSuggestion)}</code>
                                </span>
                              )}
                              {r.takeProfitSuggestion != null && (
                                <span className="me-2">
                                  TP:{" "}
                                  <code>{Number(r.takeProfitSuggestion)}</code>
                                </span>
                              )}
                            </div>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          <div className="text-muted small mt-2">
            A lista não aplica nenhum filtro além dos parâmetros do backend. Se
            existir SELL no retorno, ele aparece aqui e no gráfico.
          </div>
        </div>
      </div>
    </div>
  );
}
