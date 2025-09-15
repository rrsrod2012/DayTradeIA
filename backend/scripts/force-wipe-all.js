/* eslint-disable no-console */
const path = require("path");
const fs = require("fs");
for (const p of [path.resolve(__dirname, "..", ".env"), path.resolve(__dirname, "..", "..", ".env")]) {
  if (fs.existsSync(p)) { require("dotenv").config({ path: p }); break; }
}
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

(async () => {
  console.log("cwd=", process.cwd());
  console.log("DATABASE_URL=", process.env.DATABASE_URL);

  const before = {
    signals: await prisma.signal.count(),
    trades:  await prisma.trade.count(),
    candles: await prisma.candle.count(),
  };
  console.log("BEFORE:", before);

  // Deleta sempre Trades antes (FK) e depois Signals – tudo dentro de uma transação
  await prisma.$transaction([
    prisma.trade.deleteMany(),
    prisma.signal.deleteMany(),
  ]);

  const after = {
    signals: await prisma.signal.count(),
    trades:  await prisma.trade.count(),
    candles: await prisma.candle.count(),
  };
  console.log("AFTER :", after);

  if (after.signals !== 0 || after.trades !== 0) {
    console.log("Ainda sobrou coisa. Listando amostra de sinais...");
    const sample = await prisma.$queryRawUnsafe(`
      SELECT s.id,s.signalType,s.side,c.time AS candleTime,i.symbol
      FROM Signal s
      JOIN Candle c ON c.id = s.candleId
      JOIN Instrument i ON i.id = c.instrumentId
      ORDER BY s.id LIMIT 25
    `);
    console.log(sample);
  }

  await prisma.$disconnect();
  console.log("Force wipe concluído (candles preservados).");
  process.exit(0);
})().catch(async (e) => {
  console.error(e);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
