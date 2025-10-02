// ===============================
// FILE: backend_new/src/modules/strategy/projectedSignals.engine.ts
// ===============================
/* eslint-disable no-console */
import { prisma } from '../../core/prisma';
import { loadCandlesAnyTF } from '../data-import/lib/aggregation';

/**
 * Motor de projeção de sinais (migrado do backend original).
 * - Busca candles do símbolo/timeframe pedidos
 * - Calcula indicadores básicos (EMA9, EMA21, ATR14, VWAP simples)
 * - Gera sinais heurísticos (cross EMA + breakout simples) com score
 * - Se houver MICRO_MODEL_URL e /predict responder, repondera o score (opcional)
 *
 * Importante: NUNCA lança exceção para não derrubar a rota da API.
 */

type Params = {
  symbol: string;
  timeframe: string;
  from?: string;
  to?: string;
  limit?: number;
  vwapFilter?: boolean; // <-- respeitado aqui, lado-sensível
  minEV?: number; // <-- EV SELL normalizado para positivo
  minProb?: number; // (se houver prob vindo da IA)
  [k: string]: any;
};

type Candle = {
  id: number;
  time: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
};

type Projected = {
  time: string; // ISO
  side: "BUY" | "SELL";
  score: number;
  reason: string;
  symbol: string;
  timeframe: string;
  // campos opcionais que podem aparecer quando IA está ligada:
  prob?: number;
  expectedValuePoints?: number;
  ev?: number;
  expectedValue?: number;
  expected_value?: number;
  // enriquecimento local:
  vwapOk?: boolean;
};

const tfToMinutes = (tfRaw: string) => {
  const s = String(tfRaw || "")
    .trim()
    .toUpperCase();
  if (s.startsWith("M")) return Number(s.slice(1)) || 5;
  if (s.startsWith("H")) return (Number(s.slice(1)) || 1) * 60;
  const m = /(\d+)\s*(M|min|h|H)/.exec(s);
  if (m) {
    const n = Number(m[1]) || 5;
    const unit = (m[2] || "M").toUpperCase();
    return unit.startsWith("H") ? n * 60 : n;
  }
  return 5;
};

/* ---------------- Indicadores simples ---------------- */
function EMA(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  const k = 2 / (period + 1);
  let e: number | null = null;
  for (let i = 0; i < values.length; i++) {
    const v = Number(values[i]) || 0;
    e = e == null ? v : v * k + e * (1 - k);
    out.push(e);
  }
  return out;
}
function ATR(
  high: number[],
  low: number[],
  close: number[],
  period = 14
): (number | null)[] {
  const len = close.length;
  const tr: number[] = new Array(len).fill(0);
  for (let i = 1; i < len; i++) {
    const trueRange = Math.max(
      high[i] - low[i],
      Math.abs(high[i] - close[i - 1]),
      Math.abs(low[i] - close[i - 1])
    );
    tr[i] = trueRange;
  }
  // RMA simples
  const out: (number | null)[] = [];
  let acc = 0;
  for (let i = 0; i < len; i++) {
    const v = tr[i] || 0;
    if (i === 0) {
      out.push(null);
      acc = v;
    } else if (i < period) {
      acc += v;
      out.push(null);
    } else if (i === period) {
      const first = (acc + v) / period;
      out.push(first);
    } else {
      const prev = out[i - 1] as number;
      out.push((prev * (period - 1) + v) / period);
    }
  }
  return out;
}
/** VWAP acumulada simples (typical price * volume / soma volumes). */
function VWAP(
  high: number[],
  low: number[],
  close: number[],
  volume: number[]
): number[] {
  const out: number[] = [];
  let cumPV = 0;
  let cumV = 0;
  for (let i = 0; i < close.length; i++) {
    const typical = (high[i] + low[i] + close[i]) / 3;
    const v = Math.max(0, volume[i] || 0);
    cumPV += typical * v;
    cumV += v;
    out.push(cumV > 0 ? cumPV / cumV : typical);
  }
  return out;
}

