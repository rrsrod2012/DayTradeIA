/* eslint-disable no-console */
import "dotenv/config";
import { DateTime } from "luxon";
import { prisma } from "../prisma";
import { loadCandlesAnyTF } from "../lib/aggregation";

/**
 * Pipeline para:
 *  - Consolidar sinais confirmados (EMA_CROSS) em Trades
 *  - Usado pelo endpoint /admin/trades/backfill
 *
 * Não renomeie este arquivo ou seus exports: { bootPipeline, processImportedRange }
 */

// =========================
// Configurações (via .env)
// =========================
function boolFromEnv(v: any, def: boolean) {
  const s = String(v ?? "").trim();
  if (s === "1" || /^true$/i.test(s)) return true;
  if (s === "0" || /^false$/i.test(s)) return false;
  return def;
}
function numFromEnv(v: any, def: number) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
function strFromEnv(v: any, def: string) {
  const s = String(v ?? "").trim();
  return s ? s : def;
}

const CFG = {
  LOOKBACK: numFromEnv(process.env.AUTO_TRAINER_LOOKBACK, 120), // barras p/ trás p/ ATR
  HORIZON: numFromEnv(process.env.AUTO_TRAINER_HORIZON, 12),   // barras p/ frente
  SL_ATR: numFromEnv(process.env.AUTO_TRAINER_SL_ATR, 1.0),
  RR: numFromEnv(process.env.AUTO_TRAINER_RR, 2.0),
  DEFAULT_QTY: 1,

  // Proteções
  BE_ENABLED: boolFromEnv(process.env.AUTO_TRAINER_BE_ENABLED, true),
  BE_TRIGGER_ATR: numFromEnv(process.env.AUTO_TRAINER_BE_TRIGGER_ATR, 1.0),
  BE_TRIGGER_POINTS: numFromEnv(process.env.AUTO_TRAINER_BE_TRIGGER_POINTS, 200),
  BE_OFFSET_POINTS: numFromEnv(process.env.AUTO_TRAINER_BE_OFFSET_POINTS, 0),

  TRAIL_ENABLED: boolFromEnv(process.env.AUTO_TRAINER_TRAIL_ENABLED, true),
  TRAIL_AFTER_BE_ONLY: boolFromEnv(process.env.AUTO_TRAINER_TRAIL_AFTER_BE_ONLY, false),
  TRAIL_ATR: numFromEnv(process.env.AUTO_TRAINER_TRAIL_ATR, 0.75),

  PARTIAL_ENABLED: boolFromEnv(process.env.AUTO_TRAINER_PARTIAL_ENABLED, true),
  PARTIAL_RATIO: Math.min(0.99, Math.max(0.01, numFromEnv(process.env.AUTO_TRAINER_PARTIAL_RATIO, 0.5))),
  PARTIAL_ATR: numFromEnv(process.env.AUTO_TRAINER_PARTIAL_ATR, 0.5),
  PARTIAL_BREAKEVEN_AFTER: boolFromEnv(process.env.AUTO_TRAINER_PARTIAL_BREAKEVEN_AFTER, true),

  PRIORITY: strFromEnv(process.env.AUTO_TRAINER_PRIORITY, "TP_FIRST_AFTER_BE") as
    | "SL_FIRST"
    | "TP_FIRST_AFTER_BE",

  FORCE_NO_LOSS_AFTER_MFE: boolFromEnv(process.env.AUTO_TRAINER_FORCE_NO_LOSS_AFTER_MFE, true),
  FORCE_MFE_POINTS: numFromEnv(process.env.AUTO_TRAINER_FORCE_MFE_POINTS, 200),
  FORCE_OFFSET_POINTS: numFromEnv(
    process.env.AUTO_TRAINER_FORCE_OFFSET_POINTS,
    Number.isFinite(Number(process.env.AUTO_TRAINER_BE_OFFSET_POINTS))
      ? Number(process.env.AUTO_TRAINER_BE_OFFSET_POINTS)
      : 0
  ),
};

