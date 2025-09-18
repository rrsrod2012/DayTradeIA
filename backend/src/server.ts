/* eslint-disable no-console */
import express from "express";
import cors from "cors";
import { createServer } from "http";
import routes from "./routes";
import adminRoutes from "./routesAdmin";
import { bootCsvWatchersIfConfigured } from "./services/csvWatcher";
import { bootConfirmedSignalsWorker } from "./workers/confirmedSignalsWorker";
import { setupWS } from "./services/ws";
import logger from "./logger";

import { bootPipeline, processImportedRange } from "./services/pipeline";
// Roteador do backtest
import { router as backtestRouter } from "./services/backtest";

import { DateTime, Duration } from "luxon";
import { loadCandlesAnyTF } from "./lib/aggregation";

// AutoTrainer
import { startAutoTrainer, stopAutoTrainer, statusAutoTrainer as _statusAutoTrainer } from "./workers/autoTrainer";

// prisma + backfill de sinais confirmados
import { prisma } from "./prisma";
import { backfillCandlesAndSignals } from "./workers/confirmedSignalsWorker";

const app = express();

// ====== Timezone/base para normalização de filtros de data ======
const ZONE_BR = "America/Sao_Paulo";

// util: sem cache p/ endpoints dinâmicos
function noStore(res: express.Response) {
  res.setHeader("Cache-Control", "no-store, must-revalidate");
}

