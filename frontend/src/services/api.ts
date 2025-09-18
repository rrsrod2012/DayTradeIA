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
};

const RAW_API_BASE = (import.meta as any).env?.VITE_API_BASE ?? "";
const API_BASE = (RAW_API_BASE as string).replace(/\/$/, "");

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
  if (typeof t === "string") return /Z$|[+-]\d{2}:?\d{2}$/.test(t) ? t : new Date(t).toISOString();
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

/** Fetch JSON robusto: tolera HTML/404 de dev server para habilitar fallback */
async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const fullUrl = /^https?:\/\//i.test(url)
    ? url
    : ((API_BASE || window.location.origin.replace(/\/$/, "")) +
      (url.startsWith("/") ? url : `/${url}`));

  const resp = await fetch(fullUrl, {
    headers: { "content-type": "application/json", ...(init?.headers || {}) },
    credentials: "omit",
    mode: "cors",
    cache: "no-cache",
    ...init,
  });

  const txt = await resp.text();

  // ←—— Tenta parsear como JSON, mas NÃO explode se vier HTML
  let data: any = null;
  try {
    data = txt ? JSON.parse(txt) : null;
  } catch {
    data = null; // pode ser HTML (404 do Vite), imagem, etc.
  }

  const backendErr = data && typeof data === "object" && "ok" in data && (data as any).ok === false;

  if (!resp.ok || backendErr) {
    const msg =
      (backendErr && ((data as any).error || "Erro na API")) ||
      `HTTP ${resp.status} ${resp.statusText}`;
    const err: any = new Error(msg);
    err.status = resp.status;       // <- MUITO IMPORTANTE pro fallback
    err.response = data ?? txt;     // guarda JSON parseado ou texto cru
    throw err;
  }

  // Se ok==true mas a resposta não é JSON válido, ainda assim falha (nossos endpoints sempre retornam JSON)
  if (data === null) {
    const err: any = new Error("Resposta não-JSON do servidor");
    err.status = resp.status;
    err.response = txt;
    throw err;
  }

  return data as T;
}

export type { ProjectedSignalsParams };

export async function projectedSignals(params: ProjectedSignalsParams): Promise<ProjectedSignal[]> {
  const raw = await jsonFetch<any>("/api/signals/projected", {
    method: "POST",
    body: JSON.stringify(params),
  });

  const arr: any[] = (Array.isArray(raw) && raw) || raw?.data || raw?.rows || raw?.signals || raw?.items || [];
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
}): Promise<ConfirmedSignal[]> {
  const q = new URLSearchParams();
  q.set("symbol", params.symbol.toUpperCase());
  q.set("timeframe", params.timeframe.toUpperCase());
  if (params.from) q.set("from", params.from);
  if (params.to) q.set("to", params.to);
  if (params.limit) q.set("limit", String(params.limit));

  const raw = await jsonFetch<any>(`/api/signals?${q.toString()}`, { method: "GET" });
  const arr: any[] = (Array.isArray(raw) && raw) || raw?.data || raw?.rows || raw?.signals || raw?.items || [];

  return arr.map((s) => {
    const side = normalizeSide(s.side ?? s.direction ?? s.type ?? s.signalSide);
    const iso = toISO(s.time ?? s.timestamp ?? s.date ?? s.datetime) ?? new Date().toISOString();
    const price = s.price ?? s.entry ?? s.value ?? s.execPrice ?? null;
    const note = s.note ?? s.reason ?? s.conditionText ?? s.comment ?? null;
    return { side, time: iso, price: price != null ? Number(price) : null, note };
  });
}

/** Backtest com fallback inteligente:
 *  1) Tenta /api/backtest (se existir proxy)
 *  2) Se falhar com 404 (ou resposta não-JSON 404 do Vite), cai para:
 *     a) `${API_BASE}/backtest` se VITE_API_BASE estiver definido
 *     b) `http://localhost:3000/backtest` como fallback final de dev
 */
export async function runBacktest(params: {
  symbol: string;
  timeframe: string;
  from?: string;
  to?: string;
  lossCap?: number;
  maxConsecLosses?: number;
  breakEvenAtPts?: number;
  beOffsetPts?: number;
}) {
  try {
    return await jsonFetch<any>("/api/backtest", {
      method: "POST",
      body: JSON.stringify(params),
    });
  } catch (e: any) {
    // Cai aqui quando /api/backtest deu 404 (ou HTML 404)
    const base = API_BASE || "http://localhost:3000";
    return await jsonFetch<any>(`${base}/backtest`, {
      method: "POST",
      body: JSON.stringify(params),
    });
  }
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
