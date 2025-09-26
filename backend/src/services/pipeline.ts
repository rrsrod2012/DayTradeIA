/* eslint-disable no-console */
import { DateTime } from "luxon";
import { prisma } from "../prisma";
import { loadCandlesAnyTF } from "../lib/aggregation";

/**
 * Pipeline para:
 *  - Consolidar sinais confirmados (EMA_CROSS) em Trades
 *  - Usado por reprocessamentos e pelo watcher pós-importação
 *
 * Exports: { bootPipeline, processImportedRange, reprocessSignal }
 */

// =========================
// Configurações (via .env)
// =========================
function numFromEnv(v: any, def: number) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

const CFG = {
  LOOKBACK: numFromEnv(process.env.AUTO_TRAINER_LOOKBACK, 120), // barras para trás (ATR/EMAs)
  HORIZON: numFromEnv(process.env.AUTO_TRAINER_HORIZON, 12), // barras à frente para procurar saída
  SL_ATR: numFromEnv(process.env.AUTO_TRAINER_SL_ATR, 1.0), // k do SL em ATRs
  RR: numFromEnv(process.env.AUTO_TRAINER_RR, 2.0), // TP = RR * ATR
  DEFAULT_QTY: 1,

  // Breakeven por pontos: quando MFE (a favor) atingir X pontos, mover SL para preço de entrada (+ offset)
  BE_AT_PTS: numFromEnv(process.env.AUTO_TRAINER_BE_AT_PTS, 0), // 0 = off
  BE_OFFSET_PTS: numFromEnv(process.env.AUTO_TRAINER_BE_OFFSET_PTS, 0),

  // Debug
  DEBUG: !!Number(process.env.AUTO_TRAINER_DEBUG || "0"),
};

const TF_MINUTES: Record<string, number> = { M1: 1, M5: 5, M15: 15, M30: 30, H1: 60 };
const ZONE_BR = "America/Sao_Paulo";

function tfToMinutes(tf: string | null): number {
  if (!tf) return 5;
  const u = tf.toUpperCase();
  return TF_MINUTES[u] ?? 5;
}

type Candle = { time: Date; open: number; high: number; low: number; close: number };

// =========================
// Indicadores
// =========================
function ema(values: number[], period: number) {
  const k = 2 / (period + 1);
  const out: (number | null)[] = [];
  let cur: number | null = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) {
      out.push(cur);
      continue;
    }
    cur = cur == null ? v : v * k + (cur as number) * (1 - k);
    out.push(cur);
  }
  return out;
}

function trueRange(curr: Candle, prevClose: number) {
  const a = Number(curr.high) - Number(curr.low);
  const b = Math.abs(Number(curr.high) - prevClose);
  const c = Math.abs(Number(curr.low) - prevClose);
  return Math.max(a, b, c);
}

function atr14(rows: Candle[]) {
  if (!rows.length) return [];
  const out: (number | null)[] = rows.map(() => null);
  let prevClose = Number(rows[0].close);
  for (let i = 1; i < rows.length; i++) {
    const tr = trueRange(rows[i], prevClose);
    const upto = Math.min(i, 14);
    let sum = 0;
    for (let k = 0; k < upto; k++) {
      const j = i - k;
      const trk = trueRange(rows[j], Number(rows[j - 1]?.close ?? rows[j].close));
      sum += trk;
    }
    out[i] = sum / upto;
    prevClose = Number(rows[i].close);
  }
  return out;
}

function crossedUp(
  aPrev: number | null,
  aNow: number | null,
  bPrev: number | null,
  bNow: number | null
) {
  return aPrev != null && bPrev != null && aNow != null && bNow != null && aPrev <= bPrev && aNow > bNow;
}
function crossedDown(
  aPrev: number | null,
  aNow: number | null,
  bPrev: number | null,
  bNow: number | null
) {
  return aPrev != null && bPrev != null && aNow != null && bNow != null && aPrev >= bPrev && aNow < bNow;
}

