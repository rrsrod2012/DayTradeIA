// Frontend API client — daytrade-ia

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

const RAW_API_BASE = (import.meta as any).env?.VITE_API_BASE ?? "";
const API_BASE = String(RAW_API_BASE || "").replace(/\/$/, "");
const RAW_EXEC_BASE = (import.meta as any).env?.VITE_EXEC_BASE ?? API_BASE;
const EXEC_BASE = String(RAW_EXEC_BASE || "").replace(/\/$/, "");

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
}): Promise<ConfirmedSignal[]> {
  const q = new URLSearchParams();
  q.set("symbol", params.symbol.toUpperCase());
  q.set("timeframe", params.timeframe.toUpperCase());
  if (params.from) q.set("from", params.from);
  if (params.to) q.set("to", params.to);
  if (params.limit) q.set("limit", String(params.limit));

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

/** ===========================
 * Backtest com política completa
 * =========================== */
export async function runBacktest(params: {
  symbol: string;
  timeframe: string;
  from?: string;
  to?: string;

  // custos / limites diários
  pointValue?: number;
  costPts?: number;
  slippagePts?: number;
  lossCap?: number;
  maxConsecLosses?: number;

  // política de saída
  rr?: number;
  kSL?: number;
  kTrail?: number;
  breakEvenAtR?: number;
  beOffsetR?: number;
  breakEvenAtPts?: number | null;
  beOffsetPts?: number | null;
  timeStopBars?: number;
  horizonBars?: number;

  // filtros/IA
  evalWindow?: number;
  regime?: any;
  tod?: any;
  conformal?: any;
  minProb?: number;
  minEV?: number;
  useMicroModel?: boolean;
  vwapFilter?: boolean;
}) {
  const body = JSON.stringify(params);

  // 1) POST /api/backtest (preferido)
  try {
    return await jsonFetch<any>("/api/backtest", { method: "POST", body });
  } catch (e: any) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[api] POST /api/backtest falhou", e?.status, e?.urlTried || "");
    }
  }

  // 2) GET /backtest?query (fallback)
  try {
    const q = new URLSearchParams();
    q.set("symbol", params.symbol.toUpperCase());
    q.set("timeframe", params.timeframe.toUpperCase());
    if (params.from) q.set("from", params.from);
    if (params.to) q.set("to", params.to);

    if (params.pointValue != null) q.set("pointValue", String(params.pointValue));
    if (params.costPts != null) q.set("costPts", String(params.costPts));
    if (params.slippagePts != null) q.set("slippagePts", String(params.slippagePts));
    if (params.lossCap != null) q.set("lossCap", String(params.lossCap));
    if (params.maxConsecLosses != null) q.set("maxConsecLosses", String(params.maxConsecLosses));

    if (params.rr != null) q.set("rr", String(params.rr));
    if (params.kSL != null) q.set("kSL", String(params.kSL));
    if (params.kTrail != null) q.set("kTrail", String(params.kTrail));
    if (params.breakEvenAtR != null) q.set("breakEvenAtR", String(params.breakEvenAtR));
    if (params.beOffsetR != null) q.set("beOffsetR", String(params.beOffsetR));
    if (params.breakEvenAtPts != null) q.set("breakEvenAtPts", String(params.breakEvenAtPts));
    if (params.beOffsetPts != null) q.set("beOffsetPts", String(params.beOffsetPts));
    if (params.timeStopBars != null) q.set("timeStopBars", String(params.timeStopBars));
    if (params.horizonBars != null) q.set("horizonBars", String(params.horizonBars));

    if (params.evalWindow != null) q.set("evalWindow", String(params.evalWindow));
    if (params.regime != null) q.set("regime", String(params.regime));
    if (params.tod != null) q.set("tod", String(params.tod));
    if (params.conformal != null) q.set("conformal", String(params.conformal));
    if (params.minProb != null) q.set("minProb", String(params.minProb));
    if (params.minEV != null) q.set("minEV", String(params.minEV));
    if (params.useMicroModel != null) q.set("useMicroModel", String(params.useMicroModel ? 1 : 0));
    if (params.vwapFilter != null) q.set("vwapFilter", String(params.vwapFilter ? 1 : 0));

    return await jsonFetch<any>(`/backtest?${q.toString()}`, { method: "GET" });
  } catch (e: any) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[api] GET /backtest falhou", e?.status, e?.urlTried || "");
    }
  }

  // 3) POST /backtest (último fallback)
  return jsonFetch<any>("/backtest", { method: "POST", body });
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
  const qs =
    on === undefined
      ? ""
      : `?on=${on ? "1" : "0"}`;
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
        volume: t.volume ?? 1,
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
    volume: Number(lots) || 1,
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
