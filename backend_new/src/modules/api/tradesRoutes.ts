// ===============================
// FILE: backend_new/src/modules/api/tradesRoutes.ts
// ===============================
import { Router, Request, Response } from 'express';
import { prisma } from '../../core/prisma';
import { logger } from '../../core/logger';
import { toUtcRange } from './api.helpers'; // Usando o helper centralizado

const router = Router();

router.get('/trades', async (req: Request, res: Response) => {
    try {
        const { symbol, timeframe, from, to, limit = 500, offset = 0 } = req.query as any;

        const where: any = {};

        if (symbol) {
            where.instrument = { symbol: String(symbol).toUpperCase().trim() };
        }
        if (timeframe) {
            where.timeframe = String(timeframe).toUpperCase().trim();
        }

        const range = toUtcRange(from, to);
        // <<< CORREÇÃO DA LÓGICA DE FILTRO DE DATA >>>
        if (range?.gte || range?.lte) {
            where.entrySignal = {
                is: { // A condição deve estar dentro de 'is' para relations 1-para-muitos
                    candle: {
                        time: {
                            ...(range.gte && { gte: range.gte }),
                            ...(range.lte && { lte: range.lte }),
                        }
                    }
                }
            };
        }

        const trades = await prisma.trade.findMany({
            where,
            include: {
                instrument: true,
                entrySignal: { include: { candle: true } }, // Inclui o candle para obter o tempo
                exitSignal: { include: { candle: true } },
            },
            orderBy: { id: 'desc' },
            take: Number(limit),
            skip: Number(offset),
        });

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
        
        // Retornamos o formato esperado pelo frontend, que é um array diretamente
        res.json(formattedTrades);

    } catch (e: any) {
        logger.error('[API] Erro ao buscar trades', { error: e.message, query: req.query });
        res.status(500).json({ ok: false, error: 'Erro interno ao processar a solicitação de trades.' });
    }
});

export const tradesRoutes = router;