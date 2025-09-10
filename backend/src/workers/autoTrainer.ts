/* eslint-disable no-console */
import { prisma } from "../prisma";
import logger from "../logger";

type TrainExample = {
  features: Record<string, number>;
  label: 0 | 1; // 1 = TP antes do SL dentro do horizonte; 0 = caso contrário
  meta?: Record<string, any>;
};

let _timer: NodeJS.Timeout | null = null;
let _running = false;
let _lastError: string | null = null;
let _lastRunAt: Date | null = null;
let _trainedSignals = new Set<number>(); // IDs de sinais já usados neste processo (memória)
let _stats = {
  sent: 0,
  batches: 0,
};

/* =========================
   Helpers básicos
   ========================= */
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
    const mod = await import("node-fetch");
    // @ts-ignore
    f = mod.default as any;
  }
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await f(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      // @ts-ignore
      signal: ctrl.signal,
    } as any);
    const txt = await resp.text();
    const data = txt ? JSON.parse(txt) : null;
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} ${resp.statusText} — ${txt?.slice?.(0, 200) || ""}`);
    }
    return data as T;
  } finally {
    clearTimeout(to);
  }
}

/* =========================
   Indicadores
   ========================= */
function ema(values: number[], period: number): (number | null)[] {
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
function atrFromCandles(
  candles: { high: number; low: number; close: number }[],
  period = 14
): number | null {
  if (!candles?.length) return null;
  const tr: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = i > 0 ? candles[i - 1].close : c.close;
    tr.push(
      Math.max(
        c.high - c.low,
        Math.abs(c.high - prevClose),
        Math.abs(c.low - prevClose)
      )
    );
  }
  const a = ema(tr, period);
  const last = a[a.length - 1];
  return typeof last === "number" && isFinite(last) ? last : null;
}

/* =========================
   Timeframe helpers
   ========================= */
function tfToMinutes(tf: string | null | undefined): number | null {
  if (!tf) return null;
  const s = String(tf).trim().toUpperCase();
  if (/^M\d+$/.test(s)) return Number(s.slice(1));
  if (/^\d+$/.test(s)) return Number(s);
  if (/^H\d+$/.test(s)) return Number(s.slice(1)) * 60;
  return null;
}
/** Retorna candidatos de TF a testar no where:OR (ex.: "M5" -> ["M5","5"], null -> [null]) */
function tfCandidates(tf: string | null | undefined): string[] | (string | null)[] {
  const s = (tf ?? "").toString().trim().toUpperCase();
  if (!s) return [null];
  const mins = tfToMinutes(s);
  const out: (string | null)[] = [s];
  if (mins != null) out.push(String(mins));
  out.push(null); // também aceitar null
  return out;
}

/* =========================
   Features do candle
   ========================= */
function buildFeatures(candle: {
  open: number; high: number; low: number; close: number; volume?: number;
  atr?: number | null;
}) {
  const range = Number(candle.high) - Number(candle.low);
  const body = Math.abs(Number(candle.close) - Number(candle.open));
  const dir = Number(candle.close) >= Number(candle.open) ? 1 : -1;
  const vol = Number(candle.volume ?? 1);
  const atr = Number(candle.atr ?? 0);

  return {
    range,
    body,
    wick_top: Number(candle.high) - Math.max(Number(candle.open), Number(candle.close)),
    wick_bottom: Math.min(Number(candle.open), Number(candle.close)) - Number(candle.low),
    body_ratio: range > 0 ? body / range : 0,
    direction: dir,
    vol,
    atr,
    range_atr_ratio: atr > 0 ? range / atr : 0,
    body_atr_ratio: atr > 0 ? body / atr : 0,
  };
}

/* =========================
   Rotulagem TP/SL por horizonte
   ========================= */
async function labelFromSignalPnL(sig: {
  id: number;
  side: "BUY" | "SELL";
  candle: {
    id: number;
    time: Date;
    instrumentId: number;
    timeframe: string | null; // <<======= ajustado
    open: number; high: number; low: number; close: number; volume?: number;
  };
}): Promise<{ label: 0 | 1; entry: number; sl: number | null; tp: number | null; atr: number | null }> {
  const H = Math.max(1, Number(process.env.AUTO_TRAINER_HORIZON) || 12);
  const K_SL = Number(process.env.AUTO_TRAINER_SL_ATR) || 1.0;
  const RR = Number(process.env.AUTO_TRAINER_RR) || 2.0;

  const instrId = sig.candle.instrumentId;
  const tfCands = tfCandidates(sig.candle.timeframe);
  const t0 = sig.candle.time;

  // ATR(14) com candles anteriores (mesmo instrumento/TF tolerante)
  const ATR_PERIOD = 14;
  const prev = await prisma.candle.findMany({
    where: {
      instrumentId: instrId,
      time: { lte: t0 },
      OR: (tfCands as any[]).map((v) => ({ timeframe: v })),
    },
    orderBy: { time: "desc" },
    take: ATR_PERIOD + 60, // sobra
    select: { open: true, high: true, low: true, close: true, time: true },
  });
  const prevAsc = prev.slice().reverse();
  const atr = atrFromCandles(
    prevAsc.map((c) => ({ high: Number(c.high), low: Number(c.low), close: Number(c.close) })),
    ATR_PERIOD
  );

  // Próximas barras (para simular saída até H)
  const next1 = await prisma.candle.findMany({
    where: {
      instrumentId: instrId,
      time: { gt: t0 },
      OR: (tfCands as any[]).map((v) => ({ timeframe: v })),
    },
    orderBy: { time: "asc" },
    take: Math.max(1, H),
    select: { time: true, open: true, high: true, low: true, close: true },
  });

  if (!next1?.length) {
    // Sem futuras barras → conservadoramente 0
    return { label: 0, entry: Number(sig.candle.close), sl: null, tp: null, atr };
  }

  const entry = Number.isFinite(next1[0].open) ? Number(next1[0].open) : Number(next1[0].close);

  // Fallback ATR (range da barra do sinal) se não houver ATR calculável
  const fallbackATR = Math.max(1e-6, Math.abs(Number(sig.candle.high) - Number(sig.candle.low)));
  const atrUse = atr && isFinite(atr) && atr > 0 ? atr : fallbackATR;

  const slPts = Math.max(atrUse * K_SL, 0);
  const tpPts = Math.max(slPts * RR, 0);

  const isBuy = sig.side === "BUY";
  const sl = slPts > 0 ? (isBuy ? entry - slPts : entry + slPts) : null;
  const tp = tpPts > 0 ? (isBuy ? entry + tpPts : entry - tpPts) : null;

  // Varre até H barras — empate na mesma barra prioriza TP (política definida)
  let hitLabel: 0 | 1 = 0;
  const N = Math.min(H, next1.length);
  for (let i = 0; i < N; i++) {
    const bar = next1[i];
    const hi = Number(bar.high);
    const lo = Number(bar.low);

    if (tp != null && sl != null) {
      const tpHit = isBuy ? hi >= tp : lo <= tp;
      const slHit = isBuy ? lo <= sl : hi >= sl;
      if (tpHit && slHit) {
        hitLabel = 1;
        break;
      } else if (tpHit) {
        hitLabel = 1;
        break;
      } else if (slHit) {
        hitLabel = 0;
        break;
      }
    } else if (tp != null) {
      const tpHit = isBuy ? hi >= tp : lo <= tp;
      if (tpHit) {
        hitLabel = 1;
        break;
      }
    } else if (sl != null) {
      const slHit = isBuy ? lo <= sl : hi >= sl;
      if (slHit) {
        hitLabel = 0;
        break;
      }
    }
  }

  return { label: hitLabel, entry, sl, tp, atr };
}

/* =========================
   Coleta de exemplos
   ========================= */
async function collectExamples(limit: number): Promise<TrainExample[]> {
  const notInIds = Array.from(_trainedSignals.values());
  const baseWhere: any = {
    signalType: "EMA_CROSS",
    candleId: { not: null }, // evita erro `not: Int`
  };
  if (notInIds.length > 0) {
    baseWhere.id = { notIn: notInIds };
  }

  const signals = await prisma.signal.findMany({
    where: baseWhere,
    orderBy: { id: "desc" },
    take: limit,
    select: {
      id: true,
      side: true,
      candle: {
        select: {
          id: true,
          time: true,
          instrumentId: true,
          timeframe: true, // string | null
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

  const out: TrainExample[] = [];
  for (const s of signals) {
    if (!s.candle) continue;

    // Rotula via PnL (TP/SL no horizonte)
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
        volume: Number(s.candle.volume ?? 0),
      },
    });

    const feats = buildFeatures({
      open: Number(s.candle.open),
      high: Number(s.candle.high),
      low: Number(s.candle.low),
      close: Number(s.candle.close),
      volume: Number(s.candle.volume ?? 0),
      atr: pnl.atr,
    });

    out.push({
      features: feats,
      label: pnl.label,
      meta: {
        signalId: s.id,
        candleId: s.candle.id,
        timeframe: s.candle.timeframe,
        t: (s.candle.time as any as Date).toISOString(),
      },
    });
  }
  return out;
}

/* =========================
   Loop de treino
   ========================= */
async function onePass() {
  _lastRunAt = new Date();
  _lastError = null;

  if (!okURL()) {
    return { ok: false, reason: "MICRO_MODEL_URL não configurada" };
  }

  const POLL_MS = ms(Number(process.env.AUTO_TRAINER_POLL_MS), 60_000);
  const BATCH = Math.max(1, Number(process.env.AUTO_TRAINER_BATCH) || 300);
  const EPOCHS = Math.max(1, Number(process.env.AUTO_TRAINER_EPOCHS) || 1);

  try {
    const examples = await collectExamples(BATCH);
    if (!examples.length) {
      logger.info("[AutoTrainer] sem exemplos novos (aguardando próximos sinais)");
      return { ok: true, sent: 0, waitedMs: POLL_MS };
    }

    const url = `${(process.env.MICRO_MODEL_URL || "").trim()}/train`;
    const payload = {
      epochs: EPOCHS,
      batchSize: Math.max(16, Math.min(1024, examples.length)),
      data: examples,
    };

    const resp = await httpPostJSON<{ ok?: boolean; trained?: number; msg?: string }>(url, payload, 60_000);

    for (const ex of examples) {
      const sid = Number(ex.meta?.signalId);
      if (Number.isFinite(sid)) _trainedSignals.add(sid);
    }
    _stats.sent += examples.length;
    _stats.batches += 1;

    logger.info("[AutoTrainer] train OK", { examples: examples.length, resp });
    return { ok: true, sent: examples.length, resp };
  } catch (e: any) {
    _lastError = e?.message || String(e);
    logger.warn("[AutoTrainer] exceção:", e?.stack || e?.message || e);
    return { ok: false, error: _lastError };
  }
}

export async function startAutoTrainer() {
  if (_running) {
    return { ok: true, running: true, note: "already running" };
  }
  if (!okURL()) {
    _running = false;
    return { ok: false, running: false, reason: "MICRO_MODEL_URL não configurada" };
  }

  const POLL_MS = ms(Number(process.env.AUTO_TRAINER_POLL_MS), 60_000);

  // primeira rodada imediata (não bloqueante)
  void onePass();

  _timer = setInterval(() => {
    void onePass();
  }, POLL_MS);
  _running = true;
  _lastError = null;
  logger.info("[AutoTrainer] loop iniciado", { pollMs: POLL_MS });
  return { ok: true, running: true };
}

export async function stopAutoTrainer() {
  if (_timer) clearInterval(_timer);
  _timer = null;
  _running = false;
  logger.info("[AutoTrainer] parado");
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
