// ===============================
// FILE: backend_new/src/modules/api/backtestRoutes.ts
// ===============================
import { Router, Request, Response } from 'express';
import { runBacktest } from '../backtest/backtest.engine';
import { logger } from '../../core/logger';
import { normalizeApiDateRange } from './api.helpers'; // <<< USANDO O HELPER PADRONIZADO

const router = Router();

async function handleBacktestRequest(req: Request, res: Response) {
  try {
    // Unifica parâmetros do corpo e da query para flexibilidade
    const params = { ...req.query, ...req.body };
    const { symbol, timeframe, from, to } = params;

    if (!symbol || !timeframe) {
      return res.status(400).json({ ok: false, error: "Parâmetros 'symbol' e 'timeframe' são obrigatórios." });
    }

    // <<< CORREÇÃO: Utiliza a função de data centralizada >>>
    const dateRange = normalizeApiDateRange(from, to);

    const result = await runBacktest({
      ...params,
      dateRange, // Passa o objeto de data corrigido para o motor de backtest
    });

    res.json(result);

  } catch (error: any) {
    logger.error('Erro ao executar backtest', { error: error.message, stack: error.stack });
    res.status(500).json({ ok: false, error: 'Ocorreu um erro interno no servidor.' });
  }
}

// Rota principal para executar o backtest, conforme esperado pelo frontend.
router.post('/backtest/run', handleBacktestRequest);

// Mantém as rotas antigas por compatibilidade, se necessário, mas aponta para o mesmo handler.
router.get('/backtest', handleBacktestRequest);
router.post('/backtest', handleBacktestRequest);

export const backtestRoutes = router;