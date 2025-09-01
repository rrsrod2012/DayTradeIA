import { Router } from "express";
import { prisma } from "./prisma";

const router = Router();

/**
 * Zera o banco (apenas conteúdo) mantendo o schema.
 * Uso: POST /api/admin/reset
 */
router.post("/api/admin/reset", async (req, res) => {
  try {
    // Desliga FKs p/ limpar em qualquer ordem (SQLite)
    await prisma.$executeRawUnsafe(`PRAGMA foreign_keys=OFF;`);

    const tables = [
      "Signal",
      "Trade",
      "IndicatorValue",
      "Pattern",
      "BacktestRun",
      "Candle",
      "Instrument",
    ];

    for (const t of tables) {
      try {
        await prisma.$executeRawUnsafe(`DELETE FROM "${t}";`);
      } catch (e) {
        // ignora se a tabela não existir no schema atual
      }
    }

    await prisma.$executeRawUnsafe(`PRAGMA foreign_keys=ON;`);
    res.json({ ok: true, cleared: tables });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

export default router;
