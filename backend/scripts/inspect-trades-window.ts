#!/usr/bin/env node
/**
 * Inspeciona trades por janela de horário.
 * Uso (dentro de backend/):
 *   npx tsx scripts/inspect-trades-window.ts --symbol=WIN --day=2025-09-18 --from=09:00 --to=09:10
 *   (opcional) --timeframe=M1
 */

import "dotenv/config";
import { DateTime } from "luxon";
import { prisma } from "../src/prisma";

type Args = { symbol?: string; day?: string; from?: string; to?: string; timeframe?: string; _: string[] };
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
  npx tsx scripts/inspect-trades-window.ts --symbol=WIN --day=2025-09-18 --from=09:00 --to=09:10
  (opcional) --timeframe=M1|M5|...
`); process.exit(1);
}
function parseDay(s?: string) {
    if (!s) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
    if (!m) return null;
    return { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) };
}
async function ensureInstrumentId(symbol?: string) {
    if (!symbol) return undefined;
    const inst = await prisma.instrument.findFirst({ where: { symbol: String(symbol).trim() }, select: { id: true } });
    if (!inst) throw new Error(`Instrumento não encontrado: symbol='${symbol}'`);
    return inst.id;
}

async function main() {
    const a = parseArgs();
    if (!a.day || !a.symbol || !a.from || !a.to) usage();

    const dd = parseDay(a.day);
    if (!dd) { console.error(`Dia inválido: ${a.day}`); process.exit(1); }

    const tf = (a.timeframe ?? "").trim().toUpperCase();
    const instId = await ensureInstrumentId(a.symbol);

    // janela
    const from = DateTime.fromObject({ year: dd.y, month: dd.mo, day: dd.d, hour: Number(a.from!.slice(0, 2)), minute: Number(a.from!.slice(3, 5)) });
    const to = DateTime.fromObject({ year: dd.y, month: dd.mo, day: dd.d, hour: Number(a.to!.slice(0, 2)), minute: Number(a.to!.slice(3, 5)) });

    // Trades do dia/inst, juntando sinais de entrada/saída
    const trades = await prisma.trade.findMany({
        where: {
            instrumentId: instId!,
            // timeframe opcional (como gravado no trade)
            ...(tf ? { timeframe: tf } : {}),
            // filtro por janela usando o candle do sinal de entrada
            entrySignal: {
                is: {
                    candle: {
                        is: {
                            time: { gte: from.toJSDate(), lte: to.toJSDate() },
                        }
                    }
                }
            }
        },
        include: {
            entrySignal: { include: { candle: { select: { time: true, timeframe: true } }, } },
            exitSignal: { include: { candle: { select: { time: true, timeframe: true } }, } },
        },
        orderBy: { id: "asc" },
    });

    console.log(`Trades em ${a.day} ${a.from}-${a.to} ${tf ? `[${tf}]` : ""}: ${trades.length}`);
    for (const t of trades) {
        const entTime = t.entrySignal?.candle?.time ? DateTime.fromJSDate(t.entrySignal!.candle!.time).toFormat("HH:mm:ss") : "??";
        const exiTime = t.exitSignal?.candle?.time ? DateTime.fromJSDate(t.exitSignal!.candle!.time).toFormat("HH:mm:ss") : "??";
        const exiType = t.exitSignal?.signalType ?? "(sem exitSignal)";
        const exiReason = t.exitSignal?.reason ?? "";
        const tfEnt = t.entrySignal?.candle?.timeframe ?? t.timeframe;

        console.log(`- ${tfEnt}  entry=${entTime}  exit=${exiTime}  entryPx=${t.entryPrice?.toFixed(1)}  exitPx=${t.exitPrice?.toFixed(1)}  pnlPts=${t.pnlPoints?.toFixed(1)}  exitType=${exiType} ${exiReason ? `• ${exiReason}` : ""}`);
    }
}

main()
    .catch(e => { console.error("[inspect-trades-window] ERRO:", e?.stack || e); process.exit(1); })
    .finally(async () => { try { await prisma.$disconnect(); } catch { } });
