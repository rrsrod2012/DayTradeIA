import { Router } from 'express';
import { startAutoTrainer, stopAutoTrainer, statusAutoTrainer } from '../ai-trainer/autoTrainer.engine';
import { logger } from '../../core/logger';

const router = Router();

// --- Rotas do AutoTrainer ---
router.get('/admin/auto-trainer/status', (req, res) => {
    try {
        const status = statusAutoTrainer();
        res.json({ ok: true, ...status });
    } catch (error: any) {
        logger.error('Erro ao obter status do AutoTrainer', { error: error.message });
        res.status(500).json({ ok: false, error: 'Erro interno' });
    }
});

router.post('/admin/auto-trainer/start', (req, res) => {
    try {
        const result = startAutoTrainer();
        res.json(result);
    } catch (error: any) {
        logger.error('Erro ao iniciar o AutoTrainer', { error: error.message });
        res.status(500).json({ ok: false, error: 'Erro interno' });
    }
});

router.post('/admin/auto-trainer/stop', (req, res) => {
    try {
        const result = stopAutoTrainer();
        res.json(result);
    } catch (error: any) {
        logger.error('Erro ao parar o AutoTrainer', { error: error.message });
        res.status(500).json({ ok: false, error: 'Erro interno' });
    }
});


export const adminRoutes = router;