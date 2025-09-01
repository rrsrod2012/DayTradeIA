import { prisma } from "../prisma";
import { DateTime } from "luxon";
import { Config } from "../config";

// Tipos simples (manter compatibilidade)
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
  score?: number;
  probHit?: number;
  probCalibrated?: number;
  expectedValuePoints?: number;
  volatilityAtr?: number;
  bbWidthNow?: number;
  // extras (opcionais)
  meta?: {
    trendBias: TrendBias;
    todWindow?: string;
  };
};

export type GenerateOpts = {
  symbol: string;
  timeframe: string;
  from?: string; // YYYY-MM-DD ou ISO
  to?: string; // YYYY-MM-DD ou ISO
  limit?: number;

  // já existentes
  horizon?: number;
  rr?: number;
  evalWindow?: number;
  adaptive?: boolean;
  cooldown?: boolean;
  regime?: boolean;
  tod?: boolean;
  conformal?: boolean;

  // NOVOS (opt-in)
  costPts?: number; // custos fixos por trade (pontos)
  slippagePts?: number; // slippage médio (pontos)
  requireMtf?: boolean; // exige confirmação multi-timeframe
  confirmTf?: string; // timeframe de confirmação (ex.: "M15")
  cooldownSmart?: boolean; // cooldown por playbook inteligente
  minProb?: number; // limiar mínimo
  minEV?: number; // limiar mínimo de EV (pontos)
};

// ---- utilidades de timeframe para minutos (apenas para cálculos/expiração)
const tfMinutes = (tf: string): number => {
  const m = String(tf || "").toUpperCase();
  if (m === "M1") return 1;
  if (m === "M5") return 5;
  if (m === "M15") return 15;
  if (m === "M30") return 30;
  if (m === "H1") return 60;
  return 5; // default conservador
};

// ===== utilitários curtos =====
function rrTargets(entry: number, side: Side, atr: number, rr: number) {
  const risk = Math.max(1, Math.round(atr || 1));
  const loss = risk;
  const gain = Math.round(loss * rr);
  const stop = side === "BUY" ? entry - loss : entry + loss;
  const take = side === "BUY" ? entry + gain : entry - gain;
  return { stop, take, loss, gain };
}

function applyCosts(evPoints: number, costPts: number, slippagePts: number) {
  const total = (costPts || 0) + (slippagePts || 0);
  return (evPoints ?? 0) - total;
}

function timeOfDayBucket(iso: string): string {
  const d = DateTime.fromISO(iso, { zone: "America/Sao_Paulo" });
  const hh = d.hour;
  if (hh < 10) return "PRE";
  if (hh < 12) return "MORNING";
  if (hh < 15) return "MID";
  return "CLOSE";
}

