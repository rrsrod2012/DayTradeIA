/* eslint-disable no-console */
// backend/scripts/rebuild-all-direct-run.js

const path = require("path");
const fs = require("fs");

// 1) Carrega .env (backend/.env → raiz/.env)
for (const p of [
  path.resolve(__dirname, "..", ".env"),
  path.resolve(__dirname, "..", "..", ".env"),
]) {
  if (fs.existsSync(p)) {
    require("dotenv").config({ path: p });
    break;
  }
}

// 2) Registra ts-node para permitir require de arquivos .ts internos
require("ts-node").register({
  transpileOnly: true,
  project: path.resolve(__dirname, "..", "tsconfig.json"),
});

// 3) Prisma
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

// 4) Helper pra tentar múltiplos caminhos
function requireOne(ofPaths) {
  let lastErr;
  for (const p of ofPaths) {
    try { return require(p); } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// >>> AQUI trocamos para src/workers/confirmedSignalsWorker <<<
const confirmed = requireOne([
  path.resolve(__dirname, "..", "src", "workers", "confirmedSignalsWorker"),
  path.resolve(__dirname, "..", "src", "workers", "confirmedSignalsWorker.ts"),
  path.resolve(__dirname, "..", "dist", "workers", "confirmedSignalsWorker.js"),
]);

// pipeline continua em src/services/pipeline (como no seu projeto)
const pipeline = requireOne([
  path.resolve(__dirname, "..", "src", "services", "pipeline"),
  path.resolve(__dirname, "..", "src", "services", "pipeline.ts"),
  path.resolve(__dirname, "..", "dist", "services", "pipeline.js"),
]);

const backfillCandlesAndSignals = confirmed.backfillCandlesAndSignals || confirmed.default?.backfillCandlesAndSignals;
const processImportedRange     = pipeline.processImportedRange     || pipeline.default?.processImportedRange;

if (!backfillCandlesAndSignals || !processImportedRange) {
  throw new Error("Não consegui importar backfillCandlesAndSignals/processImportedRange.");
}

// 5) Config
const DROP_FIRST = String(process.env.DROP_FIRST || "true").toLowerCase() === "true";
const TF_LIST = (process.env.TF_LIST || "M1,M5,M15,M30,H1")
  .split(",")
  .map(s => s.trim().toUpperCase())
  .filter(Boolean);

// (Opcional) limitar a um símbolo
const ONLY_SYMBOL = process.env.SYMBOL ? String(process.env.SYMBOL).toUpperCase() : null;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log("DATABASE_URL =", process.env.DATABASE_URL || "(não definido)");
  console.log("DROP_FIRST   =", DROP_FIRST);
  console.log("TF_LIST      =", TF_LIST.join(", "));
  if (ONLY_SYMBOL) console.log("ONLY_SYMBOL =", ONLY_SYMBOL);

  // instrumentos
  const instruments = await prisma.instrument.findMany({
    select: { id: true, symbol: true },
    orderBy: { id: "asc" },
    where: ONLY_SYMBOL ? { symbol: ONLY_SYMBOL } : undefined,
  });
  if (!instruments.length) {
    console.log("Nenhum instrumento encontrado para o filtro informado. Abortando.");
    process.exit(0);
  }

  // wipe (opcional)
  if (DROP_FIRST) {
    for (const inst of instruments) {
      const sid = inst.id;
      const sym = String(inst.symbol).toUpperCase();
      console.log(`\n[WIPE] ${sym}`);

      const delTrades = await prisma.trade.deleteMany({ where: { instrumentId: sid } });
      console.log(`- Trades apagados: ${delTrades.count}`);

      const delSignals = await prisma.signal.deleteMany({
        where: {
          OR: [
            { signalType: "EMA_CROSS" },
            { signalType: "EXIT_TP" },
            { signalType: "EXIT_SL" },
            { signalType: "EXIT_NONE" },
          ],
          candle: { instrumentId: sid },
        },
      });
      console.log(`- Sinais apagados (EMA/EXIT): ${delSignals.count}`);
    }
  }

  // rebuild
  for (const inst of instruments) {
    const sym = String(inst.symbol).toUpperCase();
    console.log(`\n[REBUILD] ${sym}`);

    for (const tf of TF_LIST) {
      console.log(`  - TF=${tf}: backfill sinais (direct)`);
      const r1 = await backfillCandlesAndSignals(inst.id, tf);
      console.log("    ✓ signals:", r1);
      await sleep(50);

      console.log(`    TF=${tf}: backfill trades (direct, histórico inteiro)`);
      const r2 = await processImportedRange({ symbol: sym, timeframe: tf });
      console.log("    ✓ trades:", r2);
      await sleep(50);
    }
  }

  // resumo
  const counts = {
    instruments: await prisma.instrument.count(),
    candles: await prisma.candle.count(),
    signals: await prisma.signal.count(),
    signals_ema: await prisma.signal.count({ where: { signalType: "EMA_CROSS" } }),
    trades: await prisma.trade.count(),
  };
  console.log("\nDONE. COUNTS =", counts);

  await prisma.$disconnect();
  process.exit(0);
})().catch(async (e) => {
  console.error(e);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
