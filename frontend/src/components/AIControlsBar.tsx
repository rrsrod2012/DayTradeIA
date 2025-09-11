import React, { useSyncExternalStore } from "react";
import {
  projectedSignals,
  fetchConfirmedSignals,
  runBacktest,
} from "../services/api";
import { useAIStore } from "../store/ai";
import BacktestRunsPanel from "./BacktestRunsPanel";

/* ============================
   Helpers de data (YYYY-MM-DD)
   ============================ */
function fmtDate(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

type Props = {
  collapsedByDefault?: boolean;
};

/* ===========================================================
   Store global de filtros (sem Provider) via useSyncExternalStore
   =========================================================== */
type FiltersState = {
  symbol: string;
  timeframe: string;
  from: string | null; // "YYYY-MM-DD" ou null
  to: string | null; // "YYYY-MM-DD" ou null
};
type FiltersAPI = {
  get: () => FiltersState;
  set: (patch: Partial<FiltersState>) => void;
  subscribe: (cb: () => void) => () => void;
};

const _today = new Date();
const _filtersStore: {
  state: FiltersState;
  listeners: Set<() => void>;
} = {
  state: {
    symbol: "WIN",
    timeframe: "M5",
    from: fmtDate(_today),
    to: fmtDate(_today),
  },
  listeners: new Set(),
};

const FiltersAPIImpl: FiltersAPI = {
  get: () => _filtersStore.state,
  set: (patch) => {
    _filtersStore.state = { ..._filtersStore.state, ...patch };
    _filtersStore.listeners.forEach((fn) => fn());
  },
  subscribe: (cb) => {
    _filtersStore.listeners.add(cb);
    return () => _filtersStore.listeners.delete(cb);
  },
};

/** Hook global exportado: outros componentes podem importar de AIControlsBar.tsx */
export function useAIControls() {
  const snapshot = useSyncExternalStore(
    FiltersAPIImpl.subscribe,
    FiltersAPIImpl.get,
    FiltersAPIImpl.get
  );
  const setFilters = React.useCallback(
    (patch: Partial<FiltersState>) => FiltersAPIImpl.set(patch),
    []
  );
  return { ...snapshot, setFilters };
}

/* ============================
   Componente da barra de controles
   ============================ */
export default function AIControlsBar({ collapsedByDefault }: Props) {
  const [collapsed, setCollapsed] = React.useState(!!collapsedByDefault);

  // -------- Filtros globais (fonte única de verdade) --------
  const { symbol, timeframe, from, to, setFilters } = useAIControls();

  // -------- Parâmetros (apenas para Projetados) --------
  const [rr, setRr] = React.useState(2);
  const [minProb, setMinProb] = React.useState(0.52);
  const [minEV, setMinEV] = React.useState(0);
  const [useMicroModel, setUseMicroModel] = React.useState(true);
  const [vwapFilter, setVwapFilter] = React.useState(true);
  const [requireMtf, setRequireMtf] = React.useState(true);
  const [confirmTf, setConfirmTf] = React.useState("M15");

  // -------- Auto-refresh --------
  const [autoRefresh, setAutoRefresh] = React.useState(true);
  const [refreshSec, setRefreshSec] = React.useState(20);

  // -------- Estado geral --------
  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  // -------- Painel Backtests --------
  const [showBacktests, setShowBacktests] = React.useState(false);

  const setProjected = useAIStore((s) => s.setProjected);
  const setConfirmed = useAIStore((s) => s.setConfirmed);
  const setPnL = useAIStore((s) => s.setPnL);
  const setTrades = useAIStore((s) => s.setTrades);

  const baseParams = React.useCallback(
    () => ({
      symbol: String(symbol || "")
        .trim()
        .toUpperCase(),
      timeframe: String(timeframe || "")
        .trim()
        .toUpperCase(),
      from: from || undefined,
      to: to || undefined,
    }),
    [symbol, timeframe, from, to]
  );

  /** Busca PROJETADOS + CONFIRMADOS + PnL + Trades */
  async function fetchAllOnce() {
    setLoading(true);
    setErr(null);
    try {
      const params = baseParams();

      // 1) Projetados — PATCH TEMPORÁRIO: desligar filtros que podem suprimir SELL
      const payload: any = {
        ...params,
        rr,
        minProb,
        minEV,
        useMicroModel,
        vwapFilter,
        requireMtf,
        confirmTf: String(confirmTf || "")
          .trim()
          .toUpperCase(),
      };

      // --- overrides temporários ---
      if (payload.minEV === 0) delete payload.minEV;
      payload.vwapFilter = false;
      payload.requireMtf = false;
      delete payload.confirmTf;
      // -----------------------------

      const proj = await projectedSignals(payload);

      if (process.env.NODE_ENV !== "production") {
        const buy = (proj || []).filter((r) => r.side === "BUY").length;
        const sell = (proj || []).filter((r) => r.side === "SELL").length;
        // eslint-disable-next-line no-console
        console.log("[AIControlsBar] projected fetched (TEMP PATCH)", {
          sent: payload,
          received: (proj || []).length,
          buy,
          sell,
          exampleSELL: (proj || []).find((r) => r.side === "SELL") || null,
        });
      }

      setProjected(proj || [], {
        ...params,
        rr,
        minProb,
        // refletimos os valores do formulário (sem os overrides) para não quebrar UI
        minEV,
        useMicroModel,
        vwapFilter,
        requireMtf,
        confirmTf,
      });

      // 2) Confirmados (sem patch)
      const conf = await fetchConfirmedSignals({ ...params, limit: 2000 });
      setConfirmed(conf || [], params);

      // 3) Backtest (PnL + Trades)
      const bt = await runBacktest(params as any);

      const sum = bt?.summary || null;
      setPnL(
        sum
          ? {
              trades: sum.trades ?? 0,
              wins: sum.wins ?? 0,
              losses: sum.losses ?? 0,
              ties: sum.ties ?? 0,
              winRate: sum.winRate ?? 0,
              pnlPoints: sum.pnlPoints ?? bt?.pnlPoints ?? 0,
              pnlMoney: bt?.pnlMoney ?? undefined,
              avgPnL: sum.avgPnL ?? 0,
              profitFactor: sum.profitFactor ?? 0,
              maxDrawdown: sum.maxDrawdown ?? 0,
            }
          : null
      );

      // Captura trades (várias chaves possíveis)
      const rawTrades =
        (Array.isArray(bt?.trades) && bt?.trades) ||
        (Array.isArray(bt?.rows) && bt?.rows) ||
        (Array.isArray(bt?.items) && bt?.items) ||
        (Array.isArray(bt?.data) && bt?.data) ||
        [];

      setTrades(rawTrades);
    } catch (e: any) {
      setErr(e?.message || "Erro ao atualizar dados");
    } finally {
      setLoading(false);
    }
  }

  // Botão manual
  async function onBuscarAgora() {
    await fetchAllOnce();
  }

  // Loop de auto-refresh (dispara imediatamente ao ligar)
  React.useEffect(() => {
    if (!autoRefresh) return;
    let alive = true;
    let timer: any = null;

    async function tick() {
      if (!alive) return;
      await fetchAllOnce();
      if (!alive) return;
      timer = setTimeout(tick, Math.max(5, refreshSec) * 1000);
    }

    tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    autoRefresh,
    refreshSec,
    symbol,
    timeframe,
    from,
    to,
    rr,
    minProb,
    minEV,
    useMicroModel,
    vwapFilter,
    requireMtf,
    confirmTf,
  ]);

  // Invalidação por evento vindo do backend/WS
  React.useEffect(() => {
    function onInvalidate() {
      fetchAllOnce();
    }
    window.addEventListener("daytrade:data-invalidate" as any, onInvalidate);
    return () => {
      window.removeEventListener(
        "daytrade:data-invalidate" as any,
        onInvalidate
      );
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    symbol,
    timeframe,
    from,
    to,
    rr,
    minProb,
    minEV,
    useMicroModel,
    vwapFilter,
    requireMtf,
    confirmTf,
  ]);

  return (
    <>
      <div style={{ position: "sticky", top: 0, zIndex: 1030 }}>
        <div className="bg-body-tertiary border-bottom">
          <div className="container py-2">
            <div className="d-flex align-items-center gap-2">
              <button
                className="btn btn-sm btn-outline-secondary"
                onClick={() => setCollapsed((c) => !c)}
                title={collapsed ? "Expandir" : "Recolher"}
              >
                {collapsed ? "▸" : "▾"}
              </button>
              <strong>IA</strong>

              {/* Botão painel Backtests */}
              <button
                className="btn btn-sm btn-outline-primary ms-2"
                onClick={() => setShowBacktests((v) => !v)}
                title="Mostrar/ocultar backtests recentes"
              >
                {showBacktests ? "Ocultar Backtests" : "Backtests"}
              </button>

              <div className="vr mx-2" />

              <div className="d-flex flex-wrap align-items-end gap-2">
                {/* filtros principais (ligados ao store global) */}
                <div
                  className="input-group input-group-sm"
                  style={{ width: 140 }}
                >
                  <span className="input-group-text">Símbolo</span>
                  <input
                    className="form-control"
                    value={symbol}
                    onChange={(e) => setFilters({ symbol: e.target.value })}
                  />
                </div>

                <div
                  className="input-group input-group-sm"
                  style={{ width: 120 }}
                >
                  <span className="input-group-text">TF</span>
                  <input
                    className="form-control"
                    value={timeframe}
                    onChange={(e) => setFilters({ timeframe: e.target.value })}
                  />
                </div>

                <div
                  className="input-group input-group-sm"
                  style={{ width: 210 }}
                >
                  <span className="input-group-text">De</span>
                  <input
                    type="date"
                    className="form-control"
                    value={from ?? ""}
                    onChange={(e) =>
                      setFilters({ from: e.target.value || null })
                    }
                  />
                </div>

                <div
                  className="input-group input-group-sm"
                  style={{ width: 210 }}
                >
                  <span className="input-group-text">Até</span>
                  <input
                    type="date"
                    className="form-control"
                    value={to ?? ""}
                    onChange={(e) => setFilters({ to: e.target.value || null })}
                  />
                </div>

                {/* parâmetros — afetam apenas os Projetados */}
                <div
                  className="input-group input-group-sm"
                  style={{ width: 110 }}
                >
                  <span className="input-group-text">RR</span>
                  <input
                    type="number"
                    step="0.1"
                    className="form-control"
                    value={rr}
                    onChange={(e) => setRr(Number(e.target.value))}
                  />
                </div>

                <div
                  className="input-group input-group-sm"
                  style={{ width: 150 }}
                >
                  <span className="input-group-text">minProb</span>
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

                <div
                  className="input-group input-group-sm"
                  style={{ width: 140 }}
                >
                  <span className="input-group-text">minEV</span>
                  <input
                    type="number"
                    step="0.1"
                    className="form-control"
                    value={minEV}
                    onChange={(e) => setMinEV(Number(e.target.value))}
                  />
                </div>

                <div className="form-check form-switch">
                  <input
                    className="form-check-input"
                    type="checkbox"
                    id="ai-toggle"
                    checked={useMicroModel}
                    onChange={(e) => setUseMicroModel(e.target.checked)}
                  />
                  <label className="form-check-label" htmlFor="ai-toggle">
                    Usar IA
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
                    VWAP
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
                    MTF
                  </label>
                </div>

                <div
                  className="input-group input-group-sm"
                  style={{ width: 150 }}
                >
                  <span className="input-group-text">TF Conf.</span>
                  <input
                    className="form-control"
                    value={confirmTf}
                    onChange={(e) => setConfirmTf(e.target.value)}
                  />
                </div>

                <div className="vr mx-1" />

                {/* Auto refresh */}
                <div className="form-check form-switch">
                  <input
                    className="form-check-input"
                    type="checkbox"
                    id="auto-toggle"
                    checked={autoRefresh}
                    onChange={(e) => setAutoRefresh(e.target.checked)}
                  />
                  <label className="form-check-label" htmlFor="auto-toggle">
                    Atualizar auto
                  </label>
                </div>

                <div
                  className="input-group input-group-sm"
                  style={{ width: 130 }}
                >
                  <span className="input-group-text">a cada</span>
                  <input
                    type="number"
                    min={5}
                    step={5}
                    className="form-control"
                    value={refreshSec}
                    onChange={(e) =>
                      setRefreshSec(Math.max(5, Number(e.target.value)))
                    }
                  />
                  <span className="input-group-text">s</span>
                </div>

                <button
                  className="btn btn-sm btn-primary ms-2"
                  onClick={onBuscarAgora}
                  disabled={loading}
                >
                  {loading ? "Atualizando..." : "Buscar agora"}
                </button>

                {err && (
                  <span className="text-danger small ms-2">
                    <strong>Erro:</strong> {err}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Painel Backtests (fora do header sticky) */}
      {showBacktests && <BacktestRunsPanel />}
    </>
  );
}
