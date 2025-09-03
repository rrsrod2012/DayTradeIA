import React from "react";
import { projectedSignals, ProjectedSignal } from "../services/api";

type State = {
  loading: boolean;
  error: string | null;
  rows: ProjectedSignal[];
};

export default function AIProjectedSignalsPlayground() {
  const [symbol, setSymbol] = React.useState("WIN");
  const [timeframe, setTimeframe] = React.useState("M5");
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [rr, setRr] = React.useState(2);
  const [useMicroModel, setUseMicroModel] = React.useState(true);
  const [minProb, setMinProb] = React.useState(0.52);
  const [minEV, setMinEV] = React.useState(0);
  const [vwapFilter, setVwapFilter] = React.useState(true);
  const [requireMtf, setRequireMtf] = React.useState(true);
  const [confirmTf, setConfirmTf] = React.useState("M15");

  const [st, setSt] = React.useState<State>({
    loading: false,
    error: null,
    rows: [],
  });

  async function onFetch() {
    setSt((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await projectedSignals({
        symbol,
        timeframe,
        from: from || undefined,
        to: to || undefined,
        rr,
        minProb,
        minEV,
        useMicroModel,
        vwapFilter,
        requireMtf,
        confirmTf,
      });
      setSt({ loading: false, error: null, rows: data || [] });
    } catch (e: any) {
      setSt({
        loading: false,
        error:
          e?.message ||
          (typeof e === "string" ? e : "Erro ao buscar projeções"),
        rows: [],
      });
    }
  }

  return (
    <div className="container my-3">
      <div className="card shadow-sm border-0">
        <div className="card-body">
          <div className="d-flex align-items-center gap-2 mb-3">
            <h5 className="mb-0">IA — Projeções (Playground)</h5>
            <span className="badge text-bg-secondary">beta</span>
          </div>

          <div className="row g-3">
            <div className="col-6 col-md-2">
              <label className="form-label">Símbolo</label>
              <input
                className="form-control"
                value={symbol}
                onChange={(e) => setSymbol(e.target.value.toUpperCase())}
              />
            </div>
            <div className="col-6 col-md-2">
              <label className="form-label">Timeframe</label>
              <input
                className="form-control"
                value={timeframe}
                onChange={(e) => setTimeframe(e.target.value.toUpperCase())}
                placeholder="M5"
              />
            </div>
            <div className="col-6 col-md-2">
              <label className="form-label">De (YYYY-MM-DD)</label>
              <input
                className="form-control"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                placeholder="opcional"
              />
            </div>
            <div className="col-6 col-md-2">
              <label className="form-label">Até (YYYY-MM-DD)</label>
              <input
                className="form-control"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                placeholder="opcional"
              />
            </div>
            <div className="col-6 col-md-2">
              <label className="form-label">RR (TP/SL)</label>
              <input
                type="number"
                step="0.1"
                className="form-control"
                value={rr}
                onChange={(e) => setRr(Number(e.target.value))}
              />
            </div>
            <div className="col-6 col-md-2">
              <label className="form-label">minProb</label>
              <input
                type="number"
                step="0.01"
                min={0}
                max={1}
                className="form-control"
                value={minProb}
                onChange={(e) => setMinProb(Number(e.target.value))}
              />
            </div>
            <div className="col-6 col-md-2">
              <label className="form-label">minEV (pts)</label>
              <input
                type="number"
                step="0.1"
                className="form-control"
                value={minEV}
                onChange={(e) => setMinEV(Number(e.target.value))}
              />
            </div>

            <div className="col-6 col-md-10 d-flex align-items-end flex-wrap gap-3">
              <div className="form-check form-switch">
                <input
                  className="form-check-input"
                  type="checkbox"
                  id="ai-toggle"
                  checked={useMicroModel}
                  onChange={(e) => setUseMicroModel(e.target.checked)}
                />
                <label className="form-check-label" htmlFor="ai-toggle">
                  Usar IA (micro-modelo)
                </label>
              </div>

              <div className="form-check form-switch">
                <input
                  className="form-check-input"
                  type="checkbox"
                  id="vwap-toggle"
                  checked={vwapFilter}
                  onChange={(e) => setVwapFilter(e.target.checked)}
                />
                <label className="form-check-label" htmlFor="vwap-toggle">
                  Filtro VWAP
                </label>
              </div>

              <div className="form-check form-switch">
                <input
                  className="form-check-input"
                  type="checkbox"
                  id="mtf-toggle"
                  checked={requireMtf}
                  onChange={(e) => setRequireMtf(e.target.checked)}
                />
                <label className="form-check-label" htmlFor="mtf-toggle">
                  Confirmação MTF
                </label>
              </div>

              <div className="input-group" style={{ maxWidth: 180 }}>
                <span className="input-group-text">TF Conf.</span>
                <input
                  className="form-control"
                  value={confirmTf}
                  onChange={(e) => setConfirmTf(e.target.value.toUpperCase())}
                />
              </div>

              <button
                className="btn btn-primary ms-auto"
                onClick={onFetch}
                disabled={st.loading}
              >
                {st.loading ? "Carregando..." : "Buscar projeções"}
              </button>
            </div>
          </div>

          {st.error && (
            <div className="alert alert-danger mt-3 mb-0">
              <strong>Erro:</strong> {st.error}
            </div>
          )}

          <div className="table-responsive mt-3">
            <table className="table table-sm align-middle">
              <thead>
                <tr>
                  <th>Data/Hora</th>
                  <th>Lado</th>
                  <th>Entry</th>
                  <th>SL</th>
                  <th>TP</th>
                  <th>Prob</th>
                  <th>EV (pts)</th>
                  <th>Condição</th>
                </tr>
              </thead>
              <tbody>
                {st.rows.length === 0 && (
                  <tr>
                    <td colSpan={8} className="text-muted">
                      {st.loading
                        ? "Carregando…"
                        : "Sem projeções para os filtros."}
                    </td>
                  </tr>
                )}
                {st.rows.map((r, i) => (
                  <tr key={i}>
                    <td>
                      <code>{r.time?.replace("T", " ").replace("Z", "")}</code>
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
                    <td className="text-muted">{r.conditionText}</td>
                  </tr>
                ))}
              </tbody>
              {st.rows.length > 0 && (
                <tfoot>
                  <tr>
                    <td colSpan={8} className="text-end text-muted">
                      {st.rows.length} projeção(ões)
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
