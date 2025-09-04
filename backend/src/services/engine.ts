/* eslint-disable no-console */
import { prisma } from "../prisma";

/**
 * Motor de projeção de sinais:
 * - Busca candles do símbolo/timeframe pedidos
 * - Calcula indicadores básicos (EMA9, EMA21, ATR14)
 * - Gera sinais heurísticos (cross EMA + breakout simples) com score
 * - Se houver MICRO_MODEL_URL e /predict responder, repondera o score (opcional)
 *
 * Importante: NUNCA lança exceção para não derrubar /signals/projected.
 */

type Params = {
  symbol: string;
  timeframe: string;
  from?: string;
  to?: string;
  limit?: number;
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
    const prev = candles[i - 1];

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

  // Se nada gatilhou, dá um “palpite” suave no último candle conforme inclinação das EMAs
  if (out.length === 0) {
    const i = candles.length - 1;
    const ema9 = e9[i] ?? closes[i];
    const ema21 = e21[i] ?? closes[i];
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
    // Monta features simples para os tempos dos sinais
    const times = new Set(items.map((i) => i.time));
    const mapByIso = new Map<string, Candle>(
      candles.map((c) => [c.time.toISOString(), c])
    );
    const closes = candles.map((c) => c.close);
    const e9 = EMA(closes, 9);
    const e21 = EMA(closes, 21);
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);
    const atr = ATR(highs, lows, closes, 14);

    const rows: any[] = [];
    for (let i = 0; i < candles.length; i++) {
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
    if (!r.ok || !j?.ok || !Array.isArray(j?.scores)) return items;

    // Repondera de forma suave
    const rescored: Projected[] = [];
    let k = 0;
    for (const it of items) {
      const ml = j.scores[k++];
      const w = typeof ml === "number" ? Math.min(1, Math.max(0, ml)) : 0.5;
      const score = Math.min(
        1,
        Math.max(0.1, (it.score * 0.6 + w * 0.8) / 1.2)
      );
      rescored.push({ ...it, score });
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
  const tfMin = tfToMinutes(timeframe);
  const variants = Array.from(
    new Set([symbol, symbol.toUpperCase(), symbol.toLowerCase()])
  );
  const whereAny: any = {};
  if (from || to) {
    const range: any = {};
    if (from)
      range.gte = new Date(from.includes("T") ? from : `${from}T00:00:00.000Z`);
    if (to) range.lte = new Date(to.includes("T") ? to : `${to}T23:59:59.999Z`);
    whereAny.time = range;
  }
  // Tentativa com relação e timeframe tolerante
  try {
    const rows = await prisma.candle.findMany({
      where: {
        ...(whereAny.time ? { time: whereAny.time } : {}),
        OR: variants.map((v) => ({ instrument: { is: { symbol: v } } })),
        timeframe: { in: [timeframe.toUpperCase(), String(tfMin)] },
      },
      orderBy: { time: "asc" },
      take: limit && !whereAny.time ? Math.max(100, limit * 5) : undefined,
      select: {
        id: true,
        time: true,
        open: true,
        high: true,
        low: true,
        close: true,
        volume: true,
      },
    });
    if (rows.length) return rows as any;
  } catch {
    // cai no fallback
  }
  // Fallback: sem relação/timeframe (pega por tempo apenas)
  const rows = await prisma.candle.findMany({
    where: whereAny.time ? { time: whereAny.time } : undefined,
    orderBy: { time: "asc" },
    take: limit && !whereAny.time ? Math.max(100, limit * 5) : 1000,
    select: {
      id: true,
      time: true,
      open: true,
      high: true,
      low: true,
      close: true,
      volume: true,
    },
  });
  return rows as any;
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

    // Se veio range, usamos os próprios candles do range; se não, usamos a cauda
    const tail =
      from || to
        ? candles
        : candles.slice(-Math.max(120, Math.min(limit, 600)));

    // Heurística básica
    let items = buildHeuristicSignals(symbol, timeframe, tail);

    // Reordena e limita
    items = items.sort((a, b) => a.time.localeCompare(b.time)).slice(-limit);

    // Opcional: IA reponderando (se disponível)
    items = await rescoreWithML(items, tail);

    return items;
  } catch (e: any) {
    console.warn(
      "[engine] erro em generateProjectedSignals:",
      e?.message || String(e)
    );
    return []; // nunca propaga erro para a rota
  }
}

export default { generateProjectedSignals };