/** Parse flexível: ISO (com/sem hora) ou BR "dd/MM/yyyy[ HH:mm[:ss]]" — tudo no fuso de SP */
function parseUserDate(raw: any): { ok: boolean; dt: DateTime; isDateOnly: boolean } {
  if (raw == null) return { ok: false, dt: DateTime.invalid("empty"), isDateOnly: false };
  const s = String(raw).trim();

  // BR: dd/MM/yyyy [HH:mm[:ss]]
  const brFull = /^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;
  const m = brFull.exec(s);
  if (m) {
    const dt = DateTime.fromFormat(s, m[4] ? (m[6] ? "dd/LL/yyyy HH:mm:ss" : "dd/LL/yyyy HH:mm") : "dd/LL/yyyy", {
      zone: ZONE_BR,
    });
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

/** Normaliza um range de usuário para [fromLocal, toLocal] cobrindo o DIA INTEIRO quando data é “só a data” */
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
  return { fromLocal, toLocal };
}

// ===== CORS (com credenciais) + preflight =====
const ORIGINS =
  process.env.CORS_ORIGIN?.split(",").map((s) => s.trim()).filter(Boolean) || ["http://localhost:5173"];

app.use(
  cors({
    origin: ORIGINS,
    credentials: true,
  })
);
app.options(
  "*",
  cors({
    origin: ORIGINS,
    credentials: true,
  })
);

app.use(express.json({ limit: "5mb" }));

/**
 * Ordem:
 * - backtestRouter antes do legado
 * - rotas inline (projected + fallbacks + debug)
 * - rotas legadas
 */
app.use(backtestRouter);

/* =========================
   /api/signals/projected (inline)
   ========================= */
(() => {
  const ZONE = "America/Sao_Paulo";

  function normalizeTf(tfRaw: string): { tfU: string; tfMin: number } {
    const s = String(tfRaw || "").trim().toUpperCase();
    if (!s) return { tfU: "M5", tfMin: 5 };
    if (s.startsWith("M") || s.startsWith("H")) {
      const unit = s[0];
      const num = parseInt(s.slice(1), 10) || (unit === "H" ? 1 : 5);
      return { tfU: `${unit}${num}`, tfMin: unit === "H" ? num * 60 : num };
    }
    const m = /(\d+)\s*(M|MIN|MINUTES|m)?/.exec(s);
    if (m) {
      const num = parseInt(m[1], 10) || 5;
      return { tfU: `M${num}`, tfMin: num };
    }
    return { tfU: "M5", tfMin: 5 };
  }
  const floorTo = (d: Date, tfMin: number) =>
    DateTime.fromJSDate(d).toUTC().set({
      second: 0,
      millisecond: 0,
      minute: Math.floor(DateTime.fromJSDate(d).toUTC().minute / tfMin) * tfMin,
    }).toJSDate();

  const ceilToExclusive = (d: Date, tfMin: number) =>
    DateTime.fromJSDate(d).toUTC().set({
      second: 0,
      millisecond: 0,
      minute: Math.floor(DateTime.fromJSDate(d).toUTC().minute / tfMin) * tfMin + tfMin,
    }).toJSDate();

  const EMA = (values: number[], period: number): (number | null)[] => {
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
  };

  const ATR = (candles: { high: number; low: number; close: number }[], period = 14): (number | null)[] => {
    const tr: number[] = [];
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      const prevClose = i > 0 ? candles[i - 1].close : c.close;
      tr.push(Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose)));
    }
    const out: (number | null)[] = [];
    let ema: number | null = null;
    const k = 2 / (period + 1);
    for (let i = 0; i < tr.length; i++) {
      const v = tr[i];
      ema = ema == null ? v : v * k + ema * (1 - k);
      out.push(ema);
    }
    return out;
  };

  async function httpPostJSON<T = any>(url: string, body: any, timeoutMs = 2500): Promise<T> {
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
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      return data as T;
    } finally {
      clearTimeout(to);
    }
  }

  app.post("/api/signals/projected", express.json(), async (req, res) => {
    noStore(res);
    try {
      const {
        symbol,
        timeframe,
        from,
        to,
        rr = 2,
        minProb = 0,
        minEV = -Infinity,
        useMicroModel = true,
        vwapFilter = false,
        requireMtf = false,
        confirmTf = "M15",
        costPts = 0,
        slippagePts = 0,
        atrPeriod = 14,
        k_sl = 1.0,
        k_tp = rr,
      } = req.body || {};

      const sym = String(symbol || "").trim().toUpperCase();
      if (!sym) return res.status(200).json([]);

      const { tfU, tfMin } = normalizeTf(String(timeframe || "M5"));

      // ====== Range ======
      let fromD: Date, toD: Date;
      const norm = normalizeDayRange(from, to);
      if (norm) {
        fromD = floorTo(norm.fromLocal.toUTC().toJSDate(), tfMin);
        toD = ceilToExclusive(norm.toLocal.toUTC().toJSDate(), tfMin);
      } else {
        const fallbackDays = Number(process.env.PROJECTED_DEFAULT_DAYS || 1);
        const now = DateTime.now().setZone(ZONE_BR).toUTC();
        const f = now.minus(Duration.fromObject({ days: fallbackDays }));
        fromD = floorTo(f.toJSDate(), tfMin);
        toD = ceilToExclusive(now.toJSDate(), tfMin);
      }
      if (fromD >= toD) return res.status(200).json([]);

      // Candles
      const candles = await loadCandlesAnyTF(sym, tfU, { gte: fromD, lte: toD } as any);
      if (!candles?.length) return res.status(200).json([]);

      const closes = candles.map((c) => Number(c.close));
      const highs = candles.map((c) => Number(c.high));
      const lows = candles.map((c) => Number(c.low));
      const times = candles.map((c) => c.time);

      const e9 = EMA(closes, 9);
      const e21 = EMA(closes, 21);
      const atr = ATR(candles.map((c) => ({ high: c.high, low: c.low, close: c.close })), Number(atrPeriod) || 14);

      // VWAP por sessão (dia local em SP)
      const vwap: (number | null)[] = [];
      let accPV = 0, accVol = 0;
      let dLocal = DateTime.fromJSDate(times[0]).setZone(ZONE).toFormat("yyyy-LL-dd");
      for (let i = 0; i < candles.length; i++) {
        const dl = DateTime.fromJSDate(times[i]).setZone(ZONE).toFormat("yyyy-LL-dd");
        if (dl !== dLocal) {
          accPV = 0;
          accVol = 0;
          dLocal = dl;
        }
        const typical = (highs[i] + lows[i] + closes[i]) / 3;
        const vol = Number((candles[i] as any).volume ?? 1);
        accPV += typical * vol;
        accVol += vol;
        vwap.push(accVol > 0 ? accPV / accVol : null);
      }

      // (MTF opcional)
      let mtfUp: boolean[] | null = null, mtfDown: boolean[] | null = null;
      if (requireMtf && confirmTf && confirmTf !== tfU) {
        const { tfU: confU } = normalizeTf(confirmTf);
        const c2 = await loadCandlesAnyTF(sym, confU, { gte: fromD, lte: toD } as any);
        if (c2?.length) {
          const e9b = EMA(c2.map((c) => Number(c.close)), 9);
          const e21b = EMA(c2.map((c) => Number(c.close)), 21);
          mtfUp = [];
          mtfDown = [];
          let j = 0;
          for (let i = 0; i < candles.length; i++) {
            const t = times[i].getTime();
            while (j + 1 < c2.length && c2[j + 1].time.getTime() <= t) j++;
            const u = e9b[j] != null && e21b[j] != null && (e9b[j] as number) > (e21b[j] as number);
            const d = e9b[j] != null && e21b[j] != null && (e9b[j] as number) < (e21b[j] as number);
            mtfUp.push(!!u);
            mtfDown.push(!!d);
          }
        }
      }

      type Row = {
        side: "BUY" | "SELL" | "FLAT";
        suggestedEntry: number | null;
        stopSuggestion: number | null;
        takeProfitSuggestion: number | null;
        conditionText: string;
        probHit?: number | null;
        probCalibrated?: number | null;
        expectedValuePoints?: number | null;
        time: string;
        date: string;
      };
      const out: Row[] = [];

      function featuresAt(i: number) {
        const c = closes[i];
        const e9v = e9[i] ?? c;
        const e21v = e21[i] ?? c;
        const atrv = atr[i] ?? 0;
        const vw = vwap[i] ?? c;
        const slope9 = i > 0 && e9[i - 1] != null ? (e9v as number) - (e9[i - 1] as number) : 0;
        const slope21 = i > 0 && e21[i - 1] != null ? (e21v as number) - (e21[i - 1] as number) : 0;
        const range = highs[i] - lows[i];
        const rangeRatio = atrv > 0 ? range / atrv : 0;
        const distEma21 = e21v ? (c as number) - (e21v as number) : 0;
        const distVwap = (c as number) - (vw as number);
        return { dist_ema21: distEma21, dist_vwap: distVwap, slope_e9: slope9, slope_e21: slope21, range_ratio: rangeRatio };
      }

      async function getProb(_features: any): Promise<number | null> {
        const url = String(process.env.MICRO_MODEL_URL || "").trim();
        if (!(useMicroModel && url)) return null;
        try {
          const resp = await httpPostJSON<{ probHit?: number }>(`${url}/predict`, { features: _features });
          if (typeof resp?.probHit === "number" && isFinite(resp.probHit)) return resp.probHit;
          return null;
        } catch {
          return null;
        }
      }

      for (let i = 1; i < candles.length - 1; i++) {
        const prevUp = e9[i - 1] != null && e21[i - 1] != null && (e9[i - 1] as number) <= (e21[i - 1] as number);
        const nowUp = e9[i] != null && e21[i] != null && (e9[i] as number) > (e21[i] as number);
        const prevDn = e9[i - 1] != null && e21[i - 1] != null && (e9[i - 1] as number) >= (e21[i - 1] as number);
        const nowDn = e9[i] != null && e21[i] != null && (e9[i] as number) < (e21[i] as number);
        const crossUp = prevUp && nowUp;
        const crossDn = prevDn && nowDn;
        if (!crossUp && !crossDn) continue;

        if (vwapFilter) {
          const vw = vwap[i];
          if (vw != null) {
            if (crossUp && closes[i] < (vw as number)) continue;
            if (crossDn && closes[i] > (vw as number)) continue;
          }
        }
        if (requireMtf && mtfUp && mtfDown) {
          if (crossUp && !mtfUp[i]) continue;
          if (crossDn && !mtfDown[i]) continue;
        }

        const j = Math.min(i + 1, candles.length - 1);
        const entry = Number.isFinite((candles[j] as any).open) ? Number((candles[j] as any).open) : Number((candles[j] as any).close) || Number(candles[i].close);

        const atrv = atr[i] ?? 0;
        const isBuy = !!crossUp;

        const slPts = atrv > 0 ? Math.max(atrv * Number(k_sl), 0) : 0;
        const tpPts = atrv > 0 ? Math.max(atrv * Number(k_tp), 0) : 0;

        const sl = slPts > 0 ? (isBuy ? entry - slPts : entry + slPts) : null;
        const tp = tpPts > 0 ? (isBuy ? entry + tpPts : entry - tpPts) : null;

        let prob = await getProb(featuresAt(i));
        if (prob == null) {
          const e9v0 = e9[i] ?? entry;
          const e21v0 = e21[i] ?? entry;
          const raw =
            0.5 +
            Math.max(-0.08, Math.min(0.08, ((e9v0 as number) - (e21v0 as number)) * 0.002)) +
            Math.max(-0.05, Math.min(0.05, ((entry - (e21v0 as number)) / Math.max(atrv || 1e-6, 1e-6)) * 0.1));
          prob = Math.max(0.35, Math.min(0.65, raw));
        }

        const costs = Number(costPts) + Number(slippagePts);
        const evPts = (tpPts || 0) * prob - (slPts || 0) * (1 - prob) - costs;

        if (prob < Number(minProb)) continue;
        if (evPts < Number(minEV)) continue;

        const row: Row = {
          side: isBuy ? "BUY" : "SELL",
          suggestedEntry: entry,
          stopSuggestion: sl,
          takeProfitSuggestion: tp,
          conditionText: `EMA9 vs EMA21 ${isBuy ? "UP" : "DOWN"}${vwapFilter ? " + VWAP" : ""}${requireMtf ? ` + MTF(${confirmTf})` : ""}`,
          probHit: Number(prob.toFixed(4)),
          probCalibrated: Number(prob.toFixed(4)),
          expectedValuePoints: Number((isFinite(evPts) ? evPts : 0).toFixed(2)),
          time: candles[i].time.toISOString(),
          date: DateTime.fromJSDate(candles[i].time).setZone(ZONE).toISODate()!,
        };
        out.push(row);
      }

      out.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
      return res.status(200).json(out);
    } catch (e: any) {
      console.error("[/api/signals/projected] erro:", e?.stack || e?.message || e);
      return res.status(200).json([]);
    }
  });
})();

