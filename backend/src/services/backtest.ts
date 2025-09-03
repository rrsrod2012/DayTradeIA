/* eslint-disable no-console */
import express from "express";
import { DateTime, Duration } from "luxon";
import { loadCandlesAnyTF } from "../lib/aggregation";

export const router = express.Router();

type TF = "M1" | "M5" | "M15" | "M30" | "H1";
const TF_MIN: Record<TF, number> = { M1: 1, M5: 5, M15: 15, M30: 30, H1: 60 };
const ZONE = "America/Sao_Paulo";

const VERSION = "backtest:v3.4-always-200";

function normalizeTf(tfRaw: string): { tfU: string; tfMin: number } {
  const s = String(tfRaw || "")
    .trim()
    .toUpperCase();
  if (!s) return { tfU: "M5", tfMin: 5 };
  if (s.startsWith("M") || s.startsWith("H")) {
    const unit = s[0];
    const num = parseInt(s.slice(1), 10) || (unit === "H" ? 1 : 5);
    const tfU = `${unit}${num}`;
    const tfMin = unit === "H" ? num * 60 : num;
    return { tfU, tfMin };
  }
  const m = /(\d+)\s*(M|MIN|MINUTES|m)?/.exec(s);
  if (m) {
    const num = parseInt(m[1], 10) || 5;
    return { tfU: `M${num}`, tfMin: num };
  }
  return { tfU: "M5", tfMin: 5 };
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
    ema = ema == null ? v : v * k + ema * (1 - k);
    out.push(ema);
  }
  return out;
}

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

