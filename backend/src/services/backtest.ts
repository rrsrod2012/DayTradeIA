/* eslint-disable no-console */
import express from "express";
import { DateTime } from "luxon";
import { loadCandlesAnyTF } from "../lib/aggregation";

export const router = express.Router();

type TF = "M1" | "M5" | "M15" | "M30" | "H1";
const TF_MIN: Record<TF, number> = { M1: 1, M5: 5, M15: 15, M30: 30, H1: 60 };
const ZONE = "America/Sao_Paulo";

// BUMP: facilite ver se este arquivo carregou
const VERSION = "backtest:v4.3-ATR-RR-BE-TRAIL-HORIZON+runs+dual";

/* ===== Helpers de timeframe/bucket ===== */
function normalizeTf(tfRaw: string): { tfU: TF; tfMin: number } {
  const s = String(tfRaw || "").trim().toUpperCase() as TF;
  if (!s || !TF_MIN[s]) return { tfU: "M5", tfMin: 5 };
  return { tfU: s, tfMin: TF_MIN[s] };
}
function floorTo(d: Date, tfMin: number): Date {
  const dt = DateTime.fromJSDate(d).toUTC();
  const bucketMin = Math.floor(dt.minute / tfMin) * tfMin;
  return dt.set({ second: 0, millisecond: 0, minute: bucketMin }).toJSDate();
}
function ceilToExclusive(d: Date, tfMin: number): Date {
  const dt = DateTime.fromJSDate(d).toUTC();
  const bucketMin = Math.floor(dt.minute / tfMin) * tfMin + tfMin;
  return dt.set({ second: 0, millisecond: 0, minute: bucketMin }).toJSDate();
}
function toLocalDateStr(d: Date) {
  return DateTime.fromJSDate(d).setZone(ZONE).toFormat("yyyy-LL-dd");
}

/* ===== EMA ===== */
function EMA(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  const k = 2 / (period + 1);
  let ema: number | null = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!isFinite(v)) {
      out.push(ema);
      continue;
    }
    ema = ema == null ? v : v * k + (ema as number) * (1 - k);
    out.push(ema);
  }
  return out;
}

/* ===== ATR (Wilder) ===== */
type Candle = { time: Date; open: number; high: number; low: number; close: number };
function trueRange(curr: Candle, prevClose: number) {
  const h = Number(curr.high), l = Number(curr.low);
  return Math.max(
    Math.abs(h - l),
    Math.abs(h - prevClose),
    Math.abs(l - prevClose)
  );
}
function ATR(candles: Candle[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  if (candles.length < period + 1) return out;

  const trs: number[] = new Array(candles.length).fill(0);
  trs[0] = Math.abs(Number(candles[0].high) - Number(candles[0].low));
  for (let i = 1; i < candles.length; i++) {
    trs[i] = trueRange(candles[i], Number(candles[i - 1].close));
  }

  let atr = 0;
  for (let i = 0; i < period; i++) atr += trs[i];
  atr /= period;
  out[period] = atr;

  for (let i = period + 1; i < candles.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
    out[i] = atr;
  }
  return out;
}

/* ===== Respostas padrão ===== */
function ok<T>(data: T, extra: Record<string, any> = {}) {
  return { ok: true, version: VERSION, ...extra, ...data };
}
function bad(message: string, meta: any = {}) {
  return { ok: false, version: VERSION, error: message, ...meta };
}
function diagify(e: any) {
  const s = String(e?.stack || e?.message || e);
  const lines = s.split("\n").slice(0, 10).join("\n");
  return { diag: lines };
}

/* ===== Parsing/normalização de datas no fuso de SP ===== */
function parseUserDate(raw: any): { ok: boolean; dt: DateTime; isDateOnly: boolean } {
  if (raw == null) return { ok: false, dt: DateTime.invalid("empty"), isDateOnly: false };
  let s = String(raw).trim();
  if (!s) return { ok: false, dt: DateTime.invalid("empty"), isDateOnly: false };

  // BR: dd/MM/yyyy [HH:mm[:ss]]
  const reBR = /^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2})(?::(\d{2})(?::(\d{2}))?)?)?$/;
  const m = reBR.exec(s);
  if (m) {
    const fmt = m[4] ? (m[6] ? "dd/LL/yyyy HH:mm:ss" : "dd/LL/yyyy HH:mm") : "dd/LL/yyyy";
    const dt = DateTime.fromFormat(s, fmt, { zone: ZONE });
    return { ok: dt.isValid, dt, isDateOnly: !m[4] };
  }

  // ISO yyyy-MM-dd → só data
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const dt = DateTime.fromISO(s, { zone: ZONE });
    return { ok: dt.isValid, dt, isDateOnly: true };
  }

  // ISO com hora — trata como hora local (remove offset/Z)
  if (/^\d{4}-\d{2}-\d{2}t/i.test(s)) {
    s = s.replace(/([+-]\d{2}:?\d{2}|Z)$/i, "");
    const dt = DateTime.fromISO(s, { zone: ZONE });
    return { ok: dt.isValid, dt, isDateOnly: false };
  }

  // Epoch ms
  if (/^\d{10,13}$/.test(s)) {
    const n = Number(s);
    const dt = Number.isFinite(n) ? DateTime.fromMillis(n, { zone: ZONE }) : DateTime.invalid("nan");
    return { ok: dt.isValid, dt, isDateOnly: false };
  }

  return { ok: false, dt: DateTime.invalid("unparsed"), isDateOnly: false };
}

