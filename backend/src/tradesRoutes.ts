import express from "express";
import { prisma } from "./prisma";
import { DateTime } from "luxon";

export const router = express.Router();

router.get("/api/trades", async (req, res) => {
    try {
        const { from, symbol, timeframe } = req.query;

        if (!from || !symbol || !timeframe) {
            return res
                .status(400)
                .json({ ok: false, error: "Faltando parâmetros obrigatórios: from, symbol, timeframe" });
        }

        const fromDate = DateTime.fromISO(from as string).startOf('day').toJSDate();
        const toDate = DateTime.fromISO(from as string).endOf('day').toJSDate();

        const trades = await prisma.trade.findMany({
            where: {
                instrument: {
                    symbol: String(symbol).toUpperCase(),
                },
                timeframe: String(timeframe).toUpperCase(),
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
                entrySignal: {
                    include: {
                        candle: true
                    }
                },
                exitSignal: {
                    include: {
                        candle: true
                    }
                },
            },
            orderBy: {
                entrySignal: {
                    candle: {
                        time: 'asc'
                    }
                }
            }
        });

        // O frontend espera um objeto com a propriedade 'data'
        res.status(200).json({ ok: true, data: trades });
    } catch (e: any) {
        console.error("[/api/trades] erro:", e?.message || String(e));
        res.status(500).json({ ok: false, error: "Erro interno do servidor" });
    }
});

export default router;