/* =========================
   Fallback /api/candles — normalização de 1 dia
   ========================= */
app.get("/api/candles", async (req, res) => {
  noStore(res);
  try {
    const symbol = String(req.query.symbol || "").trim().toUpperCase();
    const timeframe = String(req.query.timeframe || "M5").trim().toUpperCase();
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    if (!symbol) return res.status(400).json({ ok: false, error: "Faltou 'symbol'" });

    const norm = normalizeDayRange(req.query.from, req.query.to);
    let f: Date, t: Date;
    if (norm) {
      f = norm.fromLocal.toUTC().toJSDate();
      t = norm.toLocal.toUTC().toJSDate();
    } else {
      const now = DateTime.now().setZone(ZONE_BR);
      f = now.minus({ days: 1 }).startOf("day").toUTC().toJSDate();
      t = now.endOf("day").toUTC().toJSDate();
    }

    const rows = await loadCandlesAnyTF(symbol, timeframe, { gte: f, lte: t, /* @ts-ignore */ limit } as any);
    const out = (rows || []).map((c) => ({
      time: c.time.toISOString(),
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: Number((c as any).volume ?? 0),
    }));
    return res.json(out);
  } catch (e: any) {
    console.error("[/api/candles] erro:", e?.message || e);
    return res.status(200).json({ ok: false, error: e?.message || String(e) });
  }
});

