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
  time?: string;
  date?: string;
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

const RAW_API_BASE = (import.meta as any).env?.VITE_API_BASE ?? "";
const API_BASE = (RAW_API_BASE as string).replace(/\/$/, "");

/** Fetch JSON com tratamento de erro padrão do backend (ok=false) */
async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const fullUrl =
    (API_BASE || window.location.origin.replace(/\/$/, "")) +
    (url.startsWith("/") ? url : `/${url}`);

  const resp = await fetch(fullUrl, {
    headers: { "content-type": "application/json", ...(init?.headers || {}) },
    // ⚠️ CORS: sem cookies/credenciais (o backend usa ACAO: *)
    credentials: "omit",
    mode: "cors",
    cache: "no-cache",
    ...init,
  });

  const txt = await resp.text();
  const data = txt ? JSON.parse(txt) : null;
  const backendErr =
    data &&
    typeof data === "object" &&
    "ok" in data &&
    (data as any).ok === false;

  if (!resp.ok || backendErr) {
    const msg =
      (backendErr && ((data as any).error || "Erro na API")) ||
      `HTTP ${resp.status} ${resp.statusText}`;
    const err: any = new Error(msg);
    (err as any).response = data ?? txt;
    throw err;
  }
  return data as T;
}

export type { ProjectedSignalsParams };

export async function projectedSignals(
  params: ProjectedSignalsParams
): Promise<ProjectedSignal[]> {
  const raw = await jsonFetch<any>("/api/signals/projected", {
    method: "POST",
    body: JSON.stringify(params),
  });

  let arr: any[] = [];
  if (Array.isArray(raw)) arr = raw;
  else if (Array.isArray(raw?.data)) arr = raw.data;
  else if (Array.isArray(raw?.rows)) arr = raw.rows;
  else if (Array.isArray(raw?.signals)) arr = raw.signals;
  else if (Array.isArray(raw?.items)) arr = raw.items;

  const out: ProjectedSignal[] = arr.map((s) => {
    const sideRaw = s.side ?? s.direction ?? s.type ?? s.signalSide;
    const side = String(sideRaw || "").toUpperCase();
    const normSide: "BUY" | "SELL" | "FLAT" = side.includes("BUY")
      ? "BUY"
      : side.includes("SELL")
      ? "SELL"
      : "FLAT";

    const t = s.time ?? s.timestamp ?? s.date ?? s.datetime;
    let iso: string | undefined;
    if (typeof t === "string")
      iso = t.match(/Z$|[+-]\d{2}:?\d{2}$/) ? t : new Date(t).toISOString();
    else if (t instanceof Date) iso = t.toISOString();
    else if (typeof t === "number") iso = new Date(t).toISOString();

    return {
      side: normSide,
      suggestedEntry: s.suggestedEntry ?? s.entry ?? null,
      stopSuggestion: s.stopSuggestion ?? s.sl ?? s.stop ?? null,
      takeProfitSuggestion: s.takeProfitSuggestion ?? s.tp ?? null,
      conditionText: s.conditionText ?? s.note ?? s.reason ?? null,
      score: s.score ?? null,
      probHit: s.probHit ?? s.prob ?? null,
      probCalibrated: s.probCalibrated ?? null,
      expectedValuePoints: s.expectedValuePoints ?? s.ev ?? null,
      time: iso,
      date: s.date ?? null,
    };
  });

  return out;
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

  let arr: any[] = [];
  if (Array.isArray(raw)) arr = raw;
  else if (Array.isArray(raw?.data)) arr = raw.data;
  else if (Array.isArray(raw?.rows)) arr = raw.rows;
  else if (Array.isArray(raw?.signals)) arr = raw.signals;
  else if (Array.isArray(raw?.items)) arr = raw.items;

  const out: ConfirmedSignal[] = arr.map((s) => {
    const sideRaw = s.side ?? s.direction ?? s.type ?? s.signalSide;
    const side = String(sideRaw || "").toUpperCase();
    const normSide: "BUY" | "SELL" | "FLAT" = side.includes("BUY")
      ? "BUY"
      : side.includes("SELL")
      ? "SELL"
      : "FLAT";

    const t = s.time ?? s.timestamp ?? s.date ?? s.datetime;
    let iso: string;
    if (typeof t === "string") {
      iso = t.match(/Z$|[+-]\d{2}:?\d{2}$/) ? t : new Date(t).toISOString();
    } else if (t instanceof Date) {
      iso = t.toISOString();
    } else if (typeof t === "number") {
      iso = new Date(t).toISOString();
    } else {
      iso = new Date().toISOString();
    }

    const price = s.price ?? s.entry ?? s.value ?? s.execPrice ?? null;
    const note = s.note ?? s.reason ?? s.conditionText ?? s.comment ?? null;

    return { side: normSide, time: iso, price, note };
  });

  return out;
}

export async function runBacktest(params: {
  symbol: string;
  timeframe: string;
  from?: string;
  to?: string;
  lossCap?: number;
  maxConsecLosses?: number;
}) {
  return jsonFetch<any>("/api/backtest", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

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
