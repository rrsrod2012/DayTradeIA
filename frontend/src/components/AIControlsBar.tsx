// ===============================
// FILE: frontend/src/components/AIControlsBar.tsx
// ===============================
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
const LS_PARAMS_KEY = "ai/controls/params/v3";
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
  from: string | null;
  to: string | null;
};
type FiltersAPI = {
  get: () => FiltersState;
  set: (patch: Partial<FiltersState>) => void;
  subscribe: (cb: () => void) => () => void;
};

// <<< DATA FINAL CORRIGIDA >>>
const _defaultDate = new Date("2025-10-02T12:00:00Z");

const _filtersInitial: FiltersState = (() => {
  const fallback: FiltersState = {
    symbol: "WIN",
    timeframe: "M5",
    from: fmtDate(_defaultDate),
    to: fmtDate(_defaultDate),
  };
  return lsGet<FiltersState>(LS_FILTERS_KEY, fallback);
})();

const _filtersStore: { state: FiltersState; listeners: Set<() => void> } = {
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
   Tipos auxiliares
   ============================ */
type LastSent = {
  at: string;
  agentId: string;
  side: "BUY" | "SELL";
  volume: number;
  slPoints: number | null;
  tpPoints: number | null;
  beAtPoints: number | null;
  beOffsetPoints: number | null;
  comment: string;
  taskId: string;
};

type BackendRuntimeConfig = {
  uiTimeframe?: "M1" | "M5" | "M15" | "M30" | "H1";
  uiLots?: number;
  rr?: number;
  slAtr?: number;
  beAtPts?: number;
  beOffsetPts?: number;
  entryDelayBars?: number;
  decisionThreshold?: number;
  debug?: boolean;
  [k: string]: any;
};

type AiNodeConfigResponse = {
  ok?: boolean;
  config?: BackendRuntimeConfig;
  modelStore?: string;
  configFile?: string;
  meta?: any;
};

function isLikelyFrontendDevBase(u: string | null | undefined) {
  if (!u) return false;
  try {
    const url = new URL(u);
    return url.port === "3000" || url.port === "5173";
  } catch {
    return false;
  }
}
function cleanBase(u: string) {
  return String(u || "").replace(/\/$/, "");
}
function resolveAPIBase() {
  const env: any = (import.meta as any).env || {};
  const fromEnv = env.VITE_API_BASE || env.VITE_API_URL;
  const fromWin = (window as any)?.DAYTRADE_CFG?.apiBase;
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  let candidate = cleanBase(String(fromEnv || fromWin || ""));
  if (!candidate && origin && !isLikelyFrontendDevBase(origin)) {
    candidate = cleanBase(origin);
  }
  if (!candidate || isLikelyFrontendDevBase(candidate)) {
    candidate = "http://localhost:3002";
  }
  return cleanBase(candidate);
}
function resolveMLBase() {
  const env: any = (import.meta as any).env || {};
  const fromEnv = env.VITE_ML_URL;
  const fromWin = (window as any)?.DAYTRADE_CFG?.mlBase;
  const candidate = cleanBase(String(fromEnv || fromWin || "http://127.0.0.1:5001"));
  return cleanBase(candidate);
}
function resolveRuntimePath() {
  const env: any = (import.meta as any).env || {};
  const fromEnv = env.VITE_RUNTIME_PATH;
  const fromWin = (window as any)?.DAYTRADE_CFG?.runtimePath;
  const raw = String(fromEnv || fromWin || "/admin/runtime-config");
  return raw.startsWith("/") ? raw : `/${raw}`;
}
function readHasRuntimeCfgFlag(): boolean | null {
  const env: any = (import.meta as any).env || {};
  const fromEnv = env.VITE_HAS_RUNTIME_CFG;
  const fromWin = (window as any)?.DAYTRADE_CFG?.hasRuntimeConfig;
  const v = fromEnv ?? fromWin;
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return null;
}

const API_BASE = resolveAPIBase();
const ML_BASE = resolveMLBase();
const RUNTIME_PATH = resolveRuntimePath();
const HAS_RUNTIME_CFG_ENV = readHasRuntimeCfgFlag();

if (process.env.NODE_ENV !== "production") {
  console.info("[AIControlsBar] Bases resolvidas:", { API_BASE, ML_BASE });
}

async function httpJson<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const safeBase = cleanBase(base || "http://localhost:3002");
  const safePath = path.startsWith("/") ? path : `/${path}`;
  const full = `${safeBase}${safePath}`;
  const resp = await fetch(full, {
    headers: { "content-type": "application/json", ...(init?.headers || {}) },
    credentials: "omit",
    mode: "cors",
    cache: "no-cache",
    ...init,
  });
  const txt = await resp.text();
  const data = txt ? JSON.parse(txt) : (null as any);
  if (!resp.ok) {
    const err: any = new Error(`HTTP ${resp.status} ${resp.statusText}`);
    (err as any).response = data ?? txt;
    (err as any).status = resp.status;
    (err as any).urlTried = full;
    throw err;
  }
  return data as T;
}

function runtimeEndpointBaseLooksValid() {
  return !isLikelyFrontendDevBase(API_BASE);
}

/* ============================
   (NOVO) Estado de risco (ganhos/perdas) + Fallback
   ============================ */
type RiskState = {
  ok?: boolean;
  mode: "block" | "conservative";
  dailyPnL: number;
  pontosGanhos: number;
  pontosPerdidos: number; // pode vir negativo do backend
  hitLoss: boolean;
  hitProfit: boolean;
  maxLoss?: number | null;
  profitTarget?: number | null;
};

