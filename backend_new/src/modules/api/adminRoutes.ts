// ===============================
// FILE: backend_new/src/modules/api/adminRoutes.ts
// ===============================
import { Router, Request, Response } from 'express';
import { prisma } from '../../core/prisma';
import { logger } from '../../core/logger';
import { backfillSignalsAndTrades, processImportedRange } from '../strategy/maintenance.tasks';
import { startAutoTrainer, stopAutoTrainer, statusAutoTrainer } from '../ai-trainer';
import { toUtcRange } from './api.helpers';
import { DateTime } from 'luxon';

const router = Router();

// Rota para forçar o backfill de sinais e trades
router.post('/admin/signals/backfill', async (req: Request, res: Response) => {
    try {
        const { symbol, timeframe } = req.body;
        if (!symbol || !timeframe) {
            return res.status(400).json({ ok: false, error: 'Symbol e timeframe são obrigatórios.' });
        }
        const instrument = await prisma.instrument.findUnique({ where: { symbol } });
        if (!instrument) {
            return res.status(404).json({ ok: false, error: `Instrumento ${symbol} não encontrado.` });
        }
        
        logger.info(`[Admin] Iniciando backfill para ${symbol} ${timeframe}...`);
        const result = await backfillSignalsAndTrades(instrument, timeframe);
        logger.info(`[Admin] Backfill para ${symbol} ${timeframe} concluído.`);

        res.json({ ok: true, result });
    } catch (e: any) {
        logger.error('[Admin] Erro no backfill de sinais', { error: e.message });
        res.status(500).json({ ok: false, error: e.message });
    }
});

// Rota para reconstruir trades (usa a mesma lógica do backfill completo)
router.post('/admin/rebuild/trades', async (req: Request, res: Response) => {
    try {
        const { symbol, timeframe } = req.body;
        if (!symbol || !timeframe) {
            return res.status(400).json({ ok: false, error: 'Symbol e timeframe são obrigatórios.' });
        }
        const instrument = await prisma.instrument.findUnique({ where: { symbol } });
        if (!instrument) {
            return res.status(404).json({ ok: false, error: `Instrumento ${symbol} não encontrado.` });
        }

        logger.info(`[Admin] Iniciando reconstrução de trades para ${symbol} ${timeframe}...`);
        const result = await backfillSignalsAndTrades(instrument, timeframe);
        logger.info(`[Admin] Reconstrução para ${symbol} ${timeframe} concluída.`);

        res.json({ ok: true, result });
    } catch (e: any) {
        logger.error('[Admin] Erro na reconstrução de trades', { error: e.message });
        res.status(500).json({ ok: false, error: e.message });
    }
});

// Rotas de controle do AutoTrainer
router.get('/admin/auto-trainer/status', (_req, res) => res.json(statusAutoTrainer()));
router.post('/admin/auto-trainer/start', (_req, res) => res.json(startAutoTrainer()));
router.post('/admin/auto-trainer/stop', (_req, res) => res.json(stopAutoTrainer()));

// Rota para inspecionar trades recentes
router.get("/admin/trades/inspect", async (req: Request, res: Response) => {
    try {
      const { symbol, timeframe, limit = 50 } = req.query;
      const where: any = {};
      if (symbol) where.instrument = { symbol: String(symbol).toUpperCase() };
      if (timeframe) where.timeframe = String(timeframe).toUpperCase();
  
      const trades = await prisma.trade.findMany({
        where,
        orderBy: { id: "desc" },
        take: Number(limit),
        include: {
          instrument: { select: { symbol: true } },
          entrySignal: { include: { candle: { select: { time: true } } } },
          exitSignal: { include: { candle: { select: { time: true } } } },
        },
      });
  
      const out = trades.map((tr) => ({
        id: tr.id,
        symbol: tr.instrument.symbol,
        timeframe: tr.timeframe,
        side: tr.entrySignal?.side || null,
        entryPrice: tr.entryPrice,
        exitPrice: tr.exitPrice,
        pnlPoints: tr.pnlPoints,
        entryTime: tr.entrySignal?.candle?.time?.toISOString() || null,
        exitTime: tr.exitSignal?.candle?.time?.toISOString() || null,
        exitReason: tr.exitSignal?.reason || null,
      }));
  
      res.json({ ok: true, data: out });
    } catch (e: any) {
      logger.error("[Admin] Erro ao inspecionar trades", { error: e.message });
      res.status(500).json({ ok: false, error: e.message });
    }
});

// Rota de diagnóstico de disponibilidade de dados
router.get("/api/debug/availability", async (_req, res) => {
    try {
        const syms = (process.env.DEBUG_SYMBOLS || "WIN,WDO").split(',').map(s => s.trim().toUpperCase());
        const tfs = (process.env.DEBUG_TFS || "M1,M5,M15,H1").split(',').map(s => s.trim().toUpperCase());
        const now = DateTime.now();
        const from = now.minus({ days: 30 }).startOf("day").toJSDate();
        const to = now.endOf("day").toJSDate();
        const out: any[] = [];
        for (const s of syms) {
            for (const tf of tfs) {
                try {
                    const rows = await loadCandlesAnyTF(s, tf, { gte: from, lte: to, limit: 5000 });
                    out.push({
                        symbol: s, timeframe: tf, count: rows?.length || 0,
                        first: rows?.[0]?.time?.toISOString?.() || null,
                        last: rows?.[rows.length - 1]?.time?.toISOString?.() || null,
                    });
                } catch (e: any) {
                    out.push({ symbol: s, timeframe: tf, error: e?.message || String(e) });
                }
            }
        }
        res.json({ ok: true, data: out });
    } catch (e: any) {
        res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
});

export const adminRoutes = router;