// =========================
// Janela via agregador (M1->TF)
// =========================
async function loadCandlesWindow(params: {
  instrumentId: number;
  timeframe: string | null;
  signalTime: Date; // candle do sinal (entry = próxima barra)
  lookback: number;
  horizon: number;
}) {
  const { instrumentId, timeframe, signalTime, lookback, horizon } = params;

  const inst = await prisma.instrument.findFirst({
    where: { id: instrumentId },
    select: { id: true, symbol: true },
  });
  if (!inst)
    return { win: [] as Candle[], candleIds: [] as (number | null)[], tf: (timeframe || "M5").toUpperCase(), symbol: "?" };

  const tf = (timeframe || "M5").toUpperCase();
  const tfMin = tfToMinutes(tf);

  const backMin = lookback * tfMin;
  const fwdMin = (horizon + 2) * tfMin; // +2 por segurança
  const t0 = DateTime.fromJSDate(signalTime).minus({ minutes: backMin });
  const t1 = DateTime.fromJSDate(signalTime).plus({ minutes: fwdMin });

  const rows = await loadCandlesAnyTF(inst.symbol, tf as any, {
    gte: t0.toJSDate(),
    lte: t1.toJSDate(),
    limit: null,
  });

  const times = rows.map((r) => r.time);
  const persisted = await prisma.candle.findMany({
    where: { instrumentId: inst.id, timeframe: tf, time: { in: times } },
    select: { id: true, time: true },
  });
  const byTime = new Map(persisted.map((c) => [c.time.getTime(), c.id]));
  const candleIds = rows.map((r) => byTime.get(r.time.getTime()) ?? null);

  const win: Candle[] = rows.map((r: any) => ({
    time: r.time instanceof Date ? r.time : new Date(r.time),
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
  }));

  return { win, candleIds, tf, symbol: inst.symbol };
}

// =========================
// Casamento robusto do índice do sinal
// =========================
function resolveSignalIndex(win: Candle[], signalTime: Date, tf: string) {
  if (!win.length) return -1;
  const tfMs = tfToMinutes(tf) * 60 * 1000;
  const target = signalTime.getTime();

  // 1) igualdade exata
  let idx = win.findIndex((c) => c.time.getTime() === target);
  if (idx >= 0) return idx;

  // 2) última barra <= signalTime
  let lastLE = -1;
  for (let i = 0; i < win.length; i++) {
    const t = win[i].time.getTime();
    if (t <= target) lastLE = i;
    else break;
  }
  if (lastLE >= 0) return lastLE;

  // 3) barra mais próxima dentro de 1×TF
  let best = -1,
    bestDiff = Number.POSITIVE_INFINITY;
  for (let i = 0; i < win.length; i++) {
    const d = Math.abs(win[i].time.getTime() - target);
    if (d < bestDiff) {
      best = i;
      bestDiff = d;
    }
  }
  if (best >= 0 && bestDiff <= tfMs) return best;

  return -1;
}

