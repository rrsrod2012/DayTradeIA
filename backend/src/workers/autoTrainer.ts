/* eslint-disable no-console */
import { prisma } from "../prisma";
import logger from "../logger";

type TrainExample = {
  features: Record<string, number>;
  label: 0 | 1;
  meta?: Record<string, any>;
};

let _timer: NodeJS.Timeout | null = null;
let _running = false;
let _lastError: string | null = null;
let _lastRunAt: Date | null = null;
let _trainedSignals = new Set<number>();
let _stats = { sent: 0, batches: 0 };

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

function atr14(values: { high: number; low: number; close: number }[]) {
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

async function labelFromSignalPnL(args: {
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

  const atr = atr14(atrCands);
  if (!Number.isFinite(atr) || !atr) return 0;

  const sl = K_SL * atr;
  const tp = RR * sl;

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

  if (!win?.length) return 0;

  if (args.side === "BUY") {
    let hitSL = false;
    for (const w of win) {
      if (w.low <= entry - sl) {
        hitSL = true;
        break;
      }
      if (w.high >= entry + tp) {
        return 1;
      }
    }
    return hitSL ? 0 : 0;
  } else {
    let hitSL = false;
    for (const w of win) {
      if (w.high >= entry + sl) {
        hitSL = true;
        break;
      }
      if (w.low <= entry - tp) {
        return 1;
      }
    }
    return hitSL ? 0 : 0;
  }
}

function featureize(sig: {
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
  const c = sig.candle;
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low;
  const upperShadow = c.high - Math.max(c.open, c.close);
  const lowerShadow = Math.min(c.open, c.close) - c.low;
  const dir = c.close >= c.open ? 1 : -1;

  return {
    body,
    range,
    upperShadow,
    lowerShadow,
    dir,
    close: c.close,
    open: c.open,
    volume: c.volume ?? 0,
    sideBuy: sig.side === "BUY" ? 1 : 0,
  } as Record<string, number>;
}

async function buildTrainBatch(signals: any[]) {
  const out: TrainExample[] = [];
  for (const s of signals) {
    if (!s.candle) continue;

    const pnl = await labelFromSignalPnL({
      id: s.id,
      side: s.side as any,
      candle: {
        id: s.candle.id,
        time: s.candle.time as any,
        instrumentId: s.candle.instrumentId as any,
        timeframe: (s.candle.timeframe as string | null) ?? null,
        open: Number(s.candle.open),
        high: Number(s.candle.high),
        low: Number(s.candle.low),
        close: Number(s.candle.close),
        volume: s.candle.volume == null ? null : Number(s.candle.volume),
      },
    });

    out.push({
      features: featureize(s),
      label: pnl ? 1 : 0,
      meta: { signalId: s.id, candleId: s.candle.id },
    });

    _trainedSignals.add(s.id);
  }
  return out;
}

async function collectExamples(limit: number): Promise<TrainExample[]> {
  const notInIds = Array.from(_trainedSignals.values());
  const baseWhere: any = {
    signalType: "EMA_CROSS",
    // em vez de candleId != null, usa relação
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
        },
      },
    },
  });

  if (!signals?.length) return [];
  return await buildTrainBatch(signals);
}

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
      f = require("node-fetch");
    } catch {
      throw new Error("fetch indisponível e node-fetch não encontrado");
    }
  }
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

async function runOnce() {
  _lastRunAt = new Date();
  _lastError = null;

  try {
    if (!okURL()) throw new Error("MICRO_MODEL_URL não configurado");

    const BATCH = Math.max(1, Number(process.env.AUTO_TRAINER_BATCH) || 64);
    const EPOCHS = Math.max(1, Number(process.env.AUTO_TRAINER_EPOCHS) || 2);

    const examples = await collectExamples(BATCH);
    if (!examples.length) {
      logger.info("[AutoTrainer] nenhum exemplo novo no momento");
      return;
    }

    const payload = {
      inputs: examples.map((e) => e.features),
      labels: examples.map((e) => e.label),
      meta: examples.map((e) => e.meta || null),
      epochs: EPOCHS,
    };

    const url = `${(process.env.MICRO_MODEL_URL || "").trim().replace(/\/+$/, "")}/train`;
    const res = await httpPostJSON<{ ok: boolean; trained: number }>(url, payload, ms(Number(process.env.AUTO_TRAINER_HTTP_TIMEOUT_MS) || 0, 20000));

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
