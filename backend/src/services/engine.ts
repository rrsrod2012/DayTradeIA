/* eslint-disable no-console */
import { DateTime } from "luxon";
import { Config } from "../config";
import { loadCandlesAnyTF } from "../lib/aggregation";
import { EMA, ATR } from "./indicators";

/** Tipos básicos */
export type Side = "BUY" | "SELL" | "FLAT";
type TrendBias = "UP" | "DOWN" | "SIDEWAYS";

type Candle = {
  time: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number | null;
};

/** Saída para a UI */
export type ProjectedSignal = {
  side: Side;
  suggestedEntry?: number | null;
  stopSuggestion?: number | null;
  takeProfitSuggestion?: number | null;

  conditionText?: string | null;
  score?: number | null;

  probHit?: number | null;
  probCalibrated?: number | null;
  expectedValuePoints?: number | null;

  time?: string; // ISO
  date?: string; // YYYY-MM-DD
};

/** Opções (compatível com o frontend atual) */
export type GenerateOpts = {
  symbol: string;
  timeframe: string;
  from?: string | Date | null;
  to?: string | Date | null;

  limit?: number;
  horizon?: number;
  rr?: number;
  evalWindow?: number;
  adaptive?: boolean;
  cooldown?: boolean;
  regime?: boolean;
  tod?: boolean;
  conformal?: boolean;

  /** Custos */
  costPts?: number;
  slippagePts?: number;

  /** Confirmação MTF */
  requireMtf?: boolean;
  confirmTf?: string;

  /** Cooldown inteligente (não usado aqui) */
  cooldownSmart?: boolean;

  /** Filtros de decisão */
  minProb?: number;
  minEV?: number;

  /** IA micro-modelo (gateway p/ futura integração) */
  useMicroModel?: boolean;

  /** Confluências adicionais */
  vwapFilter?: boolean;
};

const MICRO_URL = process.env.MICRO_MODEL_URL || ""; // ex.: http://localhost:8000

/* --------- Utils --------- */
function toUtcRange(
  from?: string | Date | null,
  to?: string | Date | null
): { time?: { gte?: Date; lte?: Date } } {
  const gte = from ? new Date(from as any) : undefined;
  const lte = to ? new Date(to as any) : undefined;
  if (gte || lte)
    return { time: { ...(gte ? { gte } : {}), ...(lte ? { lte } : {}) } };
  return {};
}

function logisticCalibrate(p: number): number {
  // placeholder simples e monotônico (a ser substituído por calibração real)
  const z = Math.max(1e-6, Math.min(1 - 1e-6, p));
  const shifted = 1 / (1 + Math.exp(-((z - 0.5) * 3)));
  return Math.max(0.0, Math.min(1.0, shifted));
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function trendFrom(
  ema9: (number | null)[],
  ema21: (number | null)[],
  i: number
): TrendBias {
  if (ema9[i] == null || ema21[i] == null) return "SIDEWAYS";
  const e9 = ema9[i] as number,
    e21 = ema21[i] as number;
  const prev9 = i > 0 && ema9[i - 1] != null ? (ema9[i - 1] as number) : e9;
  const prev21 = i > 0 && ema21[i - 1] != null ? (ema21[i - 1] as number) : e21;
  if (e9 > e21 && prev9 >= prev21) return "UP";
  if (e9 < e21 && prev9 <= prev21) return "DOWN";
  return e9 > e21 ? "UP" : e9 < e21 ? "DOWN" : "SIDEWAYS";
}

/** Arredondamento a tick (pontos); default 1 ponto */
function roundToTick(price: number, tick = 1): number {
  if (!isFinite(price) || tick <= 0) return price;
  return Math.round(price / tick) * tick;
}

/** VWAP intradiário (ancorado no início do dia, reinicia a cada data local BRT) */
function vwapAnchoredDaily(
  candles: Candle[],
  zone = "America/Sao_Paulo"
): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  let curDay = "";
  let cumPV = 0;
  let cumV = 0;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const d = DateTime.fromJSDate(c.time).setZone(zone).toFormat("yyyy-LL-dd");
    if (d !== curDay) {
      curDay = d;
      cumPV = 0;
      cumV = 0;
    }
    const tp = (c.high + c.low + c.close) / 3;
    const v = (c.volume ?? 1) || 1;
    cumPV += tp * v;
    cumV += v;
    out[i] = cumV > 0 ? cumPV / cumV : tp;
  }
  return out;
}