// logs didáticos
const DEBUG_BE = String(process.env.PIPELINE_DEBUG_BE || "").trim() === "1";

// TF em minutos
const TF_MINUTES: Record<string, number> = { M1: 1, M5: 5, M15: 15, M30: 30, H1: 60 };

// =========================
// Utils
// =========================
function tfToMinutes(tf: string): number | null {
  const s = String(tf || "").trim().toUpperCase();
  if (TF_MINUTES[s]) return TF_MINUTES[s];
  if (/^\d+$/.test(s)) return Number(s);           // "5" -> 5
  const m = /^H(\d{1,2})$/.exec(s);                // "H2" -> 120
  if (m) return Number(m[1]) * 60;
  return null;
}

function atrEMA(
  candles: { high: number; low: number; close: number }[],
  period = 14
): (number | null)[] {
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
    ema = ema == null ? v : v * k + (ema as number) * (1 - k);
    out.push(ema);
  }
  return out;
}

// =========================
// Carregamento via agregador M1→TF (com tolerância de tempo)
// =========================

/**
 * Carrega candles usando o agregador central para o mesmo instrumento/TF do sinal
 * numa janela ao redor do tempo do sinal e tenta **resolver o candleId com tolerância**
 * p/ evitar mismatch (fechamento vs abertura, arredondamentos, TZ, etc).
 */
async function loadCandlesWindow(params: {
  instrumentId: number;
  timeframe: string | null;
  signalTime: Date; // candle do sinal (entry é a próxima barra)
  lookback: number;
  horizon: number;
}) {
  const { instrumentId, timeframe, signalTime, lookback, horizon } = params;

  // Resolve símbolo
  const inst = await prisma.instrument.findUnique({
    where: { id: instrumentId },
    select: { symbol: true },
  });
  if (!inst?.symbol) return [];

  const tfStrRaw = (timeframe ? String(timeframe) : "M5").toUpperCase();
  const tfStr = /^\d+$/.test(tfStrRaw) ? `M${tfStrRaw}` : tfStrRaw; // "5" -> "M5"
  const tfMin = tfToMinutes(tfStr) ?? 5;
  const tolMs = Math.max(60_000, Math.round(tfMin * 60_000 * 0.75)); // tolerância ~0.75×TF

  // Janela temporal aproximada (em minutos)
  const from = DateTime.fromJSDate(signalTime).minus({ minutes: lookback * tfMin }).toUTC().toJSDate();
  const to = DateTime.fromJSDate(signalTime).plus({ minutes: (horizon + 2) * tfMin }).toUTC().toJSDate();

  // 1) Série agregada coerente com Projected/Confirmed
  const series = await loadCandlesAnyTF(String(inst.symbol).toUpperCase(), tfStr, { gte: from, lte: to });
  if (!series?.length) return [];

  // 2) Mapa (time -> id) dos candles persistidos na janela (sem restringir timeframe)
  const persisted = await prisma.candle.findMany({
    where: { instrumentId, time: { gte: from, lte: to } },
    select: { id: true, time: true },
  });

  // indexa por timestamp (ms)
  const idByTime = new Map<number, number>();
  const times: number[] = [];
  for (const r of persisted) {
    const ms = new Date(r.time).getTime();
    idByTime.set(ms, r.id);
    times.push(ms);
  }
  times.sort((a, b) => a - b);

  function findNearestId(ts: number): number | undefined {
    // busca linear (janela pequena). Se preferir, troque por busca binária.
    let best: { id?: number; diff: number } = { diff: Infinity };
    for (const t of times) {
      const d = Math.abs(t - ts);
      if (d < best.diff) best = { id: idByTime.get(t), diff: d };
      if (d > tolMs && t > ts) break; // pequena otimização
    }
    return best.diff <= tolMs ? best.id : undefined;
  }

  // 3) Normaliza shape + injeta id quando existir (exato OU vizinho dentro da tolerância)
  const rows = series.map((r: any) => {
    const t = r.time instanceof Date ? r.time : new Date(r.time);
    let id = idByTime.get(t.getTime());
    if (id == null) id = findNearestId(t.getTime());
    return {
      id: id ?? undefined,
      time: t,
      instrumentId,
      timeframe: tfStr,
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: r.volume == null ? null : Number(r.volume),
    };
  });

  return rows;
}

