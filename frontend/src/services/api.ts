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

const RAW_API_BASE = (import.meta as any).env?.VITE_API_BASE ?? "";
const API_BASE = (RAW_API_BASE as string).replace(/\/$/, "");

/** --------- Helpers --------- */
function normalizeSide(val: any): "BUY" | "SELL" | "FLAT" {
  if (val == null) return "FLAT";
  const s = String(val).toUpperCase();
  // cobre variações comuns
  if (s.includes("BUY") || s.includes("LONG") || s === "1") return "BUY";
  if (s.includes("SELL") || s.includes("SHORT") || s === "-1") return "SELL";
  return "FLAT";
}

function toISO(t: any): string | undefined {
  if (!t && t !== 0) return undefined;
  if (typeof t === "string") {
    // se já é ISO com timezone, mantém; senão converte
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

/** Fetch JSON com tratamento de erro padrão do backend (ok=false) */
async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const fullUrl =
    (API_BASE || window.location.origin.replace(/\/$/, "")) +
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

  // aceita vários formatos {data|rows|signals|items} ou array direto
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
    const date =
      s.date ??
      (iso ? ymdLocalFromISO(iso) : null); // se backend não mandar, derivamos do ISO

    // coerção numérica sem engolir 0
    const num = (v: any) => (v === undefined || v === null ? null : Number(v));

    return {
      side,
      suggestedEntry: num(s.suggestedEntry ?? s.entry),
      stopSuggestion: num(s.stopSuggestion ?? s.sl ?? s.stop),
      takeProfitSuggestion: num(s.takeProfitSuggestion ?? s.tp),
      conditionText: s.conditionText ?? s.note ?? s.reason ?? null,
      score: num(s.score),
      probHit: s.probHit != null ? Number(s.probHit) : null,
      probCalibrated: s.probCalibrated != null ? Number(s.probCalibrated) : null,
      expectedValuePoints:
        s.expectedValuePoints != null ? Number(s.expectedValuePoints) : s.ev != null ? Number(s.ev) : null,
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

  const raw = await jsonFetch<any>(`/api/signals?${q.toString()}`, { method: "GET" });

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
      toISO(s.time ?? s.timestamp ?? s.date ?? s.datetime) ?? new Date().toISOString();

    const price =
      s.price ?? s.entry ?? s.value ?? s.execPrice ?? null;
    const note =
      s.note ?? s.reason ?? s.conditionText ?? s.comment ?? null;

    return { side, time: iso, price: price != null ? Number(price) : null, note };
  });
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
