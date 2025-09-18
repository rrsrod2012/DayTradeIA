#!/usr/bin/env node
/**
 * Lista sinais EMA_CROSS por timeframe no dia.
 * Uso (dentro de backend/):
 *   npx tsx scripts/list-signals-day.ts --symbol=WIN --day=2025-09-18
 *   # opcional: --timeframe=M1 (filtra)
 */

import "dotenv/config";
import { DateTime } from "luxon";
import { prisma } from "../src/prisma";

type Args = { symbol?: string; day?: string; timeframe?: string; _: string[] };
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
function usage() {
    console.log(`
Uso:
  npx tsx scripts/list-signals-day.ts --symbol=WIN --day=2025-09-18
  (opcional) --timeframe=M1|M5|M15|M30|H1
`); process.exit(1);
}
function parseDay(s?: string) {
    if (!s) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}
async function ensureInstrumentId(symbol?: string) {
    if (!symbol) return undefined;
    const inst = await prisma.instrument.findFirst({ where: { symbol: String(symbol).trim() }, select: { id: true } });
    if (!inst) throw new Error(`Instrumento não encontrado: symbol='${symbol}'`);
    return inst.id;
}

async function main() {
    const a = parseArgs();
    if (!a.day) usage();
    const day = parseDay(a.day);
    if (!day) { console.error(`Dia inválido: ${a.day}`); process.exit(1); }

    const instrumentId = await ensureInstrumentId(a.symbol);
    if (!instrumentId) { console.error("Informe --symbol"); process.exit(1); }

    const start = DateTime.fromJSDate(day).startOf("day").toJSDate();
    const end = DateTime.fromJSDate(day).endOf("day").toJSDate();
    const tf = (a.timeframe ?? "").trim().toUpperCase();

    const signals = await prisma.signal.findMany({
        where: {
            signalType: "EMA_CROSS",
            candle: {
                instrumentId,
                time: { gte: start, lte: end },
                ...(tf ? { timeframe: tf } : {}),
            },
        },
        select: {
            id: true,
            side: true,
            candle: { select: { time: true, timeframe: true } },
        },
        orderBy: { id: "asc" },
    });

    const byTF = new Map<string, number>();
    for (const s of signals) {
        const t = (s.candle?.timeframe || "NA").toUpperCase();
        byTF.set(t, (byTF.get(t) ?? 0) + 1);
    }

    console.log(`Sinais EMA_CROSS em ${a.day} (symbol=${a.symbol}): total=${signals.length}`);
    const rows = Array.from(byTF.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    for (const [t, n] of rows) console.log(`  ${t.padEnd(3)} : ${n}`);

    // lista alguns horários só pra amostra
    console.log("\nExemplos (primeiros 10):");
    for (const s of signals.slice(0, 10)) {
        const tm = DateTime.fromJSDate(s.candle!.time).toFormat("HH:mm:ss");
        console.log(`  ${s.candle!.timeframe} ${tm} ${s.side}`);
    }
}

main()
    .catch(e => { console.error("[list-signals-day] ERRO:", e?.stack || e); process.exit(1); })
    .finally(async () => { try { await prisma.$disconnect(); } catch { } });
