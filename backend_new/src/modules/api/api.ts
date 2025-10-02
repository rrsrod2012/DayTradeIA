// ===============================
// FILE: backend_new/src/modules/api/api.ts
// ===============================
import { Express, Request, Response } from 'express';
import { prisma } from '../../core/prisma';
import { tradesRoutes } from './tradesRoutes';
import { signalsRoutes } from './signalsRoutes';
import { projectedSignalsRoutes } from './projectedSignalsRoutes';
import { backtestRoutes } from './backtestRoutes';
import { notifyRoutes } from './notifyRoutes';
import { adminRoutes } from './adminRoutes';
import { orderLogsRoutes } from './orderLogsRoutes';
import { brokerAdminRoutes } from './brokerAdminRoutes';
import { runtimeConfigRoutes } from './runtimeConfigRoutes';
import { riskRoutes } from './riskRoutes'; // <<< NOVA IMPORTAÇÃO
import { loadCandlesAnyTF } from '../data-import/lib/aggregation';
import { logger } from '../../core/logger';

export const initApi = (app: Express) => {
    // Inicializa as rotas específicas
    app.use('/api', tradesRoutes);
    app.use('/api', signalsRoutes);
    app.use('/api', projectedSignalsRoutes);
    app.use('/api', backtestRoutes);
    app.use('/api', notifyRoutes);
    app.use('/api', adminRoutes);
    app.use('/api', orderLogsRoutes);
    app.use('/', brokerAdminRoutes);
    app.use('/', runtimeConfigRoutes);
    app.use('/', riskRoutes); // <<< NOVO USO

    // Rota para buscar candles para o gráfico
    app.get('/api/candles', async (req: Request, res: Response) => {
        try {
            const { symbol, timeframe, from, to, limit } = req.query;
            if (!symbol || !timeframe) {
                return res.status(400).json({ error: 'Parâmetros symbol e timeframe são obrigatórios.' });
            }

            const range = from || to ? {
                gte: from ? new Date(String(from)) : undefined,
                lte: to ? new Date(String(to)) : undefined
            } : undefined;

            const candles = await loadCandlesAnyTF(
                String(symbol),
                String(timeframe),
                { ...range, limit: limit ? Number(limit) : undefined }
            );

            res.json(candles);
        } catch (err: any) {
            logger.error("[/candles] erro", { message: err?.message });
            res.status(500).json({ ok: false, error: err?.message || String(err) });
        }
    });
};