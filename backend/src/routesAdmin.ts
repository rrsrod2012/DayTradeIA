// backend/src/routesAdmin.ts
import { Router } from "express";
import { prisma } from "./prisma";
import { DateTime } from "luxon";
import { enqueue as brokerEnqueue } from "./services/brokerPersist";
import { loadCandlesAnyTF } from "./lib/aggregation";

const router = Router();

/**
 * Util: parse "YYYY-MM-DD" p/ Date (UTC 00:00 e 23:59:59.999)
 */
function parseRange(from: string, to: string) {
  const gte = new Date(`${from}T00:00:00.000Z`);
  const lte = new Date(`${to}T23:59:59.999Z`);
  return { gte, lte };
}

/**
 * Agrega candles M1 -> TF (M5/M15/M30/H1). Se timeframe for M1, retorna os próprios M1.
 */
async function ensureAggregatedCandles(
  instrumentId: number,
  timeframe: "M1" | "M5" | "M15" | "M30" | "H1",
  gte: Date,
  lte: Date
) {
  if (timeframe === "M1") {
    const m1 = await prisma.candle.findMany({
      where: { instrumentId, timeframe: "M1", time: { gte, lte } },
      orderBy: { time: "asc" },
    });
    return { aggregated: 0, candles: m1 };
  }

  const tfToMinutes: Record<Exclude<typeof timeframe, "M1">, number> = {
    M5: 5,
    M15: 15,
    M30: 30,
    H1: 60,
  };
  const step = tfToMinutes[timeframe as Exclude<typeof timeframe, "M1">];

  // Já existem candles agregados?
  const existing = await prisma.candle.findMany({
    where: { instrumentId, timeframe, time: { gte, lte } },
    select: { id: true },
    take: 1,
  });
  if (existing.length) {
    // Já tem — ainda assim vamos retornar candles para uso adiante
  }

  // Busca base M1 no período
  const m1 = await prisma.candle.findMany({
    where: { instrumentId, timeframe: "M1", time: { gte, lte } },
    orderBy: { time: "asc" },
  });

  if (!m1.length) {
    return {
      aggregated: 0,
      candles: [] as Awaited<ReturnType<typeof prisma.candle.findMany>>,
    };
  }

  // Floor para múltiplo de step
  const floorToStep = (d: Date) => {
    const t = new Date(d);
    t.setUTCSeconds(0, 0);
    const m = t.getUTCMinutes();
    const floored = m - (m % step);
    t.setUTCMinutes(floored);
    return t;
  };

  // Bucketiza M1 -> TF
  type Bucket = {
    time: Date;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  };
  const buckets = new Map<number, Bucket>();
  for (const c of m1) {
    const keyDate = floorToStep(c.time);
    const key = keyDate.getTime();
    if (!buckets.has(key)) {
      buckets.set(key, {
        time: keyDate,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      });
    } else {
      const b = buckets.get(key)!;
      b.high = Math.max(b.high, c.high);
      b.low = Math.min(b.low, c.low);
      b.close = c.close;
      b.volume += c.volume;
    }
  }

  // Persiste via upsert (@@unique[instrumentId,timeframe,time] em Candle)
  const aggCandles = [] as Awaited<ReturnType<typeof prisma.candle.upsert>>[];
  for (const b of [...buckets.values()].sort(
    (a, b) => a.time.getTime() - b.time.getTime()
  )) {
    const saved = await prisma.candle.upsert({
      where: {
        instrumentId_timeframe_time: {
          instrumentId,
          timeframe,
          time: b.time,
        },
      },
      update: {
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
      },
      create: {
        instrumentId,
        timeframe,
        time: b.time,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
      },
    });
    aggCandles.push(saved);
  }

  return { aggregated: aggCandles.length, candles: aggCandles };
}

/**
 * EMA simples
 */
function ema(values: number[], period: number) {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let emaPrev = values[0] ?? 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    emaPrev = i === 0 ? v : k * v + (1 - k) * emaPrev;
    out.push(emaPrev);
  }
  return out;
}

/**
 * Zera o banco (apenas conteúdo) mantendo o schema.
 * Uso: POST /api/admin/reset
 */
router.post("/api/admin/reset", async (_req, res) => {
  try {
    await prisma.$executeRawUnsafe(`PRAGMA foreign_keys=OFF;`);

    const tables = [
      "Signal",
      "Trade",
      "IndicatorValue",
      "Pattern",
      "BacktestRun",
      "Candle",
      "Instrument",
      "BrokerExecution",
    ];

    for (const t of tables) {
      try {
        await prisma.$executeRawUnsafe(`DELETE FROM "${t}";`);
      } catch {
        // ignora se a tabela não existir no schema atual
      }
    }

    await prisma.$executeRawUnsafe(`PRAGMA foreign_keys=ON;`);
    res.json({ ok: true, cleared: tables });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

/**
 * Backfill de sinais confirmados base EMA(9/21) para um período.
 * Body: { symbol: "WIN", timeframe: "M1"|"M5"|"M15"|"M30"|"H1", from: "YYYY-MM-DD", to: "YYYY-MM-DD" }
 */
router.post("/api/admin/signals/backfill", async (req, res) => {
  const { symbol, timeframe, from, to } = req.body || {};
  if (!symbol || !timeframe || !from || !to) {
    return res.status(400).json({
      ok: false,
      error: "Campos obrigatórios: symbol, timeframe, from, to",
    });
  }

  if (!["M1", "M5", "M15", "M30", "H1"].includes(timeframe)) {
    return res.status(400).json({ ok: false, error: "timeframe inválido" });
  }

  const { gte, lte } = parseRange(from, to);

  try {
    // Instrumento
    const instrument = await prisma.instrument.upsert({
      where: { symbol },
      update: { name: symbol },
      create: { symbol, name: symbol },
    });

    // Garante candles para o TF (M1 retorna os próprios, TF>1 agrega)
    const { aggregated, candles } = await ensureAggregatedCandles(
      instrument.id,
      timeframe,
      gte,
      lte
    );

    // Busca candles do TF (se ensure já devolveu, usa; senão lê do banco)
    const tfCandles =
      candles.length > 0
        ? candles
        : await prisma.candle.findMany({
          where: {
            instrumentId: instrument.id,
            timeframe,
            time: { gte, lte },
          },
          orderBy: { time: "asc" },
        });

    if (!tfCandles.length) {
      return res.json({
        ok: true,
        symbol,
        timeframe,
        range: { from, to },
        aggregatedCandles: aggregated,
        signalsCreated: 0,
        signalsExisting: 0,
        note: "Sem candles no período.",
      });
    }

    // Calcula EMAs e cruzamentos
    const closes = tfCandles.map((c) => c.close);
    const ema9 = ema(closes, 9);
    const ema21 = ema(closes, 21);

    let created = 0;
    let existing = 0;

    for (let i = 1; i < tfCandles.length; i++) {
      const prevDiff = ema9[i - 1] - ema21[i - 1];
      const curDiff = ema9[i] - ema21[i];

      let side: "BUY" | "SELL" | null = null;
      if (prevDiff <= 0 && curDiff > 0) side = "BUY";
      else if (prevDiff >= 0 && curDiff < 0) side = "SELL";

      if (!side) continue;

      const signalType = "EMA_CROSS";
      const candleId = tfCandles[i].id;
      const score = Math.abs(curDiff);
      const reason = `EMA9/EMA21 ${side === "BUY" ? "golden" : "death"} cross`;

      const already = await prisma.signal.findFirst({
        where: { candleId, signalType, side },
        select: { id: true },
      });

      if (already) {
        existing++;
      } else {
        await prisma.signal.create({
          data: { candleId, signalType, side, score, reason },
        });
        created++;
      }
    }

    res.json({
      ok: true,
      symbol,
      timeframe,
      range: { from, to },
      aggregatedCandles: aggregated,
      signalsCreated: created,
      signalsExisting: existing,
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

/* =========================================================================
 * Rebuild de Trades a partir dos Sinais confirmados (pairing simples)
 * ========================================================================= */
router.post("/api/admin/trades/rebuild", async (req, res) => {
  try {
    const { symbol, timeframe, from, to, dry = "0", sample = 5 } = (req.query as any) || {};
    if (!symbol) return res.status(400).json({ ok: false, error: "faltou symbol" });
    const sym = String(symbol).toUpperCase().trim();
    const tf = timeframe ? String(timeframe).toUpperCase().trim() : undefined;
    const isDry = String(dry) === "1";

    if (!from || !to) {
      return res.status(400).json({ ok: false, error: "faltou from/to" });
    }
    const { gte, lte } = parseRange(String(from), String(to));

    const instrument = await prisma.instrument.findUnique({ where: { symbol: sym } });
    if (!instrument) return res.status(200).json({ ok: false, error: `instrumento não encontrado para ${sym}` });

    const whereSignal: any = {
      candle: {
        instrumentId: instrument.id,
        time: { gte, lte },
      },
    };
    if (tf) whereSignal.candle.timeframe = tf;

    const signals = await prisma.signal.findMany({
      where: whereSignal,
      include: { candle: true },
      orderBy: [{ candle: { timeframe: "asc" } }, { candle: { time: "asc" } }, { id: "asc" }],
    });

    if (!signals.length) {
      return res.status(200).json({ ok: true, rebuilt: 0, deleted: 0, trades: [] });
    }

    const byTF = new Map<string, any[]>();
    for (const s of signals) {
      const tframe = s.candle.timeframe.toUpperCase();
      if (tf && tframe !== tf) continue;
      if (!byTF.has(tframe)) byTF.set(tframe, []);
      byTF.get(tframe)!.push(s);
    }

    let totalDeleted = 0;
    let totalCreated = 0;
    const sampleTrades: any[] = [];

    for (const [tframe, list] of byTF.entries()) {
      // apaga trades existentes da janela/TF
      const existing = await prisma.trade.findMany({
        where: {
          instrumentId: instrument.id,
          timeframe: tframe,
          entrySignal: {
            is: {
              candle: { time: { gte, lte } },
            },
          },
        },
        select: { id: true },
      });
      const existingIds = existing.map((r) => r.id);

      if (!isDry && existingIds.length) {
        await prisma.trade.deleteMany({ where: { id: { in: existingIds } } });
        totalDeleted += existingIds.length;
      }

      // pairing: abre com o primeiro sinal; fecha no primeiro oposto
      let position: null | { entry: any } = null;
      const creations: any[] = [];

      for (const s of list) {
        if (!position) {
          position = { entry: s };
          continue;
        } else {
          const entrySide = String(position.entry.side).toUpperCase();
          const thisSide = String(s.side).toUpperCase();
          if (entrySide !== thisSide) {
            const entryC = position.entry.candle;
            const exitC = s.candle;
            const entryPrice = Number(entryC.close);
            const exitPrice = Number(exitC.close);
            const pnlPoints = entrySide === "BUY" ? (exitPrice - entryPrice) : (entryPrice - exitPrice);

            creations.push({
              instrumentId: instrument.id,
              timeframe: tframe,
              entrySignalId: position.entry.id,
              exitSignalId: s.id,
              qty: 1,
              entryPrice,
              exitPrice,
              pnlPoints,
            });
            position = null;
          }
        }
      }

      if (!isDry && creations.length) {
        const batchSize = 500;
        for (let i = 0; i < creations.length; i += batchSize) {
          const slice = creations.slice(i, i + batchSize);
          await prisma.trade.createMany({ data: slice, skipDuplicates: true });
        }
      }

      totalCreated += creations.length;

      for (const c of creations.slice(0, Number(sample) || 5)) {
        sampleTrades.push({
          ...c,
          symbol: sym,
          entryTime: list.find((x) => x.id === c.entrySignalId)?.candle?.time ?? null,
          exitTime: list.find((x) => x.id === c.exitSignalId)?.candle?.time ?? null,
        });
      }
    }

    return res.status(200).json({
      ok: true,
      dryRun: isDry,
      deleted: totalDeleted,
      rebuilt: totalCreated,
      sample: sampleTrades,
    });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

/* =========================================================================
 * Diagnóstico consolidado (execuções/confirmados/projetados/trades/PNL)
 * ========================================================================= */
router.get("/api/admin/diag/recap", async (req, res) => {
  try {
    const symbol = String((req.query.symbol as any) || "").toUpperCase();
    const timeframe = String((req.query.timeframe as any) || "").toUpperCase();
    const from = String((req.query.from as any) || "");
    const to = String((req.query.to as any) || "");
    if (!symbol) return res.status(400).json({ ok: false, error: "missing_symbol" });

    const today = DateTime.now().toUTC().toISODate()!;
    const rng = from && to ? parseRange(from, to) : parseRange(today, today);

    const instr = await prisma.instrument.findUnique({ where: { symbol } });
    if (!instr) return res.status(200).json({ ok: true, data: { note: "instrument_not_found", symbol } });

    // Execuções do MT5 por lado (taskId únicos)
    const execRows = await prisma.brokerExecution.findMany({
      where: { symbol, time: { gte: rng.gte, lte: rng.lte } },
      select: { taskId: true, side: true },
    });
    const execBySide: Record<string, number> = {};
    const seenTask: Record<string, string> = {};
    for (const r of execRows) {
      const tid = r.taskId || "";
      if (!tid) continue;
      if (!seenTask[tid]) {
        seenTask[tid] = r.side || "";
        const s = (r.side || "").toUpperCase();
        execBySide[s] = (execBySide[s] || 0) + 1;
      }
    }

    // Confirmados por lado (M1)
    const sigRows = await prisma.signal.findMany({
      where: {
        side: { in: ["BUY", "SELL"] },
        candle: {
          instrumentId: instr.id,
          timeframe: timeframe || "M1",
          time: { gte: rng.gte, lte: rng.lte },
        },
      },
      select: { side: true },
    });
    const confirmedBySide: Record<string, number> = { BUY: 0, SELL: 0 };
    for (const s of sigRows) {
      const sd = (s.side || "").toUpperCase();
      if (sd === "BUY" || sd === "SELL") confirmedBySide[sd]++;
    }

    // Trades por lado e PnL
    const trades = await prisma.trade.findMany({
      where: {
        timeframe: timeframe || "M1",
        instrumentId: instr.id,
        entrySignal: { time: { gte: rng.gte, lte: rng.lte } },
      },
      include: { entrySignal: true },
    });
    const tradesBySide: Record<string, number> = { BUY: 0, SELL: 0 };
    let pnlPoints = 0;
    for (const t of trades) {
      const sd = (t.entrySignal as any)?.side || "";
      const S = String(sd).toUpperCase();
      if (S === "BUY" || S === "SELL") tradesBySide[S] = (tradesBySide[S] || 0) + 1;
      if (Number.isFinite(t.pnlPoints as any)) pnlPoints += Number(t.pnlPoints);
    }

    // Projetados por lado (se o motor estiver exposto)
    let projectedBySide: Record<string, number> = { BUY: 0, SELL: 0 };
    try {
      const { generateProjectedSignals } = await import("./services/engine");
      const items = await generateProjectedSignals({
        symbol,
        timeframe: timeframe || "M1",
        range: { gte: rng.gte, lte: rng.lte },
        limit: 2000,
      } as any);
      for (const it of items || []) {
        const sd = String((it as any).side || "").toUpperCase();
        if (sd === "BUY" || sd === "SELL") projectedBySide[sd] = (projectedBySide[sd] || 0) + 1;
      }
    } catch {
      projectedBySide = { BUY: -1, SELL: -1 };
    }

    return res.status(200).json({
      ok: true,
      data: {
        symbol,
        timeframe: timeframe || "M1",
        range: { from: rng.gte, to: rng.lte },
        mt5_executions_by_side: execBySide,
        confirmed_by_side: confirmedBySide,
        projected_by_side: projectedBySide,
        trades_by_side: tradesBySide,
        pnl_points_sum: pnlPoints,
      },
    });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

/**
 * Gera task (EA/MT5) a partir de um Trade existente
 */
router.post("/exec/trigger-from-trade/:id", async (req, res) => {
  try {
    const id = Number(req.params?.id || 0);
    const agentId = String((req.query?.agentId as any) || "MT5");
    if (!id) return res.status(200).json({ ok: false, error: "faltou id" });

    const trade = await prisma.trade.findUnique({
      where: { id },
      include: {
        instrument: true,
        entrySignal: { include: { candle: true } },
      },
    });
    if (!trade) return res.status(200).json({ ok: false, error: "trade não encontrado" });
    const symbol = trade.instrument?.symbol || "WIN";
    const timeframe = (trade.entrySignal as any)?.timeframe || "M1";
    const entryTime = (trade.entrySignal as any)?.time || (trade as any).entryAt || trade.createdAt;

    // ATR14 no mesmo TF/instante
    const to = DateTime.fromJSDate(entryTime).toUTC();
    const from = to.minus({ hours: 24 });
    const candles = await loadCandlesAnyTF(symbol, timeframe, { gte: from.toJSDate(), lte: to.toJSDate() });

    function atr14(cs: any[]) {
      const n = 14;
      if (cs.length < n + 1) return 100;
      let sum = 0;
      for (let i = cs.length - n; i < cs.length; i++) {
        const c = cs[i];
        const p = cs[i - 1];
        const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
        sum += tr;
      }
      return Math.round(sum / n);
    }
    const atr = atr14(candles);

    const SL_ATR = Number(process.env.AUTO_TRAINER_SL_ATR || 1.5);
    const RR = Number(process.env.AUTO_TRAINER_RR || 2);
    const beAt = Number(process.env.AUTO_TRAINER_BE_AT_PTS || 0);
    const beOff = Number(process.env.AUTO_TRAINER_BE_OFFSET_PTS || 0);

    const slPoints = Math.round(atr * SL_ATR);
    const tpPoints = Math.round(atr * RR);

    const side = (trade as any).side as "BUY" | "SELL";
    const volume = Number(trade.qty || 1);

    const task = {
      id: `trade-${trade.id}-${Date.now()}`,
      side,
      symbol,
      timeframe,
      time: entryTime as Date,
      price: trade.entryPrice || undefined,
      volume,
      slPoints,
      tpPoints,
      beAtPoints: beAt || null,
      beOffsetPoints: beOff || null,
      comment: `trade#${trade.id}`,
    };

    const r = brokerEnqueue(agentId, [task]);
    return res.status(200).json({ ok: true, agentId, enqueued: r, task });
  } catch (e: any) {
    return res.status(200).json({ ok: false, error: e?.message || String(e) });
  }
});

export default router;
