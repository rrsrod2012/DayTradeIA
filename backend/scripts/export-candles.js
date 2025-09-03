/* Exporta candles do banco para CSV.
 * Uso:
 *   node backend/scripts/export-candles.js --symbol WIN --timeframe M5 --from 2025-09-01 --to 2025-09-05 --out ml/data/WIN_M5_2025-09-01_2025-09-05.csv
 *
 * Campos:
 *  - symbol:      ex. WIN, WDO
 *  - timeframe:   M1 | M5 | M15 | M30 | H1
 *  - from/to:     ISO simples (YYYY-MM-DD) ou YYYY-MM-DDTHH:mm:ss
 *  - out:         caminho do CSV de saída
 */
const fs = require("fs");
const path = require("path");
const { PrismaClient } = require("@prisma/client");

function arg(name, def) {
  const i = process.argv.findIndex((x) => x === `--${name}`);
  return i > -1 ? process.argv[i + 1] || "" : def;
}
function parseDate(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

(async () => {
  const symbol = String(arg("symbol", "")).toUpperCase();
  const timeframe = String(arg("timeframe", "M5")).toUpperCase();
  const fromS = arg("from", "");
  const toS = arg("to", "");
  const out = arg("out", "");

  if (!symbol || !timeframe || !out) {
    console.error(
      "Parâmetros obrigatórios: --symbol WIN --timeframe M5 --out ml/data/WIN_M5.csv [--from 2025-09-01 --to 2025-09-05]"
    );
    process.exit(1);
  }
  const from = parseDate(fromS);
  const to = parseDate(toS);

  const prisma = new PrismaClient();
  try {
    // Filtro por símbolo via relação instrument
    const where = {
      timeframe,
      ...(from || to
        ? {
            time: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {}),
            },
          }
        : {}),
      instrument: { symbol },
    };
    const rows = await prisma.candle.findMany({
      where,
      orderBy: { time: "asc" },
      select: {
        time: true,
        open: true,
        high: true,
        low: true,
        close: true,
        volume: true,
      },
    });

    if (!rows.length) {
      console.log("[export] Nenhum candle encontrado para", {
        symbol,
        timeframe,
        from: fromS,
        to: toS,
      });
      process.exit(0);
    }

    const outPath = path.resolve(out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });

    const header = "time,open,high,low,close,volume\n";
    const lines = rows.map(
      (r) =>
        `${new Date(r.time).toISOString()},${r.open},${r.high},${r.low},${
          r.close
        },${r.volume ?? ""}`
    );
    fs.writeFileSync(outPath, header + lines.join("\n"), "utf8");
    console.log(`[export] OK: ${rows.length} linhas -> ${outPath}`);
  } catch (e) {
    console.error("[export] erro:", e?.message || e);
    process.exit(2);
  } finally {
    await prisma.$disconnect();
  }
})();
