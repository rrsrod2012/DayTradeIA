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
  const s = String(tfRaw || "M5").trim().toUpperCase();
  if (s === "M1" || s === "M5" || s === "M15" || s === "M30" || s === "H1") {
    return { tfU: s as TF, tfMin: TF_MIN[s as TF] };
  }
  // números “soltos” viram minutos (ex.: “3” => M3 ~ tratamos como M5)
  if (/^\d+$/.test(s)) return { tfU: "M5", tfMin: TF_MIN.M5 };
  return { tfU: "M5", tfMin: TF_MIN.M5 };
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

  return { ok: false, dt: DateTime.invalid("fmt"), isDateOnly: false };
}
function normRange(fromRaw: any, toRaw: any) {
  const a = parseUserDate(fromRaw);
  const b = parseUserDate(toRaw);
  if (!a.ok && !b.ok) return null;
  if (a.ok && a.isDateOnly && b.ok && b.isDateOnly) {
    return {
      fromLocal: a.dt.startOf("day"),
      toLocal: b.dt.endOf("day"),
    };
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

/* ===== Indicadores simples ===== */
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
    const win = Math.min(14, upto);
    if (win <= 0) { out[i] = null; continue; }
    let sum = 0;
    for (let k = 0; k < win; k++) sum += trs[upto - 1 - k];
    out[i] = sum / win;
  }
  return out;
}

/* -------- infra -------- */
function ok(data: any) { return { ok: true, ...data }; }
function bad(msg: string, extra?: any) { return { ok: false, error: msg, ...extra ? { extra } : {} }; }
function log(...args: any[]) { console.log(...args); }

// debug: versão carregada
log(`[BACKTEST] Loaded ${VERSION}`);

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
      // NOVO: BE por pontos (se > 0, tem precedência sobre R)
      breakEvenAtPts = null,
      beOffsetPts = null,
      timeStopBars = 0,        // fecha após N barras (0 = off)
      horizonBars = 0,         // alias
      evalWindow = 200,
      regime, tod, conformal,
      minProb, minEV, useMicroModel, vwapFilter,
    } = body as any;

    const sym = String(symbol || "").toUpperCase().trim();
    if (!sym) return res.status(200).json(bad("Faltou 'symbol' (ex.: WIN, WDO)"));
    // Defaults de BE por pontos (ENV override se não vier no payload)
    const bePts = Number(breakEvenAtPts ?? (process.env.BACKTEST_BE_AT_PTS || 0)) || 0;
    const beOffPts = Number(beOffsetPts ?? (process.env.BACKTEST_BE_OFFSET_PTS || 0)) || 0;

    const { tfU, tfMin } = normalizeTf(String(timeframe || "M5"));

    // Datas (janela do usuário)
    const fallbackDays = Number(process.env.BACKTEST_DEFAULT_DAYS || 1);
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

    // ===== WARM-UP =====
    const WARMUP_MULT = 30;
    const warmupMin = Math.max(150, WARMUP_MULT * tfMin);
    const fromWarm = new Date(fromD.getTime() - warmupMin * 60_000);

    let candles: { time: Date; open: number; high: number; low: number; close: number }[];
    try {
      candles = await loadCandlesAnyTF(sym, tfU, { gte: fromWarm, lte: toD } as any);
    } catch (e: any) {
      return res.status(200).json(bad("erro ao carregar candles", { message: e?.message || String(e) }));
    }

    if (!candles?.length) {
      const empty = ok({
        symbol: sym, timeframe: tfU, from: fromD.toISOString(), to: toD.toISOString(),
        candles: 0, trades: [],
        summary: { trades: 0, wins: 0, losses: 0, ties: 0, winRate: 0, pnlPoints: 0, avgPnL: 0, profitFactor: 0, maxDrawdown: 0 },
        pnlPoints: 0, pnlMoney: 0,
        lossCapApplied: Number(lossCap) || 0,
        maxConsecLossesApplied: Number(maxConsecLosses) || 0,
        policy: { rr, kSL, kTrail, breakEvenAtR, beOffsetR, breakEvenAtPts: Number(bePts), beOffsetPts: Number(beOffPts), timeStopBars: timeStopBars || horizonBars },
        config: { vwapFilter: !!vwapFilter, minProb, minEV, useMicroModel, evalWindow, regime, tod, conformal },
        info: "sem candles no período informado (verifique ingestão/DB/símbolo/TF)",
      });
      return res.status(200).json(empty);
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

    function closeAtIdxPrice(i: number, px: number, note?: string) {
      if (!pos) return;
      trades.push({
        entryIdx: pos.entryIdx,
        exitIdx: i,
        side: pos.side,
        entryTime: candles[pos.entryIdx].time.toISOString(),
        exitTime: candles[i].time.toISOString(),
        entryPrice: Number(pos.entryPrice),
        exitPrice: Number(px),
        pnl: pos.side === "BUY" ? (Number(px) - Number(pos.entryPrice)) : (Number(pos.entryPrice) - Number(px)),
        note,
        movedToBE: pos.movedToBE,
        trailEvents: pos.trailEvents,
      });
      pos = null;
    }

    // ===== Varredura =====
    let lossStreak = 0;
    let dayPnL = 0;
    let curDay = DateTime.fromJSDate(candles[0].time).setZone(ZONE).toISODate();

    for (let i = 1; i < candles.length; i++) {
      const c = candles[i];
      const prev = candles[i - 1];
      const nextIdx = i;
      const nextOpen = Number.isFinite(prev.close) ? Number(prev.close) : Number(prev.open) || 0;

      // controle diário
      const day = DateTime.fromJSDate(c.time).setZone(ZONE).toISODate();
      if (day !== curDay) { curDay = day; dayPnL = 0; lossStreak = 0; }

      const crossUp = crossUpAt(i);
      const crossDn = crossDownAt(i);

      if (pos) {
        // time-stop
        if (Number(timeStopBars || horizonBars) > 0 && (i - pos.entryIdx) >= Number(timeStopBars || horizonBars)) {
          closeAtIdxPrice(i, Number.isFinite(c.close) ? Number(c.close) : Number(c.open) || 0, "time-stop");
          continue;
        }

        const risk = pos.riskPts;
        const moveFromEntry = pos.side === "BUY" ? (Number(c.high) - pos.entryPrice) : (pos.entryPrice - Number(c.low));
        // BE por pontos tem precedência; se não definido, usa em R
        const beTriggerPts = Number(bePts) || 0;
        const beTriggerR = Number(breakEvenAtR) * risk;
        const trigger = beTriggerPts > 0 ? beTriggerPts : beTriggerR;
        if (!pos.movedToBE && trigger > 0 && moveFromEntry >= trigger) {
          const beOff = beTriggerPts > 0 ? Number(beOffPts || 0) : (Number(beOffsetR || 0) * risk);
          if (pos.side === "BUY") pos.stop = Math.max(pos.stop, pos.entryPrice + beOff);
          else pos.stop = Math.min(pos.stop, pos.entryPrice - beOff);
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

      // aberturas na janela
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
        breakEvenAtPts: Number(bePts), beOffsetPts: Number(beOffPts),
        timeStopBars: Number(timeStopBars || horizonBars || 0),
      },
      config: {
        vwapFilter: !!vwapFilter, minProb, minEV, useMicroModel, evalWindow, regime, tod, conformal,
      },
    });

    return res.status(200).json(payload);
  } catch (e: any) {
    return res.status(200).json(bad("unexpected", { message: e?.message || String(e) }));
  }
});

