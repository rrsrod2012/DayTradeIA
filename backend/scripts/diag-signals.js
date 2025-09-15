/* eslint-disable no-console */
const path = require("path");
const fs = require("fs");
for (const p of [path.resolve(__dirname, "..", ".env"), path.resolve(__dirname, "..", "..", ".env")]) {
  if (fs.existsSync(p)) { require("dotenv").config({ path: p }); break; }
}
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

(async () => {
  console.log("DATABASE_URL =", process.env.DATABASE_URL || "(none)");

  // Tipos distintos existentes
  const types = await prisma.$queryRawUnsafe(`
    SELECT signalType, COUNT(*) as cnt
    FROM Signal
    GROUP BY signalType
    ORDER BY cnt DESC
  `);
  console.log("\nTipos de signal na base:");
  for (const r of types) console.log(r);

  // Contagem por símbolo (join via Candle->Instrument)
  const bySym = await prisma.$queryRawUnsafe(`
    SELECT i.symbol, s.signalType, COUNT(*) as cnt
    FROM Signal s
    JOIN Candle c ON c.id = s.candleId
    JOIN Instrument i ON i.id = c.instrumentId
    GROUP BY i.symbol, s.signalType
    ORDER BY i.symbol, s.signalType
  `);
  console.log("\nContagem por símbolo e tipo:");
  for (const r of bySym) console.log(r);

  // Amostra de sinais do WIN (ajuste SYMBOL se quiser)
  const SYMBOL = (process.env.SYMBOL || "WIN").toUpperCase();
  const sample = await prisma.$queryRawUnsafe(`
    SELECT s.id, s.signalType, s.side, c.time as candleTime, i.symbol
    FROM Signal s
    JOIN Candle c ON c.id = s.candleId
    JOIN Instrument i ON i.id = c.instrumentId
    WHERE i.symbol = '${SYMBOL}'
    ORDER BY c.time ASC
    LIMIT 20
  `);
  console.log(`\nAmostra (primeiros 20) de ${SYMBOL}:`);
  for (const r of sample) console.log(r);

  await prisma.$disconnect();
  process.exit(0);
})().catch(async (e) => { console.error(e); try { await prisma.$disconnect(); } catch {}; process.exit(1); });
