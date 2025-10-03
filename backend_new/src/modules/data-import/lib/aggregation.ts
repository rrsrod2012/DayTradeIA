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
  range?: { gte?: Date; lte?: Date; limit?: number }
): Promise<Candle[]> {
  const tfUpper = timeframe.toUpperCase();

  // Busca instrumento
  const instrument = await prisma.instrument.findUnique({ where: { symbol } });
  if (!instrument) return [];

  // WHERE base (com janela de tempo se fornecida)
  const baseWhere: any = {
    instrumentId: instrument.id,
    timeframe: 'M1',
  };
  if (range?.gte || range?.lte) {
    baseWhere.time = {};
    if (range?.gte) baseWhere.time.gte = range.gte;
    if (range?.lte) baseWhere.time.lte = range.lte;
  }

  // Se o timeframe pedido for M1, busca diretamente no banco com os filtros
  if (tfUpper === 'M1') {
    return prisma.candle.findMany({
      where: baseWhere,
      orderBy: { time: 'asc' },
      take: range?.limit,
    });
  }

  // Caso contrário, busca M1 e agrega no cliente
  const m1Candles = await prisma.candle.findMany({
    where: baseWhere,
    orderBy: { time: 'asc' },
  });

  if (m1Candles.length === 0) return [];

  // Agregação para o timeframe alvo
  const targetMinutes = tfToMinutes(tfUpper);
  const bucketMs = targetMinutes * 60 * 1000;

  const aggregated = new Map<number, any>();
  for (const c of m1Candles) {
    const t = new Date(c.time).getTime();
    const bucketTime = Math.floor(t / bucketMs) * bucketMs;

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
