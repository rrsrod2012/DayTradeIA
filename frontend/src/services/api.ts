// ===============================
// FILE: frontend/src/services/api.ts
// ===============================
// Frontend API client — daytrade-ia

// Comparação detalhada: Simulado vs Real
export async function getBrokerComparison(tradeId: number) {
  return jsonFetch<any>(`/admin/broker/compare-detailed?tradeId=${tradeId}`, {
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
  date?: string | null; // YYYY-MM-DD
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

  // pass-through opcionais
  bbEnabled?: number | boolean;
  bbPeriod?: number;
  bbK?: number;
  candlePatterns?: string;
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
      tickSizeBySymbol?: Record<string, number>;
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
  pnl?: number;
  pnlPoints?: number;
  note?: string | null;
  reason?: string | null;
  conditionText?: string | null;
  comment?: string | null;
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

/** --------- Helpers --------- */
function normalizeSide(val: any): "BUY" | "SELL" | "FLAT" {
  const s = String(val ?? "").trim().toUpperCase();
  if (s === "SELL" || s === "SHORT" || s === "S" || s === "-1" || s === "DOWN" || s.includes("SELL") || s.includes("SHORT")) return "SELL";
  if (s === "BUY" || s === "LONG" || s === "B" || s === "1" || s === "UP" || s.includes("BUY") || s.includes("LONG")) return "BUY";
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

/** Normaliza date-only para 'YYYY-MM-DD'. Aceita 'YYYY-MM-DD' e 'DD/MM/YYYY'. */
function normalizeDateOnly(input?: string): string | undefined {
  if (!input) return undefined;
  const s = String(input).trim();
  if (!s) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) {
    const dd = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    const yyyy = parseInt(m[3], 10);
    if (dd > 31 || mm > 12) return undefined;
    return `${yyyy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  }
  return s;
}

/** Data de hoje no fuso 'America/Sao_Paulo' como 'YYYY-MM-DD' */
function todayYMD_SaoPaulo(): string {
  try {
    const fmt = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' });
    const parts = fmt.formatToParts(new Date());
    const d = Object.fromEntries(parts.map(p => [p.type, p.value]));
    return `${d.year}-${d.month}-${d.day}`;
  } catch {
    // fallback: local
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }
}

/** Expande 'YYYY-MM-DD' para ISO com timezone local (-03:00) */
function expandLocalDate(dateStr: string | undefined, kind: 'start' | 'end'): string | undefined {
  if (!dateStr) return undefined;
  const s = String(dateStr).trim();
  if (s.includes("T")) return s;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return s;
  const [_, y, mm, dd] = m;
  return kind === 'start'
    ? `${y}-${mm}-${dd}T00:00:00.000-03:00`
    : `${y}-${mm}-${dd}T23:59:59.999-03:00`;
}

/** Log helper (sempre visível) */
function logWithStack(tag: string, payload: any) {
  // eslint-disable-next-line no-console
  console.log(tag, payload);
  try { throw new Error("TRACE"); } catch (e: any) {
    const stack = e?.stack?.split("\n").slice(2, 8).join("\n");
    // eslint-disable-next-line no-console
    console.log(tag + " stack:", stack);
  }
}

// --------- Fetch base ---------
async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(url, {
    headers: { "content-type": "application/json", ...(init?.headers || {}) },
    credentials: "omit",
    mode: "cors",
    cache: "no-cache",
    ...init,
  });
  const txt = await resp.text();
  const data = txt ? JSON.parse(txt) : null;
  const backendErr = data && typeof data === "object" && "ok" in data && (data as any).ok === false;

  if (!resp.ok || backendErr) {
    const msg = (backendErr && ((data as any).error || "Erro na API")) || `HTTP ${resp.status} ${resp.statusText}`;
    const err: any = new Error(msg);
    (err as any).response = data ?? txt;
    (err as any).status = resp.status;
    (err as any).urlTried = url;
    throw err;
  }
  // eslint-disable-next-line no-console
  console.log("[api] ok", { url, init });
  return data as T;
}

export type { ProjectedSignalsParams };

/* =========================
   Runtime Config
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
  return jsonFetch<{ ok: boolean; config: RuntimeConfigPayload }>("/admin/runtime-config", { method: "GET" });
}
export async function saveRuntimeConfig(patch: RuntimeConfigPayload): Promise<{ ok: boolean; config: RuntimeConfigPayload }> {
  return jsonFetch<{ ok: boolean; config: RuntimeConfigPayload }>("/admin/runtime-config", {
    method: "POST",
    body: JSON.stringify(patch),
  });
}

export async function getAiNodeConfig(): Promise<{ ok?: boolean; config?: RuntimeConfigPayload }> {
  const ML_BASE = String(((import.meta as any).env?.VITE_ML_URL ?? "") || "").replace(/\/$/, "");
  if (!ML_BASE) return { ok: false, config: undefined };
  const resp = await fetch(`${ML_BASE}/config`, { method: "GET" });
  return resp.json();
}

/* =========================
   Signals
   ========================= */
export async function projectedSignals(params: ProjectedSignalsParams): Promise<ProjectedSignal[]> {
  // normaliza e aplica fallback
  let from = normalizeDateOnly(params.from);
  let to = normalizeDateOnly(params.to);
  if (!from || !to) {
    const today = todayYMD_SaoPaulo();
    from = from || today;
    to = to || today;
    logWithStack("[api] WARN projectedSignals without from/to — applying fallback(today SP)", { from, to, raw: { fromRaw: params.from, toRaw: params.to } });
  } else {
    logWithStack("[api] POST /api/signals/projected body", { ...params, from, to });
  }

  const raw = await jsonFetch<any>("/api/signals/projected", {
    method: "POST",
    body: JSON.stringify({ ...params, from, to }),
  });

  const arr: any[] =
    (Array.isArray(raw) && raw) || raw?.data || raw?.rows || raw?.signals || raw?.items || [];

  return arr.map((s) => {
    const side = normalizeSide(s.side ?? s.direction ?? s.type ?? s.signalSide);
    const iso = toISO(s.time ?? s.timestamp ?? s.date ?? s.datetime);
    const date = s.date ?? (iso ? ymdLocalFromISO(iso) : null);
    const num = (v: any) => (v === undefined || v === null ? null : Number(v));
    let evRaw = s.expectedValuePoints ?? s.ev ?? s.expectedValue ?? s.expected_value ?? null;
    evRaw = evRaw === null || evRaw === undefined ? null : Number(evRaw);
    let expectedValuePoints: number | null = evRaw === null || !Number.isFinite(evRaw) ? null : evRaw;
    if (expectedValuePoints !== null && side === "SELL") expectedValuePoints = Math.abs(expectedValuePoints);
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
  slPoints?: number;
  tpPoints?: number;
}): Promise<ConfirmedSignal[]> {
  const q = new URLSearchParams();
  q.set("symbol", params.symbol.toUpperCase());
  q.set("timeframe", params.timeframe.toUpperCase());

  let from = normalizeDateOnly(params.from);
  let to = normalizeDateOnly(params.to);
  if (!from || !to) {
    const today = todayYMD_SaoPaulo();
    from = from || today;
    to = to || today;
    logWithStack("[api] WARN GET /api/signals without from/to — applying fallback(today SP)", { from, to, raw: { fromRaw: params.from, toRaw: params.to } });
  }
  q.set("from", from);
  q.set("to", to);

  if (params.limit) q.set("limit", String(params.limit));
  if (params.slPoints != null) q.set("slPoints", String(params.slPoints));
  if (params.tpPoints != null) q.set("tpPoints", String(params.tpPoints));

  logWithStack("[api] GET /api/signals", { qs: q.toString() });

  const raw = await jsonFetch<any>(`/api/signals?${q.toString()}`, { method: "GET" });

  const arr: any[] =
    (Array.isArray(raw) && raw) || raw?.data || raw?.rows || raw?.signals || raw?.items || [];

  return arr.map((s) => {
    const side = normalizeSide(s.side ?? s.direction ?? s.type ?? s.signalSide);
    const iso = toISO(s.time ?? s.timestamp ?? s.date ?? s.datetime) ?? new Date().toISOString();
    const price = s.price ?? s.entry ?? s.value ?? s.execPrice ?? null;
    const note = s.note ?? s.reason ?? s.conditionText ?? s.comment ?? null;
    return { side, time: iso, price: price != null ? Number(price) : null, note };
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
  const pnlPoints = Number.isFinite(t.pnlPoints as any) ? Number(t.pnlPoints) : Number(t.pnl ?? 0);
  const noteRaw = t.note ?? t.reason ?? t.conditionText ?? t.comment ?? null;
  return {
    id: t.id ?? idx + 1,
    side: t.side,
    entryTime: t.entryTime,
    exitTime: t.exitTime,
    entryPrice: Number(t.entryPrice),
    exitPrice: Number(t.exitPrice),
    pnlPoints,
    note: noteRaw && String(noteRaw).trim() !== "" ? String(noteRaw).trim() : null,
    movedToBE: !!t.movedToBE,
    trailEvents: t.trailEvents ?? 0,
    pnl: t.pnl ?? pnlPoints,
    reason: t.reason ?? null,
    conditionText: t.conditionText ?? null,
    comment: t.comment ?? null,
  };
}

function normalizeBacktestPayload(raw: any): BacktestDTO {
  const dto: any = (raw && raw.data && typeof raw.data === "object" && raw.data) || raw;
  const tradesArr: any[] = (Array.isArray(dto?.trades) && dto.trades) || dto?.items || dto?.rows || [];
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

export async function runBacktest(params: {
  symbol: string; timeframe: string; from?: string; to?: string;
  pointValue?: number; costPts?: number; slippagePts?: number; lossCap?: number; maxConsecLosses?: number;
  rr?: number; kSL?: number; kTrail?: number; breakEvenAtR?: number; beOffsetR?: number;
  breakEvenAtPts?: number | null; beOffsetPts?: number | null; timeStopBars?: number; horizonBars?: number;
  evalWindow?: number; regime?: any; tod?: any; conformal?: any; minProb?: number; minEV?: number; useMicroModel?: boolean;
  vwapFilter?: boolean; bbEnabled?: boolean; bbPeriod?: number; bbK?: number; candlePatterns?: string;
  slPoints?: number; tpPoints?: number; tpViaRR?: boolean;
}): Promise<BacktestDTO> {
  const raw = await jsonFetch<any>('/api/backtest', { method: 'POST', body: JSON.stringify(params) });
  return normalizeBacktestPayload(raw);
}

export async function fetchBacktestRuns(limit = 100) {
  const q = new URLSearchParams();
  q.set("limit", String(limit));
  return jsonFetch<any>(`/api/backtest/runs?${q.toString()}`, { method: "GET" });
}

/* =========================
   Candles
   ========================= */
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

  // normaliza e aplica fallback (evita “janeiro” sem filtro)
  let from = normalizeDateOnly(params.from);
  let to = normalizeDateOnly(params.to);
  if (!from || !to) {
    const today = todayYMD_SaoPaulo();
    from = from || today;
    to = to || today;
    logWithStack("[api] WARN GET /api/candles without from/to — applying fallback(today SP)", { from, to, raw: { fromRaw: params.from, toRaw: params.to } });
  }
  q.set("from", from);
  q.set("to", to);

  if (params.limit) q.set("limit", String(params.limit));

  logWithStack("[api] GET /api/candles", { qs: q.toString() });

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
  const upperKey = envKey.toUpperCase();
  const fromEnv = env[envKey] ?? env[upperKey];
  if (fromEnv) return String(fromEnv);
  return s;
}

/* =========================
   Execução MT5 — client
   ========================= */
export async function execEnable(on?: boolean) {
  const qs = on === undefined ? "" : `?on=${on ? "1" : "0"}`;
  return jsonFetch<any>(`/enable${qs}`, { method: "GET" });
}
export async function execPeek(agentId: string): Promise<ExecPeekResponse> {
  const q = new URLSearchParams();
  q.set("agentId", agentId || "mt5-ea-1");
  return jsonFetch<ExecPeekResponse>(`/debug/peek?${q.toString()}`, { method: "GET" });
}
export async function execStats(): Promise<ExecStatsResponse> {
  return jsonFetch<ExecStatsResponse>("/debug/stats", { method: "GET" });
}
export async function execHistory(agentId: string): Promise<ExecHistoryResponse> {
  const q = new URLSearchParams();
  q.set("agentId", agentId || "mt5-ea-1");
  return jsonFetch<ExecHistoryResponse>(`/debug/history?${q.toString()}`, { method: "GET" });
}
export async function execPollNoop(agentId: string, max = 10) {
  return jsonFetch<any>(`/poll?noop=1`, {
    method: "POST",
    body: JSON.stringify({ agentId: agentId || "mt5-ea-1", max }),
    headers: { "Content-Type": "application/json", Accept: "application/json" },
  });
}

/* =========================
   Enfileirar ordem p/ MT5
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
        symbol?: string;
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
  if ((input as any)?.tasks && Array.isArray((input as any).tasks)) {
    const envelope = {
      agentId: (input as any).agentId ?? "mt5-ea-1",
      tasks: (input as any).tasks.map((t: any) => ({
        id: t.id ?? `ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        side: t.side,
        comment: t.comment ?? "",
        beAtPoints: t.beAtPoints ?? null,
        beOffsetPoints: t.beOffsetPoints ?? null,
        ...(t.symbol ? { symbol: mapSymbolForBroker(t.symbol) } : {}),
        timeframe: t.timeframe ?? null,
        time: t.time ?? null,
        price: t.price ?? 0,
        volume: Math.max(1, Math.floor(Number(t.volume ?? 1))),
        slPoints: t.slPoints ?? null,
        tpPoints: t.tpPoints ?? null,
      })),
    };
    return jsonFetch<any>("/enqueue", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(envelope),
    });
  }

  const p: any = input || {};
  const lots = p.volume ?? p.lots ?? 1;
  const mapped = p.symbol ? mapSymbolForBroker(String(p.symbol)) : null;
  const maybeSymbol = mapped && mapped !== String(p.symbol).toUpperCase() ? mapped : null;

  const task = {
    id: `ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    side: p.side as "BUY" | "SELL",
    comment: p.comment ?? "",
    beAtPoints: p.beAtPoints ?? null,
    beOffsetPoints: p.beOffsetPoints ?? null,
    ...(maybeSymbol ? { symbol: maybeSymbol } : {}),
    timeframe: null,
    time: null,
    price: 0,
    volume: Math.max(1, Math.floor(Number(lots) || 1)),
    slPoints: null,
    tpPoints: null,
  };

  const envelope = { agentId: p.agentId ?? "mt5-ea-1", tasks: [task] };
  return jsonFetch<any>("/enqueue", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(envelope),
  });
}

/* =========================
   /api/trades
   ========================= */
export type TradeRow = {
  id: number;
  symbol: string;
  timeframe: string;
  qty: number;
  side: "BUY" | "SELL" | null;
  entrySignalId: number | null;
  exitSignalId: number | null;
  taskId?: string | null;
  entryPrice: number | null;
  exitPrice: number | null;
  pnlPoints: number | null;
  pnlMoney: number | null;
  entryTime: string | null;
  exitTime: string | null;
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

  const from = expandLocalDate(normalizeDateOnly(params.from) ?? todayYMD_SaoPaulo(), "start")!;
  const to = expandLocalDate(normalizeDateOnly(params.to) ?? todayYMD_SaoPaulo(), "end")!;

  q.set("from", from);
  q.set("to", to);
  if (params.limit) q.set("limit", String(params.limit));

  logWithStack("[api] GET /api/trades", { qs: q.toString() });

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
   /api/order-logs
   ========================= */
export type OrderLogEntry = {
  at: string | null;
  taskId: string | null;
  entrySignalId: number | null;
  level: string | null;
  type: string | null;
  message: string | null;
  data: any | null;
  symbol: string | null;
  price: number | null;
  brokerOrderId: string | null;
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
  logWithStack("[api] GET /api/order-logs", { qs: q.toString() });
  return jsonFetch<any>(`/api/order-logs?${q.toString()}`, { method: "GET" });
}
