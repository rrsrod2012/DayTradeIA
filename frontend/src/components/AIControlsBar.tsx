import React, { useSyncExternalStore } from "react";
import {
  projectedSignals,
  fetchConfirmedSignals,
  runBacktest,
  enqueueMT5Order,
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

/* ============================
   Helpers de persistência (LS)
   ============================ */
const LS_FILTERS_KEY = "ai/controls/filters/v2";
const LS_PARAMS_KEY = "ai/controls/params/v2";

/** Auto-exec: memória de dedupe e “armado desde” */
const LS_EXEC_SENT_KEYS = "ai/exec/sentKeys/v1";
const LS_EXEC_ARMED_SINCE = "ai/exec/armedSince/v1";

function lsGet<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const val = JSON.parse(raw);
    return (val ?? fallback) as T;
  } catch {
    return fallback;
  }
}
function lsSet<T>(key: string, value: T) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch { }
}
function lsGetString(key: string, fallback: string | null = null): string | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return String(JSON.parse(raw));
  } catch {
    return fallback;
  }
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
  to: string | null;   // "YYYY-MM-DD" ou null
};
type FiltersAPI = {
  get: () => FiltersState;
  set: (patch: Partial<FiltersState>) => void;
  subscribe: (cb: () => void) => () => void;
};

// estado inicial de filtros com persistência
const _today = new Date();
const _filtersInitial: FiltersState = (() => {
  const fallback: FiltersState = {
    symbol: "WIN",
    timeframe: "M5",
    from: fmtDate(_today),
    to: fmtDate(_today),
  };
  return lsGet<FiltersState>(LS_FILTERS_KEY, fallback);
})();

const _filtersStore: {
  state: FiltersState;
  listeners: Set<() => void>;
} = {
  state: _filtersInitial,
  listeners: new Set(),
};

