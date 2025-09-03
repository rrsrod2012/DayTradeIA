/* eslint-disable no-console */
import { DateTime } from "luxon";
import { Config } from "../config";
import { loadCandlesAnyTF } from "../lib/aggregation";

// Tipos básicos
export type Side = "BUY" | "SELL" | "FLAT";
type TrendBias = "UP" | "DOWN" | "SIDEWAYS";

// Estrutura de candle mínima esperada de loadCandlesAnyTF
type Candle = {
  time: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number | null;
};

// Saída de sinal projetado
export type ProjectedSignal = {
  side: Side;
  suggestedEntry: number;
  stopSuggestion?: number;
  takeProfitSuggestion?: number;
  conditionText: string;
  validCandles: number;
  expiresAt?: string;

  // Metricas de qualidade
  score?: number;
  probHit?: number;
  probCalibrated?: number;
  expectedValuePoints?: number;

  // Campos informativos adicionais
  time?: string; // ISO
  date?: string; // YYYY-MM-DD
};

// Opções de geração (batem com o que o frontend envia)
export type GenerateOpts = {
  symbol: string;
  timeframe: string;
  from?: string | Date | null;
  to?: string | Date | null;

  limit?: number; // quando from/to não são dados
  horizon?: number;
  rr?: number;
  evalWindow?: number;
  adaptive?: boolean;
  cooldown?: boolean;
  regime?: boolean;
  tod?: boolean;
  conformal?: boolean;

  // Risco/execução
  costPts?: number;
  slippagePts?: number;

  // Filtros/gates
  requireMtf?: boolean;
  confirmTf?: string;
  cooldownSmart?: boolean;
  minProb?: number;
  minEV?: number;

  // IA
  useMicroModel?: boolean;
};

// Utils de data
function toUtcRange(
  from?: string | Date | null,
  to?: string | Date | null
): { time?: { gte?: Date; lte?: Date } } {
  const gte = from ? new Date(from) : undefined;
  const lte = to ? new Date(to) : undefined;
  if (gte || lte)
    return { time: { ...(gte ? { gte } : {}), ...(lte ? { lte } : {}) } };
  return {};
}

function timeOfDayBucket(
  ts: string | Date
): "PRE" | "MORNING" | "MID" | "CLOSE" {
  const d =
    ts instanceof Date
      ? DateTime.fromJSDate(ts, { zone: "America/Sao_Paulo" })
      : DateTime.fromISO(ts, { zone: "America/Sao_Paulo" });
  const hh = d.hour;
  if (hh < 10) return "PRE";
  if (hh < 12) return "MORNING";
  if (hh < 15) return "MID";
  return "CLOSE";
}

// Indicadores simples
function ema(vals: number[], p: number): number[] {
  if (!vals.length || p <= 1) return vals.slice();
  const k = 2 / (p + 1);
  let e: number | null = null;
  return vals.map((v) => {
    e = e === null ? v : v * k + e * (1 - k);
    return e!;
  });
}

function inferTrend(closes: number[]): TrendBias {
  if (closes.length < 5) return "SIDEWAYS";
  const a = closes[0];
  const b = closes[closes.length - 1];
  const chg = (b - a) / Math.max(1, Math.abs(a));
  if (chg > 0.002) return "UP";
  if (chg < -0.002) return "DOWN";
  return "SIDEWAYS";
}

// Probabilidade base simples em função do regime e horário
function baseProbFromContext(
  bias: TrendBias,
  tod: "PRE" | "MORNING" | "MID" | "CLOSE",
  side: Side
): number {
  let p = 0.5;
  if (bias === "UP" && side === "BUY") p += 0.06;
  if (bias === "DOWN" && side === "SELL") p += 0.06;
  if (tod === "MORNING" || tod === "MID") p += 0.02; // mais liquidez
  if (tod === "PRE" || tod === "CLOSE") p -= 0.01;
  return Math.max(0.05, Math.min(0.95, p));
}

// Recalibração logística (stub)
function logisticCalibrate(pRaw: number): number {
  // z = a + b * (pRaw - 0.5)
  const a = 0.2;
  const b = 2.0;
  const z = a + b * (pRaw - 0.5);
  const p = 1 / (1 + Math.exp(-z));
  return Math.max(0.01, Math.min(0.99, p));
}

