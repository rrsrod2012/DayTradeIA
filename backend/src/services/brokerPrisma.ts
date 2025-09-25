// src/services/brokerPrisma.ts
import { prisma } from "../prisma";

export type AckItem = {
    id?: string;
    taskId?: string;
    orderId?: string;
    status?: string; // e.g., FILLED, PARTIAL, CANCELED
    side?: "BUY" | "SELL";
    symbol?: string;
    time?: string | number;
    price?: number;
    volume?: number;
    pnlPoints?: number;
    raw?: any;
};

export type TaskItem = {
    id: string;
    side: "BUY" | "SELL";
    comment?: string;
    symbol?: string;
    timeframe?: string;
    time?: any;
    price?: number;
    volume?: number;
    slPoints?: number | null;
    tpPoints?: number | null;
    beAtPoints?: number | null;
    beOffsetPoints?: number | null;
};

export async function persistTask(agentId: string, t: TaskItem) {
    try {
        await prisma.brokerTask.create({
            data: {
                id: t.id,
                agentId,
                side: t.side,
                symbol: t.symbol || null,
                timeframe: (t.timeframe as any) || null,
                time: t.time ? new Date(t.time) : null,
                price: Number.isFinite(t.price as any) ? Number(t.price) : null,
                volume: Number.isFinite(t.volume as any) ? Number(t.volume) : null,
                slPoints: Number.isFinite(t.slPoints as any) ? Number(t.slPoints) : null,
                tpPoints: Number.isFinite(t.tpPoints as any) ? Number(t.tpPoints) : null,
                beAtPoints: Number.isFinite(t.beAtPoints as any) ? Number(t.beAtPoints) : null,
                beOffsetPoints: Number.isFinite(t.beOffsetPoints as any) ? Number(t.beOffsetPoints) : null,
                comment: t.comment || null,
            },
        });
    } catch (e) {
        // ignore uniqueness errors; task ids are unique by design
    }
}

export async function persistAck(agentId: string, done: AckItem[]) {
    for (const d of done) {
        try {
            await prisma.brokerExecution.create({
                data: {
                    taskId: d.taskId || d.id || null,
                    agentId,
                    side: (d.side as any) || "BUY",
                    symbol: d.symbol || null,
                    orderId: d.orderId || null,
                    status: d.status || null,
                    time: d.time ? new Date(d.time as any) : null,
                    price: Number.isFinite(d.price as any) ? Number(d.price) : null,
                    volume: Number.isFinite(d.volume as any) ? Number(d.volume) : null,
                    pnlPoints: Number.isFinite(d.pnlPoints as any) ? Number(d.pnlPoints) : null,
                    raw: d.raw ? JSON.stringify(d.raw) : null,
                },
            });
        } catch (e) {
            // swallow error to avoid impacting EA acks
        }
    }
}