// =========================
// Consolidação: Sinal confirmado -> Trade
// =========================
async function consolidateSignalToTrade(signalId: number) {
  const sig = await prisma.signal.findFirst({
    where: { id: signalId },
    select: {
      id: true,
      signalType: true,
      side: true,
      candleId: true,
      candle: { select: { instrumentId: true, timeframe: true, time: true } },
    },
  });
  if (!sig || !sig.candle) return;

  const { instrumentId, timeframe, time: signalTime } = sig.candle;
  const side = (sig.side || "BUY") as "BUY" | "SELL";
  const isBuy = side === "BUY";

  const { win, candleIds, tf, symbol } = await loadCandlesWindow({
    instrumentId,
    timeframe: (timeframe || "M5").toUpperCase(),
    signalTime,
    lookback: CFG.LOOKBACK,
    horizon: CFG.HORIZON,
  });
  if (!win.length) return;

  const iSignal = resolveSignalIndex(win, signalTime, tf);
  if (iSignal < 0) return;

  const iEntry = Math.min(win.length - 1, iSignal + 1);
  const entryBar = win[iEntry];
  const entryPrice = Number(entryBar.open);

  const atrSeries = atr14(win);
  const closes = win.map((c) => Number(c.close));
  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);

  const atr = Number(atrSeries[iEntry] ?? atrSeries[Math.max(0, iEntry - 1)] ?? 0);
  const slPts = atr > 0 ? atr * CFG.SL_ATR : 0;
  const tpPts = atr > 0 ? atr * CFG.RR : 0;

  const slInit = slPts > 0 ? (isBuy ? entryPrice - slPts : entryPrice + slPts) : null;
  const tpLevel = tpPts > 0 ? (isBuy ? entryPrice + tpPts : entryPrice - tpPts) : null;

  let dynSL: number | null = slInit;
  let movedToBE = false;

  let exitPrice: number | null = null;
  let outcome: "TP" | "SL" | "REVERSAL" | "NONE" = "NONE";
  let iExit: number | null = null;

  if (CFG.DEBUG) {
    console.log(
      `[DBG] symbol=${symbol} tf=${tf} signal=${signalTime.toISOString()} iSignal=${iSignal} iEntry=${iEntry}`
    );
    console.log(
      `[DBG] entry=${entryPrice} SLinit=${slInit ?? "-"} TP=${tpLevel ?? "-"} BE_AT=${CFG.BE_AT_PTS} BE_OFF=${CFG.BE_OFFSET_PTS
      }`
    );
  }

  for (let k = iEntry; k < Math.min(win.length, iEntry + CFG.HORIZON + 1); k++) {
    const bar = win[k];
    const high = Number(bar.high);
    const low = Number(bar.low);

    // 1) BE por pontos (usa MFE intrabar)
    if (!movedToBE && CFG.BE_AT_PTS > 0) {
      const mfePts = isBuy ? high - entryPrice : entryPrice - low;
      if (mfePts >= CFG.BE_AT_PTS) {
        const bePx = isBuy ? entryPrice + CFG.BE_OFFSET_PTS : entryPrice - CFG.BE_OFFSET_PTS;
        dynSL = dynSL == null ? bePx : isBuy ? Math.max(dynSL, bePx) : Math.min(dynSL, bePx);
        movedToBE = true;
        if (CFG.DEBUG) console.log(`[DBG] k=${k} MOVE->BE dynSL=${dynSL} (mfe=${mfePts.toFixed(1)})`);
      }
    }

    // Prioridade: SL/BE
    if (dynSL != null) {
      if (isBuy && low <= dynSL) {
        exitPrice = dynSL;
        outcome = "SL";
        iExit = k;
        if (CFG.DEBUG) console.log(`[DBG] k=${k} HIT SL/BE at ${dynSL}`);
        break;
      }
      if (!isBuy && high >= dynSL) {
        exitPrice = dynSL;
        outcome = "SL";
        iExit = k;
        if (CFG.DEBUG) console.log(`[DBG] k=${k} HIT SL/BE at ${dynSL}`);
        break;
      }
    }

    // TP
    if (tpLevel != null) {
      if (isBuy && high >= tpLevel) {
        exitPrice = tpLevel;
        outcome = "TP";
        iExit = k;
        if (CFG.DEBUG) console.log(`[DBG] k=${k} HIT TP at ${tpLevel}`);
        break;
      }
      if (!isBuy && low <= tpLevel) {
        exitPrice = tpLevel;
        outcome = "TP";
        iExit = k;
        if (CFG.DEBUG) console.log(`[DBG] k=${k} HIT TP at ${tpLevel}`);
        break;
      }
    }

    // Reversão por EMA
    const e9Prev = ema9[k - 1] ?? null;
    const e21Prev = ema21[k - 1] ?? null;
    const e9Now = ema9[k] ?? null;
    const e21Now = ema21[k] ?? null;
    const revUp = crossedUp(e9Prev, e9Now, e21Prev, e21Now);
    const revDown = crossedDown(e9Prev, e9Now, e21Prev, e21Now);
    const reversalAgainst = (isBuy && revDown) || (!isBuy && revUp);
    if (reversalAgainst) {
      exitPrice = Number(bar.close);
      outcome = "REVERSAL";
      iExit = k;
      if (CFG.DEBUG) console.log(`[DBG] k=${k} REVERSAL close=${exitPrice}`);
      break;
    }

    if (CFG.DEBUG) {
      const tStr = DateTime.fromJSDate(bar.time).setZone(ZONE_BR).toFormat("HH:mm:ss");
      const mfePts = isBuy ? high - entryPrice : entryPrice - low;
      console.log(`[DBG] k=${k} ${tStr} H=${high} L=${low} dynSL=${dynSL ?? "-"} mfe=${mfePts.toFixed(1)}`);
    }
  }

  const pnlPoints = exitPrice != null ? (isBuy ? exitPrice - entryPrice : entryPrice - exitPrice) : null;

  let exitSignalId: number | null = null;
  if (iExit != null) {
    const exitCandle = await prisma.candle.findFirst({
      where: { instrumentId, timeframe: tf, time: win[iExit].time },
      select: { id: true },
    });
    const exitType =
      outcome === "TP" ? "EXIT_TP" : outcome === "SL" ? "EXIT_SL" : outcome === "REVERSAL" ? "EXIT_REV" : "EXIT_NONE";

    if (exitCandle?.id) {
      const existingExit = await prisma.signal.findFirst({
        where: { candleId: exitCandle.id, signalType: exitType },
        select: { id: true },
      });
      if (existingExit) exitSignalId = existingExit.id;
      else {
        const created = await prisma.signal.create({
          data: {
            candleId: exitCandle.id,
            signalType: exitType,
            side,
            score: 1.0,
            reason: outcome,
          },
          select: { id: true },
        });
        exitSignalId = created?.id ?? null;
      }
    }
  }

  await upsertTrade(sig, {
    instrumentId,
    timeframe: tf,
    qty: CFG.DEFAULT_QTY,
    entryPrice,
    exitPrice,
    pnlPoints,
    exitSignalId,
  });

  if (CFG.DEBUG) {
    const entStr = DateTime.fromJSDate(win[iEntry].time).setZone(ZONE_BR).toFormat("HH:mm:ss");
    const exStr =
      iExit != null ? DateTime.fromJSDate(win[iExit].time).setZone(ZONE_BR).toFormat("HH:mm:ss") : "-";
    console.log(`[DBG] DONE entry@${entStr} exit@${exStr} outcome=${outcome} pnlPts=${pnlPoints ?? "-"}`);
  }
}

