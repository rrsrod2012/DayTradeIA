/* eslint-disable no-console */
import express from "express";
import { DateTime, Duration } from "luxon";
import { loadCandlesAnyTF } from "../lib/aggregation";

export const router = express.Router();

type TF = "M1" | "M5" | "M15" | "M30" | "H1";
const TF_MIN: Record<TF, number> = { M1: 1, M5: 5, M15: 15, M30: 30, H1: 60 };
const ZONE = "America/Sao_Paulo";

const VERSION = "backtest:v3.5-date-normalized";

/* ===== Helpers de timeframe/bucket ===== */
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
    ema = ema == null ? v : v * k + ema * (1 - k);
    out.push(ema);
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

/* ===== NOVO: parsing/normalização de datas no fuso de SP ===== */
function parseUserDate(raw: any): {
  ok: boolean;
  dt: DateTime;
  isDateOnly: boolean;
} {
  if (raw == null)
    return { ok: false, dt: DateTime.invalid("empty"), isDateOnly: false };
  let s = String(raw).trim();
  if (!s)
    return { ok: false, dt: DateTime.invalid("empty"), isDateOnly: false };

  // BR: dd/MM/yyyy [HH:mm[:ss]]
  const reBR =
    /^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2})(?::(\d{2})(?::(\d{2}))?)?)?$/;
  const m = reBR.exec(s);
  if (m) {
    const fmt = m[4]
      ? m[6]
        ? "dd/LL/yyyy HH:mm:ss"
        : "dd/LL/yyyy HH:mm"
      : "dd/LL/yyyy";
    const dt = DateTime.fromFormat(s, fmt, { zone: ZONE });
    return { ok: dt.isValid, dt, isDateOnly: !m[4] };
  }

  // ISO yyyy-MM-dd → só data
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const dt = DateTime.fromISO(s, { zone: ZONE });
    return { ok: dt.isValid, dt, isDateOnly: true };
  }

  // ISO com hora — tratamos como hora local (ignorando Z/offset se houver)
  if (/^\d{4}-\d{2}-\d{2}t/i.test(s)) {
    s = s.replace(/([+-]\d{2}:?\d{2}|Z)$/i, ""); // remove offset/Z para tratar como local
    const dt = DateTime.fromISO(s, { zone: ZONE });
    return { ok: dt.isValid, dt, isDateOnly: false };
  }

  // Epoch ms
  if (/^\d{10,13}$/.test(s)) {
    const n = Number(s);
    const dt = Number.isFinite(n)
      ? DateTime.fromMillis(n, { zone: ZONE })
      : DateTime.invalid("nan");
    return { ok: dt.isValid, dt, isDateOnly: false };
  }

  return { ok: false, dt: DateTime.invalid("unparsed"), isDateOnly: false };
}

function normalizeDayRange(
  fromRaw: any,
  toRaw: any
): { fromLocal: DateTime; toLocal: DateTime } | null {
  const pF = parseUserDate(fromRaw);
  const pT = parseUserDate(toRaw);

  if (!pF.ok && !pT.ok) return null;

  let fromLocal: DateTime;
  let toLocal: DateTime;

  if (pF.ok && pT.ok) {
    const sameDay =
      pF.dt.toFormat("yyyy-LL-dd") === pT.dt.toFormat("yyyy-LL-dd");
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

    // ==== NOVO: datas como dia inteiro em SP, depois em UTC + bucket ====
    const fallbackDays = Number(process.env.BACKTEST_DEFAULT_DAYS || 5);
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

    // ==== NOVO: datas como dia inteiro em SP, depois em UTC + bucket ====
    const fallbackDays = Number(process.env.BACKTEST_DEFAULT_DAYS || 5);
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