/** Tenta buscar o estado de risco, primeiro com prefixo '/broker', depois sem prefixo. */
async function tryLoadRiskState(): Promise<RiskState | null> {
  const tryPaths = ["/broker/risk/state", "/risk/state"];
  for (const p of tryPaths) {
    try {
      const res = await httpJson<any>(API_BASE, p, { method: "GET" });
      const payload = res?.ok ? res : res; // aceita com/sem "ok"
      const dailyPnL = Number(payload?.dailyPnL ?? payload?.state?.dailyPnL ?? 0);
      const pontosGanhos = Number(payload?.pontosGanhos ?? payload?.state?.pontosGanhos ?? 0);
      const pontosPerdidos = Number(payload?.pontosPerdidos ?? payload?.state?.pontosPerdidos ?? 0);
      const mode = (payload?.mode as any) || (payload?.state?.mode as any) || "conservative";
      const hitLoss = !!(payload?.hitLoss ?? payload?.state?.hitLoss);
      const hitProfit = !!(payload?.hitProfit ?? payload?.state?.hitProfit);
      const maxLoss = payload?.maxLoss ?? payload?.state?.maxLoss ?? null;
      const profitTarget = payload?.profitTarget ?? payload?.state?.profitTarget ?? null;

      if (
        Number.isFinite(dailyPnL) ||
        Number.isFinite(pontosGanhos) ||
        Number.isFinite(pontosPerdidos)
      ) {
        return {
          ok: true,
          mode,
          dailyPnL,
          pontosGanhos,
          pontosPerdidos,
          hitLoss,
          hitProfit,
          maxLoss,
          profitTarget,
        };
      }
    } catch {
      // tenta próximo path
    }
  }
  return null;
}

/* ===== Runtime config helpers ===== */
async function loadBackendRuntime(path = RUNTIME_PATH): Promise<BackendRuntimeConfig | null> {
  const res = await httpJson<{ ok: boolean; config?: BackendRuntimeConfig }>(API_BASE, path, {
    method: "GET",
  });
  return (res as any)?.config ?? null;
}
async function applyBackendRuntime(
  patch: BackendRuntimeConfig,
  path = RUNTIME_PATH
): Promise<BackendRuntimeConfig | null> {
  const res = await httpJson<{ ok: boolean; config?: BackendRuntimeConfig }>(API_BASE, path, {
    method: "POST",
    body: JSON.stringify(patch),
  });
  return (res as any)?.config ?? null;
}
async function loadAiNodeConfig(): Promise<BackendRuntimeConfig | null> {
  try {
    const res = await httpJson<AiNodeConfigResponse>(ML_BASE, "/config", { method: "GET" });
    return (res?.config as BackendRuntimeConfig) ?? null;
  } catch {
    return null;
  }
}