async function upsertTrade(
  signal: { id: number },
  trade: {
    instrumentId: number;
    timeframe: string;
    qty: number;
    entryPrice: number;
    exitPrice: number | null;
    pnlPoints: number | null;
    exitSignalId: number | null;
  }
) {
  const existing = await prisma.trade.findFirst({
    where: { entrySignalId: signal.id },
    select: { id: true },
  });

  if (existing) {
    await prisma.trade.update({
      where: { id: existing.id },
      data: {
        instrumentId: trade.instrumentId,
        timeframe: trade.timeframe,
        qty: trade.qty,
        entryPrice: trade.entryPrice,
        exitPrice: trade.exitPrice,
        pnlPoints: trade.pnlPoints,
        exitSignalId: trade.exitSignalId,
      },
    });
  } else {
    await prisma.trade.create({
      data: {
        instrumentId: trade.instrumentId,
        timeframe: trade.timeframe,
        qty: trade.qty,
        entryPrice: trade.entryPrice,
        exitPrice: trade.exitPrice,
        pnlPoints: trade.pnlPoints,
        entrySignalId: signal.id,
        exitSignalId: trade.exitSignalId,
      },
    });
  }
}

// =========================
// Util: parsing de datas
// =========================
function parseUserDate(raw: any): { ok: boolean; dt: DateTime; isDateOnly: boolean } {
  if (raw == null) return { ok: false, dt: DateTime.invalid("empty"), isDateOnly: false };
  if (raw instanceof Date) {
    const dt = DateTime.fromJSDate(raw, { zone: ZONE_BR });
    return { ok: dt.isValid, dt, isDateOnly: false };
  }
  const s = String(raw).trim();
  if (!s) return { ok: false, dt: DateTime.invalid("empty"), isDateOnly: false };

  // BR: dd/MM/yyyy [HH:mm[:ss]]
  const brFull = /^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;
  const m = brFull.exec(s);
  if (m) {
    const fmt = m[4] ? (m[6] ? "dd/LL/yyyy HH:mm:ss" : "dd/LL/yyyy HH:mm") : "dd/LL/yyyy";
    const dt = DateTime.fromFormat(s, fmt, { zone: ZONE_BR });
    return { ok: dt.isValid, dt, isDateOnly: !m[4] };
  }

  // ISO (yyyy-MM-dd[THH:mm[:ss[.SSS]]][Z])
  const dtISO = DateTime.fromISO(s, { zone: ZONE_BR });
  if (dtISO.isValid) {
    const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(s);
    return { ok: true, dt: dtISO, isDateOnly };
  }

  // Epoch ms?
  if (/^\d{10,13}$/.test(s)) {
    const n = Number(s);
    const dt = Number.isFinite(n) ? DateTime.fromMillis(n, { zone: ZONE_BR }) : DateTime.invalid("nan");
    return { ok: dt.isValid, dt, isDateOnly: false };
  }

  return { ok: false, dt: DateTime.invalid("unparsed"), isDateOnly: false };
}

