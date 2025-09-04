/* eslint-disable no-console */
import { PrismaClient } from "@prisma/client";
import { DateTime } from "luxon";
import { EMA, ATR, ADX } from "../services/indicators";

const prisma = new PrismaClient();

type Side = "BUY" | "SELL";

const ZONE = "America/Sao_Paulo";
const MICRO = String(process.env.MICRO_MODEL_URL || "").replace(/\/+$/, "");

// ======= CONFIG =======
const POLL_MS = Number(process.env.AUTO_TRAINER_POLL_MS || 60_000); // 1min
const BATCH_LIMIT_SIGNALS = Number(process.env.AUTO_TRAINER_BATCH || 300);
const LOOKBACK_CANDLES = Number(process.env.AUTO_TRAINER_LOOKBACK || 120); // p/ indicadores
const HORIZON = Number(process.env.AUTO_TRAINER_HORIZON || 12); // janelas à frente p/ label
const SL_ATR = Number(process.env.AUTO_TRAINER_SL_ATR || 1.0);
const RR = Number(process.env.AUTO_TRAINER_RR || 2.0); // tp = RR * ATR
const EPOCHS = Number(process.env.AUTO_TRAINER_EPOCHS || 1);

let _timer: NodeJS.Timeout | null = null;
let _running = false;
const _trained = new Set<number>(); // evita duplicar no ciclo do processo

// ======= UTILS =======
const clamp = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, n));
const okURL = () => MICRO.length > 0;

async function postJSON(url: string, body: any) {
  // @ts-ignore - fetch global no Node 18+
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const txt = await r.text();
  try {
    return {
      ok: r.ok,
      json: txt ? JSON.parse(txt) : null,
      status: r.status,
      txt,
    };
  } catch {
    return { ok: r.ok, json: null, status: r.status, txt };
  }
}

function toLocalHourFrac(d: Date) {
  const dt = DateTime.fromJSDate(d).setZone(ZONE);
  return dt.hour + dt.minute / 60;
}

function buildFeaturesAt(
  i: number,
  candles: {
    time: Date;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number | null;
  }[],
  e9: (number | null)[],
  e21: (number | null)[],
  atr: (number | null)[],
  adx: (number | null)[]
) {
  const c = candles[i];
  const prev = candles[i - 1] ?? c;
  const _atr = (atr[i] ?? atr[i - 1] ?? 1) as number;
  const _e9 = (e9[i] ?? e9[i - 1] ?? c.close) as number;
  const _e21 = (e21[i] ?? e21[i - 1] ?? c.close) as number;

  const slope9 = _e9 - ((e9[i - 1] ?? _e9) as number);
  const slope21 = _e21 - ((e21[i - 1] ?? _e21) as number);
  const ret1 = (c.close - prev.close) / Math.max(1e-6, _atr);

  const hourLocal = toLocalHourFrac(c.time);
  const angle = (hourLocal / 24) * 2 * Math.PI;
  const adxNorm = ((adx[i] ?? adx[i - 1] ?? 0) as number) / 100;

  return {
    dist_ema21: (c.close - _e21) / Math.max(1e-6, _atr),
    slope_e9: slope9 / Math.max(1e-6, _atr),
    slope_e21: slope21 / Math.max(1e-6, _atr),
    range_ratio: (c.high - c.low) / Math.max(1e-6, _atr),
    ret1,
    hour: Math.floor(hourLocal),
    hour_sin: Math.sin(angle),
    hour_cos: Math.cos(angle),
    adx14: adxNorm,
  };
}

function labelFromFuturePath(
  side: Side,
  entry: number,
  atr: number,
  future: { high: number; low: number }[]
): 0 | 1 {
  const sl = side === "BUY" ? entry - SL_ATR * atr : entry + SL_ATR * atr;
  const tp = side === "BUY" ? entry + RR * atr : entry - RR * atr;

  for (const f of future) {
    if (side === "BUY") {
      if (f.low <= sl) return 0;
      if (f.high >= tp) return 1;
    } else {
      if (f.high >= sl) return 0;
      if (f.low <= tp) return 1;
    }
  }
  // Se nenhum toque, desempata por quem ficou mais perto
  const last = future[future.length - 1];
  if (!last) return 0;
  const distTp = Math.abs(side === "BUY" ? tp - last.high : last.low - tp);
  const distSl = Math.abs(side === "BUY" ? last.low - sl : sl - last.high);
  return distTp < distSl ? 1 : 0;
}

