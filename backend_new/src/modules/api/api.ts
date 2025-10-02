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
import { riskRoutes } from './riskRoutes';
import { loadCandlesAnyTF } from '../data-import/lib/aggregation';
import { logger } from '../../core/logger';
import { normalizeApiDateRange } from './api.helpers'; // <<< USANDO O HELPER PADRONIZADO

export const initApi = (app: Express) => {
    // Inicializa todas as rotas da aplicação
    app.use('/api', tradesRoutes);
    app.use('/api', signalsRoutes);
    app.use('/api', projectedSignalsRoutes); // <-- Adicionado, se faltava
    app.use('/api', backtestRoutes);
    app.use('/api', notifyRoutes);
    app.use('/api', adminRoutes);
    app.use('/api', orderLogsRoutes); // <-- Adicionado, se faltava
    app.use('/', brokerAdminRoutes); // <-- Adicionado, se faltava
    app.use('/', runtimeConfigRoutes); // <-- Adicionado, se faltava
    app.use('/', riskRoutes); // <-- Adicionado, se faltava

    // Rota para buscar candles para o gráfico
    app.get('/api/candles', async (req: Request, res: Response) => {
        try {
            const { symbol, timeframe, from, to, limit } = req.query;
            if (!symbol || !timeframe) {
                return res.status(400).json({ error: 'Parâmetros symbol e timeframe são obrigatórios.' });
            }

            // <<< CORREÇÃO: Utiliza a função de data centralizada >>>
            const range = normalizeApiDateRange(from, to);

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