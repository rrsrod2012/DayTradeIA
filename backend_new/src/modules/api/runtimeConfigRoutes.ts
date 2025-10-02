// ===============================
// FILE: backend_new/src/modules/api/runtimeConfigRoutes.ts
// ===============================
import { Router, Request, Response } from 'express';
import { getRuntimeConfig, updateRuntimeConfig, RuntimeConfig } from '../../core/runtimeConfig';
import { logger } from '../../core/logger';

const router = Router();

router.get('/admin/runtime-config', (_req: Request, res: Response) => {
    try {
        const config = getRuntimeConfig();
        res.json({ ok: true, config });
    } catch (e: any) {
        logger.error('[API] Erro ao obter configuração de runtime', { error: e.message });
        res.status(500).json({ ok: false, error: 'Erro interno do servidor.' });
    }
});

router.post('/admin/runtime-config', (req: Request, res: Response) => {
    try {
        const newConfig: Partial<RuntimeConfig> = req.body;
        const updatedConfig = updateRuntimeConfig(newConfig);
        res.json({ ok: true, config: updatedConfig });
    } catch (e: any) {
        logger.error('[API] Erro ao atualizar configuração de runtime', { body: req.body, error: e.message });
        res.status(500).json({ ok: false, error: 'Erro interno do servidor.' });
    }
});

export const runtimeConfigRoutes = router;