/* =========================
   Fallback /api/signals (confirmados EMA) — com range de 1 dia
   ========================= */
app.get("/api/signals", async (req, res) => {
  noStore(res);
  try {
    const symbol = String(req.query.symbol || "").trim().toUpperCase();
    const timeframe = String(req.query.timeframe || "M5").trim().toUpperCase();
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    if (!symbol) return res.status(400).json({ ok: false, error: "Faltou 'symbol'" });

    const norm = normalizeDayRange(req.query.from, req.query.to);
    let f: Date, t: Date;
    if (norm) {
      f = norm.fromLocal.toUTC().toJSDate();
      t = norm.toLocal.toUTC().toJSDate();
    } else {
      const now = DateTime.now().setZone(ZONE_BR);
      f = now.minus({ days: 1 }).startOf("day").toUTC().toJSDate();
      t = now.endOf("day").toUTC().toJSDate();
    }

    const rows = await loadCandlesAnyTF(symbol, timeframe, { gte: f, lte: t, /* @ts-ignore */ limit } as any);
    if (!rows?.length) return res.json([]);

    const closes = rows.map((c) => (Number.isFinite(c.close) ? Number(c.close) : Number(c.open) || 0));
    const EMA = (values: number[], period: number): (number | null)[] => {
      const out: (number | null)[] = [];
      const k = 2 / (period + 1);
      let ema: number | null = null;
      for (let i = 0; i < values.length; i++) {
        const v = values[i];
        ema = ema == null ? v : v * k + (ema as number) * (1 - k);
        out.push(ema);
      }
      return out;
    };
    const e9 = EMA(closes, 9);
    const e21 = EMA(closes, 21);

    const out: any[] = [];
    for (let i = 1; i < rows.length; i++) {
      const prevUp = e9[i - 1] != null && e21[i - 1] != null && (e9[i - 1] as number) <= (e21[i - 1] as number);
      const nowUp = e9[i] != null && e21[i] != null && (e9[i] as number) > (e21[i] as number);
      const prevDn = e9[i - 1] != null && e21[i - 1] != null && (e9[i - 1] as number) >= (e21[i - 1] as number);
      const nowDn = e9[i] != null && e21[i] != null && (e9[i] as number) < (e21[i] as number);
      const crossUp = prevUp && nowUp;
      const crossDn = prevDn && nowDn;
      if (!crossUp && !crossDn) continue;

      out.push({
        side: crossUp ? "BUY" : "SELL",
        time: rows[i].time.toISOString(),
        price: Number(rows[i].close),
        note: "EMA9xEMA21",
      });
    }

    out.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
    return res.json(out);
  } catch (e: any) {
    console.error("[/api/signals] erro:", e?.message || e);
    return res.status(200).json({ ok: false, error: e?.message || String(e) });
  }
});

