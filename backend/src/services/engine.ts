import { prisma } from "../prisma";
import { DateTime } from "luxon";
import { Config } from "../config";
import { loadCandlesAnyTF, tfToMinutes } from "../lib/aggregation";

type Side = "BUY" | "SELL" | "FLAT";
type TrendBias = "UP" | "DOWN" | "SIDEWAYS";

export type ProjectedSignal = {
  side: Side;
  suggestedEntry: number;
  stopSuggestion?: number;
  takeProfitSuggestion?: number;
  conditionText: string;
  validCandles: number;
  expiresAt?: string;
  rationale: string;
  time?: string; // ISO UTC
  score?: number;
  probHit?: number;
  probCalibrated?: number;
  expectedValuePoints?: number;
  volatilityAtr?: number;
  bbWidthNow?: number;
  bbPercent?: number;
  vwapNow?: number;
  meta?: {
    trendBias: TrendBias;
    todWindow?: string;
    volZ?: number;
  };
};

type GenerateOpts = {
  symbol: string;
  timeframe: string;
  from?: string;
  to?: string;
  limit?: number;
  horizon?: number;
  rr?: number;
  evalWindow?: number;
  adaptive?: boolean;
  cooldown?: boolean;
  regime?: boolean;
  tod?: boolean;
  conformal?: boolean;
  costPts?: number;
  slippagePts?: number;
  requireMtf?: boolean;
  confirmTf?: string;
  cooldownSmart?: boolean;
  minProb?: number;
  minEV?: number;
};

const toUtcRange = (from?: string, to?: string) => {
  const zone = "America/Sao_Paulo";
  let gte: Date | undefined;
  let lte: Date | undefined;
  if (from)
    gte = DateTime.fromISO(from, { zone }).startOf("day").toUTC().toJSDate();
  if (to) lte = DateTime.fromISO(to, { zone }).endOf("day").toUTC().toJSDate();
  if (gte && lte) return { time: { gte, lte } };
  if (gte) return { time: { gte } };
  if (lte) return { time: { lte } };
  return {};
};

const timeOfDayBucket = (ts: string | Date) => {
  const d =
    ts instanceof Date
      ? DateTime.fromJSDate(ts, { zone: "America/Sao_Paulo" })
      : DateTime.fromISO(ts, { zone: "America/Sao_Paulo" });
  const hh = d.hour;
  if (hh < 10) return "PRE";
  if (hh < 12) return "MORNING";
  if (hh < 15) return "MID";
  return "CLOSE";
};

function ema(vals: number[], p: number) {
  const k = 2 / (p + 1);
  let e: number | null = null;
  return vals.map((v) => {
    e = e === null ? v : v * k + e * (1 - k);
    return e!;
  });
}
function inferTrend(closes: number[]): TrendBias {
  if (closes.length < 21) return "SIDEWAYS";
  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  const last = closes.length - 1;
  if (e9[last] > e21[last]) return "UP";
  if (e9[last] < e21[last]) return "DOWN";
  return "SIDEWAYS";
}

async function loadCloses(
  symbol: string,
  timeframe: string,
  from?: string,
  to?: string,
  take?: number
) {
  const range = toUtcRange(from, to).time as any;
  const rows = await loadCandlesAnyTF(symbol, timeframe, range);
  const arr = rows.map((r) => r.close);
  if (take && take > 0) return arr.slice(-take);
  return arr;
}

