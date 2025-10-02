// ===============================
// FILE: backend_new/src/modules/api/brokerAdminRoutes.ts
// ===============================
import { Router, Request, Response } from 'express';
import { prisma } from '../../core/prisma';
import { logger } from '../../core/logger';

const router = Router();

router.get('/admin/broker/compare-detailed', async (req: Request, res: Response) => {
    try {
        const tradeId = Number(req.query.tradeId);
        if (!tradeId || isNaN(tradeId)) {
            return res.status(400).json({ ok: false, error: 'tradeId numérico é obrigatório.' });
        }

        const trade = await prisma.trade.findUnique({
            where: { id: tradeId },
            include: {
                instrument: true,
                entrySignal: { include: { candle: true } },
                exitSignal: { include: { candle: true } },
            },
        });

        if (!trade) {
            return res.status(404).json({ ok: false, error: 'Trade não encontrado.' });
        }

        // O taskId pode ter vários formatos, mas geralmente contém o ID do trade.
        // Usamos 'contains' para flexibilidade. O ideal é ter um taskId padronizado.
        const taskIdPattern = `trade-${tradeId}-`;
        const executions = await prisma.brokerExecution.findMany({
            where: {
                taskId: {
                    contains: taskIdPattern,
                },
            },
            orderBy: {
                createdAt: 'asc',
            },
        });

        res.json({
            ok: true,
            trade,
            executions,
        });

    } catch (e: any) {
        logger.error('[Admin] Erro ao comparar trade com execuções do broker', { error: e.message });
        res.status(500).json({ ok: false, error: e.message });
    }
});

export const brokerAdminRoutes = router;