/* eslint-disable no-console */
import { prisma } from "../prisma";
import logger from "../logger";
import { loadCandlesAnyTF } from "../lib/aggregation";

type TrainExample = {
  features: Record<string, number>;
  label: 0 | 1;                // TP antes de SL (binário)
  evPoints: number;            // PnL em pontos (regressão)
  meta?: Record<string, any>;
};

let _timer: NodeJS.Timeout | null = null;
let _running = false;
let _lastError: string | null = null;
let _lastRunAt: Date | null = null;
let _trainedSignals = new Set<number>();
let _stats = { sent: 0, batches: 0 };

/* ================== Utils TF / ENV ================== */
function tfCandidates(tf?: string | null) {
  if (!tf) return ["M1", "M5", "M15", "M30", "H1"];
  const T = String(tf).toUpperCase();
  if (T.startsWith("M1")) return ["M1", "M5", "M15"];
  if (T.startsWith("M5")) return ["M5", "M1", "M15"];
  if (T.startsWith("M15")) return ["M15", "M5", "M30"];
  if (T.startsWith("M30")) return ["M30", "M15", "H1"];
  if (T.startsWith("H1")) return ["H1", "M30", "M15"];
  return ["M1", "M5", "M15", "M30", "H1"];
}
function envNumber(name: string, def?: number) {
  const v = process.env[name];
  if (!v && v !== "0") return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
function envBool(name: string, def = false) {
  const v = (process.env[name] || "").trim().toLowerCase();
  if (!v) return def;
  return v === "1" || v === "true" || v === "yes";
}

/* ================== Indicadores ================== */
function EMA(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  const k = 2 / (period + 1);
  let e: number | null = null;
  for (let i = 0; i < values.length; i++) {
    const v = Number(values[i]) || 0;
    e = e == null ? v : v * k + (e as number) * (1 - k);
    out.push(e);
  }
  return out;
}
function ATR(high: number[], low: number[], close: number[], period = 14): (number | null)[] {
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
function VWAP(high: number[], low: number[], close: number[], volume: number[]): number[] {
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
function ADX(high: number[], low: number[], close: number[], period = 14) {
  const len = close.length;
  const plusDM: number[] = [0], minusDM: number[] = [0], tr: number[] = [0];
  for (let i = 1; i < len; i++) {
    const upMove = high[i] - high[i - 1];
    const downMove = low[i - 1] - low[i];
    plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;
    tr[i] = Math.max(
      high[i] - low[i],
      Math.abs(high[i] - close[i - 1]),
      Math.abs(low[i] - close[i - 1])
    );
  }
  const smooth = (arr: number[]) => EMA(arr, period).map((v) => (v ?? 0));
  const trN = smooth(tr);
  const pDMN = smooth(plusDM);
  const mDMN = smooth(minusDM);

  const pDI: number[] = [], mDI: number[] = [], dx: number[] = [];
  for (let i = 0; i < len; i++) {
    const trv = trN[i] || 1e-9;
    const p = 100 * (pDMN[i] || 0) / trv;
    const m = 100 * (mDMN[i] || 0) / trv;
    pDI.push(p);
    mDI.push(m);
    dx.push(100 * Math.abs(p - m) / Math.max(p + m, 1e-9));
  }
  return EMA(dx, period).map((v) => (v ?? 0));
}
function slope(arr: (number | null)[], lookback = 5) {
  const buf = arr.map((x) => (x == null ? NaN : Number(x)));
  const n = Math.min(lookback, buf.length);
  if (n < 2) return 0;
  const a = buf.slice(-n);
  if (a.some((v) => !Number.isFinite(v))) return 0;
  const xBar = (n - 1) / 2;
  const yBar = a.reduce((p, v) => p + v, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xBar) * (a[i] - yBar);
    den += (i - xBar) * (i - xBar);
  }
  return den === 0 ? 0 : num / den;
}

/* ================== ATR “rápido” (uso no label) ================== */
function atr14Quick(values: { high: number; low: number; close: number }[]) {
  if (!values?.length) return null;
  let prevClose = values[0].close;
  let trs: number[] = [];
  for (let i = 1; i < values.length; i++) {
    const v = values[i];
    const tr = Math.max(
      v.high - v.low,
      Math.abs(v.high - prevClose),
      Math.abs(v.low - prevClose)
    );
    trs.push(tr);
    prevClose = v.close;
  }
  if (!trs.length) return null;
  const period = Math.min(14, trs.length);
  const arr = trs.slice(-period);
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/* ================== Avaliação do sinal: label & EV ================== */
async function evaluateSignalOutcome(args: {
  id: number;
  side: "BUY" | "SELL";
  candle: {
    id: number;
    time: Date;
    instrumentId: number;
    timeframe: string | null;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number | null;
  };
}) {
  const H = Math.max(1, Number(process.env.AUTO_TRAINER_HORIZON) || 12);
  const K_SL = Number(process.env.AUTO_TRAINER_SL_ATR) || 1.0;
  const RR = Number(process.env.AUTO_TRAINER_RR) || 2.0;
  const USE_HOLD_PNL = envBool("AUTO_TRAINER_HOLD_PNL_AT_H", true);

  const entry = args.candle.close;

  const atrCands = await prisma.candle.findMany({
    where: {
      instrumentId: args.candle.instrumentId,
      time: { lte: args.candle.time },
      timeframe: args.candle.timeframe || undefined,
    },
    orderBy: { time: "asc" },
    take: 100,
    select: { high: true, low: true, close: true },
  });

  const atr = atr14Quick(atrCands);
  if (!Number.isFinite(atr) || !atr) {
    return { label: 0 as 0 | 1, evPoints: 0 };
  }

  const slPts = K_SL * atr;
  const tpPts = RR * slPts;

  const win = await prisma.candle.findMany({
    where: {
      instrumentId: args.candle.instrumentId,
      time: { gt: args.candle.time },
      OR: tfCandidates(args.candle.timeframe).map((v) => ({ timeframe: v })),
    },
    orderBy: { time: "asc" },
    take: H,
    select: { high: true, low: true, close: true },
  });

  if (!win?.length) return { label: 0, evPoints: 0 };

  if (args.side === "BUY") {
    for (const w of win) {
      if (w.low <= entry - slPts) return { label: 0, evPoints: -slPts };
      if (w.high >= entry + tpPts) return { label: 1, evPoints: +tpPts };
    }
    // sem toque em SL/TP no horizonte
    const hold = (win[win.length - 1].close - entry);
    return { label: 0, evPoints: USE_HOLD_PNL ? hold : 0 };
  } else {
    for (const w of win) {
      if (w.high >= entry + slPts) return { label: 0, evPoints: -slPts };
      if (w.low <= entry - tpPts) return { label: 1, evPoints: +tpPts };
    }
    const hold = (entry - win[win.length - 1].close);
    return { label: 0, evPoints: USE_HOLD_PNL ? hold : 0 };
  }
}

/* ================== Feature set (enriquecido) ================== */
function baseCandleFeatures(c: {
  open: number; high: number; low: number; close: number; volume: number | null;
}, side: "BUY" | "SELL") {
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low;
  const upperShadow = c.high - Math.max(c.open, c.close);
  const lowerShadow = Math.min(c.open, c.close) - c.low;
  const dir = c.close >= c.open ? 1 : -1;
  return {
    body, range, upperShadow, lowerShadow, dir,
    close: c.close,
    open: c.open,
    volume: c.volume ?? 0,
    sideBuy: side === "BUY" ? 1 : 0,
  } as Record<string, number>;
}

function techFeaturesAtIndex(i: number, series: {
  high: number[]; low: number[]; close: number[]; vol: number[];
  e9: (number | null)[]; e21: (number | null)[]; atr: (number | null)[];
  vwap: number[]; adx: number[];
}) {
  const c = series.close[i];
  const e21 = (series.e21[i] ?? c) as number;
  const atr = (series.atr[i] ?? series.atr[i - 1] ?? 1) as number;
  const slope21 = slope(series.e21.slice(0, i + 1), Math.min(5, i));
  return {
    dist_ema21: (c - e21) / Math.max(1e-6, atr),
    slope_e21: slope21 / Math.max(1e-6, atr),
    range_ratio: (series.high[i] - series.low[i]) / Math.max(1e-6, atr),
    dist_vwap_atr: Math.abs(c - series.vwap[i]) / Math.max(1e-6, atr),
    adx14: series.adx[i] ?? 0,
  };
}

/* ================== Filtros do engine (alinhados) ================== */
function passesEngineFilters(i: number, side: "BUY" | "SELL", series: {
  high: number[]; low: number[]; close: number[]; vol: number[];
  e9: (number | null)[]; e21: (number | null)[]; atr: (number | null)[];
  vwap: number[]; adx: number[];
}) {
  const MIN_ADX = envNumber("ENGINE_MIN_ADX", 20)!;
  const MIN_SLOPE = envNumber("ENGINE_MIN_SLOPE", 0.02)!; // em ATR
  const MAX_DIST_VWAP_ATR = envNumber("ENGINE_MAX_DIST_VWAP_ATR", 0.15)!; // 0 desliga
  const REQUIRE_BREAKOUT = envBool("ENGINE_REQUIRE_BREAKOUT", true);
  const N = 10;

  if (i < 2) return false;

  const c = series.close[i];
  const ema9 = (series.e9[i] ?? c) as number;
  const ema21 = (series.e21[i] ?? c) as number;
  const prevDiff = (series.e9[i - 1] ?? series.close[i - 1])! - (series.e21[i - 1] ?? series.close[i - 1])!;
  const diff = ema9 - ema21;

  const winStart = Math.max(0, i - N);
  const winHigh = Math.max(...series.high.slice(winStart, i));
  const winLow = Math.min(...series.low.slice(winStart, i));
  const _atr = (series.atr[i] ?? series.atr[i - 1] ?? 1) as number;

  const adxOk = (series.adx[i] ?? 0) >= MIN_ADX;

  const s21 = slope(series.e21.slice(0, i + 1), Math.min(5, i));
  const sNorm = _atr > 0 ? s21 / _atr : 0;
  const slopeOkBuy = sNorm >= MIN_SLOPE;
  const slopeOkSell = sNorm <= -MIN_SLOPE;

  const distVWAP = Math.abs(c - series.vwap[i]);
  const distOk = MAX_DIST_VWAP_ATR <= 0 ? true : distVWAP >= MAX_DIST_VWAP_ATR * _atr;

  const crossedUp = (series.e9[i - 1] ?? series.close[i - 1])! <= (series.e21[i - 1] ?? series.close[i - 1])! && ema9 > ema21;
  const crossedDn = (series.e9[i - 1] ?? series.close[i - 1])! >= (series.e21[i - 1] ?? series.close[i - 1])! && ema9 < ema21;

  const breakoutUp = REQUIRE_BREAKOUT ? c > winHigh : true;
  const breakoutDn = REQUIRE_BREAKOUT ? c < winLow : true;

  if (side === "BUY") {
    return crossedUp && breakoutUp && adxOk && slopeOkBuy && distOk;
  } else {
    return crossedDn && breakoutDn && adxOk && slopeOkSell && distOk;
  }
}

/* ================== Construção do batch alinhado ================== */
async function buildTrainBatchAligned(signals: any[]) {
  const out: TrainExample[] = [];

  for (const s of signals) {
    if (!s.candle) continue;
    const symbol = (s.candle.instrument?.symbol || "WIN").toString().toUpperCase();
    const timeframe = (s.candle.timeframe as string | null) ?? "M5";

    const rows = await loadCandlesAnyTF(symbol, String(timeframe).toUpperCase(), {
      lte: s.candle.time,
      limit: 600,
    });
    if (!Array.isArray(rows) || rows.length < 50) continue;

    const timesISO = rows.map((r: any) => (r.time instanceof Date ? r.time : new Date(r.time)).toISOString());
    const targetISO = (s.candle.time as Date).toISOString();
    const idx = timesISO.lastIndexOf(targetISO);
    if (idx < 2) continue;

    const highs = rows.map((r: any) => Number(r.high));
    const lows = rows.map((r: any) => Number(r.low));
    const closes = rows.map((r: any) => Number(r.close));
    const vols = rows.map((r: any) => Number(r.volume ?? 0));
    const e9 = EMA(closes, 9);
    const e21 = EMA(closes, 21);
    const atr = ATR(highs, lows, closes, 14);
    const vwap = VWAP(highs, lows, closes, vols);
    const adx = ADX(highs, lows, closes, 14);
    const series = { high: highs, low: lows, close: closes, vol: vols, e9, e21, atr, vwap, adx };

    const side = (s.side as "BUY" | "SELL") || "BUY";

    // Só treina exemplos que passariam pelos filtros do engine
    if (!passesEngineFilters(idx, side, series)) continue;

    // Avalia label e EV
    const outcome = await evaluateSignalOutcome({
      id: s.id,
      side,
      candle: {
        id: s.candle.id,
        time: s.candle.time as any,
        instrumentId: s.candle.instrumentId as any,
        timeframe: timeframe,
        open: Number(s.candle.open),
        high: Number(s.candle.high),
        low: Number(s.candle.low),
        close: Number(s.candle.close),
        volume: s.candle.volume == null ? null : Number(s.candle.volume),
      },
    });

    // Features base + técnicas
    const base = baseCandleFeatures(
      {
        open: Number(s.candle.open),
        high: Number(s.candle.high),
        low: Number(s.candle.low),
        close: Number(s.candle.close),
        volume: s.candle.volume == null ? 0 : Number(s.candle.volume),
      },
      side
    );
    const tech = techFeaturesAtIndex(idx, series);

    out.push({
      features: { ...base, ...tech },
      label: outcome.label,
      evPoints: Number.isFinite(outcome.evPoints) ? outcome.evPoints : 0,
      meta: {
        signalId: s.id,
        candleId: s.candle.id,
        symbol,
        timeframe,
        timeISO: targetISO,
      },
    });

    _trainedSignals.add(s.id);
  }
  return out;
}

/* ================== Coleta de exemplos ================== */
async function collectExamples(limit: number): Promise<TrainExample[]> {
  const notInIds = Array.from(_trainedSignals.values());
  const baseWhere: any = {
    signalType: "EMA_CROSS",
    candle: { isNot: null },
  };
  if (notInIds.length > 0) {
    baseWhere.id = { notIn: notInIds };
  }

  const signals = await prisma.signal.findMany({
    where: baseWhere,
    orderBy: { id: "desc" },
    take: Math.max(1, Math.min(300, Number(limit) || 100)),
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
          instrument: { select: { symbol: true } },
        },
      },
    },
  });

  if (!signals?.length) return [];
  return await buildTrainBatchAligned(signals);
}