/* -------- Utilitário: ecoa o payload do front -------- */
router.all("/api/debug/echo", express.json(), (req, res) => {
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

/* -------- GET /api/backtest/health -------- */
router.get("/api/backtest/health", async (req, res) => {
  try {
    const { symbol, timeframe, from, to } = req.query as any;
    const sym = String(symbol || "")
      .toUpperCase()
      .trim();
    if (!sym) return res.status(200).json(bad("Faltou 'symbol'"));
    const { tfU, tfMin } = normalizeTf(String(timeframe || "M5"));

    const fallbackDays = Number(process.env.BACKTEST_DEFAULT_DAYS || 5);
    let fromD: Date, toD: Date;
    if (from && to) {
      const f = new Date(String(from)),
        t = new Date(String(to));
      if (!isFinite(f.getTime()) || !isFinite(t.getTime())) {
        return res.status(200).json(bad("Parâmetros 'from'/'to' inválidos"));
      }
      fromD = floorTo(f, tfMin);
      toD = ceilToExclusive(t, tfMin);
    } else {
      const tnow = DateTime.now().toUTC();
      const f = tnow.minus(Duration.fromObject({ days: fallbackDays }));
      fromD = floorTo(f.toJSDate(), tfMin);
      toD = ceilToExclusive(tnow.toJSDate(), tfMin);
    }

    const candles = await loadCandlesAnyTF(sym, tfU, { gte: fromD, lte: toD });
    return res.status(200).json(
      ok({
        symbol: sym,
        timeframe: tfU,
        samples: candles.length,
        from: fromD.toISOString(),
        to: toD.toISOString(),
      })
    );
  } catch (e: any) {
    return res.status(200).json(bad("health failed", diagify(e)));
  }
});

/* -------- POST/GET /api/backtest -------- */
router.all("/api/backtest", express.json(), async (req, res) => {
  const method = req.method.toUpperCase();
  try {
    const body = method === "GET" ? req.query || {} : req.body || {};
    const {
      symbol,
      timeframe,
      from,
      to,

      pointValue = 1,
      costPts = 2,
      slippagePts = 1,

      lossCap = 0,
      maxConsecLosses = 0,
    } = body as any;

    const sym = String(symbol || "")
      .toUpperCase()
      .trim();
    if (!sym)
      return res.status(200).json(bad("Faltou 'symbol' (ex.: WIN, WDO)"));

    const { tfU, tfMin } = normalizeTf(String(timeframe || "M5"));

    const fallbackDays = Number(process.env.BACKTEST_DEFAULT_DAYS || 5);
    let fromD: Date, toD: Date;

    if (from && to) {
      const f = new Date(String(from));
      const t = new Date(String(to));
      if (!isFinite(f.getTime()) || !isFinite(t.getTime())) {
        return res
          .status(200)
          .json(bad("Parâmetros 'from'/'to' inválidos", { from, to }));
      }
      fromD = floorTo(f, tfMin);
      toD = ceilToExclusive(t, tfMin);
    } else {
      const tnow = DateTime.now().toUTC();
      const f = tnow.minus(Duration.fromObject({ days: fallbackDays }));
      fromD = floorTo(f.toJSDate(), tfMin);
      toD = ceilToExclusive(tnow.toJSDate(), tfMin);
    }

    if (fromD >= toD) {
      return res
        .status(200)
        .json(bad("'from' deve ser anterior a 'to'", { from: fromD, to: toD }));
    }

    let candles: Array<{
      time: Date;
      open: number;
      high: number;
      low: number;
      close: number;
    }>;
    try {
      candles = await loadCandlesAnyTF(sym, tfU, { gte: fromD, lte: toD });
    } catch (e: any) {
      return res
        .status(200)
        .json(bad("Falha ao carregar candles (loadCandlesAnyTF)", diagify(e)));
    }

    if (!candles?.length) {
      return res.status(200).json(
        ok({
          symbol: sym,
          timeframe: tfU,
          candles: 0,
          trades: [],
          summary: {
            trades: 0,
            wins: 0,
            losses: 0,
            ties: 0,
            winRate: 0,
            pnlPoints: 0,
            avgPnL: 0,
            profitFactor: 0,
            maxDrawdown: 0,
          },
          pnlPoints: 0,
          pnlMoney: 0,
          lossCapApplied: Number(lossCap) || 0,
          maxConsecLossesApplied: Number(maxConsecLosses) || 0,
          info: "sem candles no período informado (verifique ingestão/DB/símbolo/TF)",
        })
      );
    }

    // Indicadores
    const closes = candles.map((c) =>
      Number.isFinite(c.close) ? Number(c.close) : Number(c.open) || 0
    );
    const e9 = EMA(closes, 9);
    const e21 = EMA(closes, 21);

    type Trade = {
      entryIdx: number;
      exitIdx: number;
      side: "BUY" | "SELL";
      entryTime: string;
      exitTime: string;
      entryPrice: number;
      exitPrice: number;
      pnl: number;
      note?: string;
    };

    const trades: Trade[] = [];
    let pos: null | {
      side: "BUY" | "SELL";
      entryIdx: number;
      entryPrice: number;
    } = null;

    let dayPnL = 0;
    let day = toLocalDateStr(candles[0].time);
    let lossStreak = 0;

    const bookTrade = (
      entryIdx: number,
      exitIdx: number,
      side: "BUY" | "SELL",
      entryPrice: number,
      exitPrice: number,
      note?: string
    ) => {
      const raw =
        side === "BUY" ? exitPrice - entryPrice : entryPrice - exitPrice;
      const pnl = raw - Number(costPts) - Number(slippagePts);
      const tr: Trade = {
        entryIdx,
        exitIdx,
        side,
        entryTime: candles[entryIdx].time.toISOString(),
        exitTime: candles[exitIdx].time.toISOString(),
        entryPrice,
        exitPrice,
        pnl: Number(isFinite(pnl) ? pnl.toFixed(2) : 0),
        note,
      };
      trades.push(tr);
      dayPnL += tr.pnl;
      if (tr.pnl <= 0) lossStreak += 1;
      else lossStreak = 0;
    };

    const closeAt = (i: number, price: number, note?: string) => {
      if (!pos) return;
      bookTrade(pos.entryIdx, i, pos.side, pos.entryPrice, price, note);
      pos = null;
    };

    for (let i = 1; i < candles.length; i++) {
      const d = toLocalDateStr(candles[i].time);
      if (d !== day) {
        day = d;
        dayPnL = 0;
        lossStreak = 0;
      }

      const prevUp =
        e9[i - 1] != null &&
        e21[i - 1] != null &&
        (e9[i - 1] as number) <= (e21[i - 1] as number);
      const nowUp =
        e9[i] != null &&
        e21[i] != null &&
        (e9[i] as number) > (e21[i] as number);
      const prevDn =
        e9[i - 1] != null &&
        e21[i - 1] != null &&
        (e9[i - 1] as number) >= (e21[i - 1] as number);
      const nowDn =
        e9[i] != null &&
        e21[i] != null &&
        (e9[i] as number) < (e21[i] as number);

      const crossUp = prevUp && nowUp;
      const crossDn = prevDn && nowDn;

      const nextIdx = Math.min(i + 1, candles.length - 1);
      const nextOpen = Number.isFinite(candles[nextIdx].open)
        ? Number(candles[nextIdx].open)
        : Number(candles[nextIdx].close) || 0;

      if (pos?.side === "BUY" && crossDn)
        closeAt(nextIdx, nextOpen, "reverse-cross");
      else if (pos?.side === "SELL" && crossUp)
        closeAt(nextIdx, nextOpen, "reverse-cross");

      if (!pos) {
        const dailyStopped =
          (Number(lossCap) > 0 && dayPnL <= -Math.abs(Number(lossCap))) ||
          (Number(maxConsecLosses) > 0 &&
            lossStreak >= Number(maxConsecLosses));
        if (!dailyStopped) {
          if (crossUp)
            pos = { side: "BUY", entryIdx: nextIdx, entryPrice: nextOpen };
          else if (crossDn)
            pos = { side: "SELL", entryIdx: nextIdx, entryPrice: nextOpen };
        }
      }
    }

    if (pos) {
      const lastIdx = candles.length - 1;
      const px = Number.isFinite(candles[lastIdx].close)
        ? Number(candles[lastIdx].close)
        : Number(candles[lastIdx].open) || 0;
      closeAt(lastIdx, px, "end");
    }

    // Métricas
    const wins = trades.filter((t) => t.pnl > 0).length;
    const losses = trades.filter((t) => t.pnl < 0).length;
    const ties = trades.filter((t) => t.pnl === 0).length;
    const pnlPoints = Number(
      trades.reduce((a, b) => a + (isFinite(b.pnl) ? b.pnl : 0), 0).toFixed(2)
    );
    const sumWin = trades
      .filter((t) => t.pnl > 0)
      .reduce((a, b) => a + b.pnl, 0);
    const sumLossAbs = Math.abs(
      trades.filter((t) => t.pnl < 0).reduce((a, b) => a + b.pnl, 0)
    );
    const profitFactor =
      sumLossAbs > 0
        ? Number((sumWin / sumLossAbs).toFixed(3))
        : wins > 0
        ? Infinity
        : 0;
    const avgPnL = trades.length
      ? Number((pnlPoints / trades.length).toFixed(2))
      : 0;

    let peak = 0,
      dd = 0,
      run = 0;
    for (const t of trades) {
      run += t.pnl;
      peak = Math.max(peak, run);
      dd = Math.min(dd, run - peak);
    }
    const maxDrawdown = Number(dd.toFixed(2));
    const pnlMoney = Number((pnlPoints * Number(pointValue)).toFixed(2));

    return res.status(200).json(
      ok({
        symbol: sym,
        timeframe: tfU,
        from: fromD.toISOString(),
        to: toD.toISOString(),
        candles: candles.length,
        trades,
        summary: {
          trades: trades.length,
          wins,
          losses,
          ties,
          winRate: trades.length
            ? Number((wins / trades.length).toFixed(4))
            : 0,
          pnlPoints,
          avgPnL,
          profitFactor,
          maxDrawdown,
        },
        pnlPoints,
        pnlMoney,
        lossCapApplied: Number(lossCap) || 0,
        maxConsecLossesApplied: Number(maxConsecLosses) || 0,
      })
    );
  } catch (e: any) {
    return res.status(200).json(bad("unexpected", diagify(e)));
  }
});

export default router;