/* ---------------- Heurística de sinais ---------------- */
function buildHeuristicSignals(
  symbol: string,
  timeframe: string,
  candles: Candle[]
): Projected[] {
  if (candles.length < 30) return [];

  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const e9 = EMA(closes, 9);
  const e21 = EMA(closes, 21);
  const atr = ATR(highs, lows, closes, 14);

  const out: Projected[] = [];

  // Sinal de cruzamento (EMA9 cruza EMA21) + breakout simples da máxima/mínima dos últimos N
  const N = 10;
  for (let i = 2; i < candles.length; i++) {
    const c = candles[i];

    const ema9 = e9[i] ?? closes[i];
    const ema21 = e21[i] ?? closes[i];
    const prevDiff =
      (e9[i - 1] ?? closes[i - 1]) - (e21[i - 1] ?? closes[i - 1]);
    const diff = ema9 - ema21;

    // breakout contexto
    const window = candles.slice(Math.max(0, i - N), i);
    const winHigh = Math.max(...window.map((x) => x.high));
    const winLow = Math.min(...window.map((x) => x.low));
    const _atr = (atr[i] ?? atr[i - 1] ?? 1) as number;

    // BUY: cruzou para cima e fechou acima da máxima recente
    if (prevDiff <= 0 && diff > 0 && c.close > winHigh) {
      const strength = (c.close - ema21) / Math.max(1e-6, _atr);
      out.push({
        time: c.time.toISOString(),
        side: "BUY",
        score: Math.max(0.1, Math.min(1, Math.abs(strength))),
        reason: `EMA9>EMA21 + breakout (${N}) • dist/ATR=${strength.toFixed(
          2
        )}`,
        symbol,
        timeframe,
      });
    }

    // SELL: cruzou para baixo e fechou abaixo da mínima recente
    if (prevDiff >= 0 && diff < 0 && c.close < winLow) {
      const strength = (ema21 - c.close) / Math.max(1e-6, _atr);
      out.push({
        time: c.time.toISOString(),
        side: "SELL",
        score: Math.max(0.1, Math.min(1, Math.abs(strength))),
        reason: `EMA9<EMA21 + breakdown (${N}) • dist/ATR=${strength.toFixed(
          2
        )}`,
        symbol,
        timeframe,
      });
    }
  }

  // Fallback suave
  if (out.length === 0 && candles.length > 1) {
    const i = candles.length - 1;
    const closes = candles.map((c) => c.close);
    const e9 = EMA(closes, 9);
    const e21 = EMA(closes, 21);
    const slope9 = (e9[i] ?? closes[i]) - (e9[i - 1] ?? closes[i - 1]);
    const slope21 = (e21[i] ?? closes[i]) - (e21[i - 1] ?? closes[i - 1]);
    const bias = slope9 + 0.5 * slope21;
    const side = bias >= 0 ? "BUY" : "SELL";
    const score = Math.min(
      0.35,
      Math.max(0.15, Math.abs(bias) / Math.max(1e-6, closes[i]))
    );
    out.push({
      time: candles[i].time.toISOString(),
      side,
      score,
      reason: `bias EMA (fallback) • slope9=${slope9.toFixed(
        2
      )} slope21=${slope21.toFixed(2)}`,
      symbol,
      timeframe,
    });
  }

  return out;
}

/* ---------------- Chamada opcional de IA (/predict) ---------------- */
async function rescoreWithML(
  items: Projected[],
  candles: Candle[]
): Promise<Projected[]> {
  try {
    const base = String(process.env.MICRO_MODEL_URL || "").replace(/\/+$/, "");
    if (!base) return items;

    const times = new Set(items.map((i) => i.time));
    const closes = candles.map((c) => c.close);
    const e9 = EMA(closes, 9);
    const e21 = EMA(closes, 21);
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);
    const atr = ATR(highs, lows, closes, 14);

    const rows: any[] = [];
    for (let i = 1; i < candles.length; i++) { // Começa de 1 para ter i-1
      const iso = candles[i].time.toISOString();
      if (!times.has(iso)) continue;
      const _atr = (atr[i] ?? atr[i - 1] ?? 1) as number;
      rows.push({
        features: {
          dist_ema21:
            (closes[i] - (e21[i] ?? closes[i])) / Math.max(1e-6, _atr),
          slope_e9:
            ((e9[i] ?? closes[i]) - (e9[i - 1] ?? closes[i - 1])) /
            Math.max(1e-6, _atr),
          slope_e21:
            ((e21[i] ?? closes[i]) - (e21[i - 1] ?? closes[i - 1])) /
            Math.max(1e-6, _atr),
          range_ratio: (highs[i] - lows[i]) / Math.max(1e-6, _atr),
        },
      });
    }

    if (rows.length === 0) return items;

    // @ts-ignore
    const r = await fetch(`${base}/predict`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rows }),
    });
    const text = await r.text();
    const j = text ? JSON.parse(text) : null;
    if (!r.ok || !j?.ok) return items;

    const probs: number[] | undefined = Array.isArray(j?.scores) ? j.scores : undefined;
    const evArr: number[] | undefined =
      Array.isArray(j?.ev) ? j.ev :
        Array.isArray(j?.ev_points) ? j.ev_points :
          Array.isArray(j?.expectedValuePoints) ? j.expectedValuePoints : undefined;

    const rescored: Projected[] = [];
    let k = 0;
    for (const it of items) {
      const p = probs && typeof probs[k] === "number" ? Math.min(1, Math.max(0, probs[k])) : undefined;
      const ev = evArr && typeof evArr[k] === "number" ? evArr[k] : undefined;

      let score = it.score;
      if (typeof p === "number") {
        score = Math.min(1, Math.max(0.1, (it.score * 0.6 + p * 0.8) / 1.2));
      }

      const out: Projected = { ...it, score };
      if (typeof p === "number") out.prob = p;
      if (typeof ev === "number") out.expectedValuePoints = ev;
      rescored.push(out);
      k++;
    }
    return rescored;
  } catch {
    return items; // se a IA falhar, segue heurístico
  }
}

