import { Router, Request, Response } from 'express';
import { prisma } from '../../core/prisma';
import { logger } from '../../core/logger';

const router = Router();

router.get('/trades', async (req: Request, res: Response) => {
    try {
        const { symbol, timeframe, from, to, limit = 500, offset = 0 } = req.query as any;

        const where: any = {};

        if (timeframe) {
            where.timeframe = timeframe;
        }

        if (symbol) {
            where.instrument = { symbol: String(symbol).toUpperCase() };
        }

        if (from || to) {
            where.entrySignal = {
                candle: {
                    time: {
                        gte: from ? new Date(from) : undefined,
                        lte: to ? new Date(to) : undefined,
                    }
                }
            };
        }

        const takeNum = Math.min(1000, Math.max(1, Number(limit)));
        const skipNum = Math.max(0, Number(offset));

        const trades = await prisma.trade.findMany({
            where,
            include: {
                instrument: true,
                entrySignal: { include: { candle: true } },
                exitSignal: { include: { candle: true } },
            },
            orderBy: { id: 'desc' },
            take: takeNum,
            skip: skipNum,
        });

        const formatted = trades.map((t: any) => ({
            id: t.id,
            symbol: t.instrument?.symbol,
            timeframe: t.timeframe,
            side: t.entrySignal?.side,
            qty: t.qty,
            entryPrice: t.entryPrice,
            exitPrice: t.exitPrice,
            pnlPoints: t.pnlPoints,
            pnlMoney: t.pnlMoney,
            entryTime: t.entrySignal?.candle?.time?.toISOString(),
            exitTime: t.exitSignal?.candle?.time?.toISOString(),
        }));
        
        const totalCount = await prisma.trade.count({ where });

        res.json({
            trades: formatted,
            total: totalCount,
            page: Math.floor(skipNum / takeNum) + 1,
            limit: takeNum,
        });

    } catch (err: any) {
        logger.error("[/trades] erro", { message: err?.message });
        res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
});

export const tradesRoutes = router;