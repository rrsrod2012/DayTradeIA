/* backend/src/services/brokerStore.ts
   Store in-memory de ordens/execuções reais do MT5 para alimentar o dashboard (Resumo MT5).

   Obs.: Por ser in-memory, zera ao reiniciar o processo. Em produção,
   troque por persistência em Prisma (tabelas mt5_order/mt5_trade).
*/

export type BrokerEvent =
    | ({
        type: "ORDER_NEW";
        idMt5: string;
        symbol: string;
        side: "BUY" | "SELL";
        volume: number;
        entryPrice: number;
        entryTime: string; // ISO
        sl?: number | null;
        tp?: number | null;
        comment?: string | null;
    })
    | ({
        type: "ORDER_MODIFY";
        idMt5: string;
        sl?: number | null;
        tp?: number | null;
        time?: string | null;
        beApplied?: boolean | null;
    })
    | ({
        type: "ORDER_CLOSE";
        idMt5: string;
        exitPrice: number;
        exitTime: string; // ISO
        exitReason: "TP" | "SL" | "MANUAL" | "REVERSE" | "TIMEOUT" | "UNKNOWN";
        commission?: number | null;
        swap?: number | null;
        slippagePts?: number | null;
    });

export type BrokerOrder = {
    idMt5: string;
    symbol: string;
    side: "BUY" | "SELL";
    volume: number;
    entryPrice: number;
    entryTime: string; // ISO
    sl: number | null;
    tp: number | null;
    status: "OPEN" | "CLOSED";
};

export type BrokerTrade = {
    idMt5: string;
    symbol: string;
    side: "BUY" | "SELL";
    volume: number;
    entryPrice: number;
    exitPrice: number;
    entryTime: string;
    exitTime: string;
    exitReason: string;
    pnlPoints: number;
    commission?: number | null;
    swap?: number | null;
    slippagePts?: number | null;
};

const ORDERS = new Map<string, BrokerOrder>();
const TRADES: BrokerTrade[] = [];

function pnlPoints(side: "BUY" | "SELL", entry: number, exit: number): number {
    const pts = exit - entry;
    return side === "BUY" ? pts : -pts;
}

export function applyBrokerEvent(ev: BrokerEvent) {
    if (ev.type === "ORDER_NEW") {
        ORDERS.set(ev.idMt5, {
            idMt5: ev.idMt5,
            symbol: ev.symbol.toUpperCase(),
            side: ev.side,
            volume: ev.volume,
            entryPrice: ev.entryPrice,
            entryTime: ev.entryTime,
            sl: ev.sl ?? null,
            tp: ev.tp ?? null,
            status: "OPEN",
        });
        return;
    }
    if (ev.type === "ORDER_MODIFY") {
        const cur = ORDERS.get(ev.idMt5);
        if (cur) {
            if (ev.sl !== undefined) cur.sl = ev.sl ?? null;
            if (ev.tp !== undefined) cur.tp = ev.tp ?? null;
            ORDERS.set(ev.idMt5, cur);
        }
        return;
    }
    if (ev.type === "ORDER_CLOSE") {
        const cur = ORDERS.get(ev.idMt5);
        if (cur) {
            cur.status = "CLOSED";
            ORDERS.set(ev.idMt5, cur);
            TRADES.push({
                idMt5: ev.idMt5,
                symbol: cur.symbol,
                side: cur.side,
                volume: cur.volume,
                entryPrice: cur.entryPrice,
                exitPrice: ev.exitPrice,
                entryTime: cur.entryTime,
                exitTime: ev.exitTime,
                exitReason: ev.exitReason,
                pnlPoints: pnlPoints(cur.side, cur.entryPrice, ev.exitPrice),
                commission: ev.commission ?? null,
                swap: ev.swap ?? null,
                slippagePts: ev.slippagePts ?? null,
            });
        }
        return;
    }
}

export function listBrokerTrades(opts?: {
    symbol?: string;
    from?: Date;
    to?: Date;
    limit?: number;
}): BrokerTrade[] {
    let arr = TRADES.slice();
    if (opts?.symbol) arr = arr.filter(t => t.symbol === opts.symbol.toUpperCase());
    if (opts?.from) arr = arr.filter(t => new Date(t.entryTime) >= opts.from!);
    if (opts?.to) arr = arr.filter(t => new Date(t.entryTime) <= opts.to!);
    arr.sort((a, b) => new Date(a.entryTime).getTime() - new Date(b.entryTime).getTime());
    if (opts?.limit) arr = arr.slice(Math.max(0, arr.length - opts.limit));
    return arr;
}

export function brokerSummary(trades: BrokerTrade[]) {
    const n = trades.length;
    let wins = 0, losses = 0, ties = 0, pnlPoints = 0;
    for (const t of trades) {
        pnlPoints += t.pnlPoints;
        if (t.pnlPoints > 0) wins++;
        else if (t.pnlPoints < 0) losses++;
        else ties++;
    }
    const winRate = n ? (wins / n) * 100 : 0;
    const avgPnL = n ? pnlPoints / n : 0;
    return { trades: n, wins, losses, ties, winRate, pnlPoints, avgPnL };
}
