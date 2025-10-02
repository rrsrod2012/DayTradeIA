// ===============================
// FILE: backend_new/src/modules/api/riskRoutes.ts
// ===============================
import { Router, Request, Response } from 'express';
import { logger } from '../../core/logger';

const router = Router();

// Simples estado de risco em memória, como no backend original
const RISK_STATE = {
    maxLoss: -500, // Exemplo de valor padrão
    pnl: 0,
    enabled: true,
};

const handleGetState = (_req: Request, res: Response) => {
    res.json({ ok: true, state: RISK_STATE });
};

const handlePostState = (req: Request, res: Response) => {
    try {
        const { maxLoss, pnl, enabled } = req.body || {};
        if (typeof maxLoss === 'number') RISK_STATE.maxLoss = maxLoss;
        if (typeof pnl === 'number') RISK_STATE.pnl = pnl;
        if (typeof enabled === 'boolean') RISK_STATE.enabled = enabled;

        logger.info('[API] Estado de risco atualizado', RISK_STATE);
        res.json({ ok: true, state: RISK_STATE });
    } catch (e: any) {
        logger.error('[API] Erro ao atualizar estado de risco', { body: req.body, error: e.message });
        res.status(500).json({ ok: false, error: 'Erro interno do servidor.' });
    }
};

// Registra as rotas
router.get('/risk/state', handleGetState);
router.post('/risk/state', handlePostState);

router.get('/broker/risk/state', handleGetState);
router.post('/broker/risk/state', handlePostState);

export const riskRoutes = router;