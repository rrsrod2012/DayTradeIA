#!/usr/bin/env node
/**
 * Lista instrumentos do banco e mostra timeframes com contagem de candles,
 * além do horário do último candle (em horário local BR).
 *
 * Uso (rodar dentro de backend/):
 *   npx tsx scripts/list-instruments.ts
 *   npx tsx scripts/list-instruments.ts --query=WIN
 */

import "dotenv/config";
import { DateTime } from "luxon";
import { prisma } from "../src/prisma";

type Args = { query?: string; _: string[] };
function parseArgs(): Args {
    const out: Args = { _: [] };
    for (const tok of process.argv.slice(2)) {
        if (tok.startsWith("--")) {
            const [k, v] = tok.slice(2).split("=");
            (out as any)[k] = v ?? "true";
        } else out._.push(tok);
    }
    return out;
}

async function main() {
    const a = parseArgs();
    const q = (a.query ?? "").trim();

    // Lista instrumentos; se --query informado, filtra por símbolo "contém"
    const instruments = await prisma.instrument.findMany({
        where: q ? { symbol: { contains: q } } : {},
        select: { id: true, symbol: true },
        orderBy: { id: "asc" },
    });

    if (!instruments.length) {
        console.log(q ? `Nenhum instrumento encontrado para query="${q}".` : "Nenhum instrumento encontrado.");
        return;
    }

    console.log(`Instrumentos${q ? ` (filtro="${q}")` : ""}: ${instruments.length}\n`);

    for (const inst of instruments) {
        // Contagem de candles por timeframe
        const byTF = await prisma.candle.groupBy({
            by: ["timeframe"],
            where: { instrumentId: inst.id },
            _count: { _all: true },
        });

        // Último candle (pra checar se o instrumento tem dados recentes)
        const lastCandle = await prisma.candle.findFirst({
            where: { instrumentId: inst.id },
            orderBy: { time: "desc" },
            select: { time: true, timeframe: true },
        });

        const tfStr = byTF
            .sort((a, b) => (a.timeframe || "").localeCompare(b.timeframe || ""))
            .map((r) => `${r.timeframe}: ${r._count._all}`)
            .join("  |  ");

        const lastLocal = lastCandle
            ? DateTime.fromJSDate(lastCandle.time).setZone("America/Sao_Paulo").toFormat("yyyy-LL-dd HH:mm:ss")
            : "—";

        console.log(`ID=${inst.id}  SYMBOL=${inst.symbol}`);
        console.log(`  TFs: ${tfStr || "—"}`);
        console.log(`  Último candle: ${lastLocal} (TF ${lastCandle?.timeframe ?? "—"})`);
        console.log("");
    }
}

main()
    .catch((e) => {
        console.error("[list-instruments] ERRO:", e?.stack || e);
        process.exit(1);
    })
    .finally(async () => {
        try { await prisma.$disconnect(); } catch { }
    });
