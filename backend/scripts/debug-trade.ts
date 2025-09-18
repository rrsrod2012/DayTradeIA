#!/usr/bin/env node
/**
 * Reprocessa e imprime um trade a partir de um horário de ENTRADA local (BR).
 *
 * Dica para M1:
 *   Se a entrada que você vê no dashboard é 09:02, o candle do SINAL (EMA_CROSS)
 *   normalmente é 09:01 (entrada no OPEN da próxima).
 *
 * Uso (dentro de backend/):
 *   npx tsx scripts/debug-trade.ts --symbol=WIN --timeframe=M1 --day=2025-09-18 --entry=09:02
 */

import "dotenv/config";
import { DateTime } from "luxon";
import { prisma } from "../src/prisma";
import { reprocessSignal } from "../src/services/pipeline";

type Args = { symbol?: string; timeframe?: string; day?: string; entry?: string; _: string[] };
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
  npx tsx scripts/debug-trade.ts --symbol=WIN --timeframe=M1 --day=2025-09-18 --entry=09:02
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
    if (!a.symbol || !a.day || !a.entry) usage();
    const tf = (a.timeframe ?? "").trim().toUpperCase() || "M1";

    const dd = parseDay(a.day);
    if (!dd) { console.error(`Dia inválido: ${a.day}`); process.exit(1); }

    const [eh, em] = a.entry.split(":").map(Number);
    const entryLocal = DateTime.fromObject({ year: dd.y, month: dd.mo, day: dd.d, hour: eh, minute: em }, { zone: "America/Sao_Paulo" });

    // Candle do SINAL = entry - TF
    const tfMin = ({ M1: 1, M5: 5, M15: 15, M30: 30, H1: 60 } as Record<string, number>)[tf] ?? 1;
    const signalLocal = entryLocal.minus({ minutes: tfMin });
    const signalUTC = signalLocal.toUTC();

    const instId = await ensureInstrumentId(a.symbol);

    // Encontra o sinal EMA_CROSS no horário (±1×TF)
    const t0 = signalUTC.minus({ minutes: tfMin }).toJSDate();
    const t1 = signalUTC.plus({ minutes: tfMin }).toJSDate();
    const sig = await prisma.signal.findFirst({
        where: {
            signalType: "EMA_CROSS",
            candle: {
                instrumentId: instId!,
                timeframe: tf,
                time: { gte: t0, lte: t1 },
            },
        },
        select: { id: true, side: true, candle: { select: { time: true, timeframe: true } } },
        orderBy: { id: "asc" },
    });

    if (!sig) {
        console.log(`Nenhum sinal EMA_CROSS encontrado perto de ${signalLocal.toFormat("HH:mm")} local (tf=${tf}).`);
        process.exit(0);
    }

    console.log(`Reprocessando signalId=${sig.id} side=${sig.side} candle=${DateTime.fromJSDate(sig.candle!.time).setZone("America/Sao_Paulo").toFormat("HH:mm:ss")} tf=${sig.candle!.timeframe}`);

    // Ativa debug se quiser logs detalhados
    if (!Number(process.env.AUTO_TRAINER_DEBUG || "0")) {
        console.log("(Dica) Para logs detalhados, rode com AUTO_TRAINER_DEBUG=1 no .env");
    }

    await reprocessSignal(sig.id);

    // Busca o trade resultante
    const trade = await prisma.trade.findFirst({
        where: { entrySignalId: sig.id },
        include: {
            entrySignal: { include: { candle: { select: { time: true, timeframe: true } } } },
            exitSignal: { include: { candle: { select: { time: true, timeframe: true, signalType: true, reason: true } } } },
        },
    });

    if (!trade) {
        console.log("Nenhum trade consolidado para este sinal.");
        return;
    }

    const entLocal = trade.entrySignal?.candle?.time
        ? DateTime.fromJSDate(trade.entrySignal.candle.time).setZone("America/Sao_Paulo").toFormat("HH:mm:ss")
        : "??";
    const exiLocal = trade.exitSignal?.candle?.time
        ? DateTime.fromJSDate(trade.exitSignal.candle.time).setZone("America/Sao_Paulo").toFormat("HH:mm:ss")
        : "-";

    console.log(`Trade: tf=${trade.timeframe} entry@${entLocal} exit@${exiLocal} entryPx=${trade.entryPrice?.toFixed(1)} exitPx=${trade.exitPrice?.toFixed(1)} pnlPts=${trade.pnlPoints?.toFixed(1)} exitType=${trade.exitSignal?.signalType ?? "-"} ${trade.exitSignal?.reason ?? ""}`);
}

main()
    .catch(e => { console.error("[debug-trade] ERRO:", e?.stack || e); process.exit(1); })
    .finally(async () => { try { await prisma.$disconnect(); } catch { } });
