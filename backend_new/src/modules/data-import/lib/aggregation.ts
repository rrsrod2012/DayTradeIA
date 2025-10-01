import { PrismaClient } from "@prisma/client";
import { DateTime } from "luxon";

const prisma = new PrismaClient();

const TF_MINUTES: Record<string, number> = {
  M1: 1, M5: 5, M15: 15, M30: 30, H1: 60,
};

type Candle = {
  time: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

function aggregateCandles(m1Candles: Candle[], targetTf: string): Candle[] {
  const targetMin = TF_MINUTES[targetTf];
  if (!targetMin || targetMin === 1) return m1Candles;

  const out: Candle[] = [];
  if (m1Candles.length === 0) return out;

  let bucketTime = DateTime.fromJSDate(m1Candles[0].time, { zone: 'utc' }).startOf('minute');
  bucketTime = bucketTime.set({ minute: Math.floor(bucketTime.minute / targetMin) * targetMin });

  let open = m1Candles[0].open;
  let high = -Infinity;
  let low = Infinity;
  let close = m1Candles[0].close;
  let volume = 0;

  for (const c of m1Candles) {
    const cTime = DateTime.fromJSDate(c.time, { zone: 'utc' });
    const cBucketTime = cTime.set({ minute: Math.floor(cTime.minute / targetMin) * targetMin });

    if (cBucketTime.toMillis() !== bucketTime.toMillis()) {
      out.push({ time: bucketTime.toJSDate(), open, high, low, close, volume });
      bucketTime = cBucketTime;
      open = c.open;
      high = -Infinity;
      low = Infinity;
      volume = 0;
    }

    high = Math.max(high, c.high);
    low = Math.min(low, c.low);
    close = c.close;
    volume += c.volume ?? 0;
  }

  out.push({ time: bucketTime.toJSDate(), open, high, low, close, volume });
  return out;
}

export async function loadCandlesAnyTF(
  symbol: string,
  timeframe: string,
  range?: { gte?: Date; lte?: Date; limit?: number }
): Promise<Candle[]> {
  const tfUpper = timeframe.toUpperCase();
  const instrument = await prisma.instrument.findUnique({ where: { symbol } });
  if (!instrument) return [];

  const m1Candles = await prisma.candle.findMany({
    where: {
      instrumentId: instrument.id,
      timeframe: 'M1',
      ...(range?.gte || range?.lte ? { time: { gte: range.gte, lte: range.lte } } : {}),
    },
    orderBy: { time: 'asc' },
    take: range?.limit ? range.limit * (TF_MINUTES[tfUpper] || 5) : undefined, // busca mais M1 para garantir a agregação
  });

  if (TF_MINUTES[tfUpper] > 1) {
    return aggregateCandles(m1Candles, tfUpper);
  }
  return m1Candles;
}