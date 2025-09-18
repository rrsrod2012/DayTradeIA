#!/usr/bin/env node
/**
 * Reprocessa um dia chamando o pipeline de consolidação.
 * Uso (dentro de backend/):
 *   # Todos os TFs do dia:
 *   npx tsx scripts/reprocess-day.ts --symbol=WIN --day=2025-09-18
 *   # Ou explicitamente:
 *   npx tsx scripts/reprocess-day.ts --symbol=WIN --timeframe=* --day=2025-09-18
 *   # Somente M1:
 *   npx tsx scripts/reprocess-day.ts --symbol=WIN --timeframe=M1 --day=2025-09-18
 */

import "dotenv/config";
import { prisma } from "../src/prisma";
import { processImportedRange } from "../src/services/pipeline";

type Args = {
    symbol?: string;
    instrumentId?: string;
    timeframe?: string | null;
    day?: string;
    _: string[];
};

function parseArgs(): Args {
    const out: Args = { _: [] };
    for (const tok of process.argv.slice(2)) {
        if (tok.startsWith("--")) {
            const [k, v] = tok.slice(2).split("=");
            (out as any)[k] = v ?? "true";
        } else {
            out._.push(tok);
        }
    }
    return out;
}

function printUsageAndExit() {
    console.log(`
Reprocess Day (pipeline)

Uso:
  # Todos os TFs:
  npx tsx scripts/reprocess-day.ts --symbol=WIN --day=2025-09-18

  # Específico:
  npx tsx scripts/reprocess-day.ts --symbol=WIN --timeframe=M1 --day=2025-09-18
  npx tsx scripts/reprocess-day.ts --symbol=WIN --timeframe=M5 --day=2025-09-18
  npx tsx scripts/reprocess-day.ts --symbol=WIN --timeframe=*  --day=2025-09-18

Parâmetros:
  --symbol=WIN            (opcional se passar --instrumentId)
  --instrumentId=1        (opcional se passar --symbol)
  --timeframe=M1|M5|...|* (opcional; '*' ou omitido = TODOS)
  --day=YYYY-MM-DD        (obrigatório)
`);
    process.exit(1);
}

function parseDay(d?: string) {
    if (!d) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d.trim());
    if (!m) return null;
    const [_, y, mo, da] = m;
    const dt = new Date(Number(y), Number(mo) - 1, Number(da));
    if (isNaN(+dt)) return null;
    return dt;
}

async function ensureInstrumentId(symbol?: string, instrumentIdArg?: string) {
    if (instrumentIdArg) {
        const idn = Number(instrumentIdArg);
        if (!Number.isFinite(idn)) throw new Error(`instrumentId inválido: ${instrumentIdArg}`);
        return idn;
    }
    if (!symbol) return undefined;
    const inst = await prisma.instrument.findFirst({
        where: { symbol: String(symbol).trim() },
        select: { id: true },
    });
    if (!inst) throw new Error(`Instrumento com symbol='${symbol}' não encontrado no banco.`);
    return inst.id;
}

async function main() {
    const args = parseArgs();
    if (!args.day) printUsageAndExit();

    const day = parseDay(args.day);
    if (!day) {
        console.error(`Dia inválido: "${args.day}". Use o formato YYYY-MM-DD (ex.: 2025-09-18).`);
        process.exit(1);
    }

    const instrumentId = await ensureInstrumentId(args.symbol, args.instrumentId);
    if (!instrumentId && !args.symbol) {
        console.error("Informe --symbol ou --instrumentId.");
        printUsageAndExit();
    }

    // '*' ou omitido => TODOS os TFs
    const tfRaw = (args.timeframe ?? "").toString().trim().toUpperCase();
    const timeframe = tfRaw === "" || tfRaw === "*" ? undefined : tfRaw;

    console.log("=== Reprocess Day ===");
    console.log(` symbol       : ${args.symbol ?? "(via instrumentId=" + instrumentId + ")"}`);
    console.log(` instrumentId : ${instrumentId ?? "(resolverá via symbol)"}`);
    console.log(` timeframe    : ${timeframe ?? "(TODOS)"}`);
    console.log(` day          : ${args.day}`);
    console.log("");

    const t0 = Date.now();
    await processImportedRange({
        instrumentId: instrumentId,
        symbol: args.symbol,
        timeframe,
        day,
    });
    const dt = ((Date.now() - t0) / 1000).toFixed(2);

    console.log(`Concluído em ${dt}s.`);
}

main()
    .catch((err) => {
        console.error("[reprocess-day] ERRO:", err?.stack || err?.message || err);
        process.exit(1);
    })
    .finally(async () => {
        try {
            await prisma.$disconnect();
        } catch { }
    });
