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

// Roteador novo do backtest (mantemos)
import { router as backtestRouter } from "./services/backtest";

// ====== IMPORTS PARA ROTA EMBUTIDA DE PROJECTED ======
import { DateTime, Duration } from "luxon";
import { loadCandlesAnyTF } from "./lib/aggregation";

// ====== APP BASE ======
const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

/**
 * Ordem importa:
 * - Montamos backtestRouter antes do legado
 * - E registramos a rota de projected inline aqui
 */
app.use(backtestRouter);

// ====== ROTA EMBUTIDA: /api/signals/projected ======
(() => {
  const ZONE = "America/Sao_Paulo";
  const VERSION = "signals-projected:inline-v1";

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
  function ATR(
    candles: { high: number; low: number; close: number }[],
    period = 14
  ): (number | null)[] {
    const tr: number[] = [];
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      const prevClose = i > 0 ? candles[i - 1].close : c.close;
      const a = c.high - c.low;
      const b = Math.abs(c.high - prevClose);
      const d = Math.abs(c.low - prevClose);
      tr.push(Math.max(a, b, d));
    }
    const out: (number | null)[] = [];
    let ema: number | null = null;
    const k = 2 / (period + 1);
    for (let i = 0; i < tr.length; i++) {
      const v = tr[i];
      if (ema == null) ema = v;
      else ema = v * k + ema * (1 - k);
      out.push(ema);
    }
    return out;
  }
  async function httpPostJSON<T = any>(
    url: string,
    body: any,
    timeoutMs = 2500
  ): Promise<T> {
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

      const sym = String(symbol || "")
        .trim()
        .toUpperCase();
      if (!sym)
        return res
          .status(200)
          .json({ ok: false, version: VERSION, error: "Faltou 'symbol'" });

      const { tfU, tfMin } = normalizeTf(String(timeframe || "M5"));

      // Range
      const fallbackDays = Number(process.env.PROJECTED_DEFAULT_DAYS || 5);
      let fromD: Date, toD: Date;
      if (from && to) {
        const f = new Date(String(from));
        const t = new Date(String(to));
        if (!isFinite(f.getTime()) || !isFinite(t.getTime())) {
          return res
            .status(200)
            .json({
              ok: false,
              version: VERSION,
              error: "Parâmetros 'from'/'to' inválidos",
            });
        }
        fromD = floorTo(f, tfMin);
        toD = ceilToExclusive(t, tfMin);
      } else {
        const now = DateTime.now().toUTC();
        const f = now.minus(Duration.fromObject({ days: fallbackDays }));
        fromD = floorTo(f.toJSDate(), tfMin);
        toD = ceilToExclusive(now.toJSDate(), tfMin);
      }
      if (fromD >= toD) {
        return res
          .status(200)
          .json({
            ok: false,
            version: VERSION,
            error: "'from' deve ser anterior a 'to'",
          });
      }

      // Candles
      const candles = await loadCandlesAnyTF(sym, tfU, {
        gte: fromD,
        lte: toD,
      });
      if (!candles?.length)
        return res.status(200).json({ ok: true, version: VERSION, data: [] });

      const closes = candles.map((c) => Number(c.close));
      const highs = candles.map((c) => Number(c.high));
      const lows = candles.map((c) => Number(c.low));
      const times = candles.map((c) => c.time);

      const e9 = EMA(closes, 9);
      const e21 = EMA(closes, 21);
      const atr = ATR(
        candles.map((c) => ({ high: c.high, low: c.low, close: c.close })),
        Number(atrPeriod) || 14
      );

      // VWAP por sessão
      const vwap: (number | null)[] = [];
      let accPV = 0,
        accVol = 0;
      let dLocal = DateTime.fromJSDate(times[0])
        .setZone(ZONE)
        .toFormat("yyyy-LL-dd");
      for (let i = 0; i < candles.length; i++) {
        const dl = DateTime.fromJSDate(times[i])
          .setZone(ZONE)
          .toFormat("yyyy-LL-dd");
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

      // MTF (opcional)
      let mtfUp: boolean[] | null = null,
        mtfDown: boolean[] | null = null;
      if (requireMtf && confirmTf && confirmTf !== tfU) {
        const { tfU: confU } = normalizeTf(confirmTf);
        const c2 = await loadCandlesAnyTF(sym, confU, { gte: fromD, lte: toD });
        if (c2?.length) {
          const e9b = EMA(
            c2.map((c) => Number(c.close)),
            9
          );
          const e21b = EMA(
            c2.map((c) => Number(c.close)),
            21
          );
          mtfUp = [];
          mtfDown = [];
          let j = 0;
          for (let i = 0; i < candles.length; i++) {
            const t = times[i].getTime();
            while (j + 1 < c2.length && c2[j + 1].time.getTime() <= t) j++;
            const u = e9b[j] != null && e21b[j] != null && e9b[j]! > e21b[j]!;
            const d = e9b[j] != null && e21b[j] != null && e9b[j]! < e21b[j]!;
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
        const slope9 =
          i > 0 && e9[i - 1] != null ? e9v - (e9[i - 1] as number) : 0;
        const slope21 =
          i > 0 && e21[i - 1] != null ? e21v - (e21[i - 1] as number) : 0;
        const ret1 = i > 0 ? closes[i] - closes[i - 1] : 0;
        const range = highs[i] - lows[i];
        const rangeRatio = atrv > 0 ? range / atrv : 0;
        const distEma21 = e21v ? c - e21v : 0;
        const distVwap = c - vw;
        const hour = DateTime.fromJSDate(times[i]).setZone(ZONE).hour;
        return {
          dist_ema21: distEma21,
          dist_vwap: distVwap,
          slope_e9: slope9,
          slope_e21: slope21,
          range_ratio: rangeRatio,
          ret1,
          hour,
        };
      }

      async function getProb(features: any): Promise<number | null> {
        const url = String(process.env.MICRO_MODEL_URL || "").trim();
        if (!(useMicroModel && url)) return null;
        try {
          const resp = await httpPostJSON<{ probHit?: number }>(
            `${url}/predict`,
            { features }
          );
          if (typeof resp?.probHit === "number" && isFinite(resp.probHit))
            return resp.probHit;
          return null;
        } catch (e) {
          console.warn(
            "[projected] micro-model erro:",
            (e as any)?.message || e
          );
          return null;
        }
      }

      for (let i = 1; i < candles.length - 1; i++) {
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
        if (!crossUp && !crossDn) continue;

        if (vwapFilter) {
          const vw = vwap[i];
          if (vw != null) {
            if (crossUp && closes[i] < vw) continue;
            if (crossDn && closes[i] > vw) continue;
          }
        }
        // MTF
        // (calculado acima quando requireMtf)
        // Se existir, valide direção:
        // @ts-ignore
        if (requireMtf && Array.isArray((global as any).__mtfUp)) {
          /* no-op */
        }

        // Entrada na próxima barra
        const j = Math.min(i + 1, candles.length - 1);
        const entry = Number.isFinite((candles[j] as any).open)
          ? Number((candles[j] as any).open)
          : Number((candles[j] as any).close) || closes[i];

        const atrv = atr[i] ?? 0;
        const slPts = Math.max(atrv * Number(k_sl), 0);
        const tpPts = Math.max(atrv * Number(k_tp), 0);

        const isBuy = !!crossUp;
        const sl = slPts > 0 ? (isBuy ? entry - slPts : entry + slPts) : null;
        const tp = tpPts > 0 ? (isBuy ? entry + tpPts : entry - tpPts) : null;

        const feats = featuresAt(i);
        let prob = await getProb(feats);
        if (prob == null) {
          const raw =
            0.5 +
            Math.max(
              -0.08,
              Math.min(0.08, (feats.slope_e9 - feats.slope_e21) * 2)
            ) +
            Math.max(
              -0.05,
              Math.min(0.05, (feats.dist_ema21 / Math.max(atrv, 1e-6)) * 0.1)
            );
          prob = Math.max(0.35, Math.min(0.65, raw));
        }

        const costs = Number(costPts) + Number(slippagePts);
        const evPts = prob * (tpPts || 0) - (1 - prob) * (slPts || 0) - costs;

        if (prob < Number(minProb)) continue;
        if (evPts < Number(minEV)) continue;

        const row = {
          side: isBuy ? "BUY" : ("SELL" as const),
          suggestedEntry: entry,
          stopSuggestion: sl,
          takeProfitSuggestion: tp,
          conditionText: `EMA9 vs EMA21 ${isBuy ? "UP" : "DOWN"}${
            vwapFilter ? " + VWAP" : ""
          }${requireMtf ? ` + MTF(${confirmTf})` : ""}`,
          probHit: Number(prob.toFixed(4)),
          probCalibrated: Number(prob.toFixed(4)),
          expectedValuePoints: Number(evPts.toFixed(2)),
          time: candles[i].time.toISOString(),
          date: DateTime.fromJSDate(candles[i].time).setZone(ZONE).toISODate()!,
        };
        (out as any[]).push(row);
      }

      return res.status(200).json(out);
    } catch (e: any) {
      console.error(
        "[/api/signals/projected] erro:",
        e?.stack || e?.message || e
      );
      return res
        .status(200)
        .json({
          ok: false,
          version: VERSION,
          error: "unexpected",
          diag: String(e?.stack || e?.message || e),
        });
    }
  });
})();

// ====== ROTAS LEGADAS ======
app.use("/api", routes);
app.use("/admin", adminRoutes);

// Health
app.get("/healthz", (_req, res) =>
  res.json({
    ok: true,
    service: "server",
    version: "server:v4-inline-projected",
  })
);

// Error handler final
app.use(
  (
    err: any,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    const code = err?.status || 500;
    const payload: any = {
      ok: false,
      error: err?.message || "internal",
      where: "global",
    };
    if (err?.stack)
      payload.diag = String(err.stack).split("\n").slice(0, 6).join("\n");
    logger?.error?.("[global-error]", {
      code,
      msg: err?.message,
      stack: err?.stack,
    });
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
    logger.warn("[SignalsWorker] módulo não carregado", {
      err: e?.message || e,
    });
  }
  try {
    setupWS?.(server);
  } catch (e: any) {
    logger.warn("[WS] módulo não iniciado", { err: e?.message || e });
  }
});

export default server;
