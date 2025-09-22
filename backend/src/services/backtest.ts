/* eslint-disable no-console */
import express from "express";
import { DateTime } from "luxon";
import { loadCandlesAnyTF } from "../lib/aggregation";

export const router = express.Router();

type TF = "M1" | "M5" | "M15" | "M30" | "H1";
const TF_MIN: Record<TF, number> = { M1: 1, M5: 5, M15: 15, M30: 30, H1: 60 };
const ZONE = "America/Sao_Paulo";

// BUMP
const VERSION = "backtest:v5.2.1-ATR+VWAP+BB+PATTERNS+BE/SLTP+runs+details+aliases+CORS";

/* ===== Helpers genéricos ===== */
function toBool(v: any): boolean {
  if (v === true) return true;
  if (v === false) return false;
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return false;
  return s === "1" || s === "true" || s === "yes" || s === "on";
}
function toNum(v: any, def = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/* ===== Helpers de timeframe/bucket ===== */
function normalizeTf(tfRaw: string): { tfU: TF; tfMin: number } {
  const s = String(tfRaw || "M5").trim().toUpperCase();
  if (s === "M1" || s === "M5" || s === "M15" || s === "M30" || s === "H1") {
    return { tfU: s as TF, tfMin: TF_MIN[s as TF] };
  }
  if (/^\d+$/.test(s)) return { tfU: "M5", tfMin: TF_MIN.M5 };
  return { tfU: "M5", tfMin: TF_MIN.M5 };
}

/* ===== Parsing datas ===== */
function parseUserDate(raw: any): { ok: boolean; dt: DateTime; isDateOnly: boolean } {
  if (raw == null) return { ok: false, dt: DateTime.invalid("empty"), isDateOnly: false };
  let s = String(raw).trim();
  if (!s) return { ok: false, dt: DateTime.invalid("empty"), isDateOnly: false };

  const reBR = /^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2})(?::(\d{2})(?::(\d{2}))?)?)?$/;
  const m = reBR.exec(s);
  if (m) {
    const fmt = m[4] ? (m[6] ? "dd/LL/yyyy HH:mm:ss" : "dd/LL/yyyy HH:mm") : "dd/LL/yyyy";
    const dt = DateTime.fromFormat(s, fmt, { zone: ZONE });
    return { ok: dt.isValid, dt, isDateOnly: !m[4] };
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const dt = DateTime.fromISO(s, { zone: ZONE });
    return { ok: dt.isValid, dt, isDateOnly: true };
  }

  if (/^\d{4}-\d{2}-\d{2}t/i.test(s)) {
    s = s.replace(/([+-]\d{2}:?\d{2}|Z)$/i, "");
    const dt = DateTime.fromISO(s, { zone: ZONE });
    return { ok: dt.isValid, dt, isDateOnly: false };
  }

  return { ok: false, dt: DateTime.invalid("fmt"), isDateOnly: false };
}
function normRange(fromRaw: any, toRaw: any) {
  const a = parseUserDate(fromRaw);
  const b = parseUserDate(toRaw);
  if (!a.ok && !b.ok) return null;
  if (a.ok && a.isDateOnly && b.ok && b.isDateOnly) {
    return { fromLocal: a.dt.startOf("day"), toLocal: b.dt.endOf("day") };
  }
  const fromLocal = a.ok ? a.dt : (b.ok ? b.dt.minus({ days: 1 }) : DateTime.now().setZone(ZONE).minus({ days: 1 }));
  const toLocal = b.ok ? b.dt : (a.ok ? a.dt.plus({ days: 1 }) : DateTime.now().setZone(ZONE));
  return { fromLocal, toLocal };
}
function floorTo(d: Date, tfMin: number) {
  const t = DateTime.fromJSDate(d).setZone("UTC");
  const m = Math.floor(t.minute / tfMin) * tfMin;
  return t.set({ second: 0, millisecond: 0, minute: m }).toJSDate();
}
function ceilToExclusive(d: Date, tfMin: number) {
  const t = DateTime.fromJSDate(d).setZone("UTC");
  const m = Math.ceil((t.minute + 0.0001) / tfMin) * tfMin;
  return t.set({ second: 0, millisecond: 0, minute: m }).toJSDate();
}

