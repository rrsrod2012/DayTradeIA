// backend/scripts/rebuild-all.js
/* eslint-disable no-console */
const path = require("path");
const fs = require("fs");

// 1) Carregar .env (tenta backend/.env e repo/.env)
const envPaths = [
  path.resolve(__dirname, "..", ".env"),
  path.resolve(__dirname, "..", "..", ".env"),
];
for (const p of envPaths) {
  if (fs.existsSync(p)) {
    require("dotenv").config({ path: p });
    break;
  }
}

// 2) Prisma para descobrir instrumentos
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

// 3) Config
const API_BASE = process.env.API_BASE || "http://localhost:4000";
const DROP_FIRST = String(process.env.DROP_FIRST || "true").toLowerCase() === "true";

// TFs alvo (normalizamos "5" ≈ "M5" dentro dos serviços)
const TF_LIST = (process.env.TF_LIST || "M1,M5,M15,M30,H1")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

// helpers
async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function httpJson(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  try {
    return { ok: r.ok, status: r.status, data: text ? JSON.parse(text) : null, raw: text };
  } catch {
    return { ok: r.ok, status: r.status, data: null, raw: text };
  }
}

(async () => {
  console.log("DATABASE_URL =", process.env.DATABASE_URL || "(não definido)");
  console.log("API_BASE     =", API_BASE);
  console.log("DROP_FIRST   =", DROP_FIRST);
  console.log("TF_LIST      =", TF_LIST.join(", "));

  // 1) Pegar instrumentos
  const instruments = await prisma.instrument.findMany({
    select: { id: true, symbol: true },
    orderBy: { id: "asc" },
  });
  if (!instruments.length) {
    console.log("Nenhum instrumento encontrado. Abortando.");
    process.exit(0);
  }

  // 2) (Opcional) Limpeza total de Trades + Sinais EMA/EXIT por instrumento
  if (DROP_FIRST) {
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

  // 3) Rebuild por instrumento e TF
  for (const inst of instruments) {
    const sym = String(inst.symbol).toUpperCase();
    console.log(`\n[REBUILD] ${sym}`);

    for (const tf of TF_LIST) {
      console.log(`  - TF=${tf}: backfill sinais...`);
      const r1 = await httpJson("POST", `${API_BASE}/admin/signals/backfill`, {
        symbol: sym,
        timeframe: tf,
      });
      if (!r1.ok) {
        console.warn(`    ! signals/backfill falhou [${r1.status}]:`, r1.raw || r1.data);
      } else {
        console.log(`    ✓ signals/backfill:`, r1.data);
      }
      // dá um respiro para não sobrecarregar
      await sleep(100);

      console.log(`    TF=${tf}: backfill trades (histórico inteiro)...`);
      // sem from/to => processa todos os sinais desse TF para o símbolo
      const r2 = await httpJson("POST", `${API_BASE}/admin/trades/backfill`, {
        symbol: sym,
        timeframe: tf,
      });
      if (!r2.ok) {
        console.warn(`    ! trades/backfill falhou [${r2.status}]:`, r2.raw || r2.data);
      } else {
        console.log(`    ✓ trades/backfill:`, r2.data);
      }
      await sleep(100);
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

  await prisma.$disconnect();
  process.exit(0);
})().catch(async (e) => {
  console.error(e);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
