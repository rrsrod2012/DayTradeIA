import express, { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const router = express.Router();

router.get("/broker/compare-detailed", async (req: Request, res: Response) => {
    try {
        const tradeIdParam = req.query.tradeId;
        if (!tradeIdParam) return res.status(400).json({ ok: false, error: "Missing tradeId" });
        const tradeId = Number(tradeIdParam);
        if (!Number.isFinite(tradeId)) return res.status(400).json({ ok: false, error: "Invalid tradeId" });

        const trade = await prisma.trade.findUnique({
            where: { id: tradeId },
            include: {
                instrument: true,
                entrySignal: { include: { candle: true } },
                exitSignal: { include: { candle: true } }
            }
        });
        if (!trade) return res.status(404).json({ ok: false, error: "Trade not found" });

        const tasks = await prisma.brokerTask.findMany({
            where: { OR: [{ tradeId: trade.id }, { comment: { contains: `trade#${trade.id}` } }] },
            orderBy: { createdAt: "asc" }
        });

        const taskIds = tasks.map(t => t.id);
        const executions = taskIds.length
            ? await prisma.brokerExecution.findMany({
                where: { taskId: { in: taskIds } },
                orderBy: [{ time: "asc" }, { createdAt: "asc" }]
            })
            : [];

        const side = (trade.side || trade.entrySide || "").toUpperCase();
        const qty = trade.qty ?? trade.quantity ?? 1;
        const tickSize = Number(process.env.TICK_SIZE_POINTS || 1);

        const simEntry = Number(trade.entryPrice ?? trade.priceEntry ?? trade.entry ?? NaN);
        const simExit = Number(trade.exitPrice ?? trade.priceExit ?? trade.exit ?? NaN);
        const simSLpts = Number(trade.slPoints ?? trade.stopLossPoints ?? NaN);
        const simTPpts = Number(trade.tpPoints ?? trade.takeProfitPoints ?? NaN);
        const beAtPoints = Number(process.env.AUTO_TRAINER_BE_AT_PTS || 0);
        const beOffsetPoints = Number(process.env.AUTO_TRAINER_BE_OFFSET_PTS || 0);

        const signedPnLPoints = (entry: number, exit: number) => {
            if (!Number.isFinite(entry) || !Number.isFinite(exit)) return null;
            if (side === "BUY") return Math.round((exit - entry) / tickSize);
            if (side === "SELL") return Math.round((entry - exit) / tickSize);
            return null;
        };

        const openExec = executions.find(e => e.type === "OPEN");
        const closeExec = executions.find(e => e.type === "CLOSE");

        const entrySlippagePts = (openExec && Number.isFinite(simEntry))
            ? Math.round(((openExec.price ?? 0) - simEntry) / tickSize) : null;

        const exitSlippagePts = (closeExec && Number.isFinite(simExit))
            ? Math.round(((closeExec.price ?? 0) - simExit) / tickSize) : null;

        const simPnLPts = signedPnLPoints(simEntry, simExit);
        const realPnLPts = (openExec && closeExec)
            ? signedPnLPoints(openExec.price ?? NaN, closeExec.price ?? NaN) : null;

        const latencyMs = (openExec && trade.entrySignal?.candle?.time)
            ? (new Date(openExec.time).getTime() - new Date(trade.entrySignal.candle.time).getTime()) : null;

        res.json({
            ok: true,
            tradeId: trade.id,
            symbol: trade.instrument?.symbol ?? trade.symbol ?? null,
            timeframe: trade.timeframe ?? trade.frame ?? null,
            side,
            qty,
            simulated: {
                entryPrice: Number.isFinite(simEntry) ? simEntry : null,
                exitPrice: Number.isFinite(simExit) ? simExit : null,
                slPoints: Number.isFinite(simSLpts) ? simSLpts : null,
                tpPoints: Number.isFinite(simTPpts) ? simTPpts : null,
                pnlPoints: simPnLPts,
                beAtPoints,
                beOffsetPoints
            },
            real: {
                open: openExec ? { id: openExec.id, time: openExec.time, price: openExec.price, agentId: openExec.agentId } : null,
                close: closeExec ? { id: closeExec.id, time: closeExec.time, price: closeExec.price, agentId: closeExec.agentId } : null,
                pnlPoints: realPnLPts
            },
            deltas: {
                entrySlippagePoints: entrySlippagePts,
                exitSlippagePoints: exitSlippagePts,
                latencyMs
            },
            tasks: tasks.map(t => ({
                id: t.id, createdAt: t.createdAt, agentId: t.agentId, side: t.side, symbol: t.symbol,
                volume: t.volume, slPoints: t.slPoints, tpPoints: t.tpPoints, beAtPoints: t.beAtPoints,
                beOffsetPoints: t.beOffsetPoints, comment: t.comment
            })),
            executions: executions.map(e => ({
                id: e.id, taskId: e.taskId, type: e.type, time: e.time, price: e.price,
                quantity: e.quantity, agentId: e.agentId, raw: e.raw ?? null
            }))
        });
    } catch (err: any) {
        console.error("compare-detailed error", err);
        res.status(500).json({ ok: false, error: err?.message || "Internal error" });
    }
});

export default router;
