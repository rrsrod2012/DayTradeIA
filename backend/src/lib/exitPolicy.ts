/* server/engine/exitPolicy.ts */
import type { Request } from "express";

export type Side = "BUY" | "SELL";

export type Candle = {
    id?: number;
    time: Date;
    open: number;
    high: number;
    low: number;
    close: number;
    volume?: number | null;
};

export type ExitPolicy = {
    /** Stop inicial em ATRs (default 1.0) */
    kSL?: number;
    /** Take em múltiplos de R (R = kSL*ATR de entrada). Se ausente/0, não usa TP fixo */
    rr?: number;
    /** Trailing stop em ATRs (aplicado durante o trade). Ex.: 1.2 */
    kTrail?: number;
    /** Time-stop em barras após a entrada (encerra no close da barra N) */
    timeStopBars?: number;
    /** Move para BE quando MFE ≥ X R (ex.: 1.0 = move para BE quando atinge 1R) */
    breakEvenAtR?: number;
    /** Offset do BE em R (ex.: 0.1 = trava +0.1R além da entrada) */
    beOffsetR?: number;
    /** Slippage (pts) aplicado na saída */
    slippagePts?: number;
    /** Custo (pts) por trade (descontado no PnL) */
    costPts?: number;
};

/** ATR14 simples (SMA do TR). Retorna array alinhado com os candles. */
export function atr14Series(candles: Candle[]): (number | null)[] {
    if (!candles?.length) return [];
    const trs: number[] = [];
    let prevClose = candles[0].close;
    for (let i = 1; i < candles.length; i++) {
        const c = candles[i];
        const tr = Math.max(
            c.high - c.low,
            Math.abs(c.high - prevClose),
            Math.abs(c.low - prevClose)
        );
        trs.push(tr);
        prevClose = c.close;
    }
    const out: (number | null)[] = candles.map(() => null);
    // ATR na barra i usa TRs até i-1; média dos últimos 14 TRs
    for (let i = 1; i < candles.length; i++) {
        const upto = Math.min(i, trs.length);
        const win = Math.min(14, upto);
        if (win <= 0) { out[i] = null; continue; }
        let sum = 0;
        for (let k = 0; k < win; k++) sum += trs[upto - 1 - k];
        out[i] = sum / win;
    }
    return out;
}

export type SimResult = {
    exitIdx: number;
    exitPrice: number;
    pnl: number;
    note?: string;
    movedToBE?: boolean;
    trailEvents?: number;
};

/** Simula a saída de UM trade (lado/entrada). */
export function simulateExitOnPath(args: {
    candles: Candle[];
    atr: (number | null)[];          // ATR alinhado
    entryIdx: number;                // índice do candle de entrada
    side: Side;
    entryPrice: number;
    policy?: ExitPolicy;
    horizonBars?: number;            // se informado, limita o máximo de barras
}): SimResult {
    const { candles, atr, entryIdx, side } = args;
    const policy: ExitPolicy = args.policy || {};
    const kSL = policy.kSL ?? 1.0;
    const rr = policy.rr ?? 0; // 0 = sem TP fixo
    const kTrail = policy.kTrail ?? 0;
    const timeStopBars = policy.timeStopBars ?? 0;
    const beAt = policy.breakEvenAtR ?? 0;
    const beOff = policy.beOffsetR ?? 0;
    const slippage = policy.slippagePts ?? 0;
    const cost = policy.costPts ?? 0;

    const entry = Math.max(0, Math.min(candles.length - 1, entryIdx));
    const atrEntry = atr[entry] ?? atr[Math.max(0, entry - 1)] ?? 0;
    const R = (kSL || 1) * (atrEntry || 0);
    const tgt = rr > 0 ? rr * R : 0;

    let stop: number;
    if (side === "BUY") stop = args.entryPrice - R;
    else stop = args.entryPrice + R;

    const take = rr > 0
        ? (side === "BUY" ? args.entryPrice + tgt : args.entryPrice - tgt)
        : 0;

    let movedToBE = false;
    let trailEvents = 0;

    // varre barras após a entrada
    const last = candles.length - 1;
    const limit = Math.min(
        last,
        args.horizonBars ? entry + args.horizonBars : last
    );

    for (let i = entry + 1; i <= limit; i++) {
        const c = candles[i];
        const atrNow = atr[i] ?? atr[i - 1] ?? atrEntry;

        // ----- BE -----
        if (R > 0 && beAt > 0) {
            if (side === "BUY") {
                const mfeR = (c.high - args.entryPrice) / R;
                if (!movedToBE && mfeR >= beAt) {
                    const bePrice = args.entryPrice + beOff * R;
                    if (bePrice > stop) stop = bePrice;
                    movedToBE = true;
                }
            } else {
                const mfeR = (args.entryPrice - c.low) / R;
                if (!movedToBE && mfeR >= beAt) {
                    const bePrice = args.entryPrice - beOff * R;
                    if (bePrice < stop) stop = bePrice;
                    movedToBE = true;
                }
            }
        }

        // ----- TRIALING ATR -----
        if (kTrail > 0 && atrNow > 0) {
            if (side === "BUY") {
                const trailCand = c.high - kTrail * atrNow;
                if (trailCand > stop) {
                    stop = trailCand;
                    trailEvents++;
                }
            } else {
                const trailCand = c.low + kTrail * atrNow;
                if (trailCand < stop) {
                    stop = trailCand;
                    trailEvents++;
                }
            }
        }

        // ----- TESTE DE SAÍDA DENTRO DA BARRA -----
        if (side === "BUY") {
            // prioridade: stop -> take (conservador)
            if (c.low <= stop) {
                const px = Math.max(stop - slippage, c.low);
                const pnl = (px - args.entryPrice) - cost;
                return { exitIdx: i, exitPrice: px, pnl, movedToBE, trailEvents, note: "SL/BE/Trail" };
            }
            if (rr > 0 && c.high >= take) {
                const px = Math.min(take - slippage, c.high);
                const pnl = (px - args.entryPrice) - cost;
                return { exitIdx: i, exitPrice: px, pnl, movedToBE, trailEvents, note: "TP" };
            }
        } else {
            if (c.high >= stop) {
                const px = Math.min(stop + slippage, c.high);
                const pnl = (args.entryPrice - px) - cost;
                return { exitIdx: i, exitPrice: px, pnl, movedToBE, trailEvents, note: "SL/BE/Trail" };
            }
            if (rr > 0 && c.low <= take) {
                const px = Math.max(take + slippage, c.low);
                const pnl = (args.entryPrice - px) - cost;
                return { exitIdx: i, exitPrice: px, pnl, movedToBE, trailEvents, note: "TP" };
            }
        }

        // ----- TIME-STOP -----
        if (timeStopBars && i - entry >= timeStopBars) {
            const px = c.close;
            const pnl = (side === "BUY" ? (px - args.entryPrice) : (args.entryPrice - px)) - cost;
            return { exitIdx: i, exitPrice: px, pnl, movedToBE, trailEvents, note: "TimeStop" };
        }
    }

    // fallback: sair no último close se nada foi acionado
    const lastC = candles[limit];
    const px = lastC.close;
    const pnl = (side === "BUY" ? (px - args.entryPrice) : (args.entryPrice - px)) - cost;
    return { exitIdx: limit, exitPrice: px, pnl, movedToBE, trailEvents, note: "End" };
}