/** Resolve instrumentId a partir do símbolo (se fornecido). */
async function resolveInstrumentId(symbol?: string): Promise<number | undefined> {
  if (!symbol) return undefined;
  const inst = await prisma.instrument.findFirst({
    where: { symbol: String(symbol).toUpperCase() },
    select: { id: true },
  });
  return inst?.id;
}

// =========================
// Núcleo: processar sinais -> Trades
// =========================

type ProcessArgs = {
  symbol?: string;
  timeframe?: string;
  from?: Date;
  to?: Date;
};

export async function processImportedRange(args: ProcessArgs) {
  const t0 = Date.now();

  const instrumentIdFilter = await resolveInstrumentId(args.symbol);
  const timeframeFilter = args.timeframe ? String(args.timeframe).toUpperCase() : undefined;

  // Monta filtro por timeframe para a relação candle (aceita "M5" e "5")
  const tfCands: string[] = [];
  if (timeframeFilter) {
    tfCands.push(timeframeFilter);
    const tfm = tfToMinutes(timeframeFilter);
    if (tfm != null) tfCands.push(String(tfm));
  }

  const candleWhere: any = {};
  if (args.from || args.to) {
    candleWhere.time = {
      ...(args.from ? { gte: args.from } : {}),
      ...(args.to ? { lte: args.to } : {}),
    };
  }
  if (instrumentIdFilter != null) candleWhere.instrumentId = instrumentIdFilter;
  if (tfCands.length) candleWhere.timeframe = { in: tfCands };

  // Busca sinais (aceita confirmado)
  const signals = await prisma.signal.findMany({
    where: {
      signalType: { in: ["EMA_CROSS", "EMA_CROSS_CONFIRMED"] },
      candle: candleWhere,
    },
    orderBy: { id: "asc" },
    select: {
      id: true,
      side: true,
      candleId: true,
      candle: {
        select: {
          id: true,
          time: true,
          instrumentId: true,
          timeframe: true,
          open: true,
          high: true,
          low: true,
          close: true,
        },
      },
    },
  });

  if (!signals.length) {
    return { ok: true, processedSignals: 0, tradesTouched: 0, tp: 0, sl: 0, none: 0, ms: Date.now() - t0 };
  }

  // estatísticas de diagnóstico
  const diag = {
    noSeries: 0,
    noIndex: 0,
    noNextBar: 0,
    noExitInHorizon: 0,
    exitNoCandleId: 0,
    beFromPartial: 0,
    beByATR: 0,
    beByPOINTS: 0,
  };

  let tradesTouched = 0;
  let tp = 0, sl = 0, none = 0;

  for (const sig of signals) {
    const c = sig.candle;
    if (!c) continue;

    // Janela de candles (via agregador)
    const win = await loadCandlesWindow({
      instrumentId: c.instrumentId,
      timeframe: c.timeframe,
      signalTime: c.time,
      lookback: CFG.LOOKBACK,
      horizon: CFG.HORIZON + 2,
    });
    if (!win?.length) {
      diag.noSeries++;
      none++;
      await upsertTradeEmpty(sig, c);
      tradesTouched++;
      continue;
    }

    // Índice do candle do sinal (exato; se não houver, usa o último <= time)
    const idx = win.findIndex((row) => row.time.getTime() === c.time.getTime());
    let iSignal = idx >= 0 ? idx : -1;
    if (iSignal < 0) {
      let j = -1;
      for (let i = 0; i < win.length; i++) {
        if (win[i].time.getTime() <= c.time.getTime()) j = i;
        else break;
      }
      if (j < 0) {
        diag.noIndex++;
        none++;
        await upsertTradeEmpty(sig, c);
        tradesTouched++;
        continue;
      }
      iSignal = j;
    }

    // Entrada = open da próxima barra
    const iEntry = iSignal + 1;
    if (iEntry >= win.length) {
      diag.noNextBar++;
      none++;
      await upsertTradeEmpty(sig, c);
      tradesTouched++;
      continue;
    }
    const entryBar = win[iEntry];
    const entryPrice = Number.isFinite(entryBar.open) ? Number(entryBar.open) : Number(entryBar.close);
    const side = String(sig.side || "").toUpperCase() as "BUY" | "SELL";

    // ATR no candle do sinal
    const atrArr = atrEMA(
      win.slice(0, iSignal + 1).map((r) => ({ high: r.high, low: r.low, close: r.close })),
      14
    );
    const atrNow = atrArr[atrArr.length - 1] ?? 0;
    const atr = Math.max(0, Number(atrNow) || 0);

    const slPts = atr * CFG.SL_ATR;
    const tpPts = atr * CFG.RR;

    const isBuy = side === "BUY";
    const slLevel = slPts > 0 ? (isBuy ? entryPrice - slPts : entryPrice + slPts) : null;
    const tpLevel = tpPts > 0 ? (isBuy ? entryPrice + tpPts : entryPrice - tpPts) : null;

    // Loop adiante com BE/Trailing/Parcial
    let exitPrice: number | null = null;
    let outcome: "TP" | "SL" | "NONE" = "NONE";
    let iExit: number | null = null;

    let dynSL: number | null = slLevel;
    const entrySide = isBuy ? 1 : -1;

    // BE: OR(ATR, PONTOS)
    const beTriggerPtsATR = atr * Math.max(0, CFG.BE_TRIGGER_ATR || 0);
    const beTriggerPtsABS = Math.max(0, CFG.BE_TRIGGER_POINTS || 0);
    const beUseATR = beTriggerPtsATR > 0;
    const beUsePOINT = beTriggerPtsABS > 0;
    const beMinTrigger = Math.min(beUseATR ? beTriggerPtsATR : Infinity, beUsePOINT ? beTriggerPtsABS : Infinity);

    const partialTargetPts = atr * CFG.PARTIAL_ATR;
    const trailATR = CFG.TRAIL_ATR;

    let beArmed = CFG.BE_ENABLED === true;
    let beTriggered = false;
    let iBeTrigger: number | null = null;
    let beLevelCache: number | null = null;

    let trailArmed = CFG.TRAIL_ENABLED === true && !CFG.TRAIL_AFTER_BE_ONLY;
    let trailActive = trailArmed;

    // trava de no-loss após BE
    let noLossFloor: number | null = null;

    let partialArmed = CFG.PARTIAL_ENABLED === true;
    let partialDone = false;
    let partialPnLPoints = 0;

    // MFE para failsafe
    let mfePts = 0;

    const atrSeries = atrEMA(win.map((r) => ({ high: r.high, low: r.low, close: r.close })), 14)
      .map((x) => Number(x || 0));

    const checkOrderAfterBE = CFG.PRIORITY === "TP_FIRST_AFTER_BE";

    for (let k = iEntry; k < Math.min(win.length, iEntry + CFG.HORIZON + 1); k++) {
      const bar = win[k];
      const high = Number(bar.high);
      const low = Number(bar.low);
      const mid = Number(bar.close);

      // MFE acumulado
      const incMfe = entrySide > 0 ? Math.max(0, high - entryPrice) : Math.max(0, entryPrice - low);
      if (incMfe > mfePts) mfePts = incMfe;

      // Melhor caso da barra (p/ gatilhos)
      const unrealizedPts = entrySide > 0 ? high - entryPrice : entryPrice - low;

      // Parcial
      if (partialArmed && !partialDone && partialTargetPts > 0) {
        const hitPartial = entrySide > 0
          ? high >= entryPrice + partialTargetPts
          : low <= entryPrice - partialTargetPts;

        if (hitPartial) {
          const partialExit = entrySide > 0 ? entryPrice + partialTargetPts : entryPrice - partialTargetPts;
          const ratio = CFG.PARTIAL_RATIO;
          partialPnLPoints += ratio * (entrySide > 0 ? partialExit - entryPrice : entryPrice - partialExit);
          partialDone = true;

          // move para BE imediatamente (±offset) se configurado
          if (CFG.PARTIAL_BREAKEVEN_AFTER) {
            const beLevel = isBuy
              ? entryPrice + Math.max(0, CFG.BE_OFFSET_POINTS)
              : entryPrice - Math.max(0, CFG.BE_OFFSET_POINTS);

            dynSL = beLevel;
            noLossFloor = beLevel;
            beLevelCache = beLevel;
            beTriggered = true;
            iBeTrigger = k;
            diag.beFromPartial++;

            if (CFG.TRAIL_ENABLED && CFG.TRAIL_AFTER_BE_ONLY) {
              trailArmed = true;
              trailActive = true;
            }

            if (DEBUG_BE) {
              console.log(`[pipeline/BE<-partial] ${side} @${bar.time.toISOString()} entry=${entryPrice} be=${beLevel}`);
            }
          } else {
            beArmed = true;
          }
        }
      }

      // Gatilhos de BE (ATR OU Pontos)
      if (beArmed && !beTriggered && (beUseATR || beUsePOINT)) {
        const hitByATR = beUseATR && unrealizedPts >= beTriggerPtsATR;
        const hitByPOINT = beUsePOINT && unrealizedPts >= beTriggerPtsABS;

        if (hitByATR || hitByPOINT) {
          const beLevel = isBuy
            ? entryPrice + Math.max(0, CFG.BE_OFFSET_POINTS)
            : entryPrice - Math.max(0, CFG.BE_OFFSET_POINTS);

          dynSL = beLevel;
          noLossFloor = beLevel;
          beLevelCache = beLevel;
          beTriggered = true;
          iBeTrigger = k;
          if (hitByATR) diag.beByATR++;
          if (hitByPOINT) diag.beByPOINTS++;

          if (DEBUG_BE) {
            console.log(`[pipeline/BE] ${side} @${bar.time.toISOString()} entry=${entryPrice} be=${beLevel} (trgMin=${isFinite(beMinTrigger) ? beMinTrigger.toFixed(2) : "-"})`);
          }

          if (CFG.TRAIL_ENABLED && CFG.TRAIL_AFTER_BE_ONLY) {
            trailArmed = true;
            trailActive = true;
          }
        }
      }

      // Trailing por ATR
      if (trailArmed) {
        const atrK = Math.max(0, Number(atrSeries[k] ?? atrSeries[Math.max(0, k - 1)] ?? atr)) || 0;
        const trailDist = trailATR * atrK;
        if (isBuy) {
          const candidate = mid - trailDist;
          dynSL = dynSL == null ? candidate : Math.max(dynSL, candidate);
        } else {
          const candidate = mid + trailDist;
          dynSL = dynSL == null ? candidate : Math.min(dynSL, candidate);
        }
        // trava para não desfazer BE
        if (noLossFloor != null) {
          dynSL = isBuy ? Math.max(dynSL!, noLossFloor) : Math.min(dynSL!, noLossFloor);
        }
      }

      // Saídas
      const hitTP = () => (tpLevel == null ? false : (isBuy ? high >= tpLevel : low <= tpLevel));
      const hitSL = () => (dynSL == null ? false : (isBuy ? low <= dynSL : high >= dynSL));

      if (beTriggered && checkOrderAfterBE) {
        if (hitTP()) { exitPrice = tpLevel!; outcome = "TP"; iExit = k; break; }
        if (hitSL()) { exitPrice = dynSL!; outcome = "SL"; iExit = k; break; }
      } else {
        if (hitSL()) { exitPrice = dynSL!; outcome = "SL"; iExit = k; break; }
        if (hitTP()) { exitPrice = tpLevel!; outcome = "TP"; iExit = k; break; }
      }
    }

    // FAILSAFE MFE
    let forcedBE = false;
    let forcedReason: string | null = null;
    const basePnL = exitPrice != null ? (isBuy ? exitPrice - entryPrice : entryPrice - exitPrice) : null;

    const autoMfeThreshold = Math.min(beUseATR ? beTriggerPtsATR : Infinity, beUsePOINT ? beTriggerPtsABS : Infinity);
    const configured = Math.max(0, CFG.FORCE_MFE_POINTS || 0);
    const forceThreshold = configured > 0 ? configured : (isFinite(autoMfeThreshold) ? autoMfeThreshold : 0);

    if (CFG.FORCE_NO_LOSS_AFTER_MFE && forceThreshold > 0) {
      const hitMfeForce = mfePts >= forceThreshold;
      const isLoss = basePnL != null ? basePnL < 0 && Math.abs(basePnL) > 1e-9 : false;

      if (hitMfeForce && isLoss) {
        const beFail = isBuy
          ? entryPrice + Math.max(0, CFG.FORCE_OFFSET_POINTS)
          : entryPrice - Math.max(0, CFG.FORCE_OFFSET_POINTS);

        let kExitBE: number | null = null;
        const kStart = (iBeTrigger ?? (iSignal + 1));
        for (let k = kStart; k < Math.min(win.length, iSignal + 1 + CFG.HORIZON + 1); k++) {
          const bar = win[k];
          if (isBuy) { if (Number(bar.low) <= beFail) { kExitBE = k; break; } }
          else { if (Number(bar.high) >= beFail) { kExitBE = k; break; } }
        }

        iExit = kExitBE != null ? kExitBE : (iExit ?? (iSignal + 1));
        exitPrice = beFail;
        forcedBE = true;
        outcome = "SL"; // semanticamente stop, porém no BE
        forcedReason = "FORCED_BE_BY_MFE";
      }
    }

    // PnL final (considerando parcial)
    let pnlPoints: number | null = null;
    if (exitPrice != null) {
      if (partialDone) {
        const ratio = CFG.PARTIAL_RATIO;
        const restRatio = 1 - ratio;
        const restPnL = isBuy ? exitPrice - entryPrice : entryPrice - exitPrice;
        pnlPoints = partialPnLPoints + restRatio * restPnL;
      } else {
        pnlPoints = isBuy ? exitPrice - entryPrice : entryPrice - exitPrice;
      }
    } else {
      diag.noExitInHorizon++;
    }

    if (outcome === "TP") tp++;
    else if (outcome === "SL") sl++;
    else none++;

    // sinal de saída (se acharmos candleId)
    let exitSignalId: number | null = null;
    let exitType: "EXIT_TP" | "EXIT_SL" | "EXIT_NONE" = "EXIT_NONE";
    if (outcome === "TP") exitType = "EXIT_TP";
    else if (outcome === "SL") exitType = "EXIT_SL";

    if (iExit != null && iExit >= 0 && iExit < win.length && exitPrice != null) {
      const exitBar = win[iExit];
      const exitCandleId = exitBar.id;

      const reasonObj = {
        side, entryPrice, exitPrice, tpLevel, slLevel,
        dynSLFinal: typeof exitPrice === "number" ? exitPrice : null,
        beTriggered,
        beTriggers: {
          atr: beUseATR ? beTriggerPtsATR : null,
          points: beUsePOINT ? beTriggerPtsABS : null,
          min: isFinite(beMinTrigger) ? beMinTrigger : null,
        },
        beLevel: beLevelCache,
        noLossFloor,
        mfePts: Number(mfePts.toFixed(2)),
        forcedBE, forcedReason,
        partialDone, priority: CFG.PRIORITY,
      };

      if (exitCandleId != null) {
        const existingExit = await prisma.signal.findFirst({
          where: { candleId: exitCandleId, signalType: exitType },
          select: { id: true },
        });

        if (existingExit) {
          exitSignalId = existingExit.id;
        } else {
          const createdExit = await prisma.signal.create({
            data: {
              candleId: exitCandleId,
              signalType: exitType,
              side,
              score: 1.0,
              reason:
                exitType === "EXIT_TP"
                  ? `Take Profit atingido | diag=${JSON.stringify(reasonObj)}`
                  : exitType === "EXIT_SL"
                    ? `Stop Loss atingido | diag=${JSON.stringify(reasonObj)}`
                    : `Saída neutra | diag=${JSON.stringify(reasonObj)}`,
            },
            select: { id: true },
          });
          exitSignalId = createdExit.id;
        }
      } else {
        diag.exitNoCandleId++;
        console.log("[pipeline] exit without candleId", { exitType, diag: reasonObj, signalId: sig.id });
      }
    }

    await upsertTrade(sig, {
      instrumentId: c.instrumentId,
      timeframe: c.timeframe || inferTfStringFromRow(win[iEntry]) || "M5",
      qty: CFG.DEFAULT_QTY,
      entryPrice,
      exitPrice: exitPrice ?? null,
      pnlPoints,
      exitSignalId: exitSignalId ?? null,
    });

    tradesTouched++;
  }

  const ms = Date.now() - t0;
  console.log("[pipeline] backfill", {
    signals: signals.length,
    tradesTouched,
    TP: tp,
    SL: sl,
    NONE: none,
    ms,
    diag,
  });

  return { ok: true, processedSignals: signals.length, tradesTouched, tp, sl, none, ms, diag };
}