/** Busca índice do TF de confirmação com tempo <= t, avançando ponteiro */
function advanceIdxUntil(times: Date[], startIdx: number, t: Date): number {
  let j = Math.max(0, startIdx);
  while (j + 1 < times.length && times[j + 1] <= t) j++;
  return j;
}

/** Monta features compatíveis com o micro-modelo */
function buildFeatures(
  i: number,
  candles: Candle[],
  e9: (number | null)[],
  e21: (number | null)[],
  atr: (number | null)[],
  vwap: (number | null)[]
) {
  const c = candles[i];
  const prev = candles[i - 1] ?? c;
  const _atr = (atr[i] ?? atr[i - 1] ?? 1) as number;
  const _e9 = (e9[i] ?? e9[i - 1] ?? c.close) as number;
  const _e21 = (e21[i] ?? e21[i - 1] ?? c.close) as number;
  const _vwap = (vwap[i] ?? vwap[i - 1] ?? c.close) as number;

  const ret1 = (c.close - prev.close) / Math.max(1e-6, _atr);
  const slope9 = ((e9[i] ?? _e9) as number) - ((e9[i - 1] ?? _e9) as number);
  const slope21 =
    ((e21[i] ?? _e21) as number) - ((e21[i - 1] ?? _e21) as number);

  const feat = {
    dist_ema21: (c.close - _e21) / Math.max(1e-6, _atr),
    dist_vwap: (c.close - _vwap) / Math.max(1e-6, _atr),
    slope_e9: slope9 / Math.max(1e-6, _atr),
    slope_e21: slope21 / Math.max(1e-6, _atr),
    range_ratio: (c.high - c.low) / Math.max(1e-6, _atr),
    ret1,
    hour: DateTime.fromJSDate(c.time).setZone("America/Sao_Paulo").hour,
  };
  return feat;
}

/** Chama microserviço de IA (FastAPI) para obter probabilidade calibrada */
async function microPredict(
  features: Record<string, number>
): Promise<number | null> {
  if (!MICRO_URL) return null;
  try {
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), 1200);
    // @ts-ignore - Node 18+ possui fetch global
    const resp = await fetch(`${MICRO_URL.replace(/\/+$/, "")}/predict`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ features }),
      signal: controller.signal,
    });
    clearTimeout(to);
    if (!resp.ok) return null;
    const j = await resp.json();
    if (typeof j?.p === "number" && isFinite(j.p)) return clamp(j.p, 0, 1);
    return null;
  } catch {
    return null;
  }
}