// ---------- Função principal ----------
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

    // não usados diretamente aqui, mas mantidos por compatibilidade
    requireMtf = Config.REQUIRE_MTF_CONFIRM,
    confirmTf = Config.MTF_CONFIRM_TF,
    cooldownSmart = Config.COOLDOWN_SMART,

    minProb = 0,
    minEV = 0,

    useMicroModel = false,
  } = opts;

  const range = toUtcRange(from || undefined, to || undefined).time;

  // Carrega candles do TF solicitado
  let candles: Candle[] = await loadCandlesAnyTF(
    symbol,
    timeframe,
    range as any
  );

  if (!candles || candles.length === 0) return [];

  // Se não há range explícito, aplica limite no final (mais recentes)
  if ((!range || (!range.gte && !range.lte)) && limit && limit > 0) {
    candles = candles.slice(-limit);
  }

  const closes = candles.map((c) => c.close);
  const bias = inferTrend(closes);
  const last = candles[candles.length - 1];

  // EMA 21 como referência de entrada
  const e21 = ema(closes, 21);
  const lastE = e21[e21.length - 1];

  // Bucket horário
  const todBucket = tod ? timeOfDayBucket(last.time) : "MID";

  // Calcula um tamanho de alvo/stop simples (ATR não disponível aqui; usa desvio aproximado)
  const recent = closes.slice(-Math.max(10, Math.min(closes.length, 50)));
  const mean = recent.reduce((a, b) => a + b, 0) / Math.max(1, recent.length);
  const dev =
    recent.length > 1
      ? Math.sqrt(
          recent.reduce((a, b) => a + Math.pow(b - mean, 2), 0) /
            (recent.length - 1)
        )
      : Math.max(1, Math.abs(last.close) * 0.001);
  const basePoints = Math.max(1, dev); // "pontos" aproximados

  // Duas candidatas: BUY na EMA e SELL na EMA (exemplo simples)
  const candidates: ProjectedSignal[] = [];

  // BUY
  {
    const entry = Math.round(lastE);
    const sl = Math.round(entry - basePoints);
    const tp = Math.round(entry + rr * basePoints);
    const side: Side = "BUY";
    let prob = baseProbFromContext(bias, todBucket, side);
    // conformal "dummy": p -= 0.01
    if (conformal) prob = Math.max(0.01, prob - 0.01);
    const evPts =
      prob * Math.abs(tp - entry) -
      (1 - prob) * Math.abs(entry - sl) -
      (costPts + slippagePts);

    candidates.push({
      side,
      suggestedEntry: entry,
      stopSuggestion: sl,
      takeProfitSuggestion: tp,
      conditionText: `EMA21 touch/bounce (${bias})`,
      validCandles: Math.max(2, horizon),
      time: last.time.toISOString(),
      date: DateTime.fromJSDate(last.time).toISODate() || undefined,
      score: 1,
      probHit: prob,
      expectedValuePoints: evPts,
    });
  }

  // SELL
  {
    const entry = Math.round(lastE);
    const sl = Math.round(entry + basePoints);
    const tp = Math.round(entry - rr * basePoints);
    const side: Side = "SELL";
    let prob = baseProbFromContext(bias, todBucket, side);
    if (conformal) prob = Math.max(0.01, prob - 0.01);
    const evPts =
      prob * Math.abs(entry - tp) -
      (1 - prob) * Math.abs(sl - entry) -
      (costPts + slippagePts);

    candidates.push({
      side,
      suggestedEntry: entry,
      stopSuggestion: sl,
      takeProfitSuggestion: tp,
      conditionText: `EMA21 rejection (${bias})`,
      validCandles: Math.max(2, horizon),
      time: last.time.toISOString(),
      date: DateTime.fromJSDate(last.time).toISODate() || undefined,
      score: 1,
      probHit: prob,
      expectedValuePoints: evPts,
    });
  }

  // Micro-modelo (stub) — recalibra probabilidade e atualiza EV
  if (useMicroModel) {
    for (const c of candidates) {
      const base = typeof c.probHit === "number" ? c.probHit : 0.5;
      const pCal = logisticCalibrate(base);
      c.probCalibrated = pCal;

      if (
        typeof c.suggestedEntry === "number" &&
        typeof c.stopSuggestion === "number" &&
        typeof c.takeProfitSuggestion === "number"
      ) {
        const tpPts = Math.abs(c.takeProfitSuggestion - c.suggestedEntry);
        const slPts = Math.abs(c.suggestedEntry - c.stopSuggestion);
        c.expectedValuePoints =
          pCal * tpPts - (1 - pCal) * slPts - (costPts + slippagePts);
      }
    }
  }

  // Gates finais por minProb/minEV
  const out: ProjectedSignal[] = [];
  for (const s of candidates) {
    const p = s.probCalibrated ?? s.probHit ?? 0;
    const ev = s.expectedValuePoints ?? 0;
    if (minProb > 0 && p < minProb) continue;
    if (minEV > 0 && ev < minEV) continue;
    out.push(s);
  }

  return out;
}

export default {
  generateProjectedSignals,
};
