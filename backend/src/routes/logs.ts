// src/routes/logs.ts
import { Router } from 'express';
import { getLogsByTask, getTaskIdByOrder } from '../logs';

const r = Router();

/**
 * GET /logs/by-task/:taskId
 * Retorna timeline de logs daquela task.
 */
r.get('/by-task/:taskId', (req, res) => {
    const { taskId } = req.params;
    if (!taskId) return res.status(400).json({ ok: false, error: 'missing_taskId' });
    const rows = getLogsByTask(taskId);
    res.json({ ok: true, logs: rows });
});

/**
 * GET /logs/by-order/:orderId
 * (opcional) Resolve taskId a partir de orderId e retorna os logs.
 */
r.get('/by-order/:orderId', (req, res) => {
    const { orderId } = req.params;
    if (!orderId) return res.status(400).json({ ok: false, error: 'missing_orderId' });
    const taskId = getTaskIdByOrder(orderId);
    if (!taskId) return res.json({ ok: false, reason: 'not_found' });
    const rows = getLogsByTask(taskId);
    res.json({ ok: true, taskId, logs: rows });
});

export default r;