/* --------- Função principal --------- */
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
    evalWindow = 200, // usado p/ suavização
    adaptive = true,
    cooldown = true, // mantido por compat — não aplicado aqui
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

    useMicroModel = false,
    vwapFilter = true,
  } = opts;

  const range = toUtcRange(from || undefined, to || undefined).time;

  // Carrega candles do TF solicitado (usa fallback de agregação do módulo)
  const symbolU = String(symbol).toUpperCase();
  const tfU = String(timeframe).toUpperCase();
  const candles = await loadCandlesAnyTF(symbolU, tfU, range as any);
  if (!candles?.length) return [];

  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const closes = candles.map((c) => c.close);

  // Indicadores principais MTF=base
  const e9 = EMA(closes, 9);
  const e21 = EMA(closes, 21);
  const atrArr = ATR(highs, lows, closes, 14);
  const vwap = vwapAnchoredDaily(candles, "America/Sao_Paulo");

  // MTF de confirmação (opcional)
  let confirmTimes: Date[] = [];
  let confirmE9: (number | null)[] = [];
  let confirmE21: (number | null)[] = [];
  if (requireMtf && confirmTf) {
    const conf = await loadCandlesAnyTF(
      symbolU,
      String(confirmTf).toUpperCase(),
      range as any
    );
    if (conf?.length) {
      const cCloses = conf.map((c) => c.close);
      confirmTimes = conf.map((c) => c.time);
      confirmE9 = EMA(cCloses, 9);
      confirmE21 = EMA(cCloses, 21);
    }
  }

  // Heurística de sessão/Time-Of-Day (opcional)
  const allowedHour = (d: Date) => {
    if (!tod) return true;
    const dt = DateTime.fromJSDate(d).setZone("America/Sao_Paulo");
    const h = dt.hour;
    if (h < 9 || h > 18) return false;
    if (h === 9 && dt.minute < 15) return false;
    if (h === 18 && dt.minute > 0) return false;
    return true;
  };

  const tick = Number(process.env.TICK_SIZE_POINTS || 1);

  const out: ProjectedSignal[] = [];
  let j = 0; // ponteiro no TF de confirmação
  for (let i = 30; i < candles.length; i++) {
    const cndl = candles[i];
    if (!allowedHour(cndl.time)) continue;
    if (e21[i] == null || e9[i] == null || atrArr[i] == null || vwap[i] == null)
      continue;

    const atr = atrArr[i] as number;
    const ema21 = e21[i] as number;
    const bias = trendFrom(e9, e21, i);

    // Confluência VWAP (opcional): BUY não muito abaixo do VWAP; SELL não muito acima
    const _vwap = vwap[i] as number;
    if (vwapFilter) {
      if (bias === "UP" && cndl.close < _vwap) continue;
      if (bias === "DOWN" && cndl.close > _vwap) continue;
    }

    // Sinal do tipo "EMA21 bounce" com ajuste por ATR
    let side: Side | null = null;
    const touched = cndl.low <= ema21 && cndl.high >= ema21;

    if (bias === "UP" && touched && cndl.close >= ema21) {
      side = "BUY";
    } else if (bias === "DOWN" && touched && cndl.close <= ema21) {
      side = "SELL";
    }
    if (!side) continue;

    // Confirmação MTF: exige viés no TF maior na mesma direção
    if (requireMtf && confirmTimes.length) {
      j = advanceIdxUntil(confirmTimes, j, cndl.time);
      const e9c = confirmE9[j],
        e21c = confirmE21[j];
      if (e9c != null && e21c != null) {
        const confBias: TrendBias =
          (e9c as number) > (e21c as number)
            ? "UP"
            : (e9c as number) < (e21c as number)
            ? "DOWN"
            : "SIDEWAYS";
        if (side === "BUY" && confBias !== "UP") continue;
        if (side === "SELL" && confBias !== "DOWN") continue;
      }
    }

    const entry = roundToTick(ema21, tick);
    const sl =
      side === "BUY"
        ? roundToTick(entry - 1 * atr, tick)
        : roundToTick(entry + 1 * atr, tick);
    const tp =
      side === "BUY"
        ? roundToTick(entry + rr * atr, tick)
        : roundToTick(entry - rr * atr, tick);

    // Probabilidade heurística + micro-modelo opcional
    const sep = Math.abs((e9[i]! - e21[i]!) / Math.max(1e-6, atr));
    let p = clamp(
      0.5 + (side === "BUY" ? 1 : -1) * Math.min(0.15, sep * 0.03),
      0.35,
      0.65
    );

    if (useMicroModel && MICRO_URL) {
      const feats = buildFeatures(i, candles, e9, e21, atrArr, vwap);
      const pModel = await microPredict(feats);
      if (pModel != null) {
        p = pModel; // já calibrado pelo serviço
      } else {
        p = logisticCalibrate(p); // fallback suave
      }
    }

    const tpPts = Math.abs(tp - entry);
    const slPts = Math.abs(entry - sl);
    const evPts = p * tpPts - (1 - p) * slPts - (costPts + slippagePts);

    if (p < (minProb || 0)) continue;
    if (evPts < (minEV || 0)) continue;

    out.push({
      side,
      suggestedEntry: entry,
      stopSuggestion: sl,
      takeProfitSuggestion: tp,
      conditionText: `EMA21 bounce (${bias}) • ATR14=${atr.toFixed(
        2
      )} • RR=${rr} • ${vwapFilter ? "VWAP✓" : "VWAP–"}${
        requireMtf && confirmTimes.length ? " • MTF✓" : ""
      }`,
      score: sep,
      probHit: p,
      probCalibrated: useMicroModel ? p : undefined,
      expectedValuePoints: Number(evPts.toFixed(2)),
      time: cndl.time.toISOString(),
      date: DateTime.fromJSDate(cndl.time).toFormat("yyyy-LL-dd"),
    });

    if (!range && out.length >= limit) break;
  }

  return range ? out : out.slice(-limit);
}

export default { generateProjectedSignals };
