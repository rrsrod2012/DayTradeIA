/* eslint-disable no-console */
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
const CFG = {
  LOOKBACK: numFromEnv(process.env.AUTO_TRAINER_LOOKBACK, 120), // barras para trás para calcular ATR
  HORIZON: numFromEnv(process.env.AUTO_TRAINER_HORIZON, 12), // barras à frente para procurar TP/SL
  SL_ATR: numFromEnv(process.env.AUTO_TRAINER_SL_ATR, 1.0), // k do SL em ATRs
  RR: numFromEnv(process.env.AUTO_TRAINER_RR, 2.0), // takeProfit = RR * ATR
  DEFAULT_QTY: 1,
};

// TF em minutos (tolerante aos mesmos TFs usados no worker)
const TF_MINUTES: Record<string, number> = {
  M1: 1,
  M5: 5,
  M15: 15,
  M30: 30,
  H1: 60,
};

// =========================
// Utils
// =========================
function numFromEnv(v: any, def: number) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function tfToMinutes(tf: string): number | null {
  const s = String(tf || "")
    .trim()
    .toUpperCase();
  if (TF_MINUTES[s]) return TF_MINUTES[s];

  // tolerar "5", "15"
  if (/^\d+$/.test(s)) return Number(s);
  // tolerar "H2" -> 120
  const m = /^H(\d{1,2})$/.exec(s);
  if (m) return Number(m[1]) * 60;

  return null;
}

function atrEMA(
  candles: { high: number; low: number; close: number }[],
  period = 14
): (number | null)[] {
  // True Range
  const tr: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = i > 0 ? candles[i - 1].close : c.close;
    tr.push(
      Math.max(
        c.high - c.low,
        Math.abs(c.high - prevClose),
        Math.abs(c.low - prevClose)
      )
    );
  }
  // EMA(TR, period)
  const out: (number | null)[] = [];
  let ema: number | null = null;
  const k = 2 / (period + 1);
  for (let i = 0; i < tr.length; i++) {
    const v = tr[i];
    ema = ema == null ? v : v * k + ema * (1 - k);
    out.push(ema);
  }
  return out;
}

// =========================
// Carregamento via agregador M1→TF
// =========================