/* ---------------- Consulta de candles ---------------- */
async function fetchCandles(
  symbol: string,
  timeframe: string,
  from?: string,
  to?: string,
  limit?: number
): Promise<Candle[]> {
  const range: any = {};
  if (from) range.gte = new Date(from.includes("T") ? from : `${from}T00:00:00.000Z`);
  if (to) range.lte = new Date(to.includes("T") ? to : `${to}T23:59:59.999Z`);
  if (limit && Number(limit) > 0) range.limit = Number(limit);

  const rows = await loadCandlesAnyTF(
    String(symbol).toUpperCase(),
    String(timeframe).toUpperCase(),
    range
  );

  return rows.map((r: any, idx: number) => ({
    id: idx,
    time: r.time instanceof Date ? r.time : new Date(r.time),
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: r.volume == null ? null : Number(r.volume),
  }));
}

/* ---------------- API principal ---------------- */
export async function generateProjectedSignals(
  params: Params
): Promise<Projected[]> {
  try {
    const symbol = (params.symbol || "WIN").toString().toUpperCase();
    const timeframe = (params.timeframe || "M5").toString().toUpperCase();
    const limit = Number(params.limit) || 500;
    const from = params.from ? String(params.from) : undefined;
    const to = params.to ? String(params.to) : undefined;

    const candles = await fetchCandles(symbol, timeframe, from, to, limit);
    if (!candles.length) return [];

    const tail =
      from || to
        ? candles
        : candles.slice(-Math.max(120, Math.min(limit, 600)));

    let items = buildHeuristicSignals(symbol, timeframe, tail);
    items = items.sort((a, b) => a.time.localeCompare(b.time)).slice(-limit);
    items = await rescoreWithML(items, tail);

    const highs = tail.map((c) => c.high);
    const lows = tail.map((c) => c.low);
    const closes = tail.map((c) => c.close);
    const volumes = tail.map((c) => Number(c.volume ?? 0));
    const vwap = VWAP(highs, lows, closes, volumes);
    const isoToIndex = new Map(tail.map((c, i) => [c.time.toISOString(), i]));

    items = items.map((s: Projected) => {
      const idx = isoToIndex.get(s.time);
      if (idx == null) return s;
      const ok =
        s.side === "BUY" ? closes[idx] >= vwap[idx] : closes[idx] <= vwap[idx];
      return { ...s, vwapOk: ok };
    });

    if (params?.vwapFilter) {
      items = items.filter((s) => s.vwapOk !== false);
    }

    items = items.map((s: any) => {
      const side = String(s?.side || "").toUpperCase();
      const out: any = { ...s };
      for (const f of [
        "expectedValuePoints",
        "ev",
        "expectedValue",
        "expected_value",
      ]) {
        if (out[f] != null && isFinite(Number(out[f]))) {
          const val = Number(out[f]);
          out[f] = side === "SELL" ? -val : val;
        }
      }
      return out as Projected;
    });

    if (typeof params?.minProb === "number") {
      items = items.filter(
        (s: any) => typeof s.prob !== "number" || s.prob >= params.minProb!
      );
    }
    if (typeof params?.minEV === "number") {
      items = items.filter((s: any) => {
        const ev =
          s.expectedValuePoints ?? s.ev ?? s.expectedValue ?? s.expected_value;
        return typeof ev !== "number" || ev >= params.minEV!;
      });
    }

    return items;
  } catch (e: any) {
    console.warn(
      "[engine] erro em generateProjectedSignals:",
      e?.message || String(e)
    );
    return [];
  }
}