/* ========= ALIASES /api/* (evita 404 do frontend) ========= */
// versão e health (GET)
router.get("/api/backtest/version", (_req: any, res: any) => res.redirect(307, "/backtest/version"));
router.get("/api/backtest/health", (req: any, res: any) => {
  // preserva querystring ao redirecionar
  const qs = req.originalUrl.includes("?") ? req.originalUrl.split("?")[1] : "";
  res.redirect(307, `/backtest/health${qs ? `?${qs}` : ""}`);
});
// rota principal (GET/POST)
router.get("/api/backtest", (req: any, res: any) => {
  const qs = req.originalUrl.includes("?") ? req.originalUrl.split("?")[1] : "";
  res.redirect(307, `/backtest${qs ? `?${qs}` : ""}`);
});
router.post("/api/backtest", (_req: any, res: any) => res.redirect(307, "/backtest"));

// runs (placeholders para não causar 404 no painel)
router.get("/backtest/runs", (_req: any, res: any) => res.status(200).json(ok({ items: [], count: 0 })));
router.get("/api/backtest/runs", (_req: any, res: any) => res.status(200).json(ok({ items: [], count: 0 })));
router.get("/backtest/run/:id", (_req: any, res: any) => res.status(404).json(bad("run_not_found")));
router.get("/api/backtest/run/:id", (_req: any, res: any) => res.status(404).json(bad("run_not_found")));

/* ===== Helpers dual (GET/POST) ===== */
function dualGet(path: string, h: any) {
  router.get(path, h);
}
function dualAll(path: string, h: any) {
  router.get(path, h);
  router.post(path, h);
}

export default router;
