import React from "react";

/**
 * Painel para listar execuções de backtest (mais recentes primeiro)
 * - Lista com filtros client-side por símbolo/TF
 * - Botão "Ver" carrega o snapshot e mostra resumo + trades
 * - Atualização manual e auto-refresh
 * - Usa fetch() direto nas rotas do backend:
 *    GET /api/backtest/runs?limit=100
 *    GET /api/backtest/run/:id
 */

type RunIndexItem = {
    id: string;
    ts: string; // ISO
    symbol: string;
    timeframe: string;
    from: string; // ISO
    to: string;   // ISO
    trades: number;
    pnlPoints: number;
    winRate: number; // 0..1
};

type BacktestSummary = {
    trades: number;
    wins: number;
    losses: number;
    ties: number;
    winRate: number; // 0..1
    pnlPoints: number;
    avgPnL: number;
    profitFactor: number | "Infinity";
    maxDrawdown: number;
};

type Trade = {
    entryIdx: number;
    exitIdx: number;
    side: "BUY" | "SELL";
    entryTime: string;
    exitTime: string;
    entryPrice: number;
    exitPrice: number;
    pnl: number;
    note?: string;
};

type BacktestRunSnapshot = {
    id?: string;
    ts?: string;
    ok: boolean;
    version: string;
    symbol: string;
    timeframe: string;
    from: string;
    to: string;
    candles: number;
    trades: Trade[];
    summary: BacktestSummary;
    pnlPoints: number;
    pnlMoney?: number;
    lossCapApplied?: number;
    maxConsecLossesApplied?: number;
};

function formatDateTime(iso?: string) {
    if (!iso) return "-";
    try {
        const d = new Date(iso);
        return d.toLocaleString("pt-BR", { hour12: false });
    } catch {
        return iso;
    }
}
function pct(x: number, digits = 1) {
    return `${(x * 100).toFixed(digits)}%`;
}
function n2(x: number, digits = 2) {
    return Number.isFinite(x) ? x.toFixed(digits) : String(x);
}

