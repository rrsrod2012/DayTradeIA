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

const BATCH = 2000;

async function batched(ids, fn) {
  let total = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    total += await fn(chunk);
    console.log(`  - lote ${i}-${i + chunk.length - 1} OK`);
  }
  return total;
}

(async () => {
  const SYMBOL   = (process.env.SYMBOL || "WIN").toUpperCase();
  const DAY_FROM = process.env.DAY_FROM || null; // "YYYY-MM-DD" (horário -03 aplicado abaixo)
  const DAY_TO   = process.env.DAY_TO   || null;
  const TYPES = (process.env.TYPES || "EMA_CROSS,EXIT_TP,EXIT_SL,EXIT_NONE")
    .split(",").map(s => s.trim()).filter(Boolean);

  console.log({ DATABASE_URL: process.env.DATABASE_URL, SYMBOL, DAY_FROM, DAY_TO, TYPES });

  const inst = await prisma.instrument.findFirst({
    where: { symbol: SYMBOL }, select: { id: true }
  });
  if (!inst) { console.log("Instrumento não encontrado."); process.exit(0); }

  // 1) candles alvo (do instrumento e, opcionalmente, do período)
  const whereCandles = { instrumentId: inst.id };
  if (DAY_FROM || DAY_TO) {
    const from = DAY_FROM ? new Date(DAY_FROM + "T00:00:00-03:00") : undefined;
    const to   = DAY_TO   ? new Date(DAY_TO   + "T23:59:59-03:00") : undefined;
    whereCandles.time = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
  }
  const candles = await prisma.candle.findMany({ where: whereCandles, select: { id: true } });
  const candleIds = candles.map(c => c.id);
  console.log("candles alvo:", candleIds.length);
  if (!candleIds.length) { console.log("Nada a apagar."); process.exit(0); }

  // 2) signals alvo (por candleId + tipos)
  const signals = await prisma.signal.findMany({
    where: { candleId: { in: candleIds }, signalType: { in: TYPES } },
    select: { id: true }
  });
  const signalIds = signals.map(s => s.id);
  console.log("signals alvo:", signalIds.length);
  if (!signalIds.length) { console.log("Nenhum signal para apagar."); process.exit(0); }

  // 3) Apagar trades com entrySignalId nesses signals (ou desligar, se quiser preservar)
  console.log("Apagando trades por entrySignalId...");
  let tradesDeleted = 0;
  tradesDeleted = await batched(signalIds, async (chunk) => {
    const r = await prisma.trade.deleteMany({ where: { entrySignalId: { in: chunk } } });
    return r.count;
  });
  console.log("Trades apagados:", tradesDeleted);

  // 4) Desvincular exitSignalId desses signals em trades restantes (set null)
  console.log("Limpando exitSignalId em trades restantes...");
  let tradesUpdated = 0;
  tradesUpdated = await batched(signalIds, async (chunk) => {
    const r = await prisma.trade.updateMany({
      where: { exitSignalId: { in: chunk } },
      data: { exitSignalId: null }
    });
    return r.count;
  });
  console.log("Trades atualizados (exitSignalId=null):", tradesUpdated);

  // 5) Agora podemos apagar os signals
  console.log("Apagando signals (EMA/EXIT)...");
  let signalsDeleted = 0;
  signalsDeleted = await batched(signalIds, async (chunk) => {
    const r = await prisma.signal.deleteMany({
      where: { id: { in: chunk } }
    });
    return r.count;
  });
  console.log("Signals apagados:", signalsDeleted);

  await prisma.$disconnect();
  console.log("WIPE concluído.");
  process.exit(0);
})().catch(async (e) => {
  console.error(e);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