/* ===== Indicadores ===== */
function EMA(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  const k = 2 / (period + 1);
  let e: number | null = null;
  for (let i = 0; i < values.length; i++) {
    const v = Number(values[i]) || 0;
    e = e == null ? v : (v * k + (e as number) * (1 - k));
    out.push(e);
  }
  return out;
}
function ATR(candles: { high: number; low: number; close: number }[], period = 14): (number | null)[] {
  const trs: number[] = [];
  let prevClose = candles?.[0]?.close ?? 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
    trs.push(tr);
    prevClose = c.close;
  }
  const out: (number | null)[] = candles.map(() => null);
  for (let i = 1; i < candles.length; i++) {
    const upto = Math.min(i, trs.length);
    const win = Math.min(period, upto);
    if (win <= 0) { out[i] = null; continue; }
    let sum = 0;
    for (let k = 0; k < win; k++) sum += trs[upto - 1 - k];
    out[i] = sum / win;
  }
  return out;
}
function SMA(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = values.map(() => null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}
function STDEV(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = values.map(() => null);
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) continue;
    let s = 0, s2 = 0;
    for (let k = 0; k < period; k++) {
      const v = values[i - k];
      s += v;
      s2 += v * v;
    }
    const mean = s / period;
    const varv = Math.max(0, s2 / period - mean * mean);
    out[i] = Math.sqrt(varv);
  }
  return out;
}
function VWAP(
  candles: { time: Date; high: number; low: number; close: number; volume?: number }[],
  zone = ZONE
): (number | null)[] {
  const out: (number | null)[] = candles.map(() => null);
  let curDay = DateTime.fromJSDate(candles[0].time).setZone(zone).toISODate();
  let cumPV = 0;
  let cumVol = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const day = DateTime.fromJSDate(c.time).setZone(zone).toISODate();
    if (day !== curDay) { curDay = day; cumPV = 0; cumVol = 0; }
    const tp = (Number(c.high) + Number(c.low) + Number(c.close)) / 3;
    const vol = Number((c as any).volume ?? 1) || 1;
    cumPV += tp * vol;
    cumVol += vol;
    out[i] = cumVol > 0 ? cumPV / cumVol : tp;
  }
  return out;
}

/* ===== Padrões ===== */
type C = { open: number; high: number; low: number; close: number };
const body = (c: C) => Math.abs(c.close - c.open);
const upper = (c: C) => c.high - Math.max(c.open, c.close);
const lower = (c: C) => Math.min(c.open, c.close) - c.low;

function isBullishEngulf(prev: C, cur: C) {
  return prev.close < prev.open && cur.close > cur.open &&
    cur.open <= prev.close && cur.close >= prev.open;
}
function isBearishEngulf(prev: C, cur: C) {
  return prev.close > prev.open && cur.close < cur.open &&
    cur.open >= prev.close && cur.close <= prev.open;
}
function isHammer(c: C) {
  const b = body(c);
  const l = lower(c);
  const u = upper(c);
  return l >= 2 * b && u <= b;
}
function isShootingStar(c: C) {
  const b = body(c);
  const l = lower(c);
  const u = upper(c);
  return u >= 2 * b && l <= b;
}
function isDoji(c: C) {
  const range = c.high - c.low;
  if (range <= 0) return false;
  return body(c) <= 0.1 * range;
}
function parsePatternsList(s: any): Set<string> {
  const raw = String(s ?? "").toLowerCase();
  if (!raw.trim()) return new Set();
  return new Set(raw.split(/[,\s;|]+/).map(t => t.trim()).filter(Boolean));
}

/* -------- infra -------- */
function ok(data: any) { return { ok: true, ...data }; }
function bad(msg: string, extra?: any) { return { ok: false, error: msg, ...extra ? { extra } : {} }; }
function log(...args: any[]) { console.log(...args); }

log(`[BACKTEST] Loaded ${VERSION}`);

/* ===== CORS / OPTIONS (evita 404 no preflight) ===== */
router.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method.toUpperCase() === "OPTIONS") return res.status(204).end();
  next();
});

/* ===== Mount base debug ===== */
let announcedMount = false;
router.use((req, _res, next) => {
  if (!announcedMount) {
    console.log("[BACKTEST] mount base =", req.baseUrl || "/");
    announcedMount = true;
  }
  next();
});

