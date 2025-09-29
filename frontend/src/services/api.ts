// Frontend API client — daytrade-ia
// frontend/src/services/api.ts

// import axios from "axios"; // (removido — padronizamos no jsonFetch)

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3002";

// Comparação detalhada: Simulado vs Real
export async function getBrokerComparison(tradeId: number) {
  return jsonFetchBase<any>(API_BASE, `/admin/broker/compare-detailed?tradeId=${tradeId}`, {
    method: "GET",
  });
}

export type Candle = {
  time: string; // ISO
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

export type ProjectedSignal = {
  side: "BUY" | "SELL" | "FLAT";
  suggestedEntry?: number | null;
  stopSuggestion?: number | null;
  takeProfitSuggestion?: number | null;
  conditionText?: string | null;
  score?: number | null;
  probHit?: number | null;
  probCalibrated?: number | null;
  expectedValuePoints?: number | null;
  time?: string; // ISO
  date?: string | null; // YYYY-MM-DD no local (ou do backend)
};

export type ConfirmedSignal = {
  side: "BUY" | "SELL" | "FLAT";
  time: string; // ISO
  price?: number | null;
  note?: string | null;
};

export type ProjectedSignalsParams = {
  symbol: string;
  timeframe: string;
  from?: string;
  to?: string;
  rr?: number;
  minProb?: number;
  minEV?: number;
  useMicroModel?: boolean;
  vwapFilter?: boolean;
  requireMtf?: boolean;
  confirmTf?: string;

  // >>> novos (pass-through; backend pode ignorar sem quebrar)
  bbEnabled?: number | boolean;
  bbPeriod?: number;
  bbK?: number;
  candlePatterns?: string; // "engulfing,hammer,star,doji"
};

export type ExecPeekResponse = {
  ok: boolean;
  agentId: string;
  pending: number;
  tasks: any[];
};

export type ExecStatsResponse = {
  ok: boolean;
  enabled: boolean;
  agents: Record<
    string,
    { polls: number; lastTs: number; lastServed: number; lastPending: number }
  >;
};

export type ExecHistoryResponse = {
  ok: boolean;
  agentId: string;
  count: number;
  items: any[];
};

declare global {
  interface Window {
    DAYTRADE_CFG?: {
      pointValueBySymbol?: Record<string, number>;
      defaultRiskPoints?: number;
      brokerSymbolMap?: Record<string, string>;
      tickSizeBySymbol?: Record<string, number>; // usado para converter preços→pontos se necessário
    };
  }
}

/* ===============================
   Backtest — tipos (frontend)
   =============================== */
export type BacktestTradeDTO = {
  id?: number | string;
  side: "BUY" | "SELL";
  entryTime: string;
  exitTime: string;
  entryPrice: number;
  exitPrice: number;
  pnl?: number;          // alguns backends mandam "pnl"
  pnlPoints?: number;    // outros mandam "pnlPoints"
  note?: string | null;  // motivo/nota direta
  reason?: string | null; // alias usado por alguns payloads
  conditionText?: string | null; // outro alias possível
  comment?: string | null;       // outro alias possível
  movedToBE?: boolean;
  trailEvents?: number;
};

export type BacktestDTO = {
  ok: boolean;
  id: string;
  ts: string;
  version: string;
  symbol: string;
  timeframe: string;
  from: string; // ISO
  to: string;   // ISO
  candles: number;
  trades: BacktestTradeDTO[];
  summary: {
    trades: number;
    wins: number;
    losses: number;
    ties: number;
    winRate: number;
    pnlPoints: number;
    avgPnL: number;
    profitFactor: number | "Infinity";
    maxDrawdown: number;
  };
  pnlPoints: number;
  pnlMoney: number;
  lossCapApplied?: number;
  maxConsecLossesApplied?: number;
  policy?: any;
  config?: any;
};

/* ===============================
   Bases/URLs
   =============================== */
const RAW_API_BASE = (import.meta as any).env?.VITE_API_BASE ?? API_URL;  // <<< fallback corrigido
const API_BASE = String(RAW_API_BASE || "").replace(/\/$/, "");
const RAW_EXEC_BASE = (import.meta as any).env?.VITE_EXEC_BASE ?? API_BASE;
const EXEC_BASE = String(RAW_EXEC_BASE || "").replace(/\/$/, "");

const ML_BASE = String(((import.meta as any).env?.VITE_ML_URL ?? "") || "").replace(/\/$/, "");

/** --------- Helpers --------- */
function normalizeSide(val: any): "BUY" | "SELL" | "FLAT" {
  const s = String(val ?? "").trim().toUpperCase();
  if (
    s === "SELL" ||
    s === "SHORT" ||
    s === "S" ||
    s === "-1" ||
    s === "DOWN" ||
    s.includes("SELL") ||
    s.includes("SHORT")
  )
    return "SELL";
  if (
    s === "BUY" ||
    s === "LONG" ||
    s === "B" ||
    s === "1" ||
    s === "UP" ||
    s.includes("BUY") ||
    s.includes("LONG")
  )
    return "BUY";
  if (s === "FLAT" || s === "NEUTRAL" || s === "0") return "FLAT";
  return "BUY";
}

function toISO(t: any): string | undefined {
  if (!t && t !== 0) return undefined;
  if (typeof t === "string") {
    return /Z$|[+-]\d{2}:?\d{2}$/.test(t) ? t : new Date(t).toISOString();
  }
  if (t instanceof Date) return t.toISOString();
  if (typeof t === "number") return new Date(t).toISOString();
  return undefined;
}

function ymdLocalFromISO(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

async function jsonFetchBase<T>(
  base: string,
  url: string,
  init?: RequestInit
): Promise<T> {
  const fullUrl =
    (base || window.location.origin.replace(/\/$/, "")) +
    (url.startsWith("/") ? url : `/${url}`);

  const resp = await fetch(fullUrl, {
    headers: { "content-type": "application/json", ...(init?.headers || {}) },
    credentials: "omit",
    mode: "cors",
    cache: "no-cache",
    ...init,
  });

  const txt = await resp.text();
  const data = txt ? JSON.parse(txt) : null;
  const backendErr =
    data && typeof data === "object" && "ok" in data && (data as any).ok === false;

  if (!resp.ok || backendErr) {
    const msg =
      (backendErr && ((data as any).error || "Erro na API")) ||
      `HTTP ${resp.status} ${resp.statusText}`;
    const err: any = new Error(msg);
    (err as any).response = data ?? txt;
    (err as any).status = resp.status;
    (err as any).urlTried = fullUrl;
    throw err;
  }
  if (process.env.NODE_ENV !== "production") {
    // eslint-disable-next-line no-console
    console.debug("[api] ok", { url: fullUrl, init });
  }
  return data as T;
}

/** Usa API_BASE por padrão */
async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  return jsonFetchBase<T>(API_BASE, url, init);
}

export type { ProjectedSignalsParams };

/* =========================
   Runtime Config (NOVO)
   ========================= */
export type RuntimeConfigPayload = Partial<{
  uiTimeframe: "M1" | "M5" | "M15" | "M30" | "H1";
  uiLots: number;
  rr: number;
  slAtr: number;
  beAtPts: number;
  beOffsetPts: number;
  entryDelayBars: number;
  decisionThreshold: number;
  debug: boolean;
}>;

export async function getRuntimeConfig(): Promise<{ ok: boolean; config: RuntimeConfigPayload }> {
  return jsonFetch<{ ok: boolean; config: RuntimeConfigPayload }>("/admin/runtime-config", {
    method: "GET",
  });
}

export async function saveRuntimeConfig(patch: RuntimeConfigPayload): Promise<{ ok: boolean; config: RuntimeConfigPayload }> {
  return jsonFetch<{ ok: boolean; config: RuntimeConfigPayload }>("/admin/runtime-config", {
    method: "POST",
    body: JSON.stringify(patch),
  });
}

export async function getAiNodeConfig(): Promise<{ ok?: boolean; config?: RuntimeConfigPayload }> {
  if (!ML_BASE) return { ok: false, config: undefined };
  return jsonFetchBase<{ ok?: boolean; config?: RuntimeConfigPayload }>(ML_BASE, "/config", { method: "GET" });
}

/* =========================
   Signals
   ========================= */
export async function projectedSignals(
  params: ProjectedSignalsParams
): Promise<ProjectedSignal[]> {
  const raw = await jsonFetch<any>("/api/signals/projected", {
    method: "POST",
    body: JSON.stringify(params),
  });

  const arr: any[] =
    (Array.isArray(raw) && raw) ||
    raw?.data ||
    raw?.rows ||
    raw?.signals ||
    raw?.items ||
    [];

  return arr.map((s) => {
    const side = normalizeSide(s.side ?? s.direction ?? s.type ?? s.signalSide);
    const iso = toISO(s.time ?? s.timestamp ?? s.date ?? s.datetime);
    const date = s.date ?? (iso ? ymdLocalFromISO(iso) : null);
    const num = (v: any) => (v === undefined || v === null ? null : Number(v));
    let evRaw =
      s.expectedValuePoints ?? s.ev ?? s.expectedValue ?? s.expected_value ?? null;
    evRaw = evRaw === null || evRaw === undefined ? null : Number(evRaw);
    let expectedValuePoints: number | null =
      evRaw === null || !Number.isFinite(evRaw) ? null : evRaw;
    // deixamos EV sempre positivo no frontend para SELL também (magnitude)
    if (expectedValuePoints !== null && side === "SELL") {
      expectedValuePoints = Math.abs(expectedValuePoints);
    }
    return {
      side,
      suggestedEntry: num(s.suggestedEntry ?? s.entry),
      stopSuggestion: num(s.stopSuggestion ?? s.sl ?? s.stop),
      takeProfitSuggestion: num(s.takeProfitSuggestion ?? s.tp),
      conditionText: s.conditionText ?? s.note ?? s.reason ?? null,
      score: num(s.score),
      probHit: s.probHit != null ? Number(s.probHit) : null,
      probCalibrated: s.probCalibrated != null ? Number(s.probCalibrated) : null,
      expectedValuePoints,
      time: iso,
      date,
    };
  });
}

export async function fetchConfirmedSignals(params: {
  symbol: string;
  timeframe: string;
  from?: string;
  to?: string;
  limit?: number;

  // >>> novos (apenas para alinhamento visual/legendas; o backend pode ignorar)
  slPoints?: number;
  tpPoints?: number;
}): Promise<ConfirmedSignal[]> {
  const q = new URLSearchParams();
  q.set("symbol", params.symbol.toUpperCase());
  q.set("timeframe", params.timeframe.toUpperCase());
  if (params.from) q.set("from", params.from);
  if (params.to) q.set("to", params.to);
  if (params.limit) q.set("limit", String(params.limit));
  if (params.slPoints != null) q.set("slPoints", String(params.slPoints));
  if (params.tpPoints != null) q.set("tpPoints", String(params.tpPoints));

  const raw = await jsonFetch<any>(`/api/signals?${q.toString()}`, {
    method: "GET",
  });

  const arr: any[] =
    (Array.isArray(raw) && raw) ||
    raw?.data ||
    raw?.rows ||
    raw?.signals ||
    raw?.items ||
    [];

  return arr.map((s) => {
    const side = normalizeSide(s.side ?? s.direction ?? s.type ?? s.signalSide);
    const iso =
      toISO(s.time ?? s.timestamp ?? s.date ?? s.datetime) ??
      new Date().toISOString();
    const price = s.price ?? s.entry ?? s.value ?? s.execPrice ?? null;
    const note = s.note ?? s.reason ?? s.conditionText ?? s.comment ?? null;
    return {
      side,
      time: iso,
      price: price != null ? Number(price) : null,
      note,
    };
  });
}

/* =========================================
   Backtest — normalização de payload
   ========================================= */
export type BacktestTradeNormalized = BacktestTradeDTO & {
  pnlPoints: number;
  note: string | null;
  id: number | string;
};

function mapBacktestTrade(t: BacktestTradeDTO, idx: number): BacktestTradeNormalized {
  const pnlPoints =
    Number.isFinite(t.pnlPoints as any)
      ? Number(t.pnlPoints)
      : Number(t.pnl ?? 0);

  const noteRaw =
    t.note ??
    t.reason ??
    t.conditionText ??
    t.comment ??
    null;

  return {
    id: t.id ?? idx + 1,
    side: t.side,
    entryTime: t.entryTime,
    exitTime: t.exitTime,
    entryPrice: Number(t.entryPrice),
    exitPrice: Number(t.exitPrice),
    pnlPoints, // garantido
    note: noteRaw && String(noteRaw).trim() !== "" ? String(noteRaw).trim() : null,
    movedToBE: !!t.movedToBE,
    trailEvents: t.trailEvents ?? 0,
    // campos originais mantidos:
    pnl: t.pnl ?? pnlPoints,
    reason: t.reason ?? null,
    conditionText: t.conditionText ?? null,
    comment: t.comment ?? null,
  };
}

function normalizeBacktestPayload(raw: any): BacktestDTO {
  const dto: any =
    (raw && raw.data && typeof raw.data === "object" && raw.data) ||
    raw;

  const tradesArr: any[] =
    (Array.isArray(dto?.trades) && dto.trades) ||
    dto?.items ||
    dto?.rows ||
    [];

  const trades = tradesArr.map(mapBacktestTrade);

  const pnlPointsTop = Number(dto?.pnlPoints ?? dto?.summary?.pnlPoints ?? 0);
  const pnlMoneyTop = Number(dto?.pnlMoney ?? 0);

  return {
    ok: dto?.ok !== false,
    id: String(dto?.id ?? `run-${Date.now()}`),
    ts: String(dto?.ts ?? new Date().toISOString()),
    version: String(dto?.version ?? "unknown"),
    symbol: String(dto?.symbol ?? ""),
    timeframe: String(dto?.timeframe ?? ""),
    from: String(dto?.from ?? new Date().toISOString()),
    to: String(dto?.to ?? new Date().toISOString()),
    candles: Number(dto?.candles ?? 0),
    trades,
    summary: {
      trades: Number(dto?.summary?.trades ?? trades.length),
      wins: Number(dto?.summary?.wins ?? trades.filter((t: any) => (t.pnlPoints ?? 0) > 0).length),
      losses: Number(dto?.summary?.losses ?? trades.filter((t: any) => (t.pnlPoints ?? 0) < 0).length),
      ties: Number(dto?.summary?.ties ?? trades.filter((t: any) => (t.pnlPoints ?? 0) === 0).length),
      winRate: Number(dto?.summary?.winRate ?? 0),
      pnlPoints: Number(dto?.summary?.pnlPoints ?? pnlPointsTop),
      avgPnL: Number(dto?.summary?.avgPnL ?? (trades.length ? (trades.reduce((a: number, b: any) => a + Number(b.pnlPoints ?? 0), 0) / trades.length) : 0)),
      profitFactor: dto?.summary?.profitFactor ?? 0,
      maxDrawdown: Number(dto?.summary?.maxDrawdown ?? 0),
    },
    pnlPoints: pnlPointsTop,
    pnlMoney: pnlMoneyTop,
    lossCapApplied: dto?.lossCapApplied ?? 0,
    maxConsecLossesApplied: dto?.maxConsecLossesApplied ?? 0,
    policy: dto?.policy ?? undefined,
    config: dto?.config ?? undefined,
  };
}

/** ===========================
 * Backtest com política completa
 * =========================== */
export async function runBacktest(params: {
  symbol: string; timeframe: string; from?: string; to?: string;
  pointValue?: number; costPts?: number; slippagePts?: number; lossCap?: number; maxConsecLosses?: number;
  rr?: number; kSL?: number; kTrail?: number; breakEvenAtR?: number; beOffsetR?: number;
  breakEvenAtPts?: number | null; beOffsetPts?: number | null; timeStopBars?: number; horizonBars?: number;
  evalWindow?: number; regime?: any; tod?: any; conformal?: any; minProb?: number; minEV?: number; useMicroModel?: boolean;
  vwapFilter?: boolean; bbEnabled?: boolean; bbPeriod?: number; bbK?: number; candlePatterns?: string;
  slPoints?: number; tpPoints?: number; tpViaRR?: boolean;
}): Promise<BacktestDTO> {
  const body = JSON.stringify(params);

  // helpers
  const post = (base: string, path: string) =>
    jsonFetchBase<any>(base, path, { method: "POST", body });
  const getQ = (base: string, path: string) => {
    const q = new URLSearchParams();
    q.set("symbol", params.symbol.toUpperCase());
    q.set("timeframe", params.timeframe.toUpperCase());
    if (params.from) q.set("from", params.from);
    if (params.to) q.set("to", params.to);
    // custos / limites
    if (params.pointValue != null) q.set("pointValue", String(params.pointValue));
    if (params.costPts != null) q.set("costPts", String(params.costPts));
    if (params.slippagePts != null) q.set("slippagePts", String(params.slippagePts));
    if (params.lossCap != null) q.set("lossCap", String(params.lossCap));
    if (params.maxConsecLosses != null) q.set("maxConsecLosses", String(params.maxConsecLosses));
    // política
    if (params.rr != null) q.set("rr", String(params.rr));
    if (params.kSL != null) q.set("kSL", String(params.kSL));
    if (params.kTrail != null) q.set("kTrail", String(params.kTrail));
    if (params.breakEvenAtR != null) q.set("breakEvenAtR", String(params.breakEvenAtR));
    if (params.beOffsetR != null) q.set("beOffsetR", String(params.beOffsetR));
    if (params.breakEvenAtPts != null) q.set("breakEvenAtPts", String(params.breakEvenAtPts));
    if (params.beOffsetPts != null) q.set("beOffsetPts", String(params.beOffsetPts));
    if (params.timeStopBars != null) q.set("timeStopBars", String(params.timeStopBars));
    if (params.horizonBars != null) q.set("horizonBars", String(params.horizonBars));
    // filtros/IA
    if (params.evalWindow != null) q.set("evalWindow", String(params.evalWindow));
    if (params.regime != null) q.set("regime", String(params.regime));
    if (params.tod != null) q.set("tod", String(params.tod));
    if (params.conformal != null) q.set("conformal", String(params.conformal));
    if (params.minProb != null) q.set("minProb", String(params.minProb));
    if (params.minEV != null) q.set("minEV", String(params.minEV));
    if (params.useMicroModel != null) q.set("useMicroModel", String(params.useMicroModel ? 1 : 0));
    // indicadores/gates
    if (params.vwapFilter != null) q.set("vwapFilter", String(params.vwapFilter ? 1 : 0));
    if (params.bbEnabled != null) q.set("bbEnabled", String(params.bbEnabled ? 1 : 0));
    if (params.bbPeriod != null) q.set("bbPeriod", String(params.bbPeriod));
    if (params.bbK != null) q.set("bbK", String(params.bbK));
    if (params.candlePatterns) q.set("candlePatterns", params.candlePatterns);
    // stops explícitos
    if (params.slPoints != null) q.set("slPoints", String(params.slPoints));
    if (params.tpPoints != null) q.set("tpPoints", String(params.tpPoints));
    if (params.tpViaRR != null) q.set("tpViaRR", String(params.tpViaRR ? 1 : 0));
    return jsonFetchBase<any>(base, `${path}?${q.toString()}`, { method: "GET" });
  };

  // ORDEM DE TENTATIVA:
  // 1) EXEC_BASE -> /api/backtest (preferido)
  try { return normalizeBacktestPayload(await post(EXEC_BASE, "/api/backtest")); }
  catch (e: any) { if (process.env.NODE_ENV !== "production") console.warn("[api] POST EXEC /api/backtest falhou", e?.status, e?.urlTried || ""); }

  // 2) EXEC_BASE -> GET /api/backtest
  try { return normalizeBacktestPayload(await getQ(EXEC_BASE, "/api/backtest")); }
  catch (e: any) { if (process.env.NODE_ENV !== "production") console.warn("[api] GET EXEC /api/backtest falhou", e?.status, e?.urlTried || ""); }

  // 3) EXEC_BASE -> /backtest (alias no broker)
  try { return normalizeBacktestPayload(await post(EXEC_BASE, "/backtest")); }
  catch (e: any) { if (process.env.NODE_ENV !== "production") console.warn("[api] POST EXEC /backtest falhou", e?.status, e?.urlTried || ""); }

  try { return normalizeBacktestPayload(await getQ(EXEC_BASE, "/backtest")); }
  catch (e: any) { if (process.env.NODE_ENV !== "production") console.warn("[api] GET EXEC /backtest falhou", e?.status, e?.urlTried || ""); }

  // 4) API_BASE (fallback final — caso você também tenha montado lá)
  try { return normalizeBacktestPayload(await post(API_BASE, "/api/backtest")); } catch { }
  try { return normalizeBacktestPayload(await getQ(API_BASE, "/api/backtest")); } catch { }
  try { return normalizeBacktestPayload(await post(API_BASE, "/backtest")); } catch { }
  return normalizeBacktestPayload(await getQ(API_BASE, "/backtest")); // joga última tentativa
}

/** (opcional) lista execuções de backtest salvas */
export async function fetchBacktestRuns(limit = 100) {
  const q = new URLSearchParams();
  q.set("limit", String(limit));
  return jsonFetchBase<any>(EXEC_BASE, `/api/backtest/runs?${q.toString()}`, { method: "GET" });
}

/** ===========================
 * Candles
 * =========================== */
export async function fetchCandles(params: {
  symbol: string;
  timeframe: string;
  from?: string;
  to?: string;
  limit?: number;
}): Promise<Candle[]> {
  const q = new URLSearchParams();
  q.set("symbol", params.symbol.toUpperCase());
  q.set("timeframe", params.timeframe.toUpperCase());
  if (params.from) q.set("from", params.from);
  if (params.to) q.set("to", params.to);
  if (params.limit) q.set("limit", String(params.limit));
  return jsonFetch<Candle[]>(`/api/candles?${q.toString()}`, { method: "GET" });
}

/* =========================
   Helpers MT5 / Broker map
   ========================= */
function mapSymbolForBroker(sym: string): string {
  const s = String(sym || "").toUpperCase();
  const fromWin = window?.DAYTRADE_CFG?.brokerSymbolMap?.[s];
  if (fromWin) return fromWin;
  const envKey = `VITE_BROKER_SYMBOL_${s}`;
  const env: any = (import.meta as any)?.env ?? {};
  const fromEnv = env[envKey] ?? env[envKey.toUpperCase()];
  if (fromEnv) return String(fromEnv);
  return s; // fallback: usa como está
}

/* =========================
   Execução MT5 — client
   ========================= */
export async function execEnable(on?: boolean) {
  const qs = on === undefined ? "" : `?on=${on ? "1" : "0"}`;
  return jsonFetchBase<any>(EXEC_BASE, `/enable${qs}`, { method: "GET" });
}

export async function execPeek(agentId: string): Promise<ExecPeekResponse> {
  const q = new URLSearchParams();
  q.set("agentId", agentId || "mt5-ea-1");
  return jsonFetchBase<ExecPeekResponse>(EXEC_BASE, `/debug/peek?${q.toString()}`, {
    method: "GET",
  });
}

export async function execStats(): Promise<ExecStatsResponse> {
  return jsonFetchBase<ExecStatsResponse>(EXEC_BASE, "/debug/stats", {
    method: "GET",
  });
}

export async function execHistory(agentId: string): Promise<ExecHistoryResponse> {
  const q = new URLSearchParams();
  q.set("agentId", agentId || "mt5-ea-1");
  return jsonFetchBase<ExecHistoryResponse>(
    EXEC_BASE,
    `/debug/history?${q.toString()}`,
    { method: "GET" }
  );
}

export async function execPollNoop(agentId: string, max = 10) {
  return jsonFetchBase<any>(EXEC_BASE, `/poll?noop=1`, {
    method: "POST",
    body: JSON.stringify({ agentId: agentId || "mt5-ea-1", max }),
    headers: { "Content-Type": "application/json", Accept: "application/json" },
  });
}

/* =========================
   Enfileirar ordem p/ MT5 (EA NodeBridge)
   ========================= */
export async function enqueueMT5Order(
  input:
    | {
      agentId?: string;
      tasks: Array<{
        id?: string;
        side: "BUY" | "SELL";
        comment?: string;
        beAtPoints?: number | null;
        beOffsetPoints?: number | null;
        symbol?: string; // opcional
        timeframe?: any;
        time?: any;
        price?: number | null;
        volume?: number;
        slPoints?: number | null;
        tpPoints?: number | null;
      }>;
    }
    | {
      agentId?: string;
      symbol?: string;
      side: "BUY" | "SELL";
      volume?: number;
      lots?: number;
      comment?: string;
      beAtPoints?: number | null;
      beOffsetPoints?: number | null;
      price?: number | null;
      sl?: number | null;
      tp?: number | null;
    }
) {
  // Se já veio no formato {agentId, tasks:[...]} apenas encaminha
  if ((input as any)?.tasks && Array.isArray((input as any).tasks)) {
    const envelope = {
      agentId: (input as any).agentId ?? "mt5-ea-1",
      tasks: (input as any).tasks.map((t: any) => ({
        id:
          t.id ??
          `ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        side: t.side,
        comment: t.comment ?? "",
        beAtPoints: t.beAtPoints ?? null,
        beOffsetPoints: t.beOffsetPoints ?? null,
        // SÓ envie symbol se for o código real do MT5 (ex.: WINV25). Caso contrário, omita:
        ...(t.symbol ? { symbol: mapSymbolForBroker(t.symbol) } : {}),
        timeframe: t.timeframe ?? null,
        time: t.time ?? null,
        price: t.price ?? 0,
        volume: Math.max(1, Math.floor(Number(t.volume ?? 1))),
        slPoints: t.slPoints ?? null,
        tpPoints: t.tpPoints ?? null,
      })),
    };

    return jsonFetchBase<any>(EXEC_BASE, "/enqueue", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(envelope),
    });
  }

  // Caso contrário, monta uma task única no formato esperado pelo EA
  const p: any = input || {};
  const lots = p.volume ?? p.lots ?? 1;

  // Por padrão, NÃO mandamos symbol (o EA usa _Symbol). Se quiser muito enviar,
  // garanta que mapSymbolForBroker retorne o código exato do book no MT5:
  const mapped = p.symbol ? mapSymbolForBroker(String(p.symbol)) : null;
  const maybeSymbol =
    mapped && mapped !== String(p.symbol).toUpperCase() ? mapped : null;

  const task = {
    id: `ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    side: p.side as "BUY" | "SELL",
    comment: p.comment ?? "",
    beAtPoints: p.beAtPoints ?? null,
    beOffsetPoints: p.beOffsetPoints ?? null,
    ...(maybeSymbol ? { symbol: maybeSymbol } : {}), // OMIT se não tiver certeza
    timeframe: null,
    time: null,
    price: 0,
    volume: Math.max(1, Math.floor(Number(lots) || 1)),
    slPoints: null,
    tpPoints: null,
  };

  const envelope = {
    agentId: p.agentId ?? "mt5-ea-1",
    tasks: [task],
  };

  return jsonFetchBase<any>(EXEC_BASE, "/enqueue", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(envelope),
  });
}

/* =========================
   (NOVO) /api/trades (diagnóstico rápido)
   ========================= */
export type TradeRow = {
  id: number;
  symbol: string;
  timeframe: string;
  qty: number;
  side: "BUY" | "SELL" | null;
  entrySignalId: number | null;
  exitSignalId: number | null;
  taskId?: string | null; // <- pode vir do backend (quando existir)
  entryPrice: number | null;
  exitPrice: number | null;
  pnlPoints: number | null;
  pnlMoney: number | null;
  entryTime: string | null; // ISO
  exitTime: string | null;  // ISO
};

export async function fetchTrades(params: {
  symbol?: string;
  timeframe?: string;
  from?: string;
  to?: string;
  limit?: number;
}): Promise<TradeRow[]> {
  const q = new URLSearchParams();
  if (params.symbol) q.set("symbol", params.symbol.toUpperCase());
  if (params.timeframe) q.set("timeframe", params.timeframe.toUpperCase());
  if (params.from) q.set("from", params.from);
  if (params.to) q.set("to", params.to);
  if (params.limit) q.set("limit", String(params.limit));
  const raw = await jsonFetch<any>(`/api/trades?${q.toString()}`, { method: "GET" });
  const arr: any[] = Array.isArray(raw) ? raw : (raw?.data || raw?.rows || []);
  return arr.map((t: any) => ({
    id: Number(t.id),
    symbol: String(t.symbol ?? ""),
    timeframe: String(t.timeframe ?? ""),
    qty: Number(t.qty ?? 0),
    side: t.side ? normalizeSide(t.side) : null,
    entrySignalId: t.entrySignalId ?? null,
    exitSignalId: t.exitSignalId ?? null,
    taskId: t.taskId ?? null,
    entryPrice: t.entryPrice != null ? Number(t.entryPrice) : null,
    exitPrice: t.exitPrice != null ? Number(t.exitPrice) : null,
    pnlPoints: t.pnlPoints != null ? Number(t.pnlPoints) : null,
    pnlMoney: t.pnlMoney != null ? Number(t.pnlMoney) : null,
    entryTime: t.entryTime ?? null,
    exitTime: t.exitTime ?? null,
  }));
}

/* =========================
   (NOVO) /api/order-logs (ligação tarefa↔ordem)
   ========================= */
export type OrderLogEntry = {
  at: string | null;         // ISO
  taskId: string | null;
  entrySignalId: number | null;
  level: string | null;      // "info" | "warn" | "error" | ...
  type: string | null;       // "order_ok" | "order_fail" | "market_closed" | ...
  message: string | null;
  data: any | null;
  symbol: string | null;
  price: number | null;
  brokerOrderId: string | null; // ticket/ordem no broker (quando houver)
};

export async function fetchOrderLogs(key: string | number, limit = 300): Promise<{
  ok: boolean;
  key: string;
  modelUsed?: string | null;
  count: number;
  logs: OrderLogEntry[];
}> {
  const q = new URLSearchParams();
  q.set("taskId", String(key));
  q.set("limit", String(limit));
  return jsonFetch<any>(`/api/order-logs?${q.toString()}`, { method: "GET" });
}
