// ===============================
// FILE: backend_new/src/modules/api/projectedSignalsRoutes.ts
// ===============================
import { Router, Request, Response } from 'express';
import { generateProjectedSignals } from '../strategy/projectedSignals.engine';
import { logger } from '../../core/logger';
import { normalizeApiDateRange } from './api.helpers';

const router = Router();

// <<< CORREÇÃO: Alterado de GET para POST para alinhar com o frontend >>>
router.post('/signals/projected', async (req: Request, res: Response) => {
  try {
    // <<< CORREÇÃO: Lendo parâmetros de req.body (corpo da requisição POST) >>>
    const params = req.body;
    const { from, to } = params;

    // Aplica a função de data padronizada que já corrigimos
    const dateRange = normalizeApiDateRange(from, to);

    const items = await generateProjectedSignals({
      ...params,
      dateRange, // Passa o intervalo de datas corrigido para a função
    });

    res.json(items);
  } catch (err: any) {
    logger.error("[/signals/projected] erro", { message: err?.message, stack: err?.stack });
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

export const projectedSignalsRoutes = router;