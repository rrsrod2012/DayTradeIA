/* eslint-disable no-console */
import { PrismaClient } from "@prisma/client";
import { ADX } from "../services/indicators";
import { loadCandlesAnyTF } from "../lib/aggregation";

const prisma = new PrismaClient();

const logger = {
  info: (...args: any[]) => console.log(...args),
  warn: (...args: any[]) => console.warn(...args),
  error: (...args: any[]) => console.error(...args),
};

const TF_MINUTES: Record<string, number> = {
  M1: 1,
  M5: 5,
  M15: 15,
  M30: 30,
  H1: 60,
};

function floorToBucket(d: Date, tfMin: number): Date {
  const y = d.getUTCFullYear(),
    m = d.getUTCMonth(),
    day = d.getUTCDate();
  const H = d.getUTCHours(),
    M = d.getUTCMinutes();
  const bucketMin = Math.floor(M / tfMin) * tfMin;
  return new Date(Date.UTC(y, m, day, H, bucketMin, 0, 0));
}

/** Monta candidatos aceitos para o campo timeframe no banco, sem null */
function tfCandidates(tf: keyof typeof TF_MINUTES): string[] {
  const s = String(tf).toUpperCase();
  const n = String(TF_MINUTES[tf]); // "5", "1", etc
  const out = Array.from(new Set([s, n])).filter(Boolean);
  return out;
}

/**
 * Busca candles usando o AGREGADOR central (sempre parte de M1 quando necessário),
 * garantindo que confirmados e projetados usem a MESMA série por TF.
 */
async function getCandlesFromDB(
  instrumentId: number,
  tf: keyof typeof TF_MINUTES
) {
  const inst = await prisma.instrument.findUnique({
    where: { id: instrumentId },
    select: { symbol: true },
  });
  if (!inst?.symbol) return [];

  const rows = await loadCandlesAnyTF(
    String(inst.symbol).toUpperCase(),
    String(tf).toUpperCase()
  );

  return rows.map((r: any, idx: number) => ({
    id: idx, // placeholder; o id real é resolvido por time
    time: r.time instanceof Date ? r.time : new Date(r.time),
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: r.volume == null ? null : Number(r.volume),
    timeframe: String(tf).toUpperCase(),
  }));
}

/**
 * Garante que exista um Candle persistido exatamente no TF solicitado.
 * - Se existir (instrumentId + time + timeframe em candidatos), retorna o id (atualizando OHLCV se necessário).
 * - Se não existir, cria com os valores do candle agregado.
 */
async function upsertTfCandle(
  instrumentId: number,
  tf: keyof typeof TF_MINUTES,
  row: {
    time: Date;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number | null;
  }
): Promise<number | null> {
  const candidates = tfCandidates(tf);

  const found = await prisma.candle.findFirst({
    where: { instrumentId, time: row.time, timeframe: { in: candidates } },
    select: { id: true, open: true, high: true, low: true, close: true, volume: true, timeframe: true },
  });

  if (found?.id) {
    const needsUpdate =
      Number(found.open) !== row.open ||
      Number(found.high) !== row.high ||
      Number(found.low) !== row.low ||
      Number(found.close) !== row.close ||
      ((found.volume ?? null) !== (row.volume ?? null));

    if (needsUpdate) {
      await prisma.candle.update({
        where: { id: found.id },
        data: {
          open: row.open,
          high: row.high,
          low: row.low,
          close: row.close,
          volume: row.volume,
        },
      });
    }
    return found.id;
  }

  // cria no TF canônico (ex.: "M5", "M1", etc)
  const tfStr = String(tf).toUpperCase();
  const created = await prisma.candle.create({
    data: {
      instrumentId,
      timeframe: tfStr,
      time: row.time,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume,
    },
    select: { id: true },
  });
  return created?.id ?? null;
}

function ema(values: number[], period: number): number[] {
  const out: number[] = [];
  const k = 2 / (period + 1);
  let e: number | null = null;
  for (let i = 0; i < values.length; i++) {
    const v = Number(values[i]) || 0;
    e = e == null ? v : v * k + e * (1 - k);
    out.push(e);
  }
  return out;
}

export async function backfillCandlesAndSignals(
  instrumentId: number,
  tf: keyof typeof TF_MINUTES
) {
  const candles = await getCandlesFromDB(instrumentId, tf);
  if (!candles.length) {
    logger.warn(
      `[SignalsWorker] nenhum candle (via agregador) para TF=${tf}. Pulei geração de sinais confirmados.`
    );
    return { createdOrUpdated: 0, candles: 0 };
  }

  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);

  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  const adx = ADX(highs, lows, closes, 14);

  let createdOrUpdated = 0;

  const tfMin = TF_MINUTES[tf];

  for (let i = 1; i < candles.length; i++) {
    const prevDiff = e9[i - 1] - e21[i - 1];
    const diff = e9[i] - e21[i];

    let side: "BUY" | "SELL" | null = null;
    if (prevDiff < 0 && diff > 0) side = "BUY";
    else if (prevDiff > 0 && diff < 0) side = "SELL";
    else continue;

    // tempo “bucketizado” para o TF
    const bucketTime = floorToBucket(candles[i].time, tfMin);

    // garante que exista um candle PERSISTIDO exatamente no TF solicitado
    const candleId = await upsertTfCandle(instrumentId, tf, {
      time: bucketTime,
      open: candles[i].open,
      high: candles[i].high,
      low: candles[i].low,
      close: candles[i].close,
      volume: candles[i].volume ?? null,
    });

    if (!candleId) continue;

    const reason =
      side === "BUY"
        ? `EMA9 cross above EMA21 • ADX14=${(adx[i] ?? 0).toFixed(1)}`
        : `EMA9 cross below EMA21 • ADX14=${(adx[i] ?? 0).toFixed(1)}`;

    const existing = await prisma.signal.findFirst({
      where: { candleId, signalType: "EMA_CROSS", side },
      select: { id: true },
    });

    if (existing?.id) {
      await prisma.signal.update({
        where: { id: existing.id },
        data: { score: Math.abs(diff) / (Math.abs(e21[i]) || 1), reason },
      });
    } else {
      await prisma.signal.create({
        data: {
          candleId,
          signalType: "EMA_CROSS",
          side,
          score: Math.abs(diff) / (Math.abs(e21[i]) || 1),
          reason,
        },
      });
    }
    createdOrUpdated++;
  }

  return { candles: candles.length, createdOrUpdated };
}

/** Handler opcional (usado no server.ts) para gerar sinais por instrumento/TF */
export async function handleAdminBackfill(req: any, res: any) {
  try {
    const body = req?.body || {};
    const tf: keyof typeof TF_MINUTES = String(
      body.timeframe || "M5"
    ).toUpperCase() as any;

    const instrument = await prisma.instrument.findFirst({
      where: { symbol: String(body.symbol || "").toUpperCase() },
      select: { id: true },
    });
    if (!instrument)
      return res.status(200).json({ ok: false, error: "instrument not found" });

    const r = await backfillCandlesAndSignals(instrument.id, tf);
    return res.status(200).json({ ok: true, ...r });
  } catch (err: any) {
    logger.error("[SignalsWorker] handleAdminBackfill erro", err);
    return res
      .status(200)
      .json({ ok: false, error: String(err?.message || err) });
  }
}

export default { backfillCandlesAndSignals, handleAdminBackfill };
