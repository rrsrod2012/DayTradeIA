/* eslint-disable no-console */
// backend/scripts/rebuild-all-direct.ts

/**
 * Rebuild completo SEM HTTP:
 * - (Opcional) apaga Trades e Sinais (EMA_CROSS e EXIT_*)
 * - Para cada instrumento e TF:
 *    1) chama backfillCandlesAndSignals(instrumentId, tf)
 *    2) chama processImportedRange({ symbol, timeframe: tf })
 *
 * Requer: ts-node (ou tsx). Exemplos de execução ao final.
 */

import path from "path";
import fs from "fs";

// 1) Carrega .env (tenta backend/.env e raiz/.env)
const envPaths = [
  path.resolve(__dirname, "..", ".env"),
  path.resolve(__dirname, "..", "..", ".env"),
];
for (const p of envPaths) {
  if (fs.existsSync(p)) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require("dotenv").config({ path: p });
    break;
  }
}

// 2) Prisma e serviços internos
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

// Importa diretamente seus serviços (NÃO renomeei caminhos/exports)
import {
  backfillCandlesAndSignals,
} from "../src/services/confirmedSignalsWorker";
import {
  processImportedRange,
} from "../src/services/pipeline";

// =========================
// Config
// =========================
const CFG = {
  DROP_FIRST: (String(process.env.DROP_FIRST || "true").toLowerCase() === "true"),
  TF_LIST: (process.env.TF_LIST || "M1,M5,M15,M30,H1")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),
};

// Util
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// =========================
// Main
// =========================
async function main() {
  console.log("DATABASE_URL =", process.env.DATABASE_URL || "(não definido)");
  console.log("DROP_FIRST   =", CFG.DROP_FIRST);
  console.log("TF_LIST      =", CFG.TF_LIST.join(", "));

  // 1) Lista instrumentos
  const instruments = await prisma.instrument.findMany({
    select: { id: true, symbol: true },
    orderBy: { id: "asc" },
  });
  if (!instruments.length) {
    console.log("Nenhum instrumento encontrado. Abortando.");
    return;
  }

  // 2) (Opcional) Limpeza total: Trades + Sinais EMA/EXIT por instrumento
  if (CFG.DROP_FIRST) {
    for (const inst of instruments) {
      const sid = inst.id;
      const sym = String(inst.symbol).toUpperCase();
      console.log(`\n[WIPE] Limpando ${sym} ...`);

      // Apaga trades do instrumento
      const delTrades = await prisma.trade.deleteMany({
        where: { instrumentId: sid },
      });
      console.log(`- Trades apagados: ${delTrades.count}`);

      // Apaga sinais EMA_CROSS e EXIT_*
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

  // 3) Rebuild por instrumento e TF (chamando os serviços diretamente)
  for (const inst of instruments) {
    const sym = String(inst.symbol).toUpperCase();
    console.log(`\n[REBUILD] ${sym}`);

    for (const tf of CFG.TF_LIST) {
      console.log(`  - TF=${tf}: backfill sinais (direct call)...`);
      // O tipo do parâmetro no serviço é keyof TF_MINUTES; fazemos cast pra compilar
      const rSignals = await backfillCandlesAndSignals(inst.id, tf as any);
      console.log("    ✓ signals:", rSignals);

      await sleep(50);

      console.log(`    TF=${tf}: backfill trades (histórico inteiro – direct call)...`);
      // Sem from/to => processa todo o histórico de sinais do símbolo/TF
      const rTrades = await processImportedRange({
        symbol: sym,
        timeframe: tf,
      });
      console.log("    ✓ trades:", rTrades);

      await sleep(50);
    }
  }

  // 4) Resumo final
  const counts = {
    instruments: await prisma.instrument.count(),
    candles: await prisma.candle.count(),
    signals: await prisma.signal.count(),
    signals_ema: await prisma.signal.count({ where: { signalType: "EMA_CROSS" } }),
    trades: await prisma.trade.count(),
  };
  console.log("\nDONE. COUNTS =", counts);
}

// Execução protegida
main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await prisma.$disconnect();
    } catch {}
  });