export default function BacktestRunsPanel() {
    const [runs, setRuns] = React.useState<RunIndexItem[]>([]);
    const [loading, setLoading] = React.useState(false);
    const [err, setErr] = React.useState<string | null>(null);

    const [filterSym, setFilterSym] = React.useState("");
    const [filterTf, setFilterTf] = React.useState("");

    const [selectedId, setSelectedId] = React.useState<string | null>(null);
    const [selected, setSelected] = React.useState<BacktestRunSnapshot | null>(null);
    const [loadingSel, setLoadingSel] = React.useState(false);

    const [autoRefresh, setAutoRefresh] = React.useState(true);
    const [refreshSec, setRefreshSec] = React.useState(20);

    const loadRuns = React.useCallback(async () => {
        setLoading(true);
        setErr(null);
        try {
            const r = await fetch(`/api/backtest/runs?limit=100`, { method: "GET" });
            const data = await r.json();
            if (data?.ok) {
                setRuns(Array.isArray(data.items) ? data.items : []);
            } else {
                throw new Error(data?.error || "Falha ao listar backtests");
            }
        } catch (e: any) {
            setErr(e?.message || "Erro ao listar backtests");
        } finally {
            setLoading(false);
        }
    }, []);

    const loadRunById = React.useCallback(async (id: string) => {
        setLoadingSel(true);
        try {
            const r = await fetch(`/api/backtest/run/${encodeURIComponent(id)}`, { method: "GET" });
            const data = await r.json();
            if (data?.ok && data?.run) {
                setSelected(data.run as BacktestRunSnapshot);
            } else {
                throw new Error(data?.error || "Execução não encontrada");
            }
        } catch (e: any) {
            setSelected(null);
            alert(e?.message || "Erro ao carregar execução");
        } finally {
            setLoadingSel(false);
        }
    }, []);

    React.useEffect(() => {
        let alive = true;
        let timer: any = null;
        async function tick() {
            if (!alive) return;
            await loadRuns();
            if (!alive) return;
            timer = setTimeout(tick, Math.max(5, refreshSec) * 1000);
        }
        tick();
        return () => {
            alive = false;
            if (timer) clearTimeout(timer);
        };
    }, [loadRuns, refreshSec]);

    const filtered = runs.filter((it) => {
        const okSym = filterSym ? it.symbol?.toUpperCase().includes(filterSym.toUpperCase()) : true;
        const okTf = filterTf ? it.timeframe?.toUpperCase().includes(filterTf.toUpperCase()) : true;
        return okSym && okTf;
    });

    return (
        <div className="container my-3">
            <div className="d-flex align-items-center justify-content-between mb-2">
                <h6 className="m-0">Backtests (recentes)</h6>
                <div className="d-flex align-items-center gap-2">
                    <div className="form-check form-switch">
                        <input
                            className="form-check-input"
                            type="checkbox"
                            id="runs-auto-refresh"
                            checked={autoRefresh}
                            onChange={(e) => setAutoRefresh(e.target.checked)}
                        />
                        <label className="form-check-label" htmlFor="runs-auto-refresh">
                            Auto
                        </label>
                    </div>
                    <div className="input-group input-group-sm" style={{ width: 130 }}>
                        <span className="input-group-text">a cada</span>
                        <input
                            type="number"
                            className="form-control"
                            min={5}
                            step={5}
                            value={refreshSec}
                            onChange={(e) => setRefreshSec(Math.max(5, Number(e.target.value)))}
                        />
                        <span className="input-group-text">s</span>
                    </div>
                    <button className="btn btn-sm btn-outline-primary" onClick={loadRuns} disabled={loading}>
                        {loading ? "Atualizando..." : "Atualizar"}
                    </button>
                </div>
            </div>

            <div className="d-flex flex-wrap gap-2 mb-2">
                <div className="input-group input-group-sm" style={{ width: 170 }}>
                    <span className="input-group-text">Símbolo</span>
                    <input
                        className="form-control"
                        value={filterSym}
                        onChange={(e) => setFilterSym(e.target.value)}
                        placeholder="ex.: WIN"
                    />
                </div>
                <div className="input-group input-group-sm" style={{ width: 150 }}>
                    <span className="input-group-text">TF</span>
                    <input
                        className="form-control"
                        value={filterTf}
                        onChange={(e) => setFilterTf(e.target.value)}
                        placeholder="ex.: M5"
                    />
                </div>
            </div>

            {err && <div className="alert alert-danger py-2 my-2">{err}</div>}

            <div className="table-responsive">
                <table className="table table-sm table-hover align-middle">
                    <thead className="table-light">
                        <tr>
                            <th style={{ whiteSpace: "nowrap" }}>Quando</th>
                            <th>Símbolo</th>
                            <th>TF</th>
                            <th>Período</th>
                            <th style={{ textAlign: "right" }}>Trades</th>
                            <th style={{ textAlign: "right" }}>WinRate</th>
                            <th style={{ textAlign: "right" }}>PnL (pts)</th>
                            <th></th>
                        </tr>
                    </thead>
                    <tbody>
                        {filtered.map((r) => (
                            <tr key={r.id} className={selectedId === r.id ? "table-active" : ""}>
                                <td style={{ whiteSpace: "nowrap" }}>{formatDateTime(r.ts)}</td>
                                <td>{r.symbol}</td>
                                <td>{r.timeframe}</td>
                                <td style={{ whiteSpace: "nowrap" }}>
                                    {formatDateTime(r.from)} — {formatDateTime(r.to)}
                                </td>
                                <td style={{ textAlign: "right" }}>{r.trades}</td>
                                <td style={{ textAlign: "right" }}>{pct(r.winRate)}</td>
                                <td style={{ textAlign: "right" }}>{n2(r.pnlPoints)}</td>
                                <td className="text-end">
                                    <button
                                        className="btn btn-sm btn-outline-secondary"
                                        onClick={() => {
                                            const next = selectedId === r.id ? null : r.id;
                                            setSelectedId(next);
                                            setSelected(null);
                                            if (next) loadRunById(next);
                                        }}
                                    >
                                        {selectedId === r.id ? "Fechar" : "Ver"}
                                    </button>
                                </td>
                            </tr>
                        ))}
                        {!filtered.length && (
                            <tr>
                                <td colSpan={8} className="text-center text-muted">
                                    Nenhum backtest encontrado.
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>

            {/* Detalhes */}
            {selectedId && (
                <div className="card mt-3">
                    <div className="card-body">
                        {loadingSel && <div className="text-muted">Carregando execução...</div>}
                        {!loadingSel && selected && (
                            <>
                                <div className="d-flex flex-wrap justify-content-between">
                                    <div>
                                        <h6 className="mb-1">Execução</h6>
                                        <div className="small text-muted">
                                            ID: <code>{selected.id || selectedId}</code> · Rodado em:{" "}
                                            {formatDateTime(selected.ts)}
                                        </div>
                                    </div>
                                    <div className="text-end">
                                        <div><strong>{selected.symbol}</strong> · <span className="text-muted">{selected.timeframe}</span></div>
                                        <div className="small">{formatDateTime(selected.from)} — {formatDateTime(selected.to)}</div>
                                    </div>
                                </div>

                                <div className="row row-cols-2 row-cols-md-4 g-2 my-2">
                                    <div className="col">
                                        <div className="border rounded p-2">
                                            <div className="small text-muted">Trades</div>
                                            <div className="fw-bold">{selected.summary.trades}</div>
                                        </div>
                                    </div>
                                    <div className="col">
                                        <div className="border rounded p-2">
                                            <div className="small text-muted">WinRate</div>
                                            <div className="fw-bold">{pct(selected.summary.winRate, 2)}</div>
                                        </div>
                                    </div>
                                    <div className="col">
                                        <div className="border rounded p-2">
                                            <div className="small text-muted">PnL (pts)</div>
                                            <div className="fw-bold">{n2(selected.summary.pnlPoints)}</div>
                                        </div>
                                    </div>
                                    <div className="col">
                                        <div className="border rounded p-2">
                                            <div className="small text-muted">Max DD</div>
                                            <div className="fw-bold">{n2(selected.summary.maxDrawdown)}</div>
                                        </div>
                                    </div>
                                </div>

                                <div className="table-responsive mt-3">
                                    <table className="table table-sm table-striped">
                                        <thead>
                                            <tr>
                                                <th>Entrada</th>
                                                <th>Saída</th>
                                                <th>Side</th>
                                                <th style={{ textAlign: "right" }}>Entry</th>
                                                <th style={{ textAlign: "right" }}>Exit</th>
                                                <th style={{ textAlign: "right" }}>PnL</th>
                                                <th>Obs</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {(selected.trades || []).slice(-200).map((t, i) => (
                                                <tr key={i}>
                                                    <td style={{ whiteSpace: "nowrap" }}>{formatDateTime(t.entryTime)}</td>
                                                    <td style={{ whiteSpace: "nowrap" }}>{formatDateTime(t.exitTime)}</td>
                                                    <td>{t.side}</td>
                                                    <td style={{ textAlign: "right" }}>{n2(t.entryPrice, 1)}</td>
                                                    <td style={{ textAlign: "right" }}>{n2(t.exitPrice, 1)}</td>
                                                    <td style={{ textAlign: "right" }}>{n2(t.pnl, 2)}</td>
                                                    <td>{t.note || "-"}</td>
                                                </tr>
                                            ))}
                                            {!selected.trades?.length && (
                                                <tr>
                                                    <td colSpan={7} className="text-center text-muted">
                                                        Sem trades nessa execução.
                                                    </td>
                                                </tr>
                                            )}
                                        </tbody>
                                    </table>
                                </div>
                            </>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
