// ===============================
// FILE: backend_new/src/modules/data-import/lib/aggregation.ts
// ===============================
import { prisma } from '../../../core/prisma';
import { Candle } from '@prisma/client';

const tfToMinutes = (tf: string): number => {
  const s = tf.toUpperCase();
  if (s.startsWith('M')) return parseInt(s.slice(1), 10) || 1;
  if (s.startsWith('H')) return (parseInt(s.slice(1), 10) || 1) * 60;
  return 1;
};

// Esta função é o coração do agregador.
export async function loadCandlesAnyTF(
  symbol: string,
  timeframe: string,
  range?: { gte?: Date, lte?: Date, limit?: number }
): Promise<Candle[]> {
  const tfUpper = timeframe.toUpperCase();

  // Se o timeframe pedido for M1, busca diretamente no banco.
  if (tfUpper === 'M1') {
    const instrument = await prisma.instrument.findUnique({ where: { symbol } });
    if (!instrument) return [];

    return prisma.candle.findMany({
      where: {
        instrumentId: instrument.id,
        timeframe: 'M1',
        ...(range?.gte && { time: { gte: range.gte } }),
        ...(range?.lte && { time: { lte: range.lte } }),
      },
      orderBy: { time: 'asc' },
      take: range?.limit,
    });
  }

  // Se for outro timeframe, busca a base M1 para agregar.
  const instrument = await prisma.instrument.findUnique({ where: { symbol } });
  if (!instrument) return [];

  const m1Candles = await prisma.candle.findMany({
    where: {
      instrumentId: instrument.id,
      timeframe: 'M1',
      ...(range?.gte && { time: { gte: range.gte } }),
      ...(range?.lte && { time: { lte: range.lte } }),
    },
    orderBy: { time: 'asc' },
  });

  if (m1Candles.length === 0) return [];

  const targetMinutes = tfToMinutes(tfUpper);
  const aggregated = new Map<number, Partial<Candle>>();

  for (const c of m1Candles) {
    const bucketTime = Math.floor(c.time.getTime() / (targetMinutes * 60 * 1000)) * (targetMinutes * 60 * 1000);

    if (!aggregated.has(bucketTime)) {
      aggregated.set(bucketTime, {
        instrumentId: c.instrumentId,
        timeframe: tfUpper,
        time: new Date(bucketTime),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      });
    } else {
      const current = aggregated.get(bucketTime)!;
      current.high = Math.max(current.high!, c.high);
      current.low = Math.min(current.low!, c.low);
      current.close = c.close;
      current.volume = (current.volume || 0) + (c.volume || 0);
    }
  }

  const result = Array.from(aggregated.values()) as Candle[];
  return range?.limit ? result.slice(-range.limit) : result;
}