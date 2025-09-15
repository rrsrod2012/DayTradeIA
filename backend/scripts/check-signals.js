const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const SYMBOL = 'WIN';
  const LOCAL_DATETIME = '2025-09-11 09:01:00'; // horário local -03
  const TF = 'M5';

  const z = new Date(LOCAL_DATETIME.replace(' ', 'T') + '-03:00');
  const from = new Date(z.getTime() - 500);
  const to   = new Date(z.getTime() + 500);

  const signals = await prisma.signal.findMany({
    where: {
      signalType: 'EMA_CROSS',
      candle: {
        time: { gte: from, lte: to },
        instrument: { symbol: SYMBOL.toUpperCase() }
      }
    },
    select: {
      id: true, side: true, reason: true,
      candle: { select: { id: true, time: true, timeframe: true, instrument: { select: { symbol: true } } } }
    },
    orderBy: [{ candleId: 'asc' }, { id: 'asc' }]
  });

  console.log('Signals @09:01:', signals.map(s => ({
    id: s.id, side: s.side, tf: s.candle.timeframe, sym: s.candle.instrument.symbol, time: s.candle.time
  })));

  process.exit(0);
})();