export default function AIControlsBar({ collapsedByDefault }: Props) {
  const [collapsed, setCollapsed] = React.useState(!!collapsedByDefault);

  // Filtros globais
  const { symbol, timeframe, from, to, setFilters } = useAIControls();

  // SELETORES (fallback totals)
  const pnlState = useAIStore((s: any) => s.pnl);
  const tradesState = useAIStore((s: any) => s.trades);

  // Parâmetros persistidos
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
    sendStops: sendStops0,
    slPts: slPts0,
    tpPts: tpPts0,
    tpViaRR: tpViaRR0,
    bbEnabled: bbEnabled0,
    bbPeriod: bbPeriod0,
    bbK: bbK0,
    candlePatterns: candlePatterns0,
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
    execMaxAgeSec: 20,
    sendStops: false,
    slPts: 0,
    tpPts: 0,
    tpViaRR: true,
    bbEnabled: false,
    bbPeriod: 20,
    bbK: 2,
    candlePatterns: "engulfing,hammer,doji",
  });

  // Estados de UI/Execução
  const [rr, setRr] = React.useState<number>(rr0);
  const [minProb, setMinProb] = React.useState<number>(minProb0);
  const [minEV, setMinEV] = React.useState<number>(minEV0);
  const [useMicroModel, setUseMicroModel] = React.useState<boolean>(useMicroModel0);
  const [vwapFilter, setVwapFilter] = React.useState<boolean>(vwapFilter0);
  const [requireMtf, setRequireMtf] = React.useState<boolean>(requireMtf0);
  const [confirmTf, setConfirmTf] = React.useState<string>(confirmTf0);

  const [breakEvenAtPts, setBreakEvenAtPts] = React.useState<number>(breakEvenAtPts0);
  const [beOffsetPts, setBeOffsetPts] = React.useState<number>(beOffsetPts0);

  const [execEnabled, setExecEnabled] = React.useState<boolean>(!!execEnabled0);
  const [execAgentId, setExecAgentId] = React.useState<string>(execAgentId0 || "mt5-ea-1");
  const [execLots, setExecLots] = React.useState<number>(Number(execLots0) || 1);
  const [execMaxAgeSec, setExecMaxAgeSec] = React.useState<number>(Number(execMaxAgeSec0) || 20);
  const [execMsg, setExecMsg] = React.useState<string | null>(null);

  const [sendStops, setSendStops] = React.useState<boolean>(!!sendStops0);
  const [slPts, setSlPts] = React.useState<number>(Number(slPts0) || 0);
  const [tpPts, setTpPts] = React.useState<number>(Number(tpPts0) || 0);
  const [tpViaRR, setTpViaRR] = React.useState<boolean>(!!tpViaRR0);

  const [bbEnabled, setBbEnabled] = React.useState<boolean>(!!bbEnabled0);
  const [bbPeriod, setBbPeriod] = React.useState<number>(Number(bbPeriod0) || 20);
  const [bbK, setBbK] = React.useState<number>(Number(bbK0) || 2);
  const [candlePatterns, setCandlePatterns] = React.useState<string>(String(candlePatterns0 || ""));

  const [autoRefresh, setAutoRefresh] = React.useState<boolean>(autoRefresh0);
  const [refreshSec, setRefreshSec] = React.useState<number>(refreshSec0);

  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [showBacktests, setShowBacktests] = React.useState(false);
  const [lastSent, setLastSent] = React.useState<LastSent | null>(null);

  // Runtime config
  const [serverCfg, setServerCfg] = React.useState<BackendRuntimeConfig | null>(null);
  const [aiCfg, setAiCfg] = React.useState<BackendRuntimeConfig | null>(null);
  const [cfgMsg, setCfgMsg] = React.useState<string | null>(null);
  const [showEffective, setShowEffective] = React.useState<boolean>(false);
  const [hasRuntimeCfg, setHasRuntimeCfg] = React.useState<boolean | null>(HAS_RUNTIME_CFG_ENV);

  // Tabs
  type TabKey = "filters" | "ia" | "stops_exec" | "indicators";
  const [activeTab, setActiveTab] = React.useState<TabKey>("filters");

  // Risco
  const [riskState, setRiskState] = React.useState<RiskState | null>(null);
  const [riskErr, setRiskErr] = React.useState<string | null>(null);

  // Store global setters
  const setProjected = useAIStore((s) => s.setProjected);
  const setConfirmed = useAIStore((s) => s.setConfirmed);
  const setPnL = useAIStore((s) => s.setPnL);
  const setTrades = useAIStore((s) => s.setTrades);

  // Persistência de parâmetros
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
      sendStops,
      slPts,
      tpPts,
      tpViaRR,
      bbEnabled,
      bbPeriod,
      bbK,
      candlePatterns,
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
    bbEnabled,
    bbPeriod,
    bbK,
    candlePatterns,
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

  // Probe runtime endpoint (cache)
  React.useEffect(() => {
    let cancelled = false;
    if (HAS_RUNTIME_CFG_ENV === true) {
      setHasRuntimeCfg(true);
      return;
    }
    if (HAS_RUNTIME_CFG_ENV === false) {
      setHasRuntimeCfg(false);
      return;
    }
    if (!runtimeEndpointBaseLooksValid()) {
      setHasRuntimeCfg(false);
      return;
    }
    const CACHE_KEY = "daytrade_runtime_probe";
    const cached = sessionStorage.getItem(CACHE_KEY);
    if (cached === "true") {
      setHasRuntimeCfg(true);
      return;
    }
    if (cached === "false") {
      setHasRuntimeCfg(false);
      return;
    }
    (async () => {
      try {
        await httpJson(API_BASE, RUNTIME_PATH, { method: "GET" });
        if (!cancelled) setHasRuntimeCfg(true);
        sessionStorage.setItem(CACHE_KEY, "true");
      } catch (e: any) {
        const is404 = e?.status === 404;
        if (!cancelled) setHasRuntimeCfg(is404 ? false : null);
        sessionStorage.setItem(CACHE_KEY, is404 ? "false" : "null");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const runtimeButtonsDisabled = hasRuntimeCfg !== true || !runtimeEndpointBaseLooksValid();

  async function onLoadServerConfig() {
    setCfgMsg(null);
    if (hasRuntimeCfg !== true || !runtimeEndpointBaseLooksValid()) {
      setServerCfg(null);
      setCfgMsg(
        `Endpoint de runtime não disponível (${API_BASE}${RUNTIME_PATH}). Ajuste VITE_RUNTIME_PATH/VITE_API_BASE ou window.DAYTRADE_CFG.{apiBase,runtimePath}.`
      );
      const ai = await loadAiNodeConfig();
      setAiCfg(ai);
      return;
    }
    try {
      const cfg = await loadBackendRuntime();
      setServerCfg(cfg);
      setCfgMsg(cfg ? "Config do Backend carregada." : "Não foi possível carregar a config do Backend.");
    } catch (e: any) {
      const status = e?.status ?? "erro";
      const url = e?.urlTried ?? `${API_BASE}${RUNTIME_PATH}`;
      setServerCfg(null);
      setCfgMsg(`Backend respondeu ${status} em ${url}. Dica: ajuste VITE_RUNTIME_PATH ou implemente este endpoint.`);
      if (e?.status === 404) setHasRuntimeCfg(false);
    }
    const ai = await loadAiNodeConfig();
    setAiCfg(ai);
  }

  async function onApplyServerConfig() {
    setCfgMsg(null);
    if (hasRuntimeCfg !== true || !runtimeEndpointBaseLooksValid()) {
      setCfgMsg(
        `Não é possível aplicar: ${API_BASE}${RUNTIME_PATH} não existe neste backend. Habilite o endpoint no servidor ou aponte para um backend que o possua.`
      );
      return;
    }
    const patch: BackendRuntimeConfig = {
      uiTimeframe: String(timeframe || "M5").toUpperCase() as any,
      uiLots: Number(execLots) || 1,
      rr: Number(rr),
      beAtPts: Number(breakEvenAtPts) || 0,
      beOffsetPts: Number(beOffsetPts) || 0,
      decisionThreshold: Number(minProb),
      debug: false,
    };
    try {
      const res = await applyBackendRuntime(patch);
      setServerCfg(res);
      setCfgMsg(res ? "Config aplicada no Backend. (O Backend deve propagar ao AI-node)" : "Falha ao aplicar no Backend.");
    } catch (e: any) {
      const status = e?.status ?? "erro";
      const url = e?.urlTried ?? `${API_BASE}${RUNTIME_PATH}`;
      setCfgMsg(`Falha ao aplicar (${status}) em ${url}.`);
      if (e?.status === 404) setHasRuntimeCfg(false);
    }
    const ai = await loadAiNodeConfig();
    setAiCfg(ai);
  }

  function execKeyForConfirm(s: { side: string; time: string | undefined; price?: number | null }) {
    const p = baseParams();
    const t = s.time ? new Date(s.time).toISOString() : "";
    return `${p.symbol}|${p.timeframe}|${s.side}|${t}`;
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
      .filter((s) => ["BUY", "SELL"].includes(String(s.side || "").toUpperCase()))
      .filter((s) => isFreshEnough(String(s.time || ""), execMaxAgeSec, armedSince))
      .filter((s) => !sent.has(execKeyForConfirm(s)));
    if (candidates.length === 0) return;

    const { slPtsToSend, tpPtsToSend } = computeStops();

    for (const s of candidates) {
      const side = String(s.side).toUpperCase() as "BUY" | "SELL";
      const taskId = `auto-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const task = {
        id: taskId,
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
      const body = { agentId: (execAgentId || "mt5-ea-1").trim(), tasks: [task] };
      try {
        const res = await enqueueMT5Order(body);
        setExecMsg(`AUTO ${side}: ${JSON.stringify(res)}`);
        setLastSent({
          at: new Date().toISOString(),
          agentId: body.agentId,
          side,
          volume: execLots,
          slPoints: slPtsToSend ?? null,
          tpPoints: tpPtsToSend ?? null,
          beAtPoints: breakEvenAtPts ?? null,
          beOffsetPoints: beOffsetPts ?? null,
          comment: task.comment,
          taskId,
        });
        window.dispatchEvent(new CustomEvent("daytrade:mt5-enqueue", { detail: { when: Date.now(), body, res } }));
        sent.add(execKeyForConfirm(s));
      } catch (e: any) {
        const msg = (e?.message || "Falha no enqueue") + (e?.urlTried ? ` @ ${e.urlTried}` : "") + (e?.response ? ` | resp=${JSON.stringify(e.response)}` : "");
        setExecMsg(`ERRO AUTO ${side}: ${msg}`);
      }
    }
    const newArr = clampSentKeys(Array.from(sent), 1000);
    lsSet(LS_EXEC_SENT_KEYS, newArr);
  }

  React.useEffect(() => {
    if (execEnabled) {
      const now = new Date();
      lsSet(LS_EXEC_ARMED_SINCE, now.toISOString());
      setExecMsg(`AUTO armado às ${now.toLocaleString()} (local)`);
    }
  }, [execEnabled]);

  async function fetchAllOnce() {
    setLoading(true);
    setErr(null);
    try {
      const params = baseParams();
      const { slPtsToSend, tpPtsToSend } = computeStops();

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
        bbEnabled,
        bbPeriod,
        bbK,
        candlePatterns,
        sendStops,
        slPts,
        tpPts,
        tpViaRR,
        stopsApplied: { slPoints: slPtsToSend ?? 0, tpPoints: tpPtsToSend ?? 0 },
      };

      // 1) Projetados
      const payload: any = {
        ...params,
        rr,
        minProb,
        minEV,
        useMicroModel,
        vwapFilter,
        requireMtf,
        confirmTf: String(confirmTf || "").trim().toUpperCase(),
        bbEnabled,
        bbPeriod,
        bbK,
        candlePatterns,
      };
      if (payload.minEV === 0) delete payload.minEV;
      const proj = await projectedSignals(payload);
      setProjected(proj || [], {
        ...params,
        rr,
        minProb,
        minEV,
        useMicroModel,
        vwapFilter,
        requireMtf,
        confirmTf,
        bbEnabled,
        bbPeriod,
        bbK,
        candlePatterns,
      });

      // 2) Confirmados
      const confRaw = await fetchConfirmedSignals({
        ...params,
        limit: 2000,
        slPoints: slPtsToSend ?? 0,
        tpPoints: tpPtsToSend ?? 0,
      });
      setConfirmed(confRaw || [], {
        ...params,
        slPoints: slPtsToSend ?? null,
        tpPoints: tpPtsToSend ?? null,
        tpViaRR,
        rr,
      });

      // 2.1) Auto-exec
      await autoExecFromConfirmed(confRaw || []);

      // 3) Backtest
      const bt = await runBacktest({
        ...params,
        breakEvenAtPts,
        beOffsetPts,
        slPoints: slPtsToSend ?? 0,
        tpPoints: tpPtsToSend ?? 0,
        tpViaRR,
        rr,
        vwapFilter,
        bbEnabled,
        bbPeriod,
        bbK,
        candlePatterns,
      });

      const rawTrades =
        (Array.isArray(bt?.trades) && bt?.trades) ||
        (Array.isArray(bt?.rows) && bt?.rows) ||
        (Array.isArray(bt?.items) && bt?.items) ||
        (Array.isArray(bt?.data) && bt?.data) ||
        [];
      const sum = bt?.summary || null;

      setPnL(
        sum
          ? {
            trades: sum.trades ?? 0,
            wins: sum.wins ?? 0,
            losses: sum.losses ?? 0,
            ties: sum.ties ?? 0,
            pnlPoints: sum.pnlPoints ?? bt?.pnlPoints ?? 0,
            pnlMoney: bt?.pnlMoney ?? undefined,
            avgPnL: sum.avgPnL ?? 0,
            profitFactor: sum.profitFactor ?? 0,
            maxDrawdown: sum.maxDrawdown ?? 0,
          }
          : null
      );

      setTrades(rawTrades, {
        ...(bt?.meta || {}),
        slPointsApplied: slPtsToSend ?? 0,
        tpPointsApplied: tpPtsToSend ?? 0,
        tpViaRRApplied: tpViaRR,
        rrApplied: rr,
        beAtPointsApplied: breakEvenAtPts,
        beOffsetApplied: beOffsetPts,
        bbApplied: !!bbEnabled,
        bbPeriodApplied: bbPeriod,
        bbKApplied: bbK,
        vwapApplied: !!vwapFilter,
        patternsApplied: candlePatterns || "",
      });

      // 4) Estado de risco (opcional, MT5 real)
      try {
        const rs = await tryLoadRiskState();
        if (rs) {
          setRiskState(rs);
          setRiskErr(null);
        } else {
          setRiskState(null); // fallback assume
        }
      } catch (e: any) {
        setRiskErr(e?.message || "Falha ao ler estado de risco");
      }
    } catch (e: any) {
      setErr(e?.message || "Erro ao atualizar dados");
    } finally {
      setLoading(false);
    }
  }

  async function onBuscarAgora() {
    await fetchAllOnce();
  }

  function makeMt5Task(side: "BUY" | "SELL") {
    const { slPtsToSend, tpPtsToSend } = computeStops();
    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      side,
      comment: `ui-test ${side} ${new Date().toISOString()}${slPtsToSend ? ` SL=${slPtsToSend}` : ""}${tpPtsToSend ? ` TP=${tpPtsToSend}` : ""}`,
      beAtPoints: breakEvenAtPts,
      beOffsetPts: beOffsetPts,
      timeframe: null,
      time: null,
      price: 0,
      volume: execLots,
      slPoints: slPtsToSend,
      tpPoints: tpPtsToSend,
    };
  }

  async function onExecTest(side: "BUY" | "SELL") {
    setExecMsg(null);
    if (!execEnabled) {
      setExecMsg("Execução desativada (ligue o toggle).");
      return;
    }
    if (tpViaRR && (!sendStops || Math.max(0, Math.floor(Number(slPts) || 0)) === 0)) {
      setExecMsg("Aviso: TP via RR requer SL>0 e 'Enviar SL/TP' ligado. Ajuste os controles.");
    }
    const task = makeMt5Task(side);
    const body = { agentId: (execAgentId || "mt5-ea-1").trim(), tasks: [task] };
    try {
      const res = await enqueueMT5Order(body);
      setExecMsg(`OK ${side}: ${JSON.stringify(res)}`);
      setLastSent({
        at: new Date().toISOString(),
        agentId: body.agentId,
        side,
        volume: execLots,
        slPoints: task.slPoints ?? null,
        tpPoints: task.tpPoints ?? null,
        beAtPoints: task.beAtPoints ?? null,
        beOffsetPoints: task.beOffsetPoints ?? null,
        comment: task.comment,
        taskId: task.id,
      });
      window.dispatchEvent(new CustomEvent("daytrade:mt5-enqueue", { detail: { when: Date.now(), body, res } }));
    } catch (e: any) {
      const msg =
        (e?.message || "Falha no enqueue") + (e?.urlTried ? ` @ ${e.urlTried}` : "") + (e?.response ? ` | resp=${JSON.stringify(e.response)}` : "");
      setExecMsg(`ERRO ${side}: ${msg}`);
    }
  }

  // Auto refresh principal
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
    bbEnabled,
    bbPeriod,
    bbK,
    candlePatterns,
  ]);

  // Invalidação externa
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
    bbEnabled,
    bbPeriod,
    bbK,
    candlePatterns,
  ]);

  // Poll leve do risco (5s). Agora tolerante a prefixo também (via tryLoadRiskState).
  React.useEffect(() => {
    let alive = true;
    let timer: any = null;
    async function tickRisk() {
      if (!alive) return;
      try {
        const rs = await tryLoadRiskState();
        setRiskState(rs);
        setRiskErr(null);
      } catch (e: any) {
        setRiskErr(e?.message || "Falha ao ler estado de risco");
      }
      if (!alive) return;
      timer = setTimeout(tickRisk, 5000);
    }
    tickRisk(); // primeira leitura imediata
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  // ======= Fallback local para totais do dia =======
  const uiDaily = React.useMemo(() => {
    // 1) Se o backend de risco respondeu, use-o.
    if (riskState) {
      // pontosPerdidos pode vir negativo do backend; para exibir absoluto na badge, normalizamos abaixo
      const perdasAbs = Math.abs(Number(riskState.pontosPerdidos || 0));
      return {
        ganhos: Number(riskState.pontosGanhos || 0),
        perdas: perdasAbs,
        pnl: Number(riskState.dailyPnL || 0),
        hitLoss: !!riskState.hitLoss,
        hitProfit: !!riskState.hitProfit,
      };
    }

    // 2) Senão, tenta calcular dos trades do backtest atual (com filtros do dia).
    let ganhos = 0;
    let perdasAbs = 0;
    if (Array.isArray(tradesState) && tradesState.length > 0) {
      for (const t of tradesState) {
        const pts =
          typeof t?.pnlPoints === "number"
            ? t.pnlPoints
            : typeof t?.pnl === "number"
              ? t.pnl
              : 0;
        if (pts > 0) ganhos += pts;
        if (pts < 0) perdasAbs += Math.abs(pts);
      }
    }

    // 3) PnL líquido: prefere summary.pnlPoints quando existir.
    const pnl =
      (pnlState && typeof pnlState.pnlPoints === "number" && pnlState.pnlPoints) ||
      (ganhos - perdasAbs) ||
      0;

    return { ganhos, perdas: perdasAbs, pnl, hitLoss: false, hitProfit: false };
  }, [riskState, tradesState, pnlState]);

  // ====== Render ======
  return (
    <>
      {/* HEADER STICKY: título, totais do dia, ações rápidas */}
      <div style={{ position: "sticky", top: 0, zIndex: 1030 }}>
        <div className="bg-body-tertiary border-bottom">
          <div className="container py-2">
            <div className="d-flex align-items-center gap-2 flex-wrap">
              <button
                className="btn btn-sm btn-outline-secondary"
                onClick={() => setCollapsed((c) => !c)}
                title={collapsed ? "Expandir" : "Recolher"}
              >
                {collapsed ? "▸" : "▾"}
              </button>
              <strong className="me-2">IA</strong>

              {/* Totais do dia (com fallback) */}
              <div className="d-flex align-items-center gap-2">
                <span className="badge text-bg-light border">
                  Ganhos:{" "}
                  <span className="fw-bold text-success ms-1">
                    {`+${Number(uiDaily.ganhos || 0).toLocaleString("pt-BR")}`}
                  </span>
                </span>
                <span className="badge text-bg-light border">
                  Perdas:{" "}
                  <span className="fw-bold text-danger ms-1">
                    {`${Number(uiDaily.perdas || 0).toLocaleString("pt-BR")}`}
                  </span>
                </span>
                <span className="badge text-bg-light border">
                  PnL:{" "}
                  <span
                    className={`fw-bold ms-1 ${(uiDaily.pnl || 0) >= 0 ? "text-success" : "text-danger"
                      }`}
                  >
                    {`${(uiDaily.pnl || 0) >= 0 ? "+" : ""}${Number(uiDaily.pnl || 0).toLocaleString("pt-BR")}`}
                  </span>
                </span>
                {uiDaily.hitLoss && <span className="badge text-bg-danger">Stop diário atingido</span>}
                {uiDaily.hitProfit && <span className="badge text-bg-success">Meta diária atingida</span>}
                {riskErr && (
                  <span className="text-danger">
                    <small>({riskErr})</small>
                  </span>
                )}
              </div>

              {/* Backtests toggle */}
              <button
                className="btn btn-sm btn-outline-primary ms-2"
                onClick={() => setShowBacktests((v) => !v)}
                title="Mostrar/ocultar backtests recentes"
              >
                {showBacktests ? "Ocultar Backtests" : "Backtests"}
              </button>

              {/* Parâmetros efetivos (painel expansível) */}
              <button
                className="btn btn-sm btn-outline-dark ms-2"
                onClick={() => setShowEffective((v) => !v)}
                title="Mostrar/ocultar parâmetros efetivos"
              >
                {showEffective ? "Ocultar parâmetros" : "Parâmetros efetivos"}
              </button>

              {/* Carregar/Aplicar runtime */}
              <div className="btn-group btn-group-sm ms-1" role="group" aria-label="cfg-actions">
                <button
                  className="btn btn-outline-secondary"
                  onClick={onLoadServerConfig}
                  title={`Carregar do servidor (${RUNTIME_PATH})`}
                  disabled={runtimeButtonsDisabled}
                >
                  Carregar do servidor
                </button>
                <button
                  className="btn btn-outline-success"
                  onClick={onApplyServerConfig}
                  title="Aplicar no servidor (Backend→AI-node)"
                  disabled={runtimeButtonsDisabled}
                >
                  Aplicar no servidor
                </button>
              </div>
              {cfgMsg && (
                <span className="small ms-2">
                  <code>{cfgMsg}</code>
                </span>
              )}

              {/* Ações gerais */}
              <div className="ms-auto d-flex align-items-center gap-2">
                <div className="form-check form-switch m-0">
                  <input
                    className="form-check-input"
                    type="checkbox"
                    id="auto-toggle"
                    checked={autoRefresh}
                    onChange={(e) => setAutoRefresh(e.target.checked)}
                  />
                  <label className="form-check-label ms-1" htmlFor="auto-toggle">
                    Auto
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
                    onChange={(e) => setRefreshSec(Math.max(5, Number(e.target.value)))}
                  />
                  <span className="input-group-text">s</span>
                </div>
                <button className="btn btn-sm btn-primary" onClick={onBuscarAgora} disabled={loading}>
                  {loading ? "Atualizando..." : "Buscar agora"}
                </button>
                {err && (
                  <span className="text-danger small">
                    <strong>Erro:</strong> {err}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ====== TABS SEÇÃO (não-sticky): separa filtros e parâmetros ====== */}
      {!collapsed && (
        <div className="container my-3">
          <ul className="nav nav-tabs">
            <li className="nav-item">
              <button
                className={`nav-link ${activeTab === "filters" ? "active" : ""}`}
                onClick={() => setActiveTab("filters")}
              >
                Filtros
              </button>
            </li>
            <li className="nav-item">
              <button
                className={`nav-link ${activeTab === "ia" ? "active" : ""}`}
                onClick={() => setActiveTab("ia")}
              >
                IA & Gates
              </button>
            </li>
            <li className="nav-item">
              <button
                className={`nav-link ${activeTab === "stops_exec" ? "active" : ""}`}
                onClick={() => setActiveTab("stops_exec")}
              >
                Stops & Execução
              </button>
            </li>
            <li className="nav-item">
              <button
                className={`nav-link ${activeTab === "indicators" ? "active" : ""}`}
                onClick={() => setActiveTab("indicators")}
              >
                Indicadores
              </button>
            </li>
          </ul>

          <div className="tab-content border-start border-end border-bottom p-3 rounded-bottom">
            {/* TAB: FILTROS */}
            <div className={`tab-pane fade ${activeTab === "filters" ? "show active" : ""}`}>
              <div className="row g-3">
                <div className="col-12 col-sm-6 col-md-3">
                  <label className="form-label mb-1">Símbolo</label>
                  <input
                    className="form-control form-control-sm"
                    value={symbol}
                    onChange={(e) => setFilters({ symbol: e.target.value })}
                  />
                </div>
                <div className="col-12 col-sm-6 col-md-3">
                  <label className="form-label mb-1">Timeframe</label>
                  <input
                    className="form-control form-control-sm"
                    value={timeframe}
                    onChange={(e) => setFilters({ timeframe: e.target.value })}
                  />
                </div>
                <div className="col-12 col-md-3">
                  <label className="form-label mb-1">De</label>
                  <input
                    type="date"
                    className="form-control form-control-sm"
                    value={from ?? ""}
                    onChange={(e) => setFilters({ from: e.target.value || null })}
                  />
                </div>
                <div className="col-12 col-md-3">
                  <label className="form-label mb-1">Até</label>
                  <input
                    type="date"
                    className="form-control form-control-sm"
                    value={to ?? ""}
                    onChange={(e) => setFilters({ to: e.target.value || null })}
                  />
                </div>
              </div>
            </div>

            {/* TAB: IA & GATES */}
            <div className={`tab-pane fade ${activeTab === "ia" ? "show active" : ""}`}>
              <div className="row g-3">
                <div className="col-6 col-md-2">
                  <label className="form-label mb-1">RR</label>
                  <input
                    type="number"
                    step="0.1"
                    className="form-control form-control-sm"
                    value={rr}
                    onChange={(e) => setRr(Number(e.target.value))}
                  />
                </div>
                <div className="col-6 col-md-2">
                  <label className="form-label mb-1">minProb</label>
                  <input
                    type="number"
                    step="0.01"
                    min={0}
                    max={1}
                    className="form-control form-control-sm"
                    value={minProb}
                    onChange={(e) => setMinProb(Number(e.target.value))}
                  />
                </div>
                <div className="col-6 col-md-2">
                  <label className="form-label mb-1">minEV</label>
                  <input
                    type="number"
                    step="0.1"
                    className="form-control form-control-sm"
                    value={minEV}
                    onChange={(e) => setMinEV(Number(e.target.value))}
                  />
                </div>
                <div className="col-6 col-md-2">
                  <label className="form-label mb-1">TF Confirmação</label>
                  <input
                    className="form-control form-control-sm"
                    value={confirmTf}
                    onChange={(e) => setConfirmTf(e.target.value)}
                  />
                </div>

                <div className="col-12 col-md-4 d-flex align-items-center gap-3">
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
                </div>
              </div>
            </div>

            {/* TAB: STOPS & EXECUÇÃO */}
            <div className={`tab-pane fade ${activeTab === "stops_exec" ? "show active" : ""}`}>
              <div className="row g-3">
                {/* BE */}
                <div className="col-6 col-md-2">
                  <label className="form-label mb-1">BE (pts)</label>
                  <input
                    type="number"
                    step={1}
                    className="form-control form-control-sm"
                    value={breakEvenAtPts}
                    onChange={(e) => setBreakEvenAtPts(Number(e.target.value) || 0)}
                  />
                </div>
                <div className="col-6 col-md-2">
                  <label className="form-label mb-1">Offset (pts)</label>
                  <input
                    type="number"
                    step={1}
                    className="form-control form-control-sm"
                    value={beOffsetPts}
                    onChange={(e) => setBeOffsetPts(Number(e.target.value) || 0)}
                  />
                </div>

                {/* SL/TP */}
                <div className="col-12 col-md-8 d-flex align-items-end gap-3 flex-wrap">
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

                  <div className="input-group input-group-sm" style={{ width: 160 }}>
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

                  <div className="input-group input-group-sm" style={{ width: 160 }}>
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
                </div>

                {/* Execução */}
                <div className="col-12">
                  <div className="border-top pt-3 mt-2 d-flex align-items-end gap-3 flex-wrap">
                    <div className="form-check form-switch">
                      <input
                        className="form-check-input"
                        type="checkbox"
                        id="exec-toggle"
                        checked={execEnabled}
                        onChange={(e) => setExecEnabled(e.target.checked)}
                      />
                      <label className="form-check-label ms-1" htmlFor="exec-toggle">
                        Executar no MT5 (auto)
                      </label>
                    </div>

                    <div className="input-group input-group-sm" style={{ width: 200 }}>
                      <span className="input-group-text">AgentId</span>
                      <input
                        className="form-control"
                        value={execAgentId}
                        onChange={(e) => setExecAgentId(e.target.value)}
                        placeholder="mt5-ea-1"
                      />
                    </div>

                    <div className="input-group input-group-sm" style={{ width: 140 }}>
                      <span className="input-group-text">Lots</span>
                      <input
                        type="number"
                        step={0.1}
                        min={0.1}
                        className="form-control"
                        value={execLots}
                        onChange={(e) => setExecLots(Math.max(1, Math.round(Number(e.target.value) || 1)))}
                      />
                    </div>

                    <div className="input-group input-group-sm" style={{ width: 180 }}>
                      <span className="input-group-text">MaxAge</span>
                      <input
                        type="number"
                        min={5}
                        step={5}
                        className="form-control"
                        value={execMaxAgeSec}
                        onChange={(e) => setExecMaxAgeSec(Math.max(5, Number(e.target.value) || 20))}
                      />
                      <span className="input-group-text">s</span>
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
                        className="small"
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
                </div>
              </div>
            </div>

            {/* TAB: INDICADORES */}
            <div className={`tab-pane fade ${activeTab === "indicators" ? "show active" : ""}`}>
              <div className="row g-3">
                <div className="col-12 col-md-4 d-flex align-items-center gap-3">
                  <div className="form-check form-switch">
                    <input
                      className="form-check-input"
                      type="checkbox"
                      id="bb-toggle"
                      checked={bbEnabled}
                      onChange={(e) => setBbEnabled(e.target.checked)}
                    />
                    <label className="form-check-label" htmlFor="bb-toggle">
                      Bollinger
                    </label>
                  </div>
                </div>
                <div className="col-6 col-md-2">
                  <label className="form-label mb-1">BB Period</label>
                  <input
                    type="number"
                    min={5}
                    step={1}
                    className="form-control form-control-sm"
                    value={bbPeriod}
                    onChange={(e) => setBbPeriod(Math.max(5, Number(e.target.value) || 20))}
                    disabled={!bbEnabled}
                  />
                </div>
                <div className="col-6 col-md-2">
                  <label className="form-label mb-1">BB k</label>
                  <input
                    type="number"
                    min={0.1}
                    step={0.1}
                    className="form-control form-control-sm"
                    value={bbK}
                    onChange={(e) => setBbK(Math.max(0.1, Number(e.target.value) || 2))}
                    disabled={!bbEnabled}
                  />
                </div>
                <div className="col-12 col-md-4">
                  <label className="form-label mb-1">Patterns de Candle</label>
                  <input
                    className="form-control form-control-sm"
                    placeholder="engulfing,hammer,doji"
                    value={candlePatterns}
                    onChange={(e) => setCandlePatterns(e.target.value)}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Painel: Parâmetros Efetivos */}
          {showEffective && (
            <div className="mt-3">
              <div className="p-2 rounded border bg-light">
                <div className="d-flex align-items-center justify-content-between">
                  <strong>Parâmetros efetivos (UI vs Backend vs AI-node)</strong>
                  <div className="btn-group btn-group-sm">
                    <button className="btn btn-outline-secondary" onClick={onLoadServerConfig} disabled={runtimeButtonsDisabled}>
                      Recarregar
                    </button>
                    <button className="btn btn-outline-success" onClick={onApplyServerConfig} disabled={runtimeButtonsDisabled}>
                      Aplicar no servidor
                    </button>
                  </div>
                </div>
                <div className="row mt-2">
                  <div className="col-12 col-md-4">
                    <div className="small text-muted mb-1">UI (local)</div>
                    <pre className="small p-2 bg-body border rounded" style={{ maxHeight: 240, overflow: "auto" }}>
                      {JSON.stringify(
                        {
                          timeframe,
                          lots: execLots,
                          rr,
                          beAtPts: breakEvenAtPts,
                          beOffsetPts: beOffsetPts,
                          decisionThreshold: minProb,
                          sendStops,
                          slPts,
                          tpPts,
                          tpViaRR,
                        },
                        null,
                        2
                      )}
                    </pre>
                  </div>
                  <div className="col-12 col-md-4">
                    <div className="small text-muted mb-1">Backend ({RUNTIME_PATH})</div>
                    <pre className="small p-2 bg-body border rounded" style={{ maxHeight: 240, overflow: "auto" }}>
                      {serverCfg ? JSON.stringify(serverCfg, null, 2) : "(indisponível)"}
                    </pre>
                  </div>
                  <div className="col-12 col-md-4">
                    <div className="small text-muted mb-1">AI-node ({ML_BASE || "não configurado"})</div>
                    <pre className="small p-2 bg-body border rounded" style={{ maxHeight: 240, overflow: "auto" }}>
                      {aiCfg ? JSON.stringify(aiCfg, null, 2) : "(indisponível)"}
                    </pre>
                  </div>
                </div>
                {hasRuntimeCfg === false && (
                  <div className="alert alert-warning mt-2 mb-0 py-2">
                    Endpoint <code>{API_BASE}{RUNTIME_PATH}</code> não encontrado (desabilitado no backend atual). Ajuste suas variáveis (<code>VITE_API_BASE</code>,{" "}
                    <code>VITE_RUNTIME_PATH</code>, <code>VITE_HAS_RUNTIME_CFG</code>) ou <code>window.DAYTRADE_CFG</code>.
                  </div>
                )}
                {cfgMsg && (
                  <div className="mt-2">
                    <code>{cfgMsg}</code>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Último envio (espelho) */}
          {lastSent && (
            <div className="mt-3">
              <div className="small text-muted">Último envio ao MT5 (espelho do envelope):</div>
              <div className="p-2 rounded border bg-light-subtle">
                <div className="d-flex flex-wrap gap-2 align-items-center">
                  <span className={`badge ${lastSent.side === "BUY" ? "bg-success" : "bg-danger"}`}>{lastSent.side}</span>
                  <code className="me-1">ag:{lastSent.agentId}</code>
                  <code className="me-1">vol:{lastSent.volume}</code>
                  <code className="me-1">BE:{lastSent.beAtPoints ?? 0}</code>
                  <code className="me-1">OFF:{lastSent.beOffsetPoints ?? 0}</code>
                  <code className="me-1">SLp:{lastSent.slPoints ?? "-"}</code>
                  <code className="me-1">TPp:{lastSent.tpPoints ?? "-"}</code>
                  <code className="me-1">id:{lastSent.taskId}</code>
                  <code className="me-1">at:{new Date(lastSent.at).toLocaleTimeString()}</code>
                </div>
                <div className="mt-1">
                  <div className="small">Comentário:</div>
                  <div className="text-break">
                    <code>{lastSent.comment}</code>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Painel Backtests (fora do header sticky) */}
      {showBacktests && <BacktestRunsPanel />}
    </>
  );
}