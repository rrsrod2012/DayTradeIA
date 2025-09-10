/* eslint-disable no-console */
import { PrismaClient } from "@prisma/client";
import { ADX } from "../services/indicators";

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

async function getCandlesFromDB(
  instrumentId: number,
  tf: keyof typeof TF_MINUTES
) {
  const candidates = tfCandidates(tf);

  // 1ª tentativa: filtrar pelo timeframe (M5 e "5")
  let rows = await prisma.candle.findMany({
    where: {
      instrumentId,
      timeframe: { in: candidates },
    },
    orderBy: { time: "asc" },
    select: {
      id: true,
      time: true,
      open: true,
      high: true,
      low: true,
      close: true,
      volume: true,
      timeframe: true,
    },
  });

  // Fallback: se nada encontrado, tentar sem filtrar timeframe (para dados legados)
  if (!rows.length) {
    rows = await prisma.candle.findMany({
      where: { instrumentId },
      orderBy: { time: "asc" },
      select: {
        id: true,
        time: true,
        open: true,
        high: true,
        low: true,
        close: true,
        volume: true,
        timeframe: true,
      },
    });
  }

  return rows;
}

async function findCandleIdByTime(
  instrumentId: number,
  tf: keyof typeof TF_MINUTES,
  t: Date
) {
  const candidates = tfCandidates(tf);

  // 1ª tentativa: com filtro de timeframe
  let c = await prisma.candle.findFirst({
    where: {
      instrumentId,
      time: t,
      timeframe: { in: candidates },
    },
    select: { id: true },
  });

  // Fallback: sem timeframe se não achou
  if (!c) {
    c = await prisma.candle.findFirst({
      where: {
        instrumentId,
        time: t,
      },
      select: { id: true },
    });
  }

  return c?.id ?? null;
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
      `[SignalsWorker] nenhum candle persistido para TF=${tf}. Pulei geração de sinais confirmados.`
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

  for (let i = 1; i < candles.length; i++) {
    const prevDiff = e9[i - 1] - e21[i - 1];
    const diff = e9[i] - e21[i];

    let side: "BUY" | "SELL" | null = null;
    if (prevDiff <= 0 && diff > 0) side = "BUY";
    if (prevDiff >= 0 && diff < 0) side = "SELL";
    if (!side) continue;

    const tfMin = TF_MINUTES[tf];
    const bucketTime = floorToBucket(candles[i].time, tfMin);

    const candleId =
      candles[i].id ||
      (await findCandleIdByTime(instrumentId, tf, bucketTime));
    if (!candleId) {
      // Candle não existe (ou não está com timeframe previsto); pule.
      continue;
    }

    const reason =
      side === "BUY"
        ? `EMA9 cross above EMA21 • ADX14=${(adx[i] ?? 0).toFixed(1)}`
        : `EMA9 cross below EMA21 • ADX14=${(adx[i] ?? 0).toFixed(1)}`;

    // Upsert por (candleId, signalType, side)
    const existing = await prisma.signal.findFirst({
      where: { candleId, signalType: "EMA_CROSS", side },
      select: { id: true },
    });

    if (existing) {
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
