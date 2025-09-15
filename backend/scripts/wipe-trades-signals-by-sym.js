/* eslint-disable no-console */
const path = require("path");
const fs = require("fs");
for (const p of [path.resolve(__dirname, "..", ".env"), path.resolve(__dirname, "..", "..", ".env")]) {
  if (fs.existsSync(p)) { require("dotenv").config({ path: p }); break; }
}
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const BATCH = 2000;
async function batched(ids, label, fn) {
  let total = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    const r = await fn(chunk);
    total += r;
    console.log(`  - ${label} | lote ${i}-${i + chunk.length - 1}: ${r}`);
  }
  return total;
}

(async () => {
  const SYMBOL   = process.env.SYMBOL ? String(process.env.SYMBOL).toUpperCase() : null; // se null => todos
  const DAY_FROM = process.env.DAY_FROM || null; // "YYYY-MM-DD"
  const DAY_TO   = process.env.DAY_TO   || null; // "YYYY-MM-DD"

  console.log({ DATABASE_URL: process.env.DATABASE_URL, SYMBOL, DAY_FROM, DAY_TO });

  // Clause de datas (opcional)
  let dateClause = "";
  if (DAY_FROM || DAY_TO) {
    const from = DAY_FROM ? `${DAY_FROM}T00:00:00-03:00` : null;
    const to   = DAY_TO   ? `${DAY_TO}T23:59:59-03:00` : null;
    if (from && to) dateClause = `AND c.time BETWEEN '${from}' AND '${to}'`;
    else if (from)  dateClause = `AND c.time >= '${from}'`;
    else if (to)    dateClause = `AND c.time <= '${to}'`;
  }

  // Resolve instrumentId(s)
  let instrumentIds = [];
  if (SYMBOL) {
    const inst = await prisma.instrument.findFirst({ where: { symbol: SYMBOL }, select: { id: true } });
    if (!inst) { console.log("Instrumento não encontrado para SYMBOL."); process.exit(0); }
    instrumentIds = [inst.id];
  } else {
    const all = await prisma.instrument.findMany({ select: { id: true } });
    instrumentIds = all.map(i => i.id);
  }

  // 1) Coleta todos os signalIds (join direto por Candle/Instrument e datas)
  let signalIds = [];
  for (const instId of instrumentIds) {
    const rows = await prisma.$queryRawUnsafe(
      `
      SELECT s.id
      FROM Signal s
      JOIN Candle c ON c.id = s.candleId
      WHERE c.instrumentId = ?
        ${dateClause}
      `,
      instId
    );
    signalIds.push(...rows.map(r => r.id));
  }
  // remove duplicatas
  signalIds = Array.from(new Set(signalIds));
  console.log("signals alvo:", signalIds.length);
  if (!signalIds.length) {
    console.log("Nenhum signal combinou com o filtro. Saindo.");
    process.exit(0);
  }

  // 2) Apaga trades com entry nesses signals
  console.log("Apagando trades por entrySignalId...");
  await batched(signalIds, "trades deletados (entry)", async (chunk) => {
    const r = await prisma.trade.deleteMany({ where: { entrySignalId: { in: chunk } } });
    return r.count;
  });

  // 3) Zera exitSignalId/exitPrice/pnlPoints para trades com exit nesses signals
  console.log("Desvinculando exits de trades restantes...");
  await batched(signalIds, "trades exit=null", async (chunk) => {
    const r = await prisma.trade.updateMany({
      where: { exitSignalId: { in: chunk } },
      data:  { exitSignalId: null, exitPrice: null, pnlPoints: null },
    });
    return r.count;
  });

  // 4) Apaga os signals
  console.log("Apagando signals alvo...");
  await batched(signalIds, "signals deletados", async (chunk) => {
    const r = await prisma.signal.deleteMany({ where: { id: { in: chunk } } });
    return r.count;
  });

  // resumo
  const counts = {
    instruments: await prisma.instrument.count(),
    candles: await prisma.candle.count(),
    signals: await prisma.signal.count(),
    trades: await prisma.trade.count(),
  };
  console.log("COUNTS após wipe =", counts);

  await prisma.$disconnect();
  console.log("Wipe por símbolo/período concluído (candles preservados).");
  process.exit(0);
})().catch(async (e) => {
  console.error(e);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
