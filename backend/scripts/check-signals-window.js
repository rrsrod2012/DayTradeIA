const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const SYMBOL = process.env.SYMBOL || 'WIN';
  const LOCAL_DATETIME = process.env.LOCAL_DATETIME || '2025-09-11 09:01:00'; // -03
  const WINDOW_MIN = Number(process.env.WINDOW_MIN || 10);

  const baseLocal = new Date(LOCAL_DATETIME.replace(' ', 'T') + '-03:00'); // BR->UTC
  const from = new Date(baseLocal.getTime() - WINDOW_MIN * 60 * 1000);
  const to   = new Date(baseLocal.getTime() + WINDOW_MIN * 60 * 1000);

  const signals = await prisma.signal.findMany({
    where: {
      signalType: 'EMA_CROSS',
      candle: {
        time: { gte: from, lte: to },
        instrument: { symbol: SYMBOL.toUpperCase() },
      },
    },
    orderBy: [{ candleId: 'asc' }, { id: 'asc' }],
    select: {
      id: true, side: true, reason: true,
      candle: { select: { id:true, time:true, timeframe:true, instrument: { select: { symbol:true } } } }
    }
  });

  const fmt = (d) => {
    const z = new Date(d);
    const br = new Date(z.getTime() - 3*60*60*1000);
    const pad = (n)=>String(n).padStart(2,'0');
    const isoBR = `${br.getFullYear()}-${pad(br.getMonth()+1)}-${pad(br.getDate())} ${pad(br.getHours())}:${pad(br.getMinutes())}:${pad(br.getSeconds())}`;
    return { utc: z.toISOString(), br: isoBR };
  };

  console.log(`Sinais EMA_CROSS ~ ${LOCAL_DATETIME} (-03) [${SYMBOL}] (±${WINDOW_MIN}min):`);
  for (const s of signals) {
    const t = fmt(s.candle.time);
    console.log({
      id: s.id, side: s.side, tf: s.candle.timeframe, sym: s.candle.instrument.symbol,
      time_utc: t.utc, time_br: t.br, reason: s.reason
    });
  }
  if (!signals.length) console.log('(nenhum)');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
