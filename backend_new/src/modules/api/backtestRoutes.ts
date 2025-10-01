import { Router, Request, Response } from 'express';
import { logger } from '../../core/logger';
import { runBacktest } from '../backtest/backtest.engine';

const router = Router();

router.post('/backtest', async (req: Request, res: Response) => {
    try {
        const params = req.body;
        const result = await runBacktest(params);
        res.json({ ok: true, ...result });
    } catch (err: any) {
        logger.error("[/backtest] erro", { message: err?.message });
        res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
});

export const backtestRoutes = router;