// Busca uma janela de candles ao redor do tempo do candle base (do sinal)
async function getWindowAround(
  instrumentId: number,
  timeframe: any,
  t: Date,
  lookback: number,
  forward: number
) {
  // pega uma janela grande e depois recorta
  const rows = await prisma.candle.findMany({
    where: {
      instrumentId,
      // timeframe tolerante: aceita string/nulo se o schema permitir
      // no SQLite sem constraint, comparar string/null é ok; se seu schema for enum e der erro,
      // remova 'timeframe' abaixo:
      ...(typeof timeframe === "string" || timeframe === null
        ? { timeframe: timeframe as any }
        : {}),
      time: { lte: t },
    },
    orderBy: { time: "desc" },
    take: lookback + 5, // pega no passado
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

  const past = rows.reverse();
  const fut = await prisma.candle.findMany({
    where: {
      instrumentId,
      ...(typeof timeframe === "string" || timeframe === null
        ? { timeframe: timeframe as any }
        : {}),
      time: { gt: t },
    },
    orderBy: { time: "asc" },
    take: forward,
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

  const all = past.concat(fut);
  // índice do candle exatamente igual ao tempo t
  const idx = past.length - 1; // o último do "past" deve ser t
  return { candles: all, idx };
}

async function buildRowsForSignals(
  signals: {
    id: number;
    side: Side;
    candle: {
      id: number;
      time: Date;
      instrumentId: number;
      timeframe: any;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number | null;
    };
  }[]
) {
  const rows: { features: Record<string, number>; label: 0 | 1 }[] = [];

  for (const s of signals) {
    try {
      const { candles, idx } = await getWindowAround(
        s.candle.instrumentId,
        s.candle.timeframe,
        s.candle.time,
        LOOKBACK_CANDLES,
        HORIZON
      );
      if (!candles.length || idx < 5 || idx >= candles.length) continue;

      const highs = candles.map((c) => c.high);
      const lows = candles.map((c) => c.low);
      const closes = candles.map((c) => c.close);

      const e9 = EMA(closes, 9);
      const e21 = EMA(closes, 21);
      const atr = ATR(highs, lows, closes, 14);
      const adx = ADX(highs, lows, closes, 14);

      if (e21[idx] == null || atr[idx] == null) continue;

      const entry = candles[idx].close;
      const feats = buildFeaturesAt(idx, candles as any, e9, e21, atr, adx);
      const future = candles
        .slice(idx + 1, idx + 1 + HORIZON)
        .map((c) => ({ high: c.high, low: c.low }));
      const label = labelFromFuturePath(
        s.side,
        entry,
        atr[idx] as number,
        future
      );

      rows.push({ features: feats, label });
      _trained.add(s.id);
    } catch (e) {
      // segue para o próximo
      continue;
    }
  }
  return rows;
}

async function onePass() {
  if (!okURL()) return { ok: false, reason: "MICRO_MODEL_URL não configurada" };

  // pega últimos N sinais confirmados (com candle vinculado) que ainda não treinamos neste processo
  const signals = await prisma.signal.findMany({
    where: { candleId: { not: null } },
    orderBy: { id: "desc" },
    take: BATCH_LIMIT_SIGNALS,
    select: {
      id: true,
      side: true,
      candle: {
        select: {
          id: true,
          time: true,
          instrumentId: true,
          timeframe: true,
          open: true,
          high: true,
          low: true,
          close: true,
          volume: true,
        },
      },
    },
  });

  const fresh = signals.filter((s) => !_trained.has(s.id));
  if (!fresh.length) return { ok: true, trained: 0, skipped: signals.length };

  const rows = await buildRowsForSignals(fresh as any);
  if (!rows.length) return { ok: true, trained: 0, skipped: fresh.length };

  const payload = { rows, epochs: EPOCHS };
  const r = await postJSON(`${MICRO}/train`, payload);
  if (!r.ok || !r.json?.ok) {
    return {
      ok: false,
      error: r.json?.error || `HTTP ${r.status}`,
      trained: 0,
    };
  }
  return { ok: true, trained: rows.length };
}

// ======= PUBLIC API =======
export function startAutoTrainer() {
  if (_running) return { ok: true, already: true };
  if (!okURL()) return { ok: false, error: "MICRO_MODEL_URL não configurada" };
  _running = true;
  const tick = async () => {
    try {
      const r = await onePass();
      if (!r.ok) console.warn("[AutoTrainer] erro:", r);
      else console.log("[AutoTrainer] ciclo:", r);
    } catch (e: any) {
      console.warn("[AutoTrainer] exceção:", e?.message || String(e));
    } finally {
      if (_running) _timer = setTimeout(tick, POLL_MS);
    }
  };
  _timer = setTimeout(tick, 1000); // primeiro ciclo em 1s
  return { ok: true, started: true, pollMs: POLL_MS };
}

export function stopAutoTrainer() {
  _running = false;
  if (_timer) {
    clearTimeout(_timer);
    _timer = null;
  }
  return { ok: true, stopped: true, trainedIdsCached: _trained.size };
}

export function statusAutoTrainer() {
  return {
    ok: true,
    running: _running,
    pollMs: POLL_MS,
    cached: _trained.size,
  };
}

export default { startAutoTrainer, stopAutoTrainer, statusAutoTrainer };
