/* eslint-disable no-console */
/**
 * Workers de candles agregados (M1 -> M5/M15/...) e de backfill de sinais confirmados.
 * - Remove o uso de skipDuplicates (não suportado no SQLite).
 * - Faz inserção apenas dos candles que ainda não existem.
 * - Adiciona helper de upsert compatível com schema atual (sem índice único composto e sem campo `time` em Signal).
 */

import { PrismaClient, Candle } from "@prisma/client";

const prisma = new PrismaClient();

// logger simples para não depender de util externo
const logger = {
  info: (...args: any[]) => console.log(...args),
  warn: (...args: any[]) => console.warn(...args),
  error: (...args: any[]) => console.error(...args),
  debug: (...args: any[]) => console.debug(...args),
};

type TF = "M1" | "M5" | "M15" | "M30" | "H1";

const TF_MINUTES: Record<TF, number> = {
  M1: 1,
  M5: 5,
  M15: 15,
  M30: 30,
  H1: 60,
};

function toDateUTC(d: string | Date): Date {
  return d instanceof Date ? d : new Date(d);
}

function floorToBucket(date: Date, tfMin: number): Date {
  const ms = date.getTime();
  const bucket = Math.floor(ms / (tfMin * 60 * 1000)) * tfMin * 60 * 1000;
  return new Date(bucket);
}

function ceilToBucketExclusive(date: Date, tfMin: number): Date {
  const ms = date.getTime();
  const rem = ms % (tfMin * 60 * 1000);
  const target = rem === 0 ? ms : ms + (tfMin * 60 * 1000 - rem);
  return new Date(target);
}

/**
 * Agrega uma série de candles M1 em TF alvo (M5, M15, ...).
 */
