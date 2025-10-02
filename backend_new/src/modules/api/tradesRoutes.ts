// ===============================
// FILE: backend_new/src/modules/api/tradesRoutes.ts
// ===============================
import { Router, Request, Response } from 'express';
import { prisma } from '../../core/prisma';
import { logger } from '../../core/logger';
import { normalizeApiDateRange } from './api.helpers';

const router = Router();

router.get('/trades', async (req: Request, res: Response) => {
    try {
        const { symbol, timeframe, from, to, limit = 500, offset = 0 } = req.query as any;
        logger.info('[TRADES_ROUTE_DEBUG] Recebida requisição /trades', { query: req.query });

        const where: any = {};

        if (symbol) {
            where.instrument = { symbol: String(symbol).toUpperCase().trim() };
        }
        if (timeframe) {
            where.timeframe = String(timeframe).toUpperCase().trim();
        }

        const range = normalizeApiDateRange(from, to);
        if (range) {
            where.entrySignal = {
                candle: {
                    time: range
                }
            };
        }

        logger.info('[TRADES_ROUTE_DEBUG] Executando consulta Prisma com a cláusula "where":', { where: JSON.stringify(where, null, 2) });

        const trades = await prisma.trade.findMany({
            where,
            include: {
                instrument: true,
                entrySignal: { include: { candle: true } },
                exitSignal: { include: { candle: true } },
            },
            orderBy: { id: 'desc' },
            take: Number(limit),
            skip: Number(offset),
        });

        logger.info(`[TRADES_ROUTE_DEBUG] Consulta ao banco de dados retornou ${trades.length} trades.`);

        const formattedTrades = trades.map(t => ({
            id: t.id,
            symbol: t.instrument.symbol,
            timeframe: t.timeframe,
            qty: t.qty,
            side: t.entrySignal?.side ?? null,
            entrySignalId: t.entrySignalId,
            exitSignalId: t.exitSignalId,
            entryPrice: t.entryPrice,
            exitPrice: t.exitPrice,
            pnlPoints: t.pnlPoints,
            pnlMoney: t.pnlMoney,
            entryTime: t.entrySignal?.candle?.time?.toISOString() ?? null,
            exitTime: t.exitSignal?.candle?.time?.toISOString() ?? null,
        }));

        res.json(formattedTrades);

    } catch (e: any) {
        logger.error('[API] Erro ao buscar trades', { error: e.message, query: req.query });
        res.status(500).json({ ok: false, error: 'Erro interno ao processar a solicitação de trades.' });
    }
});

export const tradesRoutes = router;