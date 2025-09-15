/* eslint-disable no-console */
const path = require("path");
const fs = require("fs");
for (const p of [path.resolve(__dirname, "..", ".env"), path.resolve(__dirname, "..", "..", ".env")]) {
  if (fs.existsSync(p)) { require("dotenv").config({ path: p }); break; }
}
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const BATCH = 2000;

async function batched(ids, fn, label) {
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
  const SYMBOL   = (process.env.SYMBOL || "WIN").toUpperCase();
  const TYPES    = (process.env.TYPES  || "EMA_CROSS,EXIT_TP,EXIT_SL,EXIT_NONE")
                    .split(",").map(s => s.trim()).filter(Boolean);
  const DAY_FROM = process.env.DAY_FROM || null;
  const DAY_TO   = process.env.DAY_TO   || null;

  console.log({ DATABASE_URL: process.env.DATABASE_URL, SYMBOL, TYPES, DAY_FROM, DAY_TO });

  // resolve instrumento
  const inst = await prisma.instrument.findFirst({ where: { symbol: SYMBOL }, select: { id: true } });
  if (!inst) { console.log("Instrumento não encontrado."); process.exit(0); }

  // monta filtro por data (opcional)
  let dateClause = "";
  if (DAY_FROM || DAY_TO) {
    const from = DAY_FROM ? `${DAY_FROM}T00:00:00-03:00` : null;
    const to   = DAY_TO   ? `${DAY_TO}T23:59:59-03:00`   : null;
    if (from && to) dateClause = `AND c.time BETWEEN '${from}' AND '${to}'`;
    else if (from) dateClause = `AND c.time >= '${from}'`;
    else if (to) dateClause = `AND c.time <= '${to}'`;
  }

  // 1) coleta todos os signalIds por JOIN direto (garante símbolo certo)
  const placeholders = TYPES.map(() => "?").join(",");
  const signalRows = await prisma.$queryRawUnsafe(
    `
    SELECT s.id
    FROM Signal s
    JOIN Candle c ON c.id = s.candleId
    WHERE c.instrumentId = ?
      AND s.signalType IN (${placeholders})
      ${dateClause}
    `,
    inst.id,
    ...TYPES
  );
  const signalIds = signalRows.map(r => r.id);
  console.log("signals alvo:", signalIds.length);
  if (!signalIds.length) {
    console.log("Nenhum signal combinou com o filtro. Saindo.");
    process.exit(0);
  }

  // 2) apaga trades que usam esses signals como entrada
  const delTradesCount = await batched(signalIds, async (chunk) => {
    const r = await prisma.trade.deleteMany({ where: { entrySignalId: { in: chunk } } });
    return r.count;
  }, "trades deletados (entry)");

  // 3) zera exitSignalId em trades que apontem para esses signals
  const updTradesCount = await batched(signalIds, async (chunk) => {
    const r = await prisma.trade.updateMany({
      where: { exitSignalId: { in: chunk } },
      data:  { exitSignalId: null, exitPrice: null, pnlPoints: null }
    });
    return r.count;
  }, "trades atualizados (exit=null)");

  // 4) apaga os signals (agora sem FK bloqueando)
  const delSignalsCount = await batched(signalIds, async (chunk) => {
    const r = await prisma.signal.deleteMany({ where: { id: { in: chunk } } });
    return r.count;
  }, "signals deletados");

  console.log({ delTradesCount, updTradesCount, delSignalsCount });

  await prisma.$disconnect();
  console.log("WIPE concluído.");
  process.exit(0);
})().catch(async (e) => {
  console.error(e);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
