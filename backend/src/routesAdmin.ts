// backend/src/routesAdmin.ts
import { Router } from "express";
import { prisma } from "./prisma";

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
 * Agrega candles M1 -> M5 (ou outro TF múltiplo de 1 minuto)
 */
async function ensureAggregatedCandles(
  instrumentId: number,
  timeframe: "M5" | "M15" | "M30" | "H1",
  gte: Date,
  lte: Date
) {
  const tfToMinutes: Record<typeof timeframe, number> = {
    M5: 5,
    M15: 15,
    M30: 30,
    H1: 60,
  };
  const step = tfToMinutes[timeframe];

  // Já existem candles agregados?
  const existing = await prisma.candle.findMany({
    where: { instrumentId, timeframe, time: { gte, lte } },
    select: { id: true },
    take: 1,
  });
  if (existing.length) {
    // Já tem — ainda assim vamos retornar os candles para usar no cálculo das EMAs
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

  // Função para "floor" no múltiplo de step minutos
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

  // Persiste via upsert (temos @@unique([instrumentId, timeframe, time]) em Candle)
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
 * EMA simples (retorna array alinhado com 'values'; posições iniciais
 * sem janela cheia usam recursiva padrão: ema = alpha*v + (1-alpha)*emaPrev)
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
 * Uso: POST /api/admin/signals/backfill
 * Body: { symbol: "WIN", timeframe: "M5", from: "YYYY-MM-DD", to: "YYYY-MM-DD" }
 */
router.post("/api/admin/signals/backfill", async (req, res) => {
  const { symbol, timeframe, from, to } = req.body || {};
  if (!symbol || !timeframe || !from || !to) {
    return res.status(400).json({
      ok: false,
      error: "Campos obrigatórios: symbol, timeframe, from, to",
    });
  }

  if (!["M5", "M15", "M30", "H1"].includes(timeframe)) {
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

    // Garante candles agregados (e devolve os candles)
    const { aggregated, candles } = await ensureAggregatedCandles(
      instrument.id,
      timeframe,
      gte,
      lte
    );

    // Se não encontrar candles TF, tenta ler do banco mesmo assim (podem já existir)
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
        note: "Sem candles agregados no período.",
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
      const time = tfCandles[i].time;
      const score = Math.abs(curDiff); // simples: magnitude do cruzamento
      const reason = `EMA9/EMA21 ${side === "BUY" ? "golden" : "death"} cross`;

      // Evita duplicar (não usamos createMany/skipDuplicates para manter compatibilidade com SQLite e Prisma antigo)
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

    console.info(
      JSON.stringify({
        level: "info",
        msg: "[admin/backfill] concluído",
        symbol,
        timeframe,
        from,
        to,
        aggregatedCandles: aggregated,
        signalsCreated: created,
        signalsExisting: existing,
      })
    );

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
    console.error(
      JSON.stringify({
        level: "error",
        msg: "[admin/backfill] falha",
        error: err?.message || String(err),
      })
    );
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

export default router;
