import { Router, Request, Response } from 'express';
import { prisma } from '../../core/prisma';
import { logger } from '../../core/logger';
import { generateProjectedSignals } from '../strategy/engine';

const router = Router();

// Rota para buscar sinais confirmados (gerados pelo StrategyEngine)
router.get('/signals/confirmed', async (req: Request, res: Response) => {
  try {
    const { symbol, timeframe, from, to, limit = "200" } = req.query as any;

    const where: any = {};
    if (symbol) {
        const instrument = await prisma.instrument.findUnique({ where: { symbol: String(symbol) }});
        if (instrument) {
            where.candle = { instrumentId: instrument.id };
        }
    }
    if (timeframe) {
        where.candle = { ...where.candle, timeframe: String(timeframe) };
    }
    if (from || to) {
        where.candle = {
            ...where.candle,
            time: {
                gte: from ? new Date(from) : undefined,
                lte: to ? new Date(to) : undefined,
            }
        };
    }

    const signals = await prisma.signal.findMany({
      where,
      include: {
        candle: {
          select: { time: true, close: true, instrument: { select: { symbol: true }} }
        }
      },
      orderBy: { candle: { time: 'desc' } },
      take: parseInt(limit, 10),
    });

    const formatted = signals.map(s => ({
        id: s.id,
        time: s.candle.time.toISOString(),
        symbol: s.candle.instrument.symbol,
        timeframe: where.candle?.timeframe,
        side: s.side,
        price: s.candle.close,
        score: s.score,
        reason: s.reason,
        signalType: s.signalType
    }));

    res.json(formatted);
  } catch (err: any) {
    logger.error("[/signals/confirmed] erro", { message: err?.message });
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// Rota para buscar sinais projetados (gerados pelo motor de projeção)
router.post('/signals/projected', async (req: Request, res: Response) => {
    try {
        const { symbol, timeframe, from, to, limit } = req.body;
        if (!symbol || !timeframe) {
            return res.status(400).json({ error: 'Parâmetros symbol e timeframe são obrigatórios.'});
        }
        
        const signals = await generateProjectedSignals({
            symbol,
            timeframe,
            from,
            to,
            limit
        });

        res.json(signals);
    } catch (err: any) {
        logger.error("[/signals/projected] erro", { message: err?.message });
        res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
});

export const signalsRoutes = router;