function normalizeDayRange(fromRaw: any, toRaw: any): { fromLocal: DateTime; toLocal: DateTime } | null {
  const pF = parseUserDate(fromRaw);
  const pT = parseUserDate(toRaw);
  if (!pF.ok && !pT.ok) return null;

  let fromLocal: DateTime;
  let toLocal: DateTime;

  if (pF.ok && pT.ok) {
    const sameDay = pF.dt.toFormat("yyyy-LL-dd") === pT.dt.toFormat("yyyy-LL-dd");
    if (pF.isDateOnly || pT.isDateOnly || sameDay) {
      fromLocal = pF.dt.startOf("day");
      toLocal = pT.dt.endOf("day");
    } else {
      fromLocal = pF.dt;
      toLocal = pT.dt;
    }
  } else if (pF.ok) {
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
  return { fromLocal, toLocal };
}

/* =========================
   Registro de execuções (em memória)
   ========================= */
type BacktestSnapshot = any;
type RunIndexItem = {
  id: string; ts: string;
  symbol: string; timeframe: TF;
  from: string; to: string;
  trades: number; pnlPoints: number; winRate: number;
};
const RECENT_MAX = 100;
const RUNS_INDEX: RunIndexItem[] = [];
const RUNS_BY_ID: Record<string, BacktestSnapshot> = {};

function makeId() {
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${ts}${rnd}`;
}
function indexRun(snap: BacktestSnapshot) {
  const id = makeId();
  const ts = new Date().toISOString();
  const item: RunIndexItem = {
    id, ts,
    symbol: snap?.symbol ?? "",
    timeframe: snap?.timeframe ?? "M5",
    from: snap?.from ?? "",
    to: snap?.to ?? "",
    trades: snap?.summary?.trades ?? 0,
    pnlPoints: snap?.pnlPoints ?? 0,
    winRate: snap?.summary?.winRate ?? 0,
  };
  RUNS_BY_ID[id] = { id, ts, ...snap };
  RUNS_INDEX.push(item);
  if (RUNS_INDEX.length > RECENT_MAX) {
    const overflow = RUNS_INDEX.length - RECENT_MAX;
    const removed = RUNS_INDEX.splice(0, overflow);
    for (const r of removed) delete RUNS_BY_ID[r.id];
  }
  return id;
}

/* ====== helpers de rota-espelho (com e sem /api) ====== */
function dualGet(path: string, handler: any) {
  router.get(path, handler);
  router.get(`/api${path}`, handler);
}
function dualAll(path: string, handler: any) {
  router.all(path, handler);
  router.all(`/api${path}`, handler);
}

/* ====== versão log ====== */
console.log(`[BACKTEST] Loaded ${VERSION}`);

/* -------- util: echo -------- */
dualAll("/debug/echo", (req: any, res: any) => {
  const method = req.method.toUpperCase();
  const payload = method === "GET" ? req.query : req.body;
  return res.status(200).json({
    ok: true,
    version: VERSION,
    method,
    headers: {
      "content-type": req.headers["content-type"] || null,
      accept: req.headers["accept"] || null,
    },
    payload,
  });
});

/* -------- versão/health -------- */
dualGet("/backtest/version", async (_req: any, res: any) => {
  return res.status(200).json(ok({ service: "backtest", now: new Date().toISOString() }));
});
dualGet("/backtest/health", async (req: any, res: any) => {
  try {
    const { symbol, timeframe, from, to } = req.query as any;
    const sym = String(symbol || "").toUpperCase().trim();
    if (!sym) return res.status(200).json(bad("Faltou 'symbol'"));

    const { tfU, tfMin } = normalizeTf(String(timeframe || "M5"));

    const fallbackDays = Number(process.env.BACKTEST_DEFAULT_DAYS || 1);
    let fromD: Date, toD: Date;

    const norm = normalizeDayRange(from, to);
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
      ok({ symbol: sym, timeframe: tfU, samples: candles.length, from: fromD.toISOString(), to: toD.toISOString() })
    );
  } catch (e: any) {
    return res.status(200).json(bad("health failed", diagify(e)));
  }
});

/* -------- runs (lista) -------- */
dualGet("/backtest/runs", async (_req: any, res: any) => {
  try {
    const sorted = RUNS_INDEX.slice().sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
    const limit = 100;
    return res.status(200).json(ok({ total: RUNS_INDEX.length, items: sorted.slice(0, limit) }));
  } catch (e: any) {
    return res.status(200).json(bad("list failed", diagify(e)));
  }
});

/* -------- run (detalhe) -------- */
dualGet("/backtest/run/:id", async (req: any, res: any) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(200).json(bad("faltou 'id'"));
    const snap = RUNS_BY_ID[id];
    if (!snap) return res.status(200).json(bad("run não encontrada", { id }));
    return res.status(200).json(ok({ run: snap }));
  } catch (e: any) {
    return res.status(200).json(bad("read failed", diagify(e)));
  }
});

/* -------- backtest (principal) -------- */
dualAll("/backtest", async (req: any, res: any) => {
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
      rr = 2,                  // take profit em R
      kSL = 1.2,               // SL = kSL * ATR
      kTrail = 0,              // trailing = kTrail * ATR (0 = off)
      breakEvenAtR = 1.0,      // quando atinge X R, mover stop para BE
      beOffsetR = 0.0,         // offset em R no BE (ex.: 0.1R)
      timeStopBars = 0,        // fecha após N barras (0 = off)
      horizonBars = 0,         // alias
      evalWindow = 200,
      regime, tod, conformal,
      minProb, minEV, useMicroModel, vwapFilter,
    } = body as any;

    const sym = String(symbol || "").toUpperCase().trim();
    if (!sym) return res.status(200).json(bad("Faltou 'symbol' (ex.: WIN, WDO)"));

    const { tfU, tfMin } = normalizeTf(String(timeframe || "M5"));

    // Datas (janela do usuário)
    const fallbackDays = Number(process.env.BACKTEST_DEFAULT_DAYS || 1);
    let fromD: Date, toD: Date;
    const norm = normalizeDayRange(from, to);
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

    // ===== WARM-UP =====
    const WARMUP_MULT = 30;
    const warmupMin = Math.max(150, WARMUP_MULT * tfMin);
    const fromWarm = new Date(fromD.getTime() - warmupMin * 60_000);

    let candles: Candle[];
    try {
      candles = await loadCandlesAnyTF(sym, tfU, { gte: fromWarm, lte: toD } as any);
    } catch (e: any) {
      return res.status(200).json(bad("Falha ao carregar candles (loadCandlesAnyTF)", diagify(e)));
    }
    if (!candles?.length) {
      const empty = ok({
        symbol: sym, timeframe: tfU, candles: 0, trades: [],
        summary: { trades: 0, wins: 0, losses: 0, ties: 0, winRate: 0, pnlPoints: 0, avgPnL: 0, profitFactor: 0, maxDrawdown: 0 },
        pnlPoints: 0, pnlMoney: 0,
        lossCapApplied: Number(lossCap) || 0, maxConsecLossesApplied: Number(maxConsecLosses) || 0,
        policy: { rr, kSL, kTrail, breakEvenAtR, beOffsetR, timeStopBars: timeStopBars || horizonBars },
        config: { vwapFilter: !!vwapFilter, minProb, minEV, useMicroModel, evalWindow, regime, tod, conformal },
        info: "sem candles no período informado (verifique ingestão/DB/símbolo/TF)",
      });
      const id = indexRun({ ...empty, symbol: sym, timeframe: tfU, from: fromD.toISOString(), to: toD.toISOString() });
      return res.status(200).json({ ...empty, id });
    }

    // ===== Indicadores =====
    const closes = candles.map((c) => Number.isFinite(c.close) ? Number(c.close) : Number(c.open) || 0);
    const e9 = EMA(closes, 9);
    const e21 = EMA(closes, 21);
    const atr = ATR(candles, 14);

    type Trade = {
      entryIdx: number; exitIdx: number; side: "BUY" | "SELL";
      entryTime: string; exitTime: string; entryPrice: number; exitPrice: number;
      pnl: number; note?: string;
      movedToBE?: boolean; trailEvents?: number;
    };

    const trades: Trade[] = [];
    let pos: null | {
      side: "BUY" | "SELL";
      entryIdx: number;
      entryPrice: number;
      riskPts: number;
      stop: number;
      take: number;
      movedToBE: boolean;
      trailEvents: number;
    } = null;

    let dayPnL = 0;
    let day = toLocalDateStr(candles[0].time);
    let lossStreak = 0;

    const applyCosts = (raw: number) => raw - Number(costPts) - Number(slippagePts);
    const bookTrade = (entryIdx: number, exitIdx: number, side: "BUY" | "SELL", entryPrice: number, exitPrice: number, note?: string) => {
      const gross = side === "BUY" ? (exitPrice - entryPrice) : (entryPrice - exitPrice);
      const pnl = Number(applyCosts(gross).toFixed(2));
      const tr: Trade = {
        entryIdx, exitIdx, side,
        entryTime: candles[entryIdx].time.toISOString(),
        exitTime: candles[exitIdx].time.toISOString(),
        entryPrice, exitPrice, pnl, note,
      };
      trades.push(tr);
      if (candles[entryIdx].time >= fromD && candles[entryIdx].time <= toD) {
        dayPnL += tr.pnl;
        if (tr.pnl <= 0) lossStreak += 1; else lossStreak = 0;
      }
    };
    const closeAtIdxPrice = (i: number, price: number, note?: string) => {
      if (!pos) return;
      bookTrade(pos.entryIdx, i, pos.side, pos.entryPrice, price, note);
      pos = null;
    };

    const barsLimit = Number(timeStopBars || horizonBars || 0);

    for (let i = 1; i < candles.length; i++) {
      const d = toLocalDateStr(candles[i].time);
      if (d !== day) {
        day = d;
        if (candles[i].time >= fromD) {
          dayPnL = 0;
          lossStreak = 0;
        }
      }

      // Cruzamentos (entrada/reversão fallback)
      const prevUp = e9[i - 1] != null && e21[i - 1] != null && (e9[i - 1] as number) <= (e21[i - 1] as number);
      const nowUp = e9[i] != null && e21[i] != null && (e9[i] as number) > (e21[i] as number);
      const prevDn = e9[i - 1] != null && e21[i - 1] != null && (e9[i - 1] as number) >= (e21[i - 1] as number);
      const nowDn = e9[i] != null && e21[i] != null && (e9[i] as number) < (e21[i] as number);

      const crossUp = prevUp && nowUp;
      const crossDn = prevDn && nowDn;

      const nextIdx = Math.min(i + 1, candles.length - 1);
      const nextOpen = Number.isFinite(candles[nextIdx].open) ? Number(candles[nextIdx].open) : Number(candles[nextIdx].close) || 0;
      const c = candles[i];

      // ===== Gestão da posição (SL/TP/BE/Trail/TimeStop) =====
      if (pos) {
        if (barsLimit > 0 && (i - pos.entryIdx) >= barsLimit) {
          closeAtIdxPrice(i, Number(c.close) || nextOpen, "time-stop");
          continue;
        }

        const risk = pos.riskPts;
        const beTrigger = Number(breakEvenAtR) * risk;
        const moveFromEntry = pos.side === "BUY" ? (Number(c.high) - pos.entryPrice) : (pos.entryPrice - Number(c.low));
        if (!pos.movedToBE && beTrigger > 0 && moveFromEntry >= beTrigger) {
          const beOffsetPts = Number(beOffsetR || 0) * risk;
          if (pos.side === "BUY") pos.stop = Math.max(pos.stop, pos.entryPrice + beOffsetPts);
          else pos.stop = Math.min(pos.stop, pos.entryPrice - beOffsetPts);
          pos.movedToBE = true;
        }

        const atrNow = Number(atr[i] || atr[i - 1] || atr[i - 2] || 0) || 0;
        if (Number(kTrail) > 0 && atrNow > 0) {
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
          if (Number(c.high) >= pos.take) { closeAtIdxPrice(i, pos.take, "tp"); continue; }
          if (Number(c.low) <= pos.stop) { closeAtIdxPrice(i, pos.stop, pos.movedToBE ? "be/stop" : "sl"); continue; }
        } else {
          if (Number(c.low) <= pos.take) { closeAtIdxPrice(i, pos.take, "tp"); continue; }
          if (Number(c.high) >= pos.stop) { closeAtIdxPrice(i, pos.stop, pos.movedToBE ? "be/stop" : "sl"); continue; }
        }

        if ((pos.side === "BUY" && crossDn) || (pos.side === "SELL" && crossUp)) {
          closeAtIdxPrice(nextIdx, nextOpen, "reverse-cross");
          continue;
        }
      }

      // ===== Aberturas na janela =====
      const inWindow = candles[nextIdx].time >= fromD && candles[nextIdx].time <= toD;
      if (!pos && inWindow) {
        const dailyStopped =
          (Number(lossCap) > 0 && dayPnL <= -Math.abs(Number(lossCap))) ||
          (Number(maxConsecLosses) > 0 && lossStreak >= Number(maxConsecLosses));
        if (!dailyStopped && (crossUp || crossDn)) {
          const side: "BUY" | "SELL" = crossUp ? "BUY" : "SELL";
          const entryIdx = nextIdx;
          const entryPrice = nextOpen;

          const atrEntry = Number(atr[entryIdx] || atr[entryIdx - 1] || atr[entryIdx - 2] || 0) || 0;
          const riskPts = (Number(kSL) > 0 && atrEntry > 0) ? Number(kSL) * atrEntry : 100;

          const take = side === "BUY"
            ? entryPrice + Number(rr) * riskPts
            : entryPrice - Number(rr) * riskPts;

          const stop0 = side === "BUY"
            ? entryPrice - riskPts
            : entryPrice + riskPts;

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

    // Filtra por entrada na janela
    const filtered = trades.filter((t) => {
      const et = new Date(t.entryTime);
      return et >= fromD && et <= toD;
    });

    // Métricas
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

    const payload = ok({
      symbol: sym, timeframe: tfU,
      from: fromD.toISOString(), to: toD.toISOString(),
      candles: candles.filter((c) => c.time >= fromD && c.time <= toD).length,
      trades: filtered,
      summary: {
        trades: filtered.length, wins, losses, ties,
        winRate: filtered.length ? Number((wins / filtered.length).toFixed(4)) : 0,
        pnlPoints, avgPnL, profitFactor, maxDrawdown,
      },
      pnlPoints, pnlMoney,
      lossCapApplied: Number(lossCap) || 0,
      maxConsecLossesApplied: Number(maxConsecLosses) || 0,
      policy: {
        rr: Number(rr), kSL: Number(kSL), kTrail: Number(kTrail),
        breakEvenAtR: Number(breakEvenAtR), beOffsetR: Number(beOffsetR),
        timeStopBars: Number(timeStopBars || horizonBars || 0),
      },
      config: {
        vwapFilter: !!vwapFilter, minProb, minEV, useMicroModel, evalWindow, regime, tod, conformal,
      },
    });

    const id = indexRun(payload);
    return res.status(200).json({ ...payload, id });
  } catch (e: any) {
    return res.status(200).json(bad("unexpected", diagify(e)));
  }
});

export default router;
