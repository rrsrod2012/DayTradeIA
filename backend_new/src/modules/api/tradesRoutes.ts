import { Express, Request, Response } from 'express';
import { prisma } from '../../core/prisma';
import { DateTime } from 'luxon';

export const initTradesRoutes = (app: Express) => {
    app.get('/api/trades', async (req: Request, res: Response) => {
        try {
            const { from, symbol, timeframe } = req.query;

            if (!from || !symbol || !timeframe) {
                return res.status(400).json({ ok: false, error: "Parâmetros obrigatórios: from, symbol, timeframe" });
            }

            const fromDate = DateTime.fromISO(from as string).startOf('day').toJSDate();
            const toDate = DateTime.fromISO(from as string).endOf('day').toJSDate();

            const instrument = await prisma.instrument.findUnique({ where: { symbol: String(symbol) }});
            if (!instrument) {
                return res.json({ ok: true, data: [] });
            }
            
            const trades = await prisma.trade.findMany({
                where: {
                    instrumentId: instrument.id,
                    timeframe: String(timeframe),
                    entrySignal: {
                        candle: {
                            time: {
                                gte: fromDate,
                                lte: toDate,
                            }
                        }
                    }
                },
                include: {
                    entrySignal: { include: { candle: true } },
                    exitSignal: { include: { candle: true } },
                },
                orderBy: {
                    entrySignal: { candle: { time: 'asc' } }
                }
            });

            res.status(200).json({ ok: true, data: trades });
        } catch (e: any) {
            console.error("[/api/trades] erro:", e?.message || String(e));
            res.status(500).json({ ok: false, error: "Erro interno do servidor" });
        }
    });
};