/* ========= runs in-memory ========= */
const runStore = new Map<string, any>();
type RunIndex = {
  id: string; ts: string; symbol: string; timeframe: string; from: string; to: string;
  trades: number; pnlPoints: number; winRate: number;
};
const RUNS_MAX = 200;
const recentRunsIdx: RunIndex[] = [];
const makeRunId = () => `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
function pushRunIndex(idx: RunIndex) {
  recentRunsIdx.push(idx);
  if (recentRunsIdx.length > RUNS_MAX) recentRunsIdx.splice(0, recentRunsIdx.length - RUNS_MAX);
}

/* ===== Helpers dual (GET/POST) ===== */
function dualGet(path: string | string[], h: any) { router.get(path as any, h); }
function dualAll(path: string | string[], h: any) { router.get(path as any, h); router.post(path as any, h); }

/* -------- util: echo -------- */
dualAll(["/debug/echo", "/backtest/debug/echo"], (req: any, res: any) => {
  const method = req.method.toUpperCase();
  const payload = method === "GET" ? req.query : req.body;
  return res.status(200).json({
    ok: true, version: VERSION, method,
    headers: { "content-type": req.headers["content-type"] || null, accept: req.headers["accept"] || null },
    payload,
  });
});

/* -------- versão/health -------- */
dualGet(["/version", "/backtest/version"], async (_req: any, res: any) => {
  return res.status(200).json(ok({ service: "backtest", version: VERSION, now: new Date().toISOString() }));
});
dualGet(["/health", "/backtest/health"], async (req: any, res: any) => {
  try {
    const { symbol, timeframe, from, to } = req.query as any;
    const sym = String(symbol || "").toUpperCase().trim();
    if (!sym) return res.status(200).json(bad("Faltou 'symbol'"));

    const { tfU, tfMin } = normalizeTf(String(timeframe || "M5"));

    const fallbackDays = toNum(process.env.BACKTEST_DEFAULT_DAYS, 1);
    let fromD: Date, toD: Date;

    const norm = normRange(from, to);
    if (norm) {
      fromD = floorTo(norm.fromLocal.toUTC().toJSDate(), tfMin);
      toD = ceilToExclusive(norm.toLocal.toUTC().toJSDate(), tfMin);
    } else {
      const tnowLocal = DateTime.now().setZone(ZONE);
      const f = tnowLocal.minus({ days: fallbackDays }).startOf("day").toUTC();
      const t = tnowLocal.endOf("day").toUTC();
      fromD = floorTo(f.toJSDate(), tfMin);
      toD = ceilToExclusive(t.toJSDate(), tfMin);
    }

    const candles = await loadCandlesAnyTF(sym, tfU, { gte: fromD, lte: toD } as any);
    return res.status(200).json(
      candles.length
        ? ok({ symbol: sym, timeframe: tfU, candles: candles.length })
        : bad("sem candles no período/símbolo/TF")
    );
  } catch (e: any) {
    return res.status(200).json(bad("unexpected", { message: e?.message || String(e) }));
  }
});

/* -------- runs -------- */
dualGet(["/runs", "/backtest/runs"], (req: any, res: any) => {
  const limit = Math.max(1, Math.min(1000, toNum(req.query?.limit, 100)));
  const sym = String(req.query?.symbol ?? "").trim().toUpperCase();
  const tf = String(req.query?.timeframe ?? "").trim().toUpperCase();

  let items = recentRunsIdx.slice().reverse();
  if (sym) items = items.filter(r => r.symbol === sym);
  if (tf) items = items.filter(r => r.timeframe === tf);

  return res.status(200).json(ok({ count: items.length, items: items.slice(0, limit) }));
});
dualGet(["/run/:id", "/backtest/run/:id"], (req: any, res: any) => {
  const id = String(req.params?.id || "");
  const run = runStore.get(id);
  if (!run) return res.status(200).json(bad("Execução não encontrada"));
  return res.status(200).json(ok({ run }));
});

/* -------- backtest (principal) -------- */
dualAll(["/", "/backtest"], async (req: any, res: any) => {
  const method = req.method.toUpperCase();
  try {
    const body = method === "GET" ? (req.query || {}) : (req.body || {});
    const {
      symbol, timeframe, from, to,

      // custos
      pointValue = 1, costPts = 2, slippagePts = 1,

      // controles diários
      lossCap = 0, maxConsecLosses = 0,

      // ======= POLÍTICA DE SAÍDA =======
      rr = 2,
      kSL = 1.2,
      kTrail = 0,
      breakEvenAtR = 1.0,
      beOffsetR = 0.0,

      // NOVO: BE / SLTP por pontos
      breakEvenAtPts = null,
      beOffsetPts = null,
      slPoints = 0,
      tpPoints = 0,
      tpViaRR = true,

      timeStopBars = 0,
      horizonBars = 0,

      // === GATES ===
      vwapFilter = false,
      bbEnabled = false,
      bbPeriod = 20,
      bbK = 2.0,
      candlePatterns = "",
      evalWindow = 200,
      regime, tod, conformal,
      minProb, minEV, useMicroModel,
    } = body as any;

    const sym = String(symbol || "").toUpperCase().trim();
    if (!sym) return res.status(200).json(bad("Faltou 'symbol' (ex.: WIN, WDO)"));

    const { tfU, tfMin } = normalizeTf(String(timeframe || "M5"));
    const bePts = toNum(breakEvenAtPts ?? process.env.BACKTEST_BE_AT_PTS, 0);
    const beOffPts = toNum(beOffsetPts ?? process.env.BACKTEST_BE_OFFSET_PTS, 0);
    const slPtsIn = Math.max(0, toNum(slPoints, 0));
    const tpPtsIn = Math.max(0, toNum(tpPoints, 0));
    const tpViaRRBool = toBool(tpViaRR);
    const vwapFilterBool = toBool(vwapFilter);
    const bbEnabledBool = toBool(bbEnabled);
    const bbPeriodNum = Math.max(2, toNum(bbPeriod, 20));
    const bbKNum = Math.max(0, toNum(bbK, 2));

    // Datas
    const fallbackDays = toNum(process.env.BACKTEST_DEFAULT_DAYS, 1);
    let fromD: Date, toD: Date;
    const norm = normRange(from, to);
    if (norm) {
      fromD = floorTo(norm.fromLocal.toUTC().toJSDate(), tfMin);
      toD = ceilToExclusive(norm.toLocal.toUTC().toJSDate(), tfMin);
    } else {
      const tnowLocal = DateTime.now().setZone(ZONE);
      const f = tnowLocal.minus({ days: fallbackDays }).startOf("day").toUTC();
      const t = tnowLocal.endOf("day").toUTC();
      fromD = floorTo(f.toJSDate(), tfMin);
      toD = ceilToExclusive(t.toJSDate(), tfMin);
    }
    if (fromD >= toD) return res.status(200).json(bad("'from' deve ser anterior a 'to'", { from: fromD, to: toD }));

    // Warm-up
    const WARMUP_MULT = 30;
    const warmupMin = Math.max(150, WARMUP_MULT * tfMin);
    const fromWarm = new Date(fromD.getTime() - warmupMin * 60_000);

    let candles: { time: Date; open: number; high: number; low: number; close: number; volume?: number }[];
    try {
      candles = await loadCandlesAnyTF(sym, tfU, { gte: fromWarm, lte: toD } as any);
    } catch (e: any) {
      return res.status(200).json(bad("erro ao carregar candles", { message: e?.message || String(e) }));
    }

    if (!candles?.length) {
      const runId = makeRunId();
      const ts = new Date().toISOString();
      const summary = { trades: 0, wins: 0, losses: 0, ties: 0, winRate: 0, pnlPoints: 0, avgPnL: 0, profitFactor: 0, maxDrawdown: 0 };

      const policy = {
        rr: toNum(rr, 2), kSL: toNum(kSL, 1.2), kTrail: toNum(kTrail, 0),
        breakEvenAtR: toNum(breakEvenAtR, 1), beOffsetR: toNum(beOffsetR, 0),
        breakEvenAtPts: bePts, beOffsetPts: beOffPts,
        timeStopBars: toNum(timeStopBars || horizonBars, 0),
        slPointsApplied: slPtsIn, tpPointsApplied: tpPtsIn, tpViaRRApplied: tpViaRRBool,
      };
      const config = {
        vwapFilter: vwapFilterBool, bbEnabled: bbEnabledBool, bbPeriod: bbPeriodNum, bbK: bbKNum,
        candlePatterns, minProb, minEV, useMicroModel, evalWindow, regime, tod, conformal
      };

      const snap = {
        id: runId, ts, ok: true, version: VERSION,
        symbol: sym, timeframe: tfU, from: fromD.toISOString(), to: toD.toISOString(),
        candles: 0, trades: [], summary,
        pnlPoints: 0, pnlMoney: 0,
        lossCapApplied: toNum(lossCap, 0), maxConsecLossesApplied: toNum(maxConsecLosses, 0),
        policy, config, info: "sem candles no período informado (verifique ingestão/DB/símbolo/TF)",
      };

      runStore.set(runId, snap);
      pushRunIndex({
        id: runId, ts, symbol: sym, timeframe: tfU, from: snap.from, to: snap.to,
        trades: summary.trades, pnlPoints: summary.pnlPoints, winRate: summary.winRate
      });

      return res.status(200).json(ok(snap));
    }

    // Indicadores
    const closes = candles.map(c => Number.isFinite(c.close) ? Number(c.close) : Number(c.open) || 0);
    const e9 = EMA(closes, 9);
    const e21 = EMA(closes, 21);
    const atr = ATR(candles, 14);
    const vwap = vwapFilterBool ? VWAP(candles) : candles.map(() => null);
    const bbMid = bbEnabledBool ? SMA(closes, bbPeriodNum) : candles.map(() => null);
    const bbStd = bbEnabledBool ? STDEV(closes, bbPeriodNum) : candles.map(() => null);
    const bbUp = bbEnabledBool ? bbMid.map((m, i) => (m == null || bbStd[i] == null ? null : (m as number) + bbKNum * (bbStd[i] as number))) : candles.map(() => null);
    const bbLo = bbEnabledBool ? bbMid.map((m, i) => (m == null || bbStd[i] == null ? null : (m as number) - bbKNum * (bbStd[i] as number))) : candles.map(() => null);

    const patternsSet = parsePatternsList(candlePatterns);
    const wantBull = (i: number) => {
      if (patternsSet.size === 0) return true;
      const cur: C = candles[i] as any; const prev: C = (candles[i - 1] ?? cur) as any;
      return (
        (patternsSet.has("engulfing") && isBullishEngulf(prev, cur)) ||
        (patternsSet.has("hammer") && (isHammer(cur) || isHammer(prev))) ||
        (patternsSet.has("doji") && (isDoji(cur) || isDoji(prev)))
      );
    };
    const wantBear = (i: number) => {
      if (patternsSet.size === 0) return true;
      const cur: C = candles[i] as any; const prev: C = (candles[i - 1] ?? cur) as any;
      return (
        (patternsSet.has("engulfing") && isBearishEngulf(prev, cur)) ||
        (patternsSet.has("star") && (isShootingStar(cur) || isShootingStar(prev))) ||
        (patternsSet.has("doji") && (isDoji(cur) || isDoji(prev)))
      );
    };

    // === Rótulo do setup para aparecer na nota ===
    const setupLabel =
      `EMA9xEMA21` +
      (vwapFilterBool ? " + VWAP" : "") +
      (bbEnabledBool ? ` + BB(${bbPeriodNum},${bbKNum})` : "") +
      (patternsSet.size ? ` + PAT(${[...patternsSet].join("+")})` : "");

    function reasonText(code?: string | null) {
      switch ((code || "").toLowerCase()) {
        case "tp": return `TP · ${setupLabel}`;
        case "sl": return `SL · ${setupLabel}`;
        case "be/stop": return `BE · ${setupLabel}`;
        case "reverse-cross": return `Reverse EMA9x21`;
        case "time-stop": return `Time Stop · ${setupLabel}`;
        case "end": return `Forced Close · ${setupLabel}`;
        default: return code || setupLabel;
      }
    }

    type Trade = {
      entryIdx: number; exitIdx: number; side: "BUY" | "SELL";
      entryTime: string; exitTime: string; entryPrice: number; exitPrice: number;
      pnl: number; note?: string; reason?: string; movedToBE?: boolean; trailEvents?: number;
    };

    const trades: Trade[] = [];
    let pos: null | {
      side: "BUY" | "SELL"; entryIdx: number; entryPrice: number; riskPts: number;
      stop: number; take: number; movedToBE: boolean; trailEvents: number;
    } = null;

    function crossUpAt(i: number): boolean {
      const aPrev = (e9[i - 1] ?? closes[i - 1]);
      const aNow = (e9[i] ?? closes[i]);
      const bPrev = (e21[i - 1] ?? closes[i - 1]);
      const bNow = (e21[i] ?? closes[i]);
      return aPrev <= bPrev && aNow > bNow;
    }
    function crossDownAt(i: number): boolean {
      const aPrev = (e9[i - 1] ?? closes[i - 1]);
      const aNow = (e9[i] ?? closes[i]);
      const bPrev = (e21[i - 1] ?? closes[i - 1]);
      const bNow = (e21[i] ?? closes[i]);
      return aPrev >= bPrev && aNow < bNow;
    }

    function closeAtIdxPrice(i: number, px: number, noteCode?: string) {
      if (!pos) return;
      const noteTxt = reasonText(noteCode);
      trades.push({
        entryIdx: pos.entryIdx, exitIdx: i, side: pos.side,
        entryTime: candles[pos.entryIdx].time.toISOString(),
        exitTime: candles[i].time.toISOString(),
        entryPrice: Number(pos.entryPrice), exitPrice: Number(px),
        pnl: pos.side === "BUY" ? (Number(px) - Number(pos.entryPrice)) : (Number(pos.entryPrice) - Number(px)),
        note: noteTxt,
        reason: noteTxt, // alias para UIs que leem "reason"
        movedToBE: pos.movedToBE, trailEvents: pos.trailEvents,
      });
      pos = null;
    }

    // Varredura
    let lossStreak = 0;
    let dayPnL = 0;
    let curDay = DateTime.fromJSDate(candles[0].time).setZone(ZONE).toISODate();

    for (let i = 1; i < candles.length; i++) {
      const c = candles[i];
      const prev = candles[i - 1];
      const nextIdx = i;
      const nextOpen = Number.isFinite(prev.close) ? Number(prev.close) : Number(prev.open) || 0;

      const day = DateTime.fromJSDate(c.time).setZone(ZONE).toISODate();
      if (day !== curDay) { curDay = day; dayPnL = 0; lossStreak = 0; }

      const crossUp = crossUpAt(i);
      const crossDn = crossDownAt(i);

      if (pos) {
        if (toNum(timeStopBars || horizonBars, 0) > 0 && (i - pos.entryIdx) >= toNum(timeStopBars || horizonBars, 0)) {
          closeAtIdxPrice(i, Number.isFinite(c.close) ? Number(c.close) : Number(c.open) || 0, "time-stop");
          const last = trades[trades.length - 1];
          if (last && last.exitIdx === i) {
            dayPnL += last.pnl - (toNum(costPts) || 0) - (toNum(slippagePts) || 0);
            if (last.pnl < 0) lossStreak += 1; else if (last.pnl > 0) lossStreak = 0;
          }
          continue;
        }

        const risk = pos.riskPts;
        const moveFromEntry = pos.side === "BUY" ? (Number(c.high) - pos.entryPrice) : (pos.entryPrice - Number(c.low));
        const beTriggerPts = Math.max(0, bePts);
        const beTriggerR = toNum(breakEvenAtR, 1) * risk;
        const trigger = beTriggerPts > 0 ? beTriggerPts : beTriggerR;
        if (!pos.movedToBE && trigger > 0 && moveFromEntry >= trigger) {
          const beOff = beTriggerPts > 0 ? Math.max(0, beOffPts) : (Math.max(0, toNum(beOffsetR, 0)) * risk);
          if (pos.side === "BUY") pos.stop = Math.max(pos.stop, pos.entryPrice + beOff);
          else pos.stop = Math.min(pos.stop, pos.entryPrice - beOff);
          pos.movedToBE = true;
        }

        const atrNow = Number(atr[i] || atr[i - 1] || atr[i - 2] || 0) || 0;
        if (toNum(kTrail, 0) > 0 && atrNow > 0) {
          if (pos.side === "BUY") {
            const trail = Number(c.close) - Number(kTrail) * atrNow;
            const newStop = Math.max(pos.stop, trail);
            if (newStop > pos.stop) { pos.stop = newStop; pos.trailEvents += 1; }
          } else {
            const trail = Number(c.close) + Number(kTrail) * atrNow;
            const newStop = Math.min(pos.stop, trail);
            if (newStop < pos.stop) { pos.stop = newStop; pos.trailEvents += 1; }
          }
        }

        if (pos.side === "BUY") {
          if (Number(c.high) >= pos.take) { closeAtIdxPrice(i, pos.take, "tp"); }
          else if (Number(c.low) <= pos.stop) { closeAtIdxPrice(i, pos.stop, pos.movedToBE ? "be/stop" : "sl"); }
        } else {
          if (Number(c.low) <= pos.take) { closeAtIdxPrice(i, pos.take, "tp"); }
          else if (Number(c.high) >= pos.stop) { closeAtIdxPrice(i, pos.stop, pos.movedToBE ? "be/stop" : "sl"); }
        }

        if (!pos) {
          const last = trades[trades.length - 1];
          if (last && last.exitIdx === i) {
            dayPnL += last.pnl - (toNum(costPts) || 0) - (toNum(slippagePts) || 0);
            if (last.pnl < 0) lossStreak += 1; else if (last.pnl > 0) lossStreak = 0;
          }
          continue;
        }

        if ((pos.side === "BUY" && crossDn) || (pos.side === "SELL" && crossUp)) {
          closeAtIdxPrice(nextIdx, nextOpen, "reverse-cross");
          const last = trades[trades.length - 1];
          if (last && last.exitIdx === nextIdx) {
            dayPnL += last.pnl - (toNum(costPts) || 0) - (toNum(slippagePts) || 0);
            if (last.pnl < 0) lossStreak += 1; else if (last.pnl > 0) lossStreak = 0;
          }
          continue;
        }
      }

      const inWindow = candles[nextIdx].time >= fromD && candles[nextIdx].time <= toD;
      if (!pos && inWindow) {
        const dailyStopped =
          (toNum(lossCap) > 0 && dayPnL <= -Math.abs(toNum(lossCap))) ||
          (toNum(maxConsecLosses) > 0 && lossStreak >= toNum(maxConsecLosses));

        if (!dailyStopped && (crossUp || crossDn)) {
          const side: "BUY" | "SELL" = crossUp ? "BUY" : "SELL";

          // GATES
          let gateOK = true;

          if (gateOK && vwapFilterBool) {
            const v = vwap[i];
            if (v != null) gateOK = side === "BUY" ? (Number(c.close) >= (v as number)) : (Number(c.close) <= (v as number));
          }

          if (gateOK && bbEnabledBool) {
            const mid = bbMid[i];
            if (mid != null) gateOK = side === "BUY" ? (Number(c.close) >= (mid as number)) : (Number(c.close) <= (mid as number));
          }

          if (gateOK && patternsSet.size > 0) {
            gateOK = side === "BUY" ? wantBull(i) : wantBear(i);
          }

          if (!gateOK) continue;

          const entryIdx = nextIdx;
          const entryPrice = nextOpen;

          const atrEntry = Number(atr[entryIdx] || atr[entryIdx - 1] || atr[entryIdx - 2] || 0) || 0;
          const riskPts =
            slPtsIn > 0 ? slPtsIn :
              (toNum(kSL) > 0 && atrEntry > 0) ? toNum(kSL) * atrEntry : 100;

          let take: number;
          if (tpViaRRBool && riskPts > 0) {
            take = side === "BUY" ? entryPrice + toNum(rr, 2) * riskPts : entryPrice - toNum(rr, 2) * riskPts;
          } else if (!tpViaRRBool && tpPtsIn > 0) {
            take = side === "BUY" ? entryPrice + tpPtsIn : entryPrice - tpPtsIn;
          } else {
            take = side === "BUY" ? entryPrice + toNum(rr, 2) * riskPts : entryPrice - toNum(rr, 2) * riskPts;
          }

          const stop0 = side === "BUY" ? (entryPrice - riskPts) : (entryPrice + riskPts);

          pos = { side, entryIdx, entryPrice, riskPts, stop: stop0, take, movedToBE: false, trailEvents: 0 };
        }
      }
    }

    if (pos) {
      const lastIdx = candles.length - 1;
      const lastTime = candles[lastIdx].time;
      const px = Number.isFinite(candles[lastIdx].close) ? Number(candles[lastIdx].close) : Number(candles[lastIdx].open) || 0;
      if (lastTime <= toD) closeAtIdxPrice(lastIdx, px, "end");
    }

    const filtered = trades.filter((t) => {
      const et = new Date(t.entryTime);
      return et >= fromD && et <= toD;
    });

    const wins = filtered.filter((t) => t.pnl > 0).length;
    const losses = filtered.filter((t) => t.pnl < 0).length;
    const ties = filtered.filter((t) => t.pnl === 0).length;
    const pnlPoints = Number(filtered.reduce((a, b) => a + (isFinite(b.pnl) ? b.pnl : 0), 0).toFixed(2));
    const sumWin = filtered.filter((t) => t.pnl > 0).reduce((a, b) => a + b.pnl, 0);
    const sumLossAbs = Math.abs(filtered.filter((t) => t.pnl < 0).reduce((a, b) => a + b.pnl, 0));
    const profitFactor = sumLossAbs > 0 ? Number((sumWin / sumLossAbs).toFixed(3)) : (wins > 0 ? Infinity : 0);
    const avgPnL = filtered.length ? Number((pnlPoints / filtered.length).toFixed(2)) : 0;

    let peak = 0, dd = 0, run = 0;
    for (const t of filtered) { run += t.pnl; peak = Math.max(peak, run); dd = Math.min(dd, run - peak); }
    const maxDrawdown = Number(dd.toFixed(2));
    const pnlMoney = Number((pnlPoints * Number(pointValue)).toFixed(2));

    const policy = {
      rr: toNum(rr, 2), kSL: toNum(kSL, 1.2), kTrail: toNum(kTrail, 0),
      breakEvenAtR: toNum(breakEvenAtR, 1), beOffsetR: toNum(beOffsetR, 0),
      breakEvenAtPts: bePts, beOffsetPts: beOffPts,
      timeStopBars: toNum(timeStopBars || horizonBars, 0),
      slPointsApplied: slPtsIn, tpPointsApplied: tpPtsIn, tpViaRRApplied: tpViaRRBool,
    };
    const config = {
      vwapFilter: vwapFilterBool, bbEnabled: bbEnabledBool, bbPeriod: bbPeriodNum, bbK: bbKNum,
      candlePatterns: String(candlePatterns || ""),
      minProb, minEV, useMicroModel, evalWindow, regime, tod, conformal,
    };

    const runId = makeRunId();
    const ts = new Date().toISOString();

    // ===== aliases + formatação para UI =====
    const tradesOut = filtered.map((t, idx) => ({
      id: idx + 1,
      side: t.side,
      entryTime: t.entryTime,
      exitTime: t.exitTime,
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice,
      pnl: t.pnl,
      pnlPoints: t.pnl,                 // alias para a UI
      note: t.note ?? null,
      reason: t.reason ?? t.note ?? null, // alias extra
      movedToBE: !!t.movedToBE,
      trailEvents: t.trailEvents ?? 0,
    }));

    const snap = {
      id: runId, ts, ok: true, version: VERSION,
      symbol: sym, timeframe: tfU,
      from: fromD.toISOString(), to: toD.toISOString(),
      candles: candles.filter((c) => c.time >= fromD && c.time <= toD).length,
      trades: tradesOut,
      summary: {
        trades: tradesOut.length, wins, losses, ties,
        winRate: tradesOut.length ? Number((wins / tradesOut.length).toFixed(4)) : 0,
        pnlPoints, avgPnL, profitFactor, maxDrawdown,
      },
      pnlPoints, pnlMoney,
      lossCapApplied: toNum(lossCap, 0),
      maxConsecLossesApplied: toNum(maxConsecLosses, 0),
      policy, config,
    };

    runStore.set(runId, snap);
    pushRunIndex({
      id: runId, ts, symbol: sym, timeframe: tfU,
      from: snap.from, to: snap.to,
      trades: snap.summary.trades, pnlPoints: snap.summary.pnlPoints, winRate: snap.summary.winRate
    });

    return res.status(200).json(ok(snap));
  } catch (e: any) {
    return res.status(200).json(bad("unexpected", { message: e?.message || String(e) }));
  }
});

export default router;
