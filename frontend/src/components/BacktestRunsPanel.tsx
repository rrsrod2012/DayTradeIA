import React from "react";

// Descobre a base do broker/backtest (porta 3002)
const RAW_EXEC_BASE = (import.meta as any).env?.VITE_EXEC_BASE ?? "";
const EXEC_BASE = String(RAW_EXEC_BASE || "").replace(/\/$/, "");

// helpers HTTP simples contra EXEC_BASE
async function execGet(path: string) {
    const url = `${EXEC_BASE}${path.startsWith("/") ? path : "/" + path}`;
    const r = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json" },
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) {
        const msg = data?.error || `${r.status} ${r.statusText}`;
        const err: any = new Error(msg);
        err.status = r.status;
        err.url = url;
        err.response = data;
        throw err;
    }
    return data;
}

/**
 * Painel para listar execuções de backtest (mais recentes primeiro)
 * - Filtros client-side por símbolo/TF
 * - Botão "Ver" carrega o snapshot e mostra resumo + trades
 * - Auto-refresh opcional
 * - Endpoints (no EXEC_BASE):
 *    GET /api/backtest/runs?limit=100
 *    GET /api/backtest/run/:id
 */

type RunIndexItem = {
    id: string;
    ts: string;           // ISO
    symbol: string;
    timeframe: string;
    from: string;         // ISO
    to: string;           // ISO
    trades: number;
    pnlPoints: number;
    winRate: number;      // 0..1
};

type BacktestSummary = {
    trades: number;
    wins: number;
    losses: number;
    ties: number;
    winRate: number;      // 0..1
    pnlPoints: number;
    avgPnL: number;
    profitFactor: number | "Infinity";
    maxDrawdown: number;
};

type PartialFill = { atIndex: number; price: number; qty: number };

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
    movedToBE?: boolean;
    trailEvents?: number;
    partials?: PartialFill[];
};