function normalizeRange(
  fromRaw?: any,
  toRaw?: any,
  fallbackDays = 1
): { fromUTC?: Date; toUTC?: Date } {
  const pF = parseUserDate(fromRaw);
  const pT = parseUserDate(toRaw);

  // nada válido => usa [now - fallbackDays, endOfDay]
  if (!pF.ok && !pT.ok) {
    const now = DateTime.now().setZone(ZONE_BR);
    const f = now.minus({ days: Math.max(1, fallbackDays) }).startOf("day").toUTC().toJSDate();
    const t = now.endOf("day").toUTC().toJSDate();
    return { fromUTC: f, toUTC: t };
  }

  let fromLocal: DateTime;
  let toLocal: DateTime;

  if (pF.ok && pT.ok) {
    const sameDay = pF.dt.toFormat("yyyy-LL-dd") === pT.dt.toFormat("yyyy-LL-dd");
    if (pF.isDateOnly || pT.isDateOnly || sameDay) {
      const base = pF.dt;
      fromLocal = base.startOf("day");
      toLocal = pT.dt.endOf("day");
    } else {
      fromLocal = pF.dt;
      toLocal = pT.dt;
    }
  } else if (pF.ok && !pT.ok) {
    fromLocal = pF.isDateOnly ? pF.dt.startOf("day") : pF.dt;
    toLocal = pF.isDateOnly ? pF.dt.endOf("day") : pF.dt.endOf("day");
  } else {
    toLocal = pT.isDateOnly ? pT.dt.endOf("day") : pT.dt;
    fromLocal = pT.isDateOnly ? pT.dt.startOf("day") : pT.dt.startOf("day");
  }

  if (toLocal < fromLocal) {
    const tmp = fromLocal;
    fromLocal = toLocal.startOf("day");
    toLocal = tmp.endOf("day");
  }

  return { fromUTC: fromLocal.toUTC().toJSDate(), toUTC: toLocal.toUTC().toJSDate() };
}

// =========================
// Entrada pública
// =========================

