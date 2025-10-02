// ===============================
// FILE: backend_new/src/modules/api/projectedSignalsRoutes.ts
// ===============================
import { Router, Request, Response } from 'express';
import { generateProjectedSignals } from '../strategy/projectedSignals.engine';
import { logger } from '../../core/logger';

const router = Router();

router.post('/signals/projected', async (req: Request, res: Response) => {
  try {
    const params = req.body;
    const items = await generateProjectedSignals(params);
    res.json(items);
  } catch (err: any) {
    logger.error("[/signals/projected] erro", { message: err?.message });
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

export const projectedSignalsRoutes = router;