/* =========================
   Diagnóstico rápido
   ========================= */
app.get("/api/debug/availability", async (_req, res) => {
  try {
    const syms = (process.env.DEBUG_SYMBOLS || "WIN,WDO").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    const tfs = (process.env.DEBUG_TFS || "M1,M5,M15,H1").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    const now = DateTime.now().setZone(ZONE_BR);
    const from = now.minus({ days: 30 }).startOf("day").toUTC().toJSDate();
    const to = now.endOf("day").toUTC().toJSDate();
    const out: any[] = [];
    for (const s of syms) {
      for (const tf of tfs) {
        try {
          const rows = await loadCandlesAnyTF(s, tf, { gte: from, lte: to, /* @ts-ignore */ limit: 5_000 } as any);
          out.push({
            symbol: s,
            timeframe: tf,
            count: rows?.length || 0,
            first: rows?.[0]?.time?.toISOString?.() || null,
            last: rows?.[rows.length - 1]?.time?.toISOString?.() || null,
          });
        } catch (e: any) {
          out.push({ symbol: s, timeframe: tf, error: e?.message || String(e) });
        }
      }
    }
    return res.json({ ok: true, data: out });
  } catch (e: any) {
    return res.status(200).json({ ok: false, error: e?.message || String(e) });
  }
});

/* =========================
   /api/trades
   ========================= */
app.get("/api/trades", async (req, res) => {
  noStore(res);
  try {
    const symbol = String(req.query.symbol || "").trim().toUpperCase() || undefined;
    const timeframe = String(req.query.timeframe || "").trim().toUpperCase() || undefined;
    const limit = req.query.limit ? Math.max(1, Number(req.query.limit)) : 200;

    // período usa a data do candle do entrySignal
    const norm = normalizeDayRange(req.query.from, req.query.to);
    let f: Date | undefined, t: Date | undefined;
    if (norm) {
      f = norm.fromLocal.toUTC().toJSDate();
      t = norm.toLocal.toUTC().toJSDate();
    }

    // where base
    const where: any = {};
    if (timeframe) where.timeframe = timeframe;

    // símbolo via relação instrument.symbol
    const instrumentFilter = symbol ? { symbol } : undefined;

    const trades = await prisma.trade.findMany({
      where,
      orderBy: { id: "desc" },
      take: limit,
      include: {
        instrument: { select: { id: true, symbol: true, name: true } },
        entrySignal: { select: { id: true, side: true, candle: { select: { time: true } } } },
        exitSignal: { select: { id: true, candle: { select: { time: true } } } },
      },
    });

    // filtros pós-query (por relação)
    const filtered = trades.filter((tr) => {
      if (instrumentFilter && tr.instrument.symbol.toUpperCase() !== instrumentFilter.symbol) return false;
      if (f || t) {
        const et = tr.entrySignal?.candle?.time ? new Date(tr.entrySignal.candle.time) : null;
        if (et) {
          if (f && et < f) return false;
          if (t && et > t) return false;
        }
      }
      return true;
    });

    const out = filtered.map((tr) => {
      const entryTime = tr.entrySignal?.candle?.time ? new Date(tr.entrySignal.candle.time).toISOString() : null;
      const exitTime = tr.exitSignal?.candle?.time ? new Date(tr.exitSignal.candle.time).toISOString() : null;
      return {
        id: tr.id,
        symbol: tr.instrument.symbol,
        timeframe: tr.timeframe,
        qty: tr.qty,
        side: tr.entrySignal?.side || null,
        entrySignalId: tr.entrySignalId,
        exitSignalId: tr.exitSignalId,
        entryPrice: tr.entryPrice,
        exitPrice: tr.exitPrice,
        // ⬇ sua UI às vezes lê pnlMoney; aqui exponho os dois
        pnlPoints: tr.pnlPoints,
        pnlMoney: tr.pnlMoney,
        entryTime,
        exitTime,
      };
    });

    return res.json(out);
  } catch (e: any) {
    console.error("[/api/trades] erro:", e?.message || e);
    return res.status(200).json({ ok: false, error: e?.message || String(e) });
  }
});

/* =========================
   /admin/trades/backfill
   ========================= */
app.post("/admin/trades/backfill", async (req, res) => {
  try {
    const q = { ...req.query, ...(req.body || {}) } as any;

    const symbol = String(q.symbol || "").trim().toUpperCase() || undefined;
    const timeframe = q.timeframe ? String(q.timeframe).trim().toUpperCase() : undefined;

    const norm = normalizeDayRange(q.from, q.to);
    let from: Date | undefined, to: Date | undefined;
    if (norm) {
      from = norm.fromLocal.toUTC().toJSDate();
      to = norm.toLocal.toUTC().toJSDate();
    } else if (q.days) {
      const days = Math.max(1, Number(q.days) || 1);
      const now = DateTime.now().setZone(ZONE_BR);
      from = now.minus({ days }).startOf("day").toUTC().toJSDate();
      to = now.endOf("day").toUTC().toJSDate();
    }

    const r = await processImportedRange({ symbol, timeframe, from, to });
    return res.json({ ok: true, input: { symbol, timeframe, from, to }, result: r });
  } catch (e: any) {
    console.error("[/admin/trades/backfill] erro:", e?.message || e);
    return res.status(200).json({ ok: false, error: e?.message || String(e) });
  }
});

/* =========================
   /admin/signals/backfill  → gera sinais confirmados (EMA_CROSS)
   ========================= */
app.post("/admin/signals/backfill", async (req, res) => {
  try {
    const q = { ...req.query, ...(req.body || {}) } as any;
    const symbol = String(q.symbol || "").trim().toUpperCase();
    const timeframe = String(q.timeframe || "M5").trim().toUpperCase() as "M1" | "M5" | "M15" | "M30" | "H1";

    if (!symbol) return res.status(200).json({ ok: false, error: "Faltou 'symbol'" });

    const inst = await prisma.instrument.findFirst({ where: { symbol }, select: { id: true } });
    if (!inst) return res.status(200).json({ ok: false, error: "Instrumento não encontrado" });

    const r = await backfillCandlesAndSignals(inst.id, timeframe);
    return res.json({ ok: true, input: { symbol, timeframe }, result: r });
  } catch (e: any) {
    console.error("[/admin/signals/backfill] erro:", e?.message || e);
    return res.status(200).json({ ok: false, error: e?.message || String(e) });
  }
});

/* =========================
   /admin/rebuild/trades → sinais + trades
   ========================= */
app.post("/admin/rebuild/trades", async (req, res) => {
  try {
    const q = { ...req.query, ...(req.body || {}) } as any;
    const symbol = String(q.symbol || "").trim().toUpperCase();
    const timeframe = String(q.timeframe || "M5").trim().toUpperCase();

    if (!symbol) return res.status(200).json({ ok: false, error: "Faltou 'symbol'" });

    const inst = await prisma.instrument.findFirst({ where: { symbol }, select: { id: true } });
    if (!inst) return res.status(200).json({ ok: false, error: "Instrumento não encontrado" });

    const rSignals = await backfillCandlesAndSignals(inst.id, timeframe as any);

    const norm = normalizeDayRange(q.from, q.to);
    let from: Date | undefined, to: Date | undefined;
    if (norm) {
      from = norm.fromLocal.toUTC().toJSDate();
      to = norm.toLocal.toUTC().toJSDate();
    } else if (q.days) {
      const days = Math.max(1, Number(q.days) || 1);
      const now = DateTime.now().setZone(ZONE_BR);
      from = now.minus({ days }).startOf("day").toUTC().toJSDate();
      to = now.endOf("day").toUTC().toJSDate();
    }

    const rTrades = await processImportedRange({ symbol, timeframe, from, to });

    return res.json({ ok: true, input: { symbol, timeframe, from, to }, signals: rSignals, trades: rTrades });
  } catch (e: any) {
    console.error("[/admin/rebuild/trades] erro:", e?.message || e);
    return res.status(200).json({ ok: false, error: e?.message || String(e) });
  }
});

/* =========================
   Admin: AutoTrainer
   ========================= */
app.get("/admin/auto-trainer/status", async (_req, res) => {
  const st = await _statusAutoTrainer();
  res.json(st);
});
app.post("/admin/auto-trainer/start", async (_req, res) => {
  const r = await startAutoTrainer();
  res.json(r);
});
app.post("/admin/auto-trainer/stop", async (_req, res) => {
  const r = await stopAutoTrainer();
  res.json(r);
});

/* =========================
   Admin: Diagnóstico — EFETIVO de config do .env
   ========================= */
function envBool(v: any, def: boolean) {
  const s = String(v ?? "").trim();
  if (s === "1" || /^true$/i.test(s)) return true;
  if (s === "0" || /^false$/i.test(s)) return false;
  return def;
}
function envNum(v: any, def: number) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
app.get("/admin/config/effective", (_req, res) => {
  const eff = {
    PORT: process.env.PORT || null,
    AUTO_TRAINER_BE_ENABLED: envBool(process.env.AUTO_TRAINER_BE_ENABLED, true),
    AUTO_TRAINER_BE_TRIGGER_ATR: envNum(process.env.AUTO_TRAINER_BE_TRIGGER_ATR, 1.0),
    AUTO_TRAINER_BE_TRIGGER_POINTS: envNum(process.env.AUTO_TRAINER_BE_TRIGGER_POINTS, 200),
    AUTO_TRAINER_BE_OFFSET_POINTS: envNum(process.env.AUTO_TRAINER_BE_OFFSET_POINTS, 0),
    AUTO_TRAINER_TRAIL_ENABLED: envBool(process.env.AUTO_TRAINER_TRAIL_ENABLED, true),
    AUTO_TRAINER_TRAIL_AFTER_BE_ONLY: envBool(process.env.AUTO_TRAINER_TRAIL_AFTER_BE_ONLY, false),
    AUTO_TRAINER_TRAIL_ATR: envNum(process.env.AUTO_TRAINER_TRAIL_ATR, 0.75),
    AUTO_TRAINER_PARTIAL_ENABLED: envBool(process.env.AUTO_TRAINER_PARTIAL_ENABLED, true),
    AUTO_TRAINER_PARTIAL_RATIO: envNum(process.env.AUTO_TRAINER_PARTIAL_RATIO, 0.5),
    AUTO_TRAINER_PARTIAL_ATR: envNum(process.env.AUTO_TRAINER_PARTIAL_ATR, 0.5),
    AUTO_TRAINER_PARTIAL_BREAKEVEN_AFTER: envBool(process.env.AUTO_TRAINER_PARTIAL_BREAKEVEN_AFTER, true),
    AUTO_TRAINER_PRIORITY: String(process.env.AUTO_TRAINER_PRIORITY || "TP_FIRST_AFTER_BE"),
    AUTO_TRAINER_FORCE_NO_LOSS_AFTER_MFE: envBool(process.env.AUTO_TRAINER_FORCE_NO_LOSS_AFTER_MFE, true),
    AUTO_TRAINER_FORCE_MFE_POINTS: envNum(process.env.AUTO_TRAINER_FORCE_MFE_POINTS, 200),
    AUTO_TRAINER_FORCE_OFFSET_POINTS: envNum(process.env.AUTO_TRAINER_FORCE_OFFSET_POINTS, envNum(process.env.AUTO_TRAINER_BE_OFFSET_POINTS, 0)),
    AUTO_TRAINER_HORIZON: envNum(process.env.AUTO_TRAINER_HORIZON, 12),
    AUTO_TRAINER_LOOKBACK: envNum(process.env.AUTO_TRAINER_LOOKBACK, 120),
    AUTO_TRAINER_RR: envNum(process.env.AUTO_TRAINER_RR, 2.0),
    AUTO_TRAINER_SL_ATR: envNum(process.env.AUTO_TRAINER_SL_ATR, 1.0),
  };
  return res.json({ ok: true, effective: eff });
});