export async function generateProjectedSignals(
  opts: GenerateOpts
): Promise<ProjectedSignal[]> {
  const {
    symbol,
    timeframe,
    from,
    to,
    limit = 500,
    horizon = 8,
    rr = 2,
    evalWindow = 200,
    adaptive = true,
    cooldown = true,
    regime = true,
    tod = true,
    conformal = false,

    costPts = Config.COST_PER_TRADE_POINTS,
    slippagePts = Config.SLIPPAGE_POINTS,
    requireMtf = Config.REQUIRE_MTF_CONFIRM,
    confirmTf = Config.MTF_CONFIRM_TF,
    cooldownSmart = Config.COOLDOWN_SMART,
    minProb = 0,
    minEV = 0,
  } = opts;

  const range = toUtcRange(from, to).time as any;

  // Usa candles do TF solicitado, agregando M1 se necessário
  let candles = await loadCandlesAnyTF(symbol, timeframe, range);
  if (limit && limit > 0 && !range?.gte && !range?.lte) {
    candles = candles.slice(-limit);
  }

  if (!candles.length) return [];

  const closes = candles.map((c) => c.close);
  const bias = inferTrend(closes);

  // ATR exponencial simples em cima do TR
  const atr = (() => {
    const tr: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      tr.push(
        Math.max(
          candles[i].high - candles[i].low,
          Math.abs(candles[i].high - candles[i - 1].close),
          Math.abs(candles[i].low - candles[i - 1].close)
        )
      );
    }
    const n = Math.max(14, Math.min(50, Math.floor(evalWindow / 10)));
    const k = 2 / (n + 1);
    let e = tr[0] || 0;
    for (let i = 1; i < tr.length; i++) e = tr[i] * k + e * (1 - k);
    return e || tr[tr.length - 1] || 1;
  })();

  // Confirmação MTF dentro do mesmo período (se houver)
  let mtfOk: TrendBias | null = null;
  if (requireMtf && confirmTf) {
    const closesHigher = await loadCloses(
      symbol,
      confirmTf,
      from,
      to,
      Math.max(60, evalWindow)
    );
    if (closesHigher.length >= 21) mtfOk = inferTrend(closesHigher);
  }

  const last = candles[candles.length - 1];
  const candidates: ProjectedSignal[] = [];

  // Condição 1: Pullback na EMA21
  {
    const e21 = ema(closes, 21);
    const lastE = e21[e21.length - 1];
    const entry = Math.round(lastE);
    const loss = Math.max(1, Math.round(atr));
    const take = Math.round(entry + rr * loss * (bias === "UP" ? 1 : -1));
    const stop = Math.round(entry - loss * (bias === "UP" ? 1 : -1));
    const probHit = bias === "UP" ? 0.54 : 0.46;
    const gain = Math.abs(take - entry);
    let ev = probHit * gain - (1 - probHit) * loss;
    const applyCosts = (v: number, cost: number, slippage: number) =>
      v - (cost + slippage);
    ev = applyCosts(ev, costPts, slippagePts);

    const minutes = tfToMinutes(timeframe) * horizon;
    candidates.push({
      time: DateTime.fromJSDate(last.time as any)
        .toUTC()
        .toISO(),
      side: bias === "UP" ? "BUY" : "SELL",
      suggestedEntry: entry,
      stopSuggestion: stop,
      takeProfitSuggestion: take,
      conditionText: "Pullback na EMA21",
      validCandles: horizon,
      expiresAt: DateTime.fromJSDate(last.time as any)
        .plus({ minutes })
        .toISO(),
      rationale: `Trend=${bias} ATR≈${Math.round(atr)} RR=${rr}`,
      score: Math.round(100 * (probHit - 0.5) + 50),
      probHit,
      probCalibrated: conformal
        ? Math.max(0, Math.min(1, probHit - 0.01))
        : probHit,
      expectedValuePoints: ev,
      volatilityAtr: atr,
      meta: {
        trendBias: bias,
        todWindow: tod ? timeOfDayBucket(last.time as any) : undefined,
      },
    });
  }

  // Condição 2: Rompimento de swing
  const lookback = Math.min(20, Math.max(10, Math.floor(evalWindow / 10)));
  const window = candles.slice(-lookback);
  if (window.length) {
    const swingHi = Math.max(...window.map((c) => c.high));
    const swingLo = Math.min(...window.map((c) => c.low));

    // BUY
    {
      const entry = Math.round(swingHi + 1);
      const L = Math.max(1, Math.round(atr));
      const T = Math.round(rr * L);
      const stop = entry - L;
      const take = entry + T;
      const probHit = bias === "UP" ? 0.52 : 0.48;
      let ev = probHit * T - (1 - probHit) * L;
      const applyCosts = (v: number, cost: number, slippage: number) =>
        v - (cost + slippage);
      ev = applyCosts(ev, costPts, slippagePts);
      const minutes = tfToMinutes(timeframe) * horizon;
      candidates.push({
        time: DateTime.fromJSDate(last.time as any)
          .toUTC()
          .toISO(),
        side: "BUY",
        suggestedEntry: entry,
        stopSuggestion: stop,
        takeProfitSuggestion: take,
        conditionText: `Rompimento do último swing high (${lookback} barras)`,
        validCandles: horizon,
        expiresAt: DateTime.fromJSDate(last.time as any)
          .plus({ minutes })
          .toISO(),
        rationale: `Trend=${bias} ATR≈${Math.round(atr)} RR=${rr}`,
        score: Math.round(100 * (probHit - 0.5) + 50),
        probHit,
        probCalibrated: conformal
          ? Math.max(0, Math.min(1, probHit - 0.01))
          : probHit,
        expectedValuePoints: ev,
        volatilityAtr: atr,
      });
    }

    // SELL
    {
      const entry = Math.round(swingLo - 1);
      const L = Math.max(1, Math.round(atr));
      const T = Math.round(rr * L);
      const stop = entry + L;
      const take = entry - T;
      const probHit = bias === "DOWN" ? 0.52 : 0.48;
      let ev = probHit * T - (1 - probHit) * L;
      const applyCosts = (v: number, cost: number, slippage: number) =>
        v - (cost + slippage);
      ev = applyCosts(ev, costPts, slippagePts);
      const minutes = tfToMinutes(timeframe) * horizon;
      candidates.push({
        time: DateTime.fromJSDate(last.time as any)
          .toUTC()
          .toISO(),
        side: "SELL",
        suggestedEntry: entry,
        stopSuggestion: stop,
        takeProfitSuggestion: take,
        conditionText: `Rompimento do último swing low (${lookback} barras)`,
        validCandles: horizon,
        expiresAt: DateTime.fromJSDate(last.time as any)
          .plus({ minutes })
          .toISO(),
        rationale: `Trend=${bias} ATR≈${Math.round(atr)} RR=${rr}`,
        score: Math.round(100 * (probHit - 0.5) + 50),
        probHit,
        probCalibrated: conformal
          ? Math.max(0, Math.min(1, probHit - 0.01))
          : probHit,
        expectedValuePoints: ev,
        volatilityAtr: atr,
      });
    }
  }

  // Gates finais
  const out: ProjectedSignal[] = [];
  for (const s of candidates) {
    // (MTF opcional)
    // (Filtros minProb/minEV)
    if (minProb > 0 && (s.probCalibrated ?? s.probHit ?? 0) < minProb) continue;
    if (minEV > 0 && (s.expectedValuePoints ?? 0) < minEV) continue;
    out.push(s);
  }
  return out;
}