/* ================== HTTP / Scheduler ================== */
function ms(n: number, def: number) {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : def;
}
function okURL() {
  return !!(process.env.MICRO_MODEL_URL || "").trim();
}

async function httpPostJSON<T = any>(url: string, body: any, timeoutMs = 15000): Promise<T> {
  let f: typeof fetch = (global as any).fetch;
  if (!f) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      f = require("node-fetch");
    } catch {
      throw new Error("fetch indisponível e node-fetch não encontrado");
    }
  }
  // @ts-expect-error AbortController global pode não existir em versões antigas
  const ctl = new (global as any).AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await f(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: ctl.signal,
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(`POST ${url} -> HTTP ${r.status} ${r.statusText} ${txt ? "- " + txt : ""}`);
    }
    return (await r.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

/** Agora exportado e com EV */
export async function runOnce() {
  _lastRunAt = new Date();
  _lastError = null;

  try {
    if (!okURL()) throw new Error("MICRO_MODEL_URL não configurado");

    const BATCH = Math.max(1, Number(process.env.AUTO_TRAINER_BATCH) || 64);
    const EPOCHS = Math.max(1, Number(process.env.AUTO_TRAINER_EPOCHS) || 2);

    const examples = await collectExamples(BATCH);
    if (!examples.length) {
      logger.info("[AutoTrainer] nenhum exemplo novo no momento (após filtros do engine)");
      return;
    }

    const payload: any = {
      inputs: examples.map((e) => e.features),
      labels: examples.map((e) => e.label),             // classificação
      targetEV: examples.map((e) => e.evPoints),        // regressão (EV em pontos)
      meta: examples.map((e) => e.meta || null),
      epochs: EPOCHS,
    };

    const base = (process.env.MICRO_MODEL_URL || "").trim().replace(/\/+$/, "");
    const url = `${base}/train`;
    const res = await httpPostJSON<{ ok: boolean; trained: number }>(
      url,
      payload,
      ms(Number(process.env.AUTO_TRAINER_HTTP_TIMEOUT_MS) || 0, 20000)
    );

    if (!res?.ok) throw new Error("Treino retornou ok=false");

    _stats.sent += res.trained || examples.length;
    _stats.batches += 1;

    logger.info(
      JSON.stringify({
        msg: "[AutoTrainer] treino concluído",
        trained: res.trained ?? examples.length,
        batch: examples.length,
        features: Object.keys(examples[0].features || {}),
      })
    );
  } catch (err: any) {
    _lastError = String(err?.message || err);
    logger.error(JSON.stringify({ msg: "[AutoTrainer] erro", error: _lastError }));
  }
}

function scheduleNext() {
  const delay = Math.max(1000, Number(process.env.AUTO_TRAINER_POLL_MS) || 10000);
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(tick, delay);
}

async function tick() {
  if (!_running) return;
  await runOnce();
  scheduleNext();
}

export function startAutoTrainer() {
  if (_running) return { ok: true, running: true };
  _running = true;
  _stats = { sent: 0, batches: 0 };
  scheduleNext();
  return { ok: true, running: true };
}

export function stopAutoTrainer() {
  _running = false;
  if (_timer) {
    clearTimeout(_timer);
    _timer = null;
  }
  return { ok: true, running: false };
}

export async function statusAutoTrainer() {
  return {
    ok: true,
    running: _running,
    lastRunAt: _lastRunAt ? _lastRunAt.toISOString() : null,
    lastError: _lastError,
    stats: _stats,
    trackedSignals: _trainedSignals.size,
    microModelUrl: (process.env.MICRO_MODEL_URL || "").trim() || null,
  };
}

/** Alias opcional */
export async function pokeAutoTrainer() {
  return runOnce();
}