/**
 * Reprocessa sinais confirmados (EMA_CROSS) em trades, em uma janela.
 *
 * Parâmetros aceitos (compatível com chamadas existentes):
 * - instrumentId?: number
 * - symbol?: string
 * - timeframe?: string | null | undefined   (ex.: "M1", "M5"; "*" ou omitido = todos)
 * - day?: Date | string                     (reprocessa o DIA inteiro)
 * - from?: Date | string                    (início da janela)
 * - to?: Date | string                      (fim da janela)
 * - days?: number                           (janela relativa: últimos N dias)
 */
export async function processImportedRange(opts: {
  instrumentId?: number;
  symbol?: string;
  timeframe?: string | null | undefined;
  day?: Date | string;
  from?: Date | string;
  to?: Date | string;
  days?: number;
}) {
  const { instrumentId, symbol } = opts;

  // Resolve instrumento
  let instId = instrumentId ?? null;
  if (!instId && symbol) {
    const inst = await prisma.instrument.findFirst({
      where: { symbol: String(symbol).trim() },
      select: { id: true },
    });
    instId = inst?.id ?? null;
  }
  if (!instId) return;

  // Resolve janela de tempo (UTC) com tolerância
  let fromUTC: Date | undefined;
  let toUTC: Date | undefined;

  if (opts.day != null) {
    // Dia inteiro
    const p = parseUserDate(opts.day);
    if (p.ok) {
      fromUTC = p.dt.startOf("day").toUTC().toJSDate();
      toUTC = p.dt.endOf("day").toUTC().toJSDate();
    }
  } else if (opts.from != null || opts.to != null) {
    const r = normalizeRange(opts.from, opts.to);
    fromUTC = r.fromUTC;
    toUTC = r.toUTC;
  } else if (opts.days != null) {
    const days = Math.max(1, Number(opts.days) || 1);
    const now = DateTime.now().setZone(ZONE_BR);
    fromUTC = now.minus({ days }).startOf("day").toUTC().toJSDate();
    toUTC = now.endOf("day").toUTC().toJSDate();
  } else {
    // fallback: 1 dia
    const r = normalizeRange(undefined, undefined, 1);
    fromUTC = r.fromUTC;
    toUTC = r.toUTC;
  }

  // TF
  const tfRaw = (opts.timeframe ?? "").toString().trim().toUpperCase();
  const allTF = !tfRaw || tfRaw === "*";

  // Monta where do candle com filtros válidos apenas
  const candleWhere: any = { instrumentId: instId };
  if (fromUTC || toUTC) {
    const timeClause: any = {};
    if (fromUTC instanceof Date && !isNaN(fromUTC.getTime())) timeClause.gte = fromUTC;
    if (toUTC instanceof Date && !isNaN(toUTC.getTime())) timeClause.lte = toUTC;
    if (Object.keys(timeClause).length) candleWhere.time = timeClause;
  }
  if (!allTF) candleWhere.timeframe = tfRaw;

  // Busca sinais confirmados no intervalo
  const signals = await prisma.signal.findMany({
    where: { signalType: "EMA_CROSS", candle: candleWhere },
    select: { id: true },
    orderBy: { id: "asc" },
  });

  if (CFG.DEBUG) {
    console.log(
      JSON.stringify({
        msg: "[pipeline] processImportedRange",
        instId,
        tf: allTF ? "*" : tfRaw,
        fromUTC,
        toUTC,
        countSignals: signals.length,
      })
    );
  }

  for (const s of signals) {
    try {
      await consolidateSignalToTrade(s.id);
    } catch (e) {
      console.error("consolidateSignalToTrade error", e);
    }
  }
}

/** Reprocessa um único sinal especificado (debug pontual). */
export async function reprocessSignal(signalId: number) {
  try {
    await consolidateSignalToTrade(signalId);
  } catch (e) {
    console.error("reprocessSignal error", e);
  }
}

export async function bootPipeline() {
  // no-op
}
