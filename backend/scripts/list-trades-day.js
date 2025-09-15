// backend/scripts/list-trades-day.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const SYMBOL = process.env.SYMBOL || 'WIN';
  const LOCAL_DATE = process.env.LOCAL_DATE || '2025-09-11'; // -03
  const start = new Date(LOCAL_DATE + 'T00:00:00-03:00');
  const end   = new Date(LOCAL_DATE + 'T23:59:59-03:00');

  const trades = await prisma.trade.findMany({
    where: {
      instrument: { symbol: SYMBOL.toUpperCase() },
      // filtraremos pelo dia usando o horário do candle do entrySignal
    },
    select: {
      id: true,
      timeframe: true,
      entryPrice: true,
      exitPrice: true,
      pnlPoints: true,
      qty: true,
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

  // limitar ao dia pelo candle do entrySignal
  const inDay = trades.filter(t => {
    const t0 = t.entrySignal?.candle?.time;
    if (!t0) return false;
    return t0 >= start && t0 <= end;
  });

  console.log(`Trades do dia ${LOCAL_DATE} [${SYMBOL}]: total=${inDay.length}`);
  for (const t of inDay) {
    console.log({
      tradeId: t.id,
      tradeSide: t.entrySignal?.side ?? '(desconhecido)', // lado do sinal de entrada
      tf: t.timeframe,
      entryTimeBR: toBR(t.entrySignal?.candle?.time),
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice,
      pnl: t.pnlPoints,
      qty: t.qty,
      entrySignalId: t.entrySignal?.id,
      entrySignalSide: t.entrySignal?.side,
      entrySignalTimeBR: toBR(t.entrySignal?.candle?.time),
      exitSignalType: t.exitSignal?.signalType || null,
    });
  }

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
