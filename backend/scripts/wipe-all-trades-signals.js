/* eslint-disable no-console */
const path = require("path");
const fs = require("fs");
for (const p of [
  path.resolve(__dirname, "..", ".env"),
  path.resolve(__dirname, "..", "..", ".env"),
]) {
  if (fs.existsSync(p)) { require("dotenv").config({ path: p }); break; }
}
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

(async () => {
  console.log("DATABASE_URL =", process.env.DATABASE_URL || "(none)");

  // 1) Apaga TODOS os trades (primeiro, para não quebrar FK de signals)
  const delTrades = await prisma.$executeRawUnsafe(`DELETE FROM "Trade";`);
  console.log("Trades deletados:", delTrades);

  // 2) Apaga TODOS os signals
  const delSignals = await prisma.$executeRawUnsafe(`DELETE FROM "Signal";`);
  console.log("Signals deletados:", delSignals);

  // 3) Mostra contagens finais (candles permanecem intactos)
  const counts = {
    instruments: await prisma.instrument.count(),
    candles: await prisma.candle.count(),
    signals: await prisma.signal.count(),
    trades: await prisma.trade.count(),
  };
  console.log("COUNTS após wipe =", counts);

  await prisma.$disconnect();
  console.log("Wipe global concluído (só candles mantidos).");
  process.exit(0);
})().catch(async (e) => {
  console.error(e);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