/**
 * Carrega candles usando o agregador central para o mesmo instrumento/TF do sinal
 * em uma janela ao redor do tempo do sinal. Resolve (em lote) os candleIds
 * persistidos no banco para cada timestamp retornado, quando houver.
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

  const tfStr = (timeframe ? String(timeframe) : "M5").toUpperCase();
  const tfMin = tfToMinutes(tfStr) ?? 5;

  // Janela temporal aproximada (em minutos)
  const from = DateTime.fromJSDate(signalTime)
    .minus({ minutes: lookback * tfMin })
    .toUTC()
    .toJSDate();
  const to = DateTime.fromJSDate(signalTime)
    .plus({ minutes: (horizon + 2) * tfMin })
    .toUTC()
    .toJSDate();

  // 1) Série agregada coerente com Projected/Confirmed
  const series = await loadCandlesAnyTF(
    String(inst.symbol).toUpperCase(),
    tfStr,
    {
      gte: from,
      lte: to,
    }
  );
  if (!series?.length) return [];

  // 2) Mapa (time -> id) dos candles persistidos na janela (sem restringir timeframe)
  const persisted = await prisma.candle.findMany({
    where: { instrumentId, time: { gte: from, lte: to } },
    select: { id: true, time: true },
  });
  const idByTime = new Map<number, number>();
  for (const r of persisted) idByTime.set(new Date(r.time).getTime(), r.id);

  // 3) Normaliza shape + injeta id quando existir
  const rows = series.map((r: any) => {
    const t = r.time instanceof Date ? r.time : new Date(r.time);
    const id = idByTime.get(t.getTime()) ?? undefined;
    return {
      id: id ?? undefined, // pode ficar undefined se não houver esse bucket persistido
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
async function resolveInstrumentId(
  symbol?: string
): Promise<number | undefined> {
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
  symbol?: string; // filtra por símbolo (Instrument.symbol)
  timeframe?: string; // filtra por TF (ex: "M5")
  from?: Date; // filtra por período (candle do sinal >= from)
  to?: Date; // filtra por período (candle do sinal <= to)
};

export async function processImportedRange(args: ProcessArgs) {
  const t0 = Date.now();

  const instrumentIdFilter = await resolveInstrumentId(args.symbol);
  const timeframeFilter = args.timeframe
    ? String(args.timeframe).toUpperCase()
    : undefined;

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

  // Busca sinais EMA_CROSS dentro do escopo (filtrando pela relação candle)
  const signals = await prisma.signal.findMany({
    where: {
      signalType: "EMA_CROSS",
      candle: candleWhere,
    },
    orderBy: { id: "asc" }, // determinístico
    select: {
      id: true,
      side: true, // "BUY" | "SELL"
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
    return {
      ok: true,
      processedSignals: 0,
      tradesTouched: 0,
      tp: 0,
      sl: 0,
      none: 0,
      ms: Date.now() - t0,
    };
  }

  let tradesTouched = 0;
  let tp = 0,
    sl = 0,
    none = 0;

  for (const sig of signals) {
    const c = sig.candle;
    if (!c) continue;

    // Janela de candles ao redor do candle do sinal (via agregador)
    const win = await loadCandlesWindow({
      instrumentId: c.instrumentId,
      timeframe: c.timeframe,
      signalTime: c.time,
      lookback: CFG.LOOKBACK,
      horizon: CFG.HORIZON + 2, // sobra para garantir a "próxima barra"
    });
    if (!win?.length) {
      none++;
      await upsertTradeEmpty(sig, c); // cria trade com entryPrice = close do candle, sem saída
      tradesTouched++;
      continue;
    }

    // Encontrar índice do candle do sinal (match exato; se não houver, usa o último <= time)
    const idx = win.findIndex((row) => row.time.getTime() === c.time.getTime());
    let iSignal = idx >= 0 ? idx : -1;
    if (iSignal < 0) {
      let j = -1;
      for (let i = 0; i < win.length; i++) {
        if (win[i].time.getTime() <= c.time.getTime()) j = i;
        else break;
      }
      if (j < 0) {
        none++;
        await upsertTradeEmpty(sig, c);
        tradesTouched++;
        continue;
      }
      iSignal = j;
    }

    // Entrada = open da próxima barra no MESMO TF
    const iEntry = iSignal + 1;
    if (iEntry >= win.length) {
      // não há barra seguinte
      none++;
      await upsertTradeEmpty(sig, c);
      tradesTouched++;
      continue;
    }
    const entryBar = win[iEntry];
    const entryPrice = Number.isFinite(entryBar.open)
      ? Number(entryBar.open)
      : Number(entryBar.close);
    const side = String(sig.side || "").toUpperCase() as "BUY" | "SELL";

    // ATR no candle do sinal (usa janela até iSignal)
    const atrArr = atrEMA(
      win
        .slice(0, iSignal + 1)
        .map((r) => ({ high: r.high, low: r.low, close: r.close })),
      14
    );
    const atrNow = atrArr[atrArr.length - 1] ?? 0;
    const atr = Math.max(0, Number(atrNow) || 0);

    const slPts = atr * CFG.SL_ATR;
    const tpPts = atr * CFG.RR;

    const isBuy = side === "BUY";
    const slLevel =
      slPts > 0 ? (isBuy ? entryPrice - slPts : entryPrice + slPts) : null;
    const tpLevel =
      tpPts > 0 ? (isBuy ? entryPrice + tpPts : entryPrice - tpPts) : null;

    // Escaneia HORIZON barras para frente para determinar saída
    let exitPrice: number | null = null;
    let outcome: "TP" | "SL" | "NONE" = "NONE";
    let iExit: number | null = null;

    // Conservador: se a barra tocar SL e TP, considerar SL primeiro.
    for (
      let k = iEntry;
      k < Math.min(win.length, iEntry + CFG.HORIZON + 1);
      k++
    ) {
      const bar = win[k];
      const high = Number(bar.high);
      const low = Number(bar.low);

      if (slLevel != null) {
        if (isBuy && low <= slLevel) {
          exitPrice = slLevel;
          outcome = "SL";
          iExit = k;
          break;
        }
        if (!isBuy && high >= slLevel) {
          exitPrice = slLevel;
          outcome = "SL";
          iExit = k;
          break;
        }
      }
      if (tpLevel != null) {
        if (isBuy && high >= tpLevel) {
          exitPrice = tpLevel;
          outcome = "TP";
          iExit = k;
          break;
        }
        if (!isBuy && low <= tpLevel) {
          exitPrice = tpLevel;
          outcome = "TP";
          iExit = k;
          break;
        }
      }
    }

    let pnlPoints: number | null = null;
    if (exitPrice != null) {
      pnlPoints = isBuy ? exitPrice - entryPrice : entryPrice - exitPrice;
    }

    if (outcome === "TP") tp++;
    else if (outcome === "SL") sl++;
    else none++;

    // cria/vincula um signal de saída no candle correspondente (para termos referência de saída)
    let exitSignalId: number | null = null;
    if (
      iExit != null &&
      iExit >= 0 &&
      iExit < win.length &&
      exitPrice != null
    ) {
      const exitBar = win[iExit];
      const exitCandleId = exitBar.id; // pode estar undefined se não houver bucket persistido

      if (exitCandleId != null) {
        const exitType =
          outcome === "TP"
            ? "EXIT_TP"
            : outcome === "SL"
            ? "EXIT_SL"
            : "EXIT_NONE";
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
              side: side, // lado do movimento até a saída (mesmo do entry)
              score: 1.0,
              reason:
                exitType === "EXIT_TP"
                  ? "Take Profit atingido"
                  : exitType === "EXIT_SL"
                  ? "Stop Loss atingido"
                  : "Saída neutra",
            },
            select: { id: true },
          });
          exitSignalId = createdExit.id;
        }
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
  });

  return {
    ok: true,
    processedSignals: signals.length,
    tradesTouched,
    tp,
    sl,
    none,
    ms,
  };
}

// =========================
// Upserts (sem side / sem entryTime no Trade)
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
        // relação obrigatória
        instrument: { connect: { id: data.instrumentId } },
        timeframe: data.timeframe,
        qty: data.qty,
        entryPrice: data.entryPrice,
        exitPrice: data.exitPrice ?? undefined,
        pnlPoints: data.pnlPoints ?? undefined,
        ...(data.exitSignalId
          ? { exitSignal: { connect: { id: data.exitSignalId } } }
          : {}),
      },
    });
  } else {
    await prisma.trade.create({
      data: {
        instrument: { connect: { id: data.instrumentId } },
        timeframe: data.timeframe,
        entrySignal: { connect: { id: signal.id } }, // lado fica no entrySignal.side
        ...(data.exitSignalId
          ? { exitSignal: { connect: { id: data.exitSignalId } } }
          : {}),
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
  candle: {
    instrumentId: number;
    timeframe: string | null;
    close: number;
  }
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

function inferTfStringFromRow(
  r: { timeframe: string | null } | undefined
): string | null {
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
