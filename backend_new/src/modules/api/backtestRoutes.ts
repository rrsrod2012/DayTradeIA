// ===============================
// FILE: backend_new/src/modules/api/backtestRoutes.ts
// ===============================
import { Router, Request, Response } from 'express';
import { runBacktest } from '../backtest/backtest.engine';
import { logger } from '../../core/logger';
import { DateTime } from 'luxon';

const router = Router();
const ZONE_BR = "America/Sao_Paulo";

// Helper para normalizar o range de datas, cobrindo o dia inteiro
function normalizeDayRange(fromRaw: any, toRaw: any): { from: string; to: string } | null {
  const parseUserDate = (raw: any) => {
    if (raw == null) return { ok: false, dt: DateTime.invalid("empty") };
    const dt = DateTime.fromISO(String(raw), { zone: ZONE_BR });
    return { ok: dt.isValid, dt };
  };

  const pF = parseUserDate(fromRaw);
  const pT = parseUserDate(toRaw);
  if (!pF.ok && !pT.ok) return null;

  let fromLocal: DateTime;
  let toLocal: DateTime;

  if (pF.ok && pT.ok) {
    fromLocal = pF.dt.startOf("day");
    toLocal = pT.dt.endOf("day");
  } else if (pF.ok) {
    fromLocal = pF.dt.startOf("day");
    toLocal = pF.dt.endOf("day");
  } else { // pT.ok
    fromLocal = pT.dt.startOf("day");
    toLocal = pT.dt.endOf("day");
  }

  if (toLocal < fromLocal) {
    [fromLocal, toLocal] = [toLocal, fromLocal];
  }

  return { from: fromLocal.toUTC().toISO()!, to: toLocal.toUTC().toISO()! };
}

async function handleBacktestRequest(req: Request, res: Response) {
  try {
    const query = { ...req.query, ...req.body };
    const { symbol, timeframe, from, to } = query;

    if (!symbol || !timeframe) {
      return res.status(400).json({ ok: false, error: "Parâmetros 'symbol' e 'timeframe' são obrigatórios." });
    }

    const range = normalizeDayRange(from, to);
    const now = DateTime.now().setZone(ZONE_BR);
    const effectiveFrom = range?.from ?? now.minus({ days: 1 }).startOf('day').toUTC().toISO();
    const effectiveTo = range?.to ?? now.endOf('day').toUTC().toISO();

    const result = await runBacktest({
      ...query,
      symbol: String(symbol),
      timeframe: String(timeframe),
      from: effectiveFrom!,
      to: effectiveTo!,
    });
    
    res.json(result);

  } catch (error: any) {
    logger.error('Erro ao executar backtest', { error: error.message, stack: error.stack });
    res.status(500).json({ ok: false, error: 'Ocorreu um erro interno no servidor.' });
  }
}

router.get('/backtest', handleBacktestRequest);
router.post('/backtest', handleBacktestRequest);

export const backtestRoutes = router;