// backend/scripts/diag-db.js
const path = require('path');
const fs = require('fs');

// Carrega .env (tenta no backend/.env e no projeto raiz)
const envPaths = [
  path.resolve(__dirname, '..', '.env'),
  path.resolve(__dirname, '..', '..', '.env'),
];
for (const p of envPaths) {
  if (fs.existsSync(p)) {
    require('dotenv').config({ path: p });
    break;
  }
}

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

function toBR(d) {
  if (!d) return null;
  const z = new Date(d);
  const br = new Date(z.getTime() - 3*60*60*1000);
  const pad = (n)=>String(n).padStart(2,'0');
  return `${br.getFullYear()}-${pad(br.getMonth()+1)}-${pad(br.getDate())} ${pad(br.getHours())}:${pad(br.getMinutes())}:${pad(br.getSeconds())}`;
}

(async () => {
  const SYMBOL = (process.env.SYMBOL || 'WIN').toUpperCase();
  const ENTRY_PRICE_LOOKUP = process.env.ENTRY_PRICE_LOOKUP ? Number(process.env.ENTRY_PRICE_LOOKUP) : null;

  console.log('DATABASE_URL =', process.env.DATABASE_URL || '(não definido)');
  console.log('NODE_ENV     =', process.env.NODE_ENV || '(não definido)');

  const counts = {
    instruments: await prisma.instrument.count(),
    candles: await prisma.candle.count(),
    signals: await prisma.signal.count(),
    signals_ema: await prisma.signal.count({ where: { signalType: 'EMA_CROSS' } }),
    trades: await prisma.trade.count(),
  };
  console.log('COUNTS =', counts);

  // 20 trades mais recentes
  const latest = await prisma.trade.findMany({
    orderBy: { id: 'desc' },
    take: 20,
    select: {
      id: true,
      timeframe: true,
      entryPrice: true,
      exitPrice: true,
      pnlPoints: true,
      qty: true,
      instrument: { select: { symbol: true } },
      entrySignal: {
        select: {
          id: true,
          side: true,
          signalType: true,
          candle: { select: { time: true } },
        }
      },
      exitSignal: { select: { id: true, signalType: true } },
    },
  });

  console.log('\nULTIMOS 20 TRADES (id desc):');
  latest.forEach(t => {
    console.log({
      id: t.id,
      sym: t.instrument?.symbol,
      tf: t.timeframe,
      entryTimeBR: toBR(t.entrySignal?.candle?.time),
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice,
      pnl: t.pnlPoints,
      qty: t.qty,
      entrySignalId: t.entrySignal?.id,
      entrySignalSide: t.entrySignal?.side,
      exitSignalType: t.exitSignal?.signalType || null,
    });
  });

  // Datas (BR) em que há trades para SYMBOL
  const tradesForSym = await prisma.trade.findMany({
    where: { instrument: { symbol: SYMBOL } },
    select: { entrySignal: { select: { candle: { select: { time: true } } } } },
  });
  const days = new Set();
  tradesForSym.forEach(t => {
    const tt = t.entrySignal?.candle?.time;
    if (tt) {
      const d = toBR(tt).slice(0, 10); // YYYY-MM-DD
      days.add(d);
    }
  });
  console.log(`\nDIAS COM TRADES para ${SYMBOL}:`, [...days].sort());

  // Lookup por entryPrice (opcional)
  if (ENTRY_PRICE_LOOKUP) {
    const found = await prisma.trade.findMany({
      where: { entryPrice: ENTRY_PRICE_LOOKUP },
      select: {
        id: true,
        timeframe: true,
        entryPrice: true,
        instrument: { select: { symbol: true } },
        entrySignal: { select: { id: true, side: true, candle: { select: { time: true } } } },
        exitSignal: { select: { id: true, signalType: true } },
      },
      take: 20,
    });
    console.log(`\nLOOKUP entryPrice=${ENTRY_PRICE_LOOKUP}:`, found.map(f => ({
      id: f.id,
      sym: f.instrument?.symbol,
      tf: f.timeframe,
      entryTimeBR: toBR(f.entrySignal?.candle?.time),
      entryPrice: f.entryPrice,
      entrySignalSide: f.entrySignal?.side,
      exitSignalType: f.exitSignal?.signalType || null,
    })));
  }

  await prisma.$disconnect();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