// =========================
// Upserts
// =========================
async function upsertTrade(
  signal: { id: number },
  data: {
    instrumentId: number;
    timeframe: string;
    qty: number;
    entryPrice: number;
    exitPrice: number | null;
    pnlPoints: number | null;
    exitSignalId: number | null;
  }
) {
  const existing = await prisma.trade.findFirst({
    where: { entrySignalId: signal.id },
    select: { id: true },
  });

  if (existing) {
    await prisma.trade.update({
      where: { id: existing.id },
      data: {
        instrument: { connect: { id: data.instrumentId } },
        timeframe: data.timeframe,
        qty: data.qty,
        entryPrice: data.entryPrice,
        exitPrice: data.exitPrice ?? undefined,
        pnlPoints: data.pnlPoints ?? undefined,
        ...(data.exitSignalId ? { exitSignal: { connect: { id: data.exitSignalId } } } : {}),
      },
    });
  } else {
    await prisma.trade.create({
      data: {
        instrument: { connect: { id: data.instrumentId } },
        timeframe: data.timeframe,
        entrySignal: { connect: { id: signal.id } },
        ...(data.exitSignalId ? { exitSignal: { connect: { id: data.exitSignalId } } } : {}),
        qty: data.qty,
        entryPrice: data.entryPrice,
        exitPrice: data.exitPrice,
        pnlPoints: data.pnlPoints,
      },
    });
  }
}

/** Cria/atualiza trade “sem saída” quando não há próxima barra */
async function upsertTradeEmpty(
  signal: { id: number },
  candle: { instrumentId: number; timeframe: string | null; close: number }
) {
  return upsertTrade(signal, {
    instrumentId: candle.instrumentId,
    timeframe: candle.timeframe || "M5",
    qty: CFG.DEFAULT_QTY,
    entryPrice: Number(candle.close),
    exitPrice: null,
    pnlPoints: null,
    exitSignalId: null,
  });
}

// =========================
// Helpers
// =========================
function inferTfStringFromRow(r: { timeframe: string | null } | undefined): string | null {
  if (!r) return null;
  const sRaw = r.timeframe ? String(r.timeframe) : "";
  const s = sRaw.toUpperCase();
  if (s.startsWith("M") || s.startsWith("H")) return s;
  if (/^\d+$/.test(s)) return `M${s}`;
  return null;
}

// =========================
// Boot (no-op seguro)
// =========================
export function bootPipeline() {
  return;
}