function ema(vals: number[], p: number) {
  const k = 2 / (p + 1);
  let e: number | null = null;
  return vals.map((v) => {
    e = e === null ? v : v * k + e * (1 - k);
    return e;
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

// ------ HELPERS DE CARREGAMENTO (com timeframe + período) ------

/**
 * Constrói filtro de tempo (gte/lte) a partir de strings from/to.
 * Aceita "YYYY-MM-DD" ou ISO ("YYYY-MM-DDTHH:mm:ss").
 */
function buildTimeWhere(from?: string, to?: string) {
  if (!from && !to) return undefined;
  const where: any = {};
  if (from) {
    const f = isNaN(Date.parse(from))
      ? new Date(`${from}T00:00:00.000Z`)
      : new Date(from);
    where.gte = f;
  }
  if (to) {
    // inclui o dia todo se vier como YYYY-MM-DD
    const isDay = /^\d{4}-\d{2}-\d{2}$/.test(to);
    const t = isNaN(Date.parse(to))
      ? new Date(`${to}T23:59:59.999Z`)
      : new Date(to);
    where.lte = isDay ? t : t;
  }
  return where;
}

/**
 * Carrega closes para um symbol/timeframe/período com limite opcional.
 */
async function loadClosesTf(
  symbol: string,
  timeframe: string,
  from?: string,
  to?: string,
  limit?: number
) {
  const where: any = {
    instrument: { is: { symbol: symbol.toUpperCase() } },
    timeframe: timeframe.toUpperCase(),
  };
  const timeWhere = buildTimeWhere(from, to);
  if (timeWhere) where.time = timeWhere;

  const rows = await prisma.candle.findMany({
    where,
    orderBy: { time: "asc" },
    take: limit && limit > 0 ? limit : undefined,
    select: { close: true },
  });
  return rows.map((r) => r.close);
}

/**
 * Carrega candles completos para um symbol/timeframe/período com limite opcional.
 */
async function loadCandlesTf(
  symbol: string,
  timeframe: string,
  from?: string,
  to?: string,
  limit?: number
) {
  const where: any = {
    instrument: { is: { symbol: symbol.toUpperCase() } },
    timeframe: timeframe.toUpperCase(),
  };
  const timeWhere = buildTimeWhere(from, to);
  if (timeWhere) where.time = timeWhere;

  const rows = await prisma.candle.findMany({
    where,
    orderBy: { time: "asc" },
    take: limit && limit > 0 ? limit : undefined,
  });
  return rows;
}

// ===== Cooldown inteligente por playbook =====
const playbookState = new Map<
  string,
  { fails: number; blockedUntilIdx: number }
>();
function pbKey(symbol: string, timeframe: string, name: string) {
  return `${symbol}:${timeframe}:${name}`;
}
function cooldownFail(
  nameKey: string,
  curIdx: number,
  nFail: number,
  blockCandles: number
) {
  const st = playbookState.get(nameKey) || { fails: 0, blockedUntilIdx: -1 };
  const fails = st.fails + 1;
  const blockedUntilIdx =
    fails >= nFail ? curIdx + blockCandles : st.blockedUntilIdx;
  playbookState.set(nameKey, { fails, blockedUntilIdx });
}
function cooldownReset(nameKey: string) {
  playbookState.set(nameKey, { fails: 0, blockedUntilIdx: -1 });
}
function cooldownCanUse(nameKey: string, curIdx: number) {
  const st = playbookState.get(nameKey);
  if (!st) return true;
  return curIdx >= st.blockedUntilIdx;
}

// ===== Núcleo (compatível com o front, agora respeitando período/timeframe) =====
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

    // novos
    costPts = Config.COST_PER_TRADE_POINTS,
    slippagePts = Config.SLIPPAGE_POINTS,
    requireMtf = Config.REQUIRE_MTF_CONFIRM,
    confirmTf = Config.MTF_CONFIRM_TF,
    cooldownSmart = Config.COOLDOWN_SMART,
    minProb = 0,
    minEV = 0,
  } = opts;

  // Carrega candles do symbol/timeframe e PERÍODO
  const candles = await loadCandlesTf(symbol, timeframe, from, to, limit);
  if (!candles.length) return [];

  const closes = candles.map((c) => c.close);
  const bias = inferTrend(closes);

  // ATR simples (true range aproximado) no período filtrado
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
    return e || tr[tr.length - 1] || 0 || 1;
  })();

  // Confirmação multi-timeframe (opcional) — agora usando confirmTf e mesmo período
  let mtfOk: TrendBias | null = null;
  if (requireMtf && confirmTf) {
    const closesHigher = await loadClosesTf(
      symbol,
      confirmTf,
      from,
      to,
      Math.max(60, evalWindow)
    );
    if (closesHigher.length >= 21) mtfOk = inferTrend(closesHigher);
  }

  // --- Geração de exemplos de "condições projetadas" ---
  const last = candles[candles.length - 1];
  const candidates: ProjectedSignal[] = [];

  // Exemplo 1: pullback na EMA21 (heurística)
  const e21 = ema(closes, 21);
  const ema21Now = e21[e21.length - 1];
  if (ema21Now) {
    const side: Side =
      bias === "UP" ? "BUY" : bias === "DOWN" ? "SELL" : "FLAT";
    if (side !== "FLAT") {
      const entry = Math.round(ema21Now);
      const { stop, take, loss, gain } = rrTargets(entry, side, atr, rr);
      const probHit = bias === "UP" ? 0.53 : bias === "DOWN" ? 0.53 : 0.5; // base simples
      let ev = probHit * gain - (1 - probHit) * loss;
      ev = applyCosts(ev, costPts, slippagePts);

      const minutes = tfMinutes(timeframe) * horizon;
      const cond: ProjectedSignal = {
        side,
        suggestedEntry: entry,
        stopSuggestion: stop,
        takeProfitSuggestion: take,
        conditionText: `Pullback na EMA21 em até ${horizon} candles`,
        validCandles: horizon,
        expiresAt: DateTime.fromJSDate(last.time).plus({ minutes }).toISO(),
        rationale: `Trend=${bias} ATR≈${Math.round(atr)} RR=${rr}`,
        score: Math.round(100 * (probHit - 0.5) + 50),
        probHit,
        probCalibrated: conformal
          ? Math.max(0, Math.min(1, probHit - 0.01))
          : probHit,
        expectedValuePoints: ev,
        volatilityAtr: atr,
        bbWidthNow: undefined,
        meta: {
          trendBias: bias,
          todWindow: tod ? timeOfDayBucket(last.time.toISOString()) : undefined,
        },
      };
      candidates.push(cond);
    }
  }

  // Exemplo 2: rompimento do último swing (heurística)
  const lookback = Math.min(20, Math.max(10, Math.floor(evalWindow / 10)));
  const slice = candles.slice(-lookback);
  const swingHi = Math.max(...slice.map((c) => c.high));
  const swingLo = Math.min(...slice.map((c) => c.low));
  {
    // BUY breakout
    const entry = Math.round(swingHi + 1);
    const { stop, take, loss, gain } = rrTargets(entry, "BUY", atr, rr);
    const probHit = bias === "UP" ? 0.52 : 0.48;
    let ev = probHit * gain - (1 - probHit) * loss;
    ev = applyCosts(ev, costPts, slippagePts);
    const minutes = tfMinutes(timeframe) * horizon;

    candidates.push({
      side: "BUY",
      suggestedEntry: entry,
      stopSuggestion: stop,
      takeProfitSuggestion: take,
      conditionText: `Rompimento do último swing high (${lookback} barras)`,
      validCandles: horizon,
      expiresAt: DateTime.fromJSDate(last.time).plus({ minutes }).toISO(),
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
        todWindow: tod ? timeOfDayBucket(last.time.toISOString()) : undefined,
      },
    });

    // SELL breakdown
    const entry2 = Math.round(swingLo - 1);
    const {
      stop: stop2,
      take: take2,
      loss: loss2,
      gain: gain2,
    } = rrTargets(entry2, "SELL", atr, rr);
    const probHit2 = bias === "DOWN" ? 0.52 : 0.48;
    let ev2 = probHit2 * gain2 - (1 - probHit2) * loss2;
    ev2 = applyCosts(ev2, costPts, slippagePts);

    candidates.push({
      side: "SELL",
      suggestedEntry: entry2,
      stopSuggestion: stop2,
      takeProfitSuggestion: take2,
      conditionText: `Rompimento do último swing low (${lookback} barras)`,
      validCandles: horizon,
      expiresAt: DateTime.fromJSDate(last.time).plus({ minutes }).toISO(),
      rationale: `Trend=${bias} ATR≈${Math.round(atr)} RR=${rr}`,
      score: Math.round(100 * (probHit2 - 0.5) + 50),
      probHit: probHit2,
      probCalibrated: conformal
        ? Math.max(0, Math.min(1, probHit2 - 0.01))
        : probHit2,
      expectedValuePoints: ev2,
      volatilityAtr: atr,
      meta: {
        trendBias: bias,
        todWindow: tod ? timeOfDayBucket(last.time.toISOString()) : undefined,
      },
    });
  }

  // ===== Filtros de pós-processamento =====
  const res: ProjectedSignal[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const s = candidates[i];

    // Gate multi-timeframe (se solicitado e calculado)
    if (requireMtf && confirmTf && mtfOk) {
      if (s.side === "BUY" && mtfOk === "DOWN") continue;
      if (s.side === "SELL" && mtfOk === "UP") continue;
    }

    // Cooldown inteligente por playbook (baseado em conditionText)
    if (cooldown && cooldownSmart) {
      const key = pbKey(symbol, timeframe, s.conditionText);
      const curIdx = candles.length - 1;
      if (!cooldownCanUse(key, curIdx)) continue;

      // Heurística: se EV < 0 após custos, conte como falha e bloqueie
      if ((s.expectedValuePoints ?? 0) < 0) {
        cooldownFail(
          key,
          curIdx,
          Config.COOLDOWN_FAIL_N,
          Config.COOLDOWN_BLOCK_CANDLES
        );
        continue;
      } else {
        // reset em caso de condição “boa”
        cooldownReset(key);
      }
    }

    // Limiar mínimo de probabilidade / EV
    if (minProb > 0 && (s.probCalibrated ?? s.probHit ?? 0) < minProb) continue;
    if (minEV > 0 && (s.expectedValuePoints ?? 0) < minEV) continue;

    res.push(s);
  }

  return res;
}