const FiltersAPIImpl: FiltersAPI = {
  get: () => _filtersStore.state,
  set: (patch) => {
    _filtersStore.state = { ..._filtersStore.state, ...patch };
    lsSet(LS_FILTERS_KEY, _filtersStore.state);
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

  // -------- Filtros globais --------
  const { symbol, timeframe, from, to, setFilters } = useAIControls();

  // -------- Parâmetros (Projetados / Backtest / Exec MT5) --------
  const {
    rr: rr0,
    minProb: minProb0,
    minEV: minEV0,
    useMicroModel: useMicroModel0,
    vwapFilter: vwapFilter0,
    requireMtf: requireMtf0,
    confirmTf: confirmTf0,
    breakEvenAtPts: breakEvenAtPts0,
    beOffsetPts: beOffsetPts0,
    autoRefresh: autoRefresh0,
    refreshSec: refreshSec0,
    execEnabled: execEnabled0,
    execAgentId: execAgentId0,
    execLots: execLots0,
    execMaxAgeSec: execMaxAgeSec0,

    // >>> novos: SL/TP da tela
    sendStops: sendStops0,
    slPts: slPts0,
    tpPts: tpPts0,
    tpViaRR: tpViaRR0,
  } = lsGet(LS_PARAMS_KEY, {
    rr: 2,
    minProb: 0.52,
    minEV: 0,
    useMicroModel: true,
    vwapFilter: true,
    requireMtf: true,
    confirmTf: "M15",
    breakEvenAtPts: 10,
    beOffsetPts: 0,
    autoRefresh: true,
    refreshSec: 20,
    execEnabled: false,
    execAgentId: "mt5-ea-1",
    execLots: 1,
    execMaxAgeSec: 20, // janela de frescor padrão (seg)

    // defaults SL/TP
    sendStops: false,
    slPts: 0,
    tpPts: 0,
    tpViaRR: true,
  });

  const [rr, setRr] = React.useState<number>(rr0);
  const [minProb, setMinProb] = React.useState<number>(minProb0);
  const [minEV, setMinEV] = React.useState<number>(minEV0);
  const [useMicroModel, setUseMicroModel] = React.useState<boolean>(useMicroModel0);
  const [vwapFilter, setVwapFilter] = React.useState<boolean>(vwapFilter0);
  const [requireMtf, setRequireMtf] = React.useState<boolean>(requireMtf0);
  const [confirmTf, setConfirmTf] = React.useState<string>(confirmTf0);

  // >>> BE por pontos (para o backtest)
  const [breakEvenAtPts, setBreakEvenAtPts] = React.useState<number>(breakEvenAtPts0);
  const [beOffsetPts, setBeOffsetPts] = React.useState<number>(beOffsetPts0);

  // Execução MT5
  const [execEnabled, setExecEnabled] = React.useState<boolean>(!!execEnabled0);
  const [execAgentId, setExecAgentId] = React.useState<string>(execAgentId0 || "mt5-ea-1");
  const [execLots, setExecLots] = React.useState<number>(Number(execLots0) || 1);
  const [execMaxAgeSec, setExecMaxAgeSec] = React.useState<number>(Number(execMaxAgeSec0) || 20);
  const [execMsg, setExecMsg] = React.useState<string | null>(null);

  // >>> Novos controles de SL/TP
  const [sendStops, setSendStops] = React.useState<boolean>(!!sendStops0);
  const [slPts, setSlPts] = React.useState<number>(Number(slPts0) || 0);
  const [tpPts, setTpPts] = React.useState<number>(Number(tpPts0) || 0);
  const [tpViaRR, setTpViaRR] = React.useState<boolean>(!!tpViaRR0);

  // -------- Auto-refresh --------
  const [autoRefresh, setAutoRefresh] = React.useState<boolean>(autoRefresh0);
  const [refreshSec, setRefreshSec] = React.useState<number>(refreshSec0);

  // -------- Estado geral --------
  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  // -------- Painel Backtests --------
  const [showBacktests, setShowBacktests] = React.useState(false);

  const setProjected = useAIStore((s) => s.setProjected);
  const setConfirmed = useAIStore((s) => s.setConfirmed);
  const setPnL = useAIStore((s) => s.setPnL);
  const setTrades = useAIStore((s) => s.setTrades);

  // Persiste parâmetros no LS sempre que mudarem
  React.useEffect(() => {
    lsSet(LS_PARAMS_KEY, {
      rr,
      minProb,
      minEV,
      useMicroModel,
      vwapFilter,
      requireMtf,
      confirmTf,
      breakEvenAtPts,
      beOffsetPts,
      autoRefresh,
      refreshSec,
      execEnabled,
      execAgentId,
      execLots,
      execMaxAgeSec,

      // novos
      sendStops,
      slPts,
      tpPts,
      tpViaRR,
    });
  }, [
    rr,
    minProb,
    minEV,
    useMicroModel,
    vwapFilter,
    requireMtf,
    confirmTf,
    breakEvenAtPts,
    beOffsetPts,
    autoRefresh,
    refreshSec,
    execEnabled,
    execAgentId,
    execLots,
    execMaxAgeSec,
    sendStops,
    slPts,
    tpPts,
    tpViaRR,
  ]);

  const baseParams = React.useCallback(
    () => ({
      symbol: String(symbol || "").trim().toUpperCase(),
      timeframe: String(timeframe || "").trim().toUpperCase(),
      from: from || undefined,
      to: to || undefined,
    }),
    [symbol, timeframe, from, to]
  );

  /** ------------- AUTO-EXEC HELPERS ------------- */

  // chave de dedupe por confirmação (inclui symbol e tf ativos)
  function execKeyForConfirm(s: { side: string; time: string | undefined; price?: number | null }) {
    const p = baseParams();
    const t = s.time ? new Date(s.time).toISOString() : "";
    const pr = s.price != null ? String(Math.round(Number(s.price) * 100) / 100) : "-";
    return `${p.symbol}|${p.timeframe}|${s.side}|${t}|${pr}`;
  }

  function clampSentKeys(keys: string[], max = 1000) {
    if (keys.length > max) return keys.slice(keys.length - Math.floor(max / 2));
    return keys;
  }

  function isFreshEnough(iso?: string | null, maxAgeSec = 20, armedSinceIso: string | null = null) {
    if (!iso) return false;
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return false;
    const now = Date.now();
    if (maxAgeSec > 0 && now - t > maxAgeSec * 1000) return false;
    if (t - now > 60000) return false;
    if (armedSinceIso) {
      const armTs = Date.parse(armedSinceIso);
      if (Number.isFinite(armTs) && t < armTs) return false;
    }
    return true;
  }

  // calcula SL/TP a partir dos controles de tela
  function computeStops() {
    let slPtsToSend: number | null = null;
    let tpPtsToSend: number | null = null;

    if (sendStops) {
      const sl = Math.max(0, Math.floor(Number(slPts) || 0));
      if (sl > 0) slPtsToSend = sl;

      if (tpViaRR) {
        if (slPtsToSend && rr > 0) {
          tpPtsToSend = Math.max(0, Math.round(slPtsToSend * Number(rr)));
        }
      } else {
        const tp = Math.max(0, Math.floor(Number(tpPts) || 0));
        if (tp > 0) tpPtsToSend = tp;
      }
    }

    return { slPtsToSend, tpPtsToSend };
  }

  async function autoExecFromConfirmed(confirms: Array<{ side: any; time: any; price?: any }>) {
    if (!execEnabled) return;

    const armedSince = lsGetString(LS_EXEC_ARMED_SINCE, null);

    const sentArr = lsGet<string[]>(LS_EXEC_SENT_KEYS, []);
    const sent = new Set(sentArr);

    const candidates = (confirms || [])
      .filter((s) => {
        const side = String(s.side || "").toUpperCase();
        return side === "BUY" || side === "SELL";
      })
      .filter((s) => isFreshEnough(String(s.time || ""), execMaxAgeSec, armedSince))
      .filter((s) => !sent.has(execKeyForConfirm(s)));

    if (candidates.length === 0) return;

    const { slPtsToSend, tpPtsToSend } = computeStops();

    for (const s of candidates) {
      const side = String(s.side).toUpperCase() as "BUY" | "SELL";
      const task = {
        id: `auto-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        side,
        comment: `auto ${side} ${new Date().toISOString()}${slPtsToSend ? ` SL=${slPtsToSend}` : ""}${tpPtsToSend ? ` TP=${tpPtsToSend}` : ""}`,
        beAtPoints: breakEvenAtPts,
        beOffsetPoints: beOffsetPts,
        timeframe: null,
        time: null,
        price: 0,
        volume: execLots,
        slPoints: slPtsToSend,
        tpPoints: tpPtsToSend,
      };

      const body = {
        agentId: (execAgentId || "mt5-ea-1").trim(),
        tasks: [task],
      };

      try {
        const res = await enqueueMT5Order(body);
        setExecMsg(`AUTO ${side}: ${JSON.stringify(res)}`);
        sent.add(execKeyForConfirm(s));
      } catch (e: any) {
        const msg =
          (e?.message || "Falha no enqueue") +
          (e?.urlTried ? ` @ ${e.urlTried}` : "") +
          (e?.response ? ` | resp=${JSON.stringify(e.response)}` : "");
        setExecMsg(`ERRO AUTO ${side}: ${msg}`);
      }
    }

    const newArr = clampSentKeys(Array.from(sent), 1000);
    lsSet(LS_EXEC_SENT_KEYS, newArr);
  }

  // quando liga o toggle, “arma” a referência de tempo (salva ISO/UTC, mostra local)
  React.useEffect(() => {
    if (execEnabled) {
      const now = new Date();
      const nowIso = now.toISOString();      // comparações (UTC)
      const nowLocal = now.toLocaleString(); // exibição (fuso local)
      lsSet(LS_EXEC_ARMED_SINCE, nowIso);
      setExecMsg(`AUTO armado às ${nowLocal} (local)`);
    }
  }, [execEnabled]);

  /** ----------------------------------------------------------- */

  /** Busca PROJETADOS + CONFIRMADOS + PnL + Trades */
  async function fetchAllOnce() {
    setLoading(true);
    setErr(null);
    try {
      const params = baseParams();

      (window as any).__dbgLastParams = {
        ...params,
        rr,
        minProb,
        minEV,
        useMicroModel,
        vwapFilter,
        requireMtf,
        confirmTf,
        breakEvenAtPts,
        beOffsetPts,
        execEnabled,
        execAgentId,
        execLots,
        execMaxAgeSec,

        // visuais
        sendStops,
        slPts,
        tpPts,
        tpViaRR,
      };

      // 1) Projetados — overrides temporários
      const payload: any = {
        ...params,
        rr,
        minProb,
        minEV,
        useMicroModel,
        vwapFilter,
        requireMtf,
        confirmTf: String(confirmTf || "").trim().toUpperCase(),
      };
      if (payload.minEV === 0) delete payload.minEV;
      payload.vwapFilter = false;
      payload.requireMtf = false;
      delete payload.confirmTf;

      const proj = await projectedSignals(payload);

      if (process.env.NODE_ENV !== "production") {
        const buy = (proj || []).filter((r) => r.side === "BUY").length;
        const sell = (proj || []).filter((r) => r.side === "SELL").length;
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
        minEV,
        useMicroModel,
        vwapFilter,
        requireMtf,
        confirmTf,
      });

      // 2) Confirmados
      const confRaw = await fetchConfirmedSignals({ ...params, limit: 2000 });
      (window as any).__dbgConfirmedRaw = confRaw;
      setConfirmed(confRaw || [], params);

      // >>> 2.1) AUTO-EXEC: dispara a partir dos confirmados frescos
      await autoExecFromConfirmed(confRaw || []);

      // 3) Backtest com BE por pontos
      const bt = await runBacktest({
        ...(params as any),
        breakEvenAtPts,
        beOffsetPts,
      });

      const rawTrades =
        (Array.isArray(bt?.trades) && bt?.trades) ||
        (Array.isArray(bt?.rows) && bt?.rows) ||
        (Array.isArray(bt?.items) && bt?.items) ||
        (Array.isArray(bt?.data) && bt?.data) ||
        [];

      (window as any).__dbgTradesRaw = rawTrades;

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

      setTrades(rawTrades, bt?.meta);
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

  // --- helper: monta task no formato que o EA/NodeBridge consome ---
  function makeMt5Task(side: "BUY" | "SELL") {
    const { slPtsToSend, tpPtsToSend } = computeStops();
    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      side,
      comment: `ui-test ${side} ${new Date().toISOString()}${slPtsToSend ? ` SL=${slPtsToSend}` : ""}${tpPtsToSend ? ` TP=${tpPtsToSend}` : ""}`,
      beAtPoints: breakEvenAtPts,
      beOffsetPoints: beOffsetPts,
      timeframe: null,
      time: null,
      price: 0,
      volume: execLots,
      slPoints: slPtsToSend,
      tpPoints: tpPtsToSend,
    };
  }

  // Enfileirar ordem de teste no MT5 (payload { agentId, tasks: [...] })
  async function onExecTest(side: "BUY" | "SELL") {
    setExecMsg(null);
    if (!execEnabled) {
      setExecMsg("Execução desativada (ligue o toggle).");
      return;
    }

    const body = {
      agentId: (execAgentId || "mt5-ea-1").trim(),
      tasks: [makeMt5Task(side)],
    };

    try {
      const res = await enqueueMT5Order(body);
      setExecMsg(`OK ${side}: ${JSON.stringify(res)}`);
      window.dispatchEvent(
        new CustomEvent("daytrade:mt5-enqueue", { detail: { when: Date.now(), body, res } })
      );
    } catch (e: any) {
      const msg =
        (e?.message || "Falha no enqueue") +
        (e?.urlTried ? ` @ ${e.urlTried}` : "") +
        (e?.response ? ` | resp=${JSON.stringify(e.response)}` : "");
      setExecMsg(`ERRO ${side}: ${msg}`);
    }
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
    breakEvenAtPts,
    beOffsetPts,
    execEnabled,
    execAgentId,
    execLots,
    execMaxAgeSec,
    sendStops,
    slPts,
    tpPts,
    tpViaRR,
  ]);

  // Invalidação por evento vindo do backend/WS
  React.useEffect(() => {
    function onInvalidate() {
      fetchAllOnce();
    }
    window.addEventListener("daytrade:data-invalidate" as any, onInvalidate);
    return () => {
      window.removeEventListener("daytrade:data-invalidate" as any, onInvalidate);
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
    breakEvenAtPts,
    beOffsetPts,
    execEnabled,
    execAgentId,
    execLots,
    execMaxAgeSec,
    sendStops,
    slPts,
    tpPts,
    tpViaRR,
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
                {/* filtros principais */}
                <div className="input-group input-group-sm" style={{ width: 140 }}>
                  <span className="input-group-text">Símbolo</span>
                  <input
                    className="form-control"
                    value={symbol}
                    onChange={(e) => setFilters({ symbol: e.target.value })}
                  />
                </div>

                <div className="input-group input-group-sm" style={{ width: 120 }}>
                  <span className="input-group-text">TF</span>
                  <input
                    className="form-control"
                    value={timeframe}
                    onChange={(e) => setFilters({ timeframe: e.target.value })}
                  />
                </div>

                <div className="input-group input-group-sm" style={{ width: 210 }}>
                  <span className="input-group-text">De</span>
                  <input
                    type="date"
                    className="form-control"
                    value={from ?? ""}
                    onChange={(e) => setFilters({ from: e.target.value || null })}
                  />
                </div>

                <div className="input-group input-group-sm" style={{ width: 210 }}>
                  <span className="input-group-text">Até</span>
                  <input
                    type="date"
                    className="form-control"
                    value={to ?? ""}
                    onChange={(e) => setFilters({ to: e.target.value || null })}
                  />
                </div>

                {/* parâmetros — Projetados / Backtest */}
                <div className="input-group input-group-sm" style={{ width: 110 }}>
                  <span className="input-group-text">RR</span>
                  <input
                    type="number"
                    step="0.1"
                    className="form-control"
                    value={rr}
                    onChange={(e) => setRr(Number(e.target.value))}
                  />
                </div>

                <div className="input-group input-group-sm" style={{ width: 150 }}>
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

                <div className="input-group input-group-sm" style={{ width: 140 }}>
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

                <div className="input-group input-group-sm" style={{ width: 150 }}>
                  <span className="input-group-text">TF Conf.</span>
                  <input
                    className="form-control"
                    value={confirmTf}
                    onChange={(e) => setConfirmTf(e.target.value)}
                  />
                </div>

                {/* >>> BE por pontos */}
                <div className="input-group input-group-sm" style={{ width: 140 }}>
                  <span className="input-group-text">BE (pts)</span>
                  <input
                    type="number"
                    step={1}
                    className="form-control"
                    value={breakEvenAtPts}
                    onChange={(e) => setBreakEvenAtPts(Number(e.target.value) || 0)}
                  />
                </div>

                <div className="input-group input-group-sm" style={{ width: 150 }}>
                  <span className="input-group-text">Offset (pts)</span>
                  <input
                    type="number"
                    step={1}
                    className="form-control"
                    value={beOffsetPts}
                    onChange={(e) => setBeOffsetPts(Number(e.target.value) || 0)}
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

                <div className="input-group input-group-sm" style={{ width: 130 }}>
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

              {/* ===== Execução MT5 ===== */}
              <div className="vr mx-2" />
              <div className="d-flex flex-wrap align-items-end gap-2">
                <div className="form-check form-switch">
                  <input
                    className="form-check-input"
                    type="checkbox"
                    id="exec-toggle"
                    checked={execEnabled}
                    onChange={(e) => setExecEnabled(e.target.checked)}
                  />
                </div>
                <label className="form-check-label me-2" htmlFor="exec-toggle">
                  Executar no MT5 (auto)
                </label>

                <div className="input-group input-group-sm" style={{ width: 180 }}>
                  <span className="input-group-text">AgentId</span>
                  <input
                    className="form-control"
                    value={execAgentId}
                    onChange={(e) => setExecAgentId(e.target.value)}
                    placeholder="mt5-ea-1"
                  />
                </div>

                <div className="input-group input-group-sm" style={{ width: 120 }}>
                  <span className="input-group-text">Lots</span>
                  <input
                    type="number"
                    step={0.1}
                    min={0.1}
                    className="form-control"
                    value={execLots}
                    onChange={(e) =>
                      setExecLots(Math.max(0.01, Number(e.target.value) || 1))
                    }
                  />
                </div>

                {/* Janela de frescor (anti-histórico) */}
                <div className="input-group input-group-sm" style={{ width: 160 }}>
                  <span className="input-group-text">MaxAge</span>
                  <input
                    type="number"
                    min={5}
                    step={5}
                    className="form-control"
                    value={execMaxAgeSec}
                    onChange={(e) =>
                      setExecMaxAgeSec(Math.max(5, Number(e.target.value) || 20))
                    }
                  />
                  <span className="input-group-text">s</span>
                </div>

                {/* >>> novos: SL/TP da tela */}
                <div className="form-check form-switch">
                  <input
                    className="form-check-input"
                    type="checkbox"
                    id="stops-toggle"
                    checked={sendStops}
                    onChange={(e) => setSendStops(e.target.checked)}
                  />
                  <label className="form-check-label" htmlFor="stops-toggle">
                    Enviar SL/TP
                  </label>
                </div>

                <div className="input-group input-group-sm" style={{ width: 130 }}>
                  <span className="input-group-text">SL (pts)</span>
                  <input
                    type="number"
                    step={1}
                    min={0}
                    className="form-control"
                    value={slPts}
                    onChange={(e) => setSlPts(Math.max(0, Number(e.target.value) || 0))}
                    disabled={!sendStops}
                  />
                </div>

                <div className="form-check form-switch">
                  <input
                    className="form-check-input"
                    type="checkbox"
                    id="tp-rr-toggle"
                    checked={tpViaRR}
                    onChange={(e) => setTpViaRR(e.target.checked)}
                    disabled={!sendStops}
                  />
                  <label className="form-check-label" htmlFor="tp-rr-toggle">
                    TP via RR
                  </label>
                </div>

                <div className="input-group input-group-sm" style={{ width: 130 }}>
                  <span className="input-group-text">TP (pts)</span>
                  <input
                    type="number"
                    step={1}
                    min={0}
                    className="form-control"
                    value={tpPts}
                    onChange={(e) => setTpPts(Math.max(0, Number(e.target.value) || 0))}
                    disabled={!sendStops || tpViaRR}
                  />
                </div>

                <button
                  className="btn btn-sm btn-success"
                  disabled={!execEnabled}
                  onClick={() => onExecTest("BUY")}
                  title="Enviar ordem de teste BUY para o MT5"
                >
                  BUY (teste)
                </button>
                <button
                  className="btn btn-sm btn-danger"
                  disabled={!execEnabled}
                  onClick={() => onExecTest("SELL")}
                  title="Enviar ordem de teste SELL para o MT5"
                >
                  SELL (teste)
                </button>

                {execMsg && (
                  <span
                    className="small ms-2"
                    style={{
                      maxWidth: 600,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    <code>{execMsg}</code>
                  </span>
                )}
              </div>
              {/* ======================== */}
            </div>
          </div>
        </div>
      </div>

      {/* Painel Backtests (fora do header sticky) */}
      {showBacktests && <BacktestRunsPanel />}
    </>
  );
}
