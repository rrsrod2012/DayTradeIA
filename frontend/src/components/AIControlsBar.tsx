import React from "react";
import {
  projectedSignals,
  fetchConfirmedSignals,
  runBacktest,
} from "../services/api";
import { useAIStore } from "../store/ai";

// helpers de data (YYYY-MM-DD no fuso local)
function fmtDate(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

type Props = {
  collapsedByDefault?: boolean;
};

export default function AIControlsBar({ collapsedByDefault }: Props) {
  const [collapsed, setCollapsed] = React.useState(!!collapsedByDefault);

  // ---------- Datas default = HOJE ----------
  const today = React.useMemo(() => new Date(), []);
  const [from, setFrom] = React.useState(fmtDate(today)); // YYYY-MM-DD
  const [to, setTo] = React.useState(fmtDate(today));     // YYYY-MM-DD

  // ---------- Filtros ----------
  const [symbol, setSymbol] = React.useState("WIN");
  const [timeframe, setTimeframe] = React.useState("M5");

  // ---------- Parâmetros (aplicam-se aos Projetados) ----------
  const [rr, setRr] = React.useState(2);
  const [minProb, setMinProb] = React.useState(0.52);
  const [minEV, setMinEV] = React.useState(0);
  const [useMicroModel, setUseMicroModel] = React.useState(true);
  const [vwapFilter, setVwapFilter] = React.useState(true);
  const [requireMtf, setRequireMtf] = React.useState(true);
  const [confirmTf, setConfirmTf] = React.useState("M15");

  // ---------- Auto-refresh ----------
  const [autoRefresh, setAutoRefresh] = React.useState(true);
  const [refreshSec, setRefreshSec] = React.useState(20);

  // ---------- Estado ----------
  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const setProjected = useAIStore((s) => s.setProjected);
  const setConfirmed = useAIStore((s) => s.setConfirmed);
  const setPnL = useAIStore((s) => s.setPnL);

  const baseParams = React.useCallback(
    () => ({
      symbol: symbol.trim().toUpperCase(),
      timeframe: timeframe.trim().toUpperCase(),
      from: from || undefined,
      to: to || undefined,
    }),
    [symbol, timeframe, from, to]
  );

  /** Busca PROJETADOS + CONFIRMADOS + PnL de uma vez só */
  async function fetchAllOnce() {
    setLoading(true);
    setErr(null);
    try {
      const params = baseParams();

      // 1) Projetados
      const proj = await projectedSignals({
        ...params,
        rr,
        minProb,
        minEV,
        useMicroModel,
        vwapFilter,
        requireMtf,
        confirmTf: confirmTf.trim().toUpperCase(),
      });
      setProjected(proj || [], {
        ...params,
        rr,
        minProb,
        minEV,
        useMicroModel,
        vwapFilter,
        requireMtf,
        confirmTf,
      });

      // 2) Confirmados
      const conf = await fetchConfirmedSignals({ ...params, limit: 2000 });
      setConfirmed(conf || [], params);

      // 3) PnL
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
    } catch (e: any) {
      setErr(e?.message || "Erro ao atualizar dados");
      // Mantemos dados anteriores na tela
    } finally {
      setLoading(false);
    }
  }

  // Botão manual (opcional)
  async function onBuscarAgora() {
    await fetchAllOnce();
  }

  // Loop de auto-refresh (inclui primeira chamada imediata)
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

    tick(); // dispara imediatamente ao ligar
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

  // OUVE o evento disparado pelo backend/WS para invalidar dados do dia atual
  React.useEffect(() => {
    function onInvalidate() {
      // Mantemos from/to atuais (por padrão = HOJE) e só refetch
      fetchAllOnce();
    }
    // nome do evento vindo do ImportProgress / stream
    window.addEventListener("daytrade:data-invalidate" as any, onInvalidate);
    return () => {
      window.removeEventListener("daytrade:data-invalidate" as any, onInvalidate);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, timeframe, from, to, rr, minProb, minEV, useMicroModel, vwapFilter, requireMtf, confirmTf]);

  return (
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
            <div className="vr mx-2" />

            <div className="d-flex flex-wrap align-items-end gap-2">
              {/* filtros principais */}
              <div
                className="input-group input-group-sm"
                style={{ width: 140 }}
              >
                <span className="input-group-text">Símbolo</span>
                <input
                  className="form-control"
                  value={symbol}
                  onChange={(e) => setSymbol(e.target.value)}
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
                  onChange={(e) => setTimeframe(e.target.value)}
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
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
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
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
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
  );
}
