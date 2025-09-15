// backend/scripts/count-day.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const SYMBOL = (process.env.SYMBOL || 'WIN').toUpperCase();
  const DAY = process.env.DAY || '2025-09-11'; // -03

  const start = new Date(DAY + 'T00:00:00-03:00');
  const end   = new Date(DAY + 'T23:59:59-03:00');

  const inst = await prisma.instrument.findFirst({ where: { symbol: SYMBOL }, select: { id: true } });

  const candles = await prisma.candle.count({
    where: { instrumentId: inst?.id, time: { gte: start, lte: end } },
  });

  const emaSignals = await prisma.signal.count({
    where: { signalType: 'EMA_CROSS', candle: { instrumentId: inst?.id, time: { gte: start, lte: end } } },
  });

  console.log({ symbol: SYMBOL, day: DAY, candles, emaSignals });
  process.exit(0);
})();