function aggregateCandles(
  m1: Candle[],
  tf: TF
): Array<Pick<Candle, "time" | "open" | "high" | "low" | "close" | "volume">> {
  if (tf === "M1") {
    return m1.map((c) => ({
      time: c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }));
  }
  const tfMin = TF_MINUTES[tf];
  const buckets = new Map<
    number,
    {
      time: Date;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
    }
  >();

  // Garantir ordenação
  const arr = [...m1].sort((a, b) => a.time.getTime() - b.time.getTime());

  for (const c of arr) {
    const bTime = floorToBucket(c.time, tfMin);
    const key = bTime.getTime();
    if (!buckets.has(key)) {
      buckets.set(key, {
        time: bTime,
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

  return [...buckets.values()].sort(
    (a, b) => a.time.getTime() - b.time.getTime()
  );
}

/**
 * Calcula EMA simples (exponencial) sobre `close`.
 */
function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev: number | undefined;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (i === 0) {
      prev = v;
    } else {
      prev = (v - (prev as number)) * k + (prev as number);
    }
    out.push(prev as number);
  }
  return out;
}

/**
 * Upsert tolerante ao schema atual:
 * - NÃO usa campo `time` em Signal (não existe no seu schema).
 * - NÃO depende do índice único composto; faz findFirst + update/create se necessário.
 * - Se futuramente existir o índice composto, tenta o upsert "bonito" primeiro.
 */
async function safeUpsertSignal(ev: {
  candleId: number;
  signalType: string;
  side: string;
  score?: number;
  reason?: string | null;
}) {
  // Tentativa de upsert com índice composto (se existir no client gerado)
  try {
    // @ts-ignore - caso o client não tenha o composite type gerado
    return await prisma.signal.upsert({
      where: {
        // funciona apenas se @@unique([candleId, signalType, side]) existir no banco e no client
        candleId_signalType_side: {
          candleId: ev.candleId,
          signalType: ev.signalType,
          side: ev.side,
        },
      },
      update: { score: ev.score ?? 0, reason: ev.reason ?? null },
      create: {
        candleId: ev.candleId,
        signalType: ev.signalType,
        side: ev.side,
        score: ev.score ?? 0,
        reason: ev.reason ?? null,
      },
    });
  } catch (_err) {
    // Fallback universal
    const existing = await prisma.signal.findFirst({
      where: {
        candleId: ev.candleId,
        signalType: ev.signalType,
        side: ev.side,
      },
      select: { id: true },
    });

    if (existing) {
      return prisma.signal.update({
        where: { id: existing.id },
        data: { score: ev.score ?? 0, reason: ev.reason ?? null },
      });
    }

    return prisma.signal.create({
      data: {
        candleId: ev.candleId,
        signalType: ev.signalType,
        side: ev.side,
        score: ev.score ?? 0,
        reason: ev.reason ?? null,
      },
    });
  }
}

/**
 * Gera sinais confirmados básicos via cruzamento de EMA(9) e EMA(21).
 * - BUY quando EMA9 cruza acima da EMA21
 * - SELL quando EMA9 cruza abaixo da EMA21
 */
async function generateConfirmedSignalsForTF(
  instrumentId: number,
  tf: TF,
  from: Date,
  to: Date
) {
  // Busca candles TF do intervalo
  const candles = await prisma.candle.findMany({
    where: {
      instrumentId,
      timeframe: tf,
      time: { gte: from, lte: to },
    },
    orderBy: { time: "asc" },
  });

  if (candles.length === 0) {
    logger.info("[SignalsWorker] nenhum candle TF para gerar sinais", {
      tf,
      from,
      to,
    });
    return 0;
  }

  const closes = candles.map((c) => c.close);
  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);

  let createdOrUpdated = 0;

  for (let i = 1; i < candles.length; i++) {
    const prevDiff = e9[i - 1] - e21[i - 1];
    const diff = e9[i] - e21[i];

    // Cruzamento: muda de sinal (acima/abaixo de zero)
    if (prevDiff <= 0 && diff > 0) {
      // BUY
      await safeUpsertSignal({
        candleId: candles[i].id,
        signalType: "EMA_CROSS",
        side: "BUY",
        score: Math.abs(diff) / (Math.abs(e21[i]) || 1),
        reason: "EMA9 cross above EMA21",
      });
      createdOrUpdated++;
    } else if (prevDiff >= 0 && diff < 0) {
      // SELL
      await safeUpsertSignal({
        candleId: candles[i].id,
        signalType: "EMA_CROSS",
        side: "SELL",
        score: Math.abs(diff) / (Math.abs(e21[i]) || 1),
        reason: "EMA9 cross below EMA21",
      });
      createdOrUpdated++;
    }
  }

  logger.info("[SignalsWorker] sinais confirmados salvos/atualizados", {
    tf,
    count: createdOrUpdated,
  });
  return createdOrUpdated;
}

/**
 * Garante que exista `Instrument` para o símbolo.
 */
async function ensureInstrument(symbol: string): Promise<number> {
  const found = await prisma.instrument.findUnique({ where: { symbol } });
  if (found) return found.id;

  const created = await prisma.instrument.create({
    data: { symbol, name: symbol },
  });
  return created.id;
}

/**
 * Carrega M1 no intervalo e agrega para TF desejado.
 * Insere apenas os candles TF que ainda não existem (sem skipDuplicates).
 */
async function ensureAggregatedTF(
  instrumentId: number,
  tf: TF,
  from: Date,
  to: Date
): Promise<number> {
  const tfMin = TF_MINUTES[tf];
  if (!tfMin) throw new Error(`Timeframe inválido: ${tf}`);

  // Busca o que já temos nesse TF
  const alreadyTF = await prisma.candle.count({
    where: { instrumentId, timeframe: tf, time: { gte: from, lte: to } },
  });

  if (alreadyTF > 0) {
    // Já existe algo; ainda assim vamos tentar completar buracos.
    logger.info(
      "[SignalsWorker] TF já possui registros — completando buracos, se houver",
      { tf, count: alreadyTF }
    );
  }

  // Busca M1 do intervalo [from, to)
  const baseM1 = await prisma.candle.findMany({
    where: { instrumentId, timeframe: "M1", time: { gte: from, lt: to } },
    orderBy: { time: "asc" },
  });

  logger.info("[SignalsWorker] M1 base count", { base: baseM1.length });

  if (baseM1.length === 0) {
    logger.warn("[SignalsWorker] não há M1 no intervalo; nada para agregar");
    return 0;
  }

  // Agrega
  const agg = aggregateCandles(baseM1, tf);
  logger.info("[SignalsWorker] aggregated TF", { tf, aggregated: agg.length });

  if (agg.length === 0) return 0;

  // Inserir somente os que faltam (sem skipDuplicates)
  const times = agg.map((c) => c.time);
  const existing = await prisma.candle.findMany({
    where: { instrumentId, timeframe: tf, time: { in: times } },
    select: { time: true },
  });
  const existingSet = new Set(existing.map((e) => e.time.getTime()));
  const toInsert = agg
    .filter((c) => !existingSet.has(c.time.getTime()))
    .map((c) => ({
      instrumentId,
      timeframe: tf,
      time: c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }));

  if (toInsert.length) {
    await prisma.candle.createMany({ data: toInsert });
    logger.info("[SignalsWorker] candles TF inseridos", {
      tf,
      inserted: toInsert.length,
      skipped: agg.length - toInsert.length,
    });
  } else {
    logger.info(
      "[SignalsWorker] nenhum candle novo para inserir (TF já preenchido)",
      {
        tf,
        totalAgg: agg.length,
      }
    );
  }

  return agg.length;
}

/**
 * Backfill principal:
 * - Garante instrumento
 * - Garante TF agregado a partir de M1 (quando necessário)
 * - Gera sinais confirmados (EMA cross) no TF
 */
export async function backfillCandlesAndSignals(params: {
  symbol: string;
  timeframe: TF;
  from: string | Date;
  to: string | Date;
}) {
  const { symbol, timeframe, from, to } = params;
  const tf = timeframe;

  const fromD = floorToBucket(toDateUTC(from), TF_MINUTES[tf]);
  const toD = ceilToBucketExclusive(toDateUTC(to), TF_MINUTES[tf]);

  const instrumentId = await ensureInstrument(symbol);

  logger.info("[SignalsWorker] backfill start", {
    symbol,
    tf,
    from: fromD.toISOString(),
    to: toD.toISOString(),
  });

  // Garante TF agregado a partir de M1
  await ensureAggregatedTF(instrumentId, tf, fromD, toD);

  // Gera sinais confirmados (baseline)
  const count = await generateConfirmedSignalsForTF(
    instrumentId,
    tf,
    fromD,
    toD
  );

  logger.info("[SignalsWorker] backfill done", { symbol, tf, signals: count });

  return { ok: true, insertedSignals: count };
}

/**
 * API-friendly: chamado pela rota /admin/signals/backfill
 */
export async function handleAdminBackfill(body: {
  symbol?: string;
  timeframe?: TF;
  from?: string;
  to?: string;
}) {
  try {
    if (!body || !body.symbol || !body.timeframe || !body.from || !body.to) {
      return {
        ok: false,
        error: "Parâmetros obrigatórios: symbol, timeframe, from, to",
      };
    }
    const res = await backfillCandlesAndSignals({
      symbol: body.symbol,
      timeframe: body.timeframe,
      from: body.from,
      to: body.to,
    });
    return res;
  } catch (err: any) {
    logger.error("[SignalsWorker] handleAdminBackfill erro", err);
    return { ok: false, error: String(err?.message || err) };
  }
}

// Export default (facilita importações existentes)
export default {
  backfillCandlesAndSignals,
  handleAdminBackfill,
};
