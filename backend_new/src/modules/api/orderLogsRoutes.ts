// ===============================
// FILE: backend_new/src/modules/api/orderLogsRoutes.ts
// ===============================
import { Router, Request, Response } from 'express';
import { prisma } from '../../core/prisma';
import { logger } from '../../core/logger';

const router = Router();

router.get('/order-logs', async (req: Request, res: Response) => {
    try {
        const keyRaw = String(req.query.taskId ?? req.query.key ?? req.query.id ?? "").trim();
        const limit = req.query.limit ? Math.min(1000, Math.max(1, Number(req.query.limit))) : 300;
        
        if (!keyRaw) {
            return res.status(400).json({ ok: false, error: "Faltou 'taskId' (ou 'key')" });
        }

        // No schema unificado, BrokerExecution é a tabela principal para logs
        const rows = await prisma.brokerExecution.findMany({
            where: {
                taskId: keyRaw,
            },
            orderBy: { createdAt: 'asc' },
            take: limit,
        });

        // Normaliza a saída para o formato que o frontend espera (OrderLogEntry)
        const logs = rows.map((r: any) => ({
            at: r.createdAt ? new Date(r.createdAt).toISOString() : (r.time ? new Date(r.time).toISOString() : null),
            taskId: r.taskId ?? keyRaw,
            entrySignalId: r.entrySignalId ?? null,
            level: r.level || r.status || "info",
            type: r.type || r.eventType || r.kind || null,
            message: r.message || r.text || r.msg || r.description || null,
            data: r.raw ? (() => { try { return JSON.parse(r.raw); } catch { return r.raw; } })() : null,
            symbol: r.symbol || r.instrument || null,
            price: Number.isFinite(Number(r.price)) ? Number(r.price) : null,
            brokerOrderId: r.brokerOrderId ?? r.orderId ?? r.ticket ?? null,
        }));

        res.json({
            ok: true,
            key: keyRaw,
            modelUsed: 'BrokerExecution',
            count: logs.length,
            logs,
        });

    } catch (e: any) {
        logger.error("[/api/order-logs] erro", { message: e?.message || e });
        res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
});

export const orderLogsRoutes = router;