// backend/scripts/check-trade-link.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const SYMBOL = process.env.SYMBOL || 'WIN';
  const LOCAL_DATETIME = process.env.LOCAL_DATETIME || '2025-09-11 09:01:00'; // -03
  const WINDOW_MIN = Number(process.env.WINDOW_MIN || 5);

  const center = new Date(LOCAL_DATETIME.replace(' ','T') + '-03:00');
  const from = new Date(center.getTime() - WINDOW_MIN*60*1000);
  const to   = new Date(center.getTime() + WINDOW_MIN*60*1000);

  const trades = await prisma.trade.findMany({
    where: {
      instrument: { symbol: SYMBOL.toUpperCase() },
      entrySignal: { candle: { time: { gte: from, lte: to } } }, // filtra pelo candle do sinal
    },
    select: {
      id: true,
      timeframe: true,
      entryPrice: true,
      exitPrice: true,
      pnlPoints: true,
      entrySignal: {
        select: {
          id: true,
          side: true,
          signalType: true,
          candle: { select: { time: true } },
        }
      },
      exitSignal: { select: { id: true, signalType: true } },
      instrument: { select: { symbol: true } },
    },
    orderBy: [{ id: 'asc' }]
  });

  const pad2 = (n)=>String(n).padStart(2,'0');
  const toBR = (d) => {
    if (!d) return null;
    const z = new Date(d);
    const br = new Date(z.getTime() - 3*60*60*1000);
    return `${br.getFullYear()}-${pad2(br.getMonth()+1)}-${pad2(br.getDate())} ${pad2(br.getHours())}:${pad2(br.getMinutes())}:${pad2(br.getSeconds())}`;
  };

  console.log(`Trades em ~${LOCAL_DATETIME} [${SYMBOL}] (±${WINDOW_MIN}min):`);
  for (const t of trades) {
    console.log({
      tradeId: t.id,
      tradeSide: t.entrySignal?.side ?? '(desconhecido)', // lado via sinal
      tf: t.timeframe,
      entryTimeBR: toBR(t.entrySignal?.candle?.time),
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice,
      pnl: t.pnlPoints,
      entrySignalId: t.entrySignal?.id,
      entrySignalSide: t.entrySignal?.side,
      entrySignalTimeBR: toBR(t.entrySignal?.candle?.time),
      exitSignalType: t.exitSignal?.signalType || null,
    });
  }
  if (!trades.length) console.log('(nenhum)');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