/* =========================
   Admin: Diagnóstico — Inspect de trades
   ========================= */
app.get("/admin/trades/inspect", async (req, res) => {
  try {
    const symbol = String(req.query.symbol || "").trim().toUpperCase() || undefined;
    const timeframe = String(req.query.timeframe || "").trim().toUpperCase() || undefined;
    const limit = req.query.limit ? Math.max(1, Number(req.query.limit)) : 50;

    const where: any = {};
    if (timeframe) where.timeframe = timeframe;

    const trades = await prisma.trade.findMany({
      where,
      orderBy: { id: "desc" },
      take: limit,
      include: {
        instrument: { select: { symbol: true } },
        entrySignal: {
          select: {
            id: true,
            side: true,
            candle: { select: { time: true } },
          },
        },
        exitSignal: {
          select: {
            id: true,
            signalType: true,
            reason: true, // <- aqui vem o diag={...} se o pipeline novo rodou
            candle: { select: { time: true } },
          },
        },
      },
    });

    const out = trades
      .filter((tr) => !symbol || tr.instrument.symbol.toUpperCase() === symbol)
      .map((tr) => ({
        id: tr.id,
        symbol: tr.instrument.symbol,
        timeframe: tr.timeframe,
        side: tr.entrySignal?.side || null,
        entryPrice: tr.entryPrice,
        exitPrice: tr.exitPrice,
        pnlPoints: tr.pnlPoints,
        entryTime: tr.entrySignal?.candle?.time ? new Date(tr.entrySignal.candle.time).toISOString() : null,
        exitTime: tr.exitSignal?.candle?.time ? new Date(tr.exitSignal.candle.time).toISOString() : null,
        exitSignalType: tr.exitSignal?.signalType || null,
        exitReason: tr.exitSignal?.reason || null,
      }));

    return res.json({ ok: true, data: out });
  } catch (e: any) {
    console.error("[/admin/trades/inspect] erro:", e?.message || e);
    return res.status(200).json({ ok: false, error: e?.message || String(e) });
  }
});

// ====== ROTAS LEGADAS ======
app.use("/api", routes);
app.use("/admin", adminRoutes);

// Health
app.get("/healthz", (_req, res) =>
  res.json({
    ok: true,
    service: "server",
    version: "server:v5-date-normalized",
  })
);

// Error handler final
app.use(
  (err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const code = err?.status || 500;
    const payload: any = {
      ok: false,
      error: err?.message || "internal",
      where: "global",
    };
    if (err?.stack) payload.diag = String(err.stack).split("\n").slice(0, 6).join("\n");
    logger?.error?.("[global-error]", { code, msg: err?.message, stack: err?.stack });
    res.status(code).json(payload);
  }
);

const server = createServer(app);
const PORT = Number(process.env.PORT || 4000);

server.listen(PORT, () => {
  logger.info(`[SERVER] ouvindo em http://localhost:${PORT}`);
  try {
    bootCsvWatchersIfConfigured?.();
  } catch (e: any) {
    logger.warn("[CSVWatcher] módulo não carregado", { err: e?.message || e });
  }
  try {
    bootConfirmedSignalsWorker?.();
  } catch (e: any) {
    logger.warn("[SignalsWorker] módulo não carregado", { err: e?.message || e });
  }
  try {
    setupWS?.(server);
  } catch (e: any) {
    logger.warn("[WS] módulo não iniciado", { err: e?.message || e });
  }
  try {
    bootPipeline?.();
  } catch (e: any) {
    logger.warn("[pipeline] módulo não iniciado", { err: e?.message || e });
  }

  // AutoTrainer on boot (se configurado)
  try {
    if ((process.env.MICRO_MODEL_URL || "").trim()) {
      const r = startAutoTrainer?.();
      if ((r as any)?.ok !== false) {
        logger.info("[AutoTrainer] iniciado automaticamente");
      } else {
        logger.warn("[AutoTrainer] não iniciou automaticamente", r);
      }
    } else {
      logger.warn("[AutoTrainer] MICRO_MODEL_URL não configurada — treino contínuo inativo");
    }
  } catch (e: any) {
    logger.warn("[AutoTrainer] falha ao iniciar no boot", { err: e?.message || e });
  }
});

export default server;