type ExitPolicy = {
    beAtR?: number;
    beOffset?: number;
    trailAtrK?: number;
    trailStepAtr?: number;
    timeStopBars?: number;
    emaExit?: boolean;
    vwapExit?: boolean;
    rr?: number;
    kSL?: number;
    kTrail?: number;
    breakEvenAtR?: number;
    beOffsetR?: number;
    partial1R?: number;
    partial2R?: number;
    partialRemainTrail?: boolean;
    slippagePts?: number;
    costPts?: number;
    horizonBars?: number;
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
    config?: {
        vwapFilter?: boolean;
        minProb?: number;
        minEV?: number;
        metaMinProb?: number;
        [k: string]: any;
    };
    policy?: ExitPolicy;
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
function pct(x: any, digits = 1) {
    const v = Number(x);
    if (!Number.isFinite(v)) return "-";
    return `${(v * 100).toFixed(digits)}%`;
}
function n2(x: any, digits = 2) {
    if (x === "Infinity") return "Infinity";
    const v = Number(x);
    return Number.isFinite(v) ? v.toFixed(digits) : String(x ?? "-");
}
function hasExtraTradeInfo(t: Trade) {
    return !!(t?.movedToBE || (t?.trailEvents && t.trailEvents > 0) || (t?.partials && t.partials.length > 0));
}
function flagsForTrade(t: Trade) {
    const bits: string[] = [];
    if (t.movedToBE) bits.push("BE");
    if (t.trailEvents && t.trailEvents > 0) bits.push(`TR${t.trailEvents}`);
    if (t.partials && t.partials.length > 0) bits.push(`P${t.partials.length}`);
    return bits.join(" · ");
}
function toCSV(rows: Record<string, any>[], headers: string[]) {
    const esc = (v: any) => {
        if (v == null) return "";
        const s = String(v);
        if (/[",;\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
        return s;
    };
    const head = headers.join(",");
    const body = rows.map((r) => headers.map((h) => esc(r[h])).join(",")).join("\n");
    return `${head}\n${body}`;
}
function downloadText(filename: string, text: string) {
    const blob = new Blob([text], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
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
    const [selErr, setSelErr] = React.useState<string | null>(null);

    const [autoRefresh, setAutoRefresh] = React.useState(true);
    const [refreshSec, setRefreshSec] = React.useState(20);

    const loadRuns = React.useCallback(async () => {
        setLoading(true);
        setErr(null);
        try {
            const limit = 100;
            const data = await execGet(`/api/backtest/runs?limit=${limit}`);
            if (data?.ok) {
                setRuns(Array.isArray(data.items) ? data.items : []);
            } else {
                throw new Error(data?.error || "Falha ao listar backtests");
            }
        } catch (e: any) {
            setErr(e?.message || "Erro ao listar backtests");
            setRuns([]);
        } finally {
            setLoading(false);
        }
    }, []);

    const loadRunById = React.useCallback(async (id: string) => {
        setLoadingSel(true);
        setSelErr(null);
        try {
            const data = await execGet(`/api/backtest/run/${encodeURIComponent(id)}`);
            if (data?.ok && data?.run) {
                setSelected(data.run as BacktestRunSnapshot);
            } else {
                throw new Error(data?.error || "Execução não encontrada");
            }
        } catch (e: any) {
            setSelected(null);
            setSelErr(e?.message || "Erro ao carregar execução");
        } finally {
            setLoadingSel(false);
        }
    }, []);

    // Auto-refresh que respeita o switch (só agenda quando ON)
    React.useEffect(() => {
        let alive = true;
        let timer: any = null;

        const tick = async () => {
            if (!alive) return;
            await loadRuns();
            if (!alive) return;
            if (autoRefresh) timer = setTimeout(tick, Math.max(5, refreshSec) * 1000);
        };

        tick(); // carga imediata
        return () => {
            alive = false;
            if (timer) clearTimeout(timer);
        };
    }, [loadRuns, refreshSec, autoRefresh]);

    const filtered = runs.filter((it) => {
        const okSym = filterSym ? it.symbol?.toUpperCase().includes(filterSym.toUpperCase()) : true;
        const okTf = filterTf ? it.timeframe?.toUpperCase().includes(filterTf.toUpperCase()) : true;
        return okSym && okTf;
    });

    const pfLabel =
        selected?.summary?.profitFactor === "Infinity"
            ? "Infinity"
            : n2(selected?.summary?.profitFactor, 3);

    const hasAnyFlags = React.useMemo(
        () => !!(selected?.trades || []).some((t) => hasExtraTradeInfo(t)),
        [selected]
    );

    const exportSelectedTradesCSV = React.useCallback(() => {
        if (!selected) return;
        const rows = (selected.trades || []).map((t) => ({
            entryTime: formatDateTime(t.entryTime),
            exitTime: formatDateTime(t.exitTime),
            side: t.side,
            entryPrice: n2(t.entryPrice, 1),
            exitPrice: n2(t.exitPrice, 1),
            pnl: n2(t.pnl, 2),
            flags: flagsForTrade(t),
            note: t.note || "",
        }));
        const csv = toCSV(rows, [
            "entryTime",
            "exitTime",
            "side",
            "entryPrice",
            "exitPrice",
            "pnl",
            "flags",
            "note",
        ]);
        const base = `${selected.symbol}_${selected.timeframe}_${(selected.id || "run").slice(0, 8)}`;
        downloadText(`trades_${base}.csv`, csv);
    }, [selected]);

    // normaliza política (aceita nomes novos ou legados)
    const policy = selected?.policy || {};
    const beAtR = (policy.beAtR ?? policy.breakEvenAtR) as number | undefined;
    const beOffset = (policy.beOffset ?? policy.beOffsetR) as number | undefined;
    const trailAtrK = (policy.trailAtrK ?? policy.kTrail) as number | undefined;
    const trailStepAtr = policy.trailStepAtr as number | undefined;
    const timeStopBars = policy.timeStopBars as number | undefined;
    const emaExit = policy.emaExit as boolean | undefined;
    const vwapExit = policy.vwapExit as boolean | undefined;
    const rr = policy.rr as number | undefined;

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
                                            setSelErr(null);
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
                        {!loadingSel && selErr && (
                            <div className="alert alert-warning py-2">
                                {selErr} — o servidor pode não expor <code>/api/backtest/run/:id</code>.
                            </div>
                        )}
                        {!loadingSel && selected && (
                            <>
                                <div className="d-flex flex-wrap justify-content-between">
                                    <div>
                                        <h6 className="mb-1">Execução</h6>
                                        <div className="small text-muted">
                                            ID: <code>{selected.id || selectedId}</code> · Rodado em: {formatDateTime(selected.ts)}
                                        </div>
                                    </div>
                                    <div className="text-end">
                                        <div>
                                            <strong>{selected.symbol}</strong> ·{" "}
                                            <span className="text-muted">{selected.timeframe}</span>
                                        </div>
                                        <div className="small">
                                            {formatDateTime(selected.from)} — {formatDateTime(selected.to)}
                                        </div>
                                    </div>
                                </div>

                                {(selected.lossCapApplied ||
                                    selected.maxConsecLossesApplied ||
                                    selected.config ||
                                    selected.policy) && (
                                        <div className="d-flex flex-wrap gap-2 mt-2">
                                            {typeof selected.lossCapApplied === "number" && selected.lossCapApplied > 0 && (
                                                <span className="badge bg-warning text-dark">
                                                    LossCap: {n2(selected.lossCapApplied, 0)} pts
                                                </span>
                                            )}
                                            {typeof selected.maxConsecLossesApplied === "number" &&
                                                selected.maxConsecLossesApplied > 0 && (
                                                    <span className="badge bg-warning text-dark">
                                                        Max Losses: {selected.maxConsecLossesApplied}
                                                    </span>
                                                )}

                                            {selected.config && typeof selected.config === "object" && (
                                                <>
                                                    {"minProb" in selected.config && (
                                                        <span className="badge bg-info">minProb: {n2(selected.config.minProb, 2)}</span>
                                                    )}
                                                    {"minEV" in selected.config && (
                                                        <span className="badge bg-info">minEV: {n2(selected.config.minEV, 2)}</span>
                                                    )}
                                                    {"metaMinProb" in selected.config && (
                                                        <span className="badge bg-secondary">
                                                            metaMinProb: {n2(selected.config.metaMinProb, 2)}
                                                        </span>
                                                    )}
                                                    {"vwapFilter" in selected.config && (
                                                        <span className="badge bg-secondary">
                                                            VWAP: {selected.config.vwapFilter ? "ON" : "OFF"}
                                                        </span>
                                                    )}
                                                </>
                                            )}

                                            {(selected.policy) && (
                                                <>
                                                    {typeof rr === "number" && (
                                                        <span className="badge bg-light text-dark">R:R {n2(rr, 2)}</span>
                                                    )}
                                                    {typeof beAtR === "number" && (
                                                        <span className="badge bg-light text-dark">BE @ {n2(beAtR, 2)}R</span>
                                                    )}
                                                    {typeof beOffset === "number" && (
                                                        <span className="badge bg-light text-dark">BE Offset {n2(beOffset, 0)} pts</span>
                                                    )}
                                                    {typeof trailAtrK === "number" && (
                                                        <span className="badge bg-light text-dark">Trail {n2(trailAtrK, 2)} ATR</span>
                                                    )}
                                                    {typeof trailStepAtr === "number" && trailStepAtr > 0 && (
                                                        <span className="badge bg-light text-dark">Step {n2(trailStepAtr, 2)} ATR</span>
                                                    )}
                                                    {typeof timeStopBars === "number" && timeStopBars > 0 && (
                                                        <span className="badge bg-light text-dark">TimeStop {timeStopBars} bars</span>
                                                    )}
                                                    {emaExit != null && (
                                                        <span className={`badge ${emaExit ? "bg-success" : "bg-secondary"}`}>
                                                            EMA Exit {emaExit ? "ON" : "OFF"}
                                                        </span>
                                                    )}
                                                    {vwapExit != null && (
                                                        <span className={`badge ${vwapExit ? "bg-success" : "bg-secondary"}`}>
                                                            VWAP Exit {vwapExit ? "ON" : "OFF"}
                                                        </span>
                                                    )}

                                                    {"slippagePts" in selected.policy && Number(selected.policy.slippagePts) > 0 && (
                                                        <span className="badge bg-danger">
                                                            Slippage: {n2(selected.policy.slippagePts, 1)} pts
                                                        </span>
                                                    )}
                                                    {"costPts" in selected.policy && Number(selected.policy.costPts) > 0 && (
                                                        <span className="badge bg-danger">
                                                            Custo: {n2(selected.policy.costPts, 1)} pts
                                                        </span>
                                                    )}
                                                </>
                                            )}
                                        </div>
                                    )}

                                <div className="row row-cols-2 row-cols-md-6 g-2 my-2">
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
                                    <div className="col">
                                        <div className="border rounded p-2">
                                            <div className="small text-muted">Profit Factor</div>
                                            <div className="fw-bold">{pfLabel}</div>
                                        </div>
                                    </div>
                                    <div className="col">
                                        <div className="border rounded p-2">
                                            <div className="small text-muted">Avg PnL</div>
                                            <div className="fw-bold">{n2(selected.summary.avgPnL, 3)}</div>
                                        </div>
                                    </div>
                                </div>

                                <div className="d-flex justify-content-end mb-2">
                                    <button
                                        className="btn btn-sm btn-outline-secondary"
                                        onClick={exportSelectedTradesCSV}
                                        disabled={!selected?.trades?.length}
                                    >
                                        Exportar CSV (trades)
                                    </button>
                                </div>

                                <div className="table-responsive">
                                    <table className="table table-sm table-striped align-middle">
                                        <thead>
                                            <tr>
                                                <th>Entrada</th>
                                                <th>Saída</th>
                                                <th>Side</th>
                                                <th style={{ textAlign: "right" }}>Entry</th>
                                                <th style={{ textAlign: "right" }}>Exit</th>
                                                <th style={{ textAlign: "right" }}>PnL</th>
                                                {hasAnyFlags && <th style={{ whiteSpace: "nowrap" }}>Flags</th>}
                                                <th>Obs</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {(selected.trades || []).slice(-200).map((t, i) => {
                                                const pnl = Number(t.pnl);
                                                const pnlClass =
                                                    Number.isFinite(pnl) && pnl !== 0
                                                        ? pnl > 0
                                                            ? "text-success fw-semibold"
                                                            : "text-danger fw-semibold"
                                                        : "";
                                                return (
                                                    <tr key={i}>
                                                        <td style={{ whiteSpace: "nowrap" }}>{formatDateTime(t.entryTime)}</td>
                                                        <td style={{ whiteSpace: "nowrap" }}>{formatDateTime(t.exitTime)}</td>
                                                        <td>{t.side}</td>
                                                        <td style={{ textAlign: "right" }}>{n2(t.entryPrice, 1)}</td>
                                                        <td style={{ textAlign: "right" }}>{n2(t.exitPrice, 1)}</td>
                                                        <td style={{ textAlign: "right" }} className={pnlClass}>
                                                            {n2(t.pnl, 2)}
                                                        </td>
                                                        {hasAnyFlags && (
                                                            <td style={{ whiteSpace: "nowrap" }}>{flagsForTrade(t) || "-"}</td>
                                                        )}
                                                        <td>{t.note || "-"}</td>
                                                    </tr>
                                                );
                                            })}
                                            {!selected.trades?.length && (
                                                <tr>
                                                    <td colSpan={hasAnyFlags ? 8 : 7} className="text-center text-muted">
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
