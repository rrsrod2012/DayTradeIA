import { Express } from 'express';
import { logger } from '../../core/logger';
import { eventBus, EVENTS } from '../../core/eventBus';

interface OrderTask {
    id: string;
    symbol: string;
    side: 'BUY' | 'SELL' | 'CLOSE';
    [key: string]: any;
}

let taskQueue: OrderTask[] = [];

export const enqueueOrder = (order: Omit<OrderTask, 'id'> & { id?: string }) => {
    const task: OrderTask = {
        id: order.id || `task-${Date.now()}`,
        ...order
    };
    taskQueue.push(task);
    logger.info(`Ordem adicionada à fila: ${task.id} (${task.side} ${task.symbol}). Fila agora com ${taskQueue.length} item(s).`);
    eventBus.emit(EVENTS.EXECUTE_TRADE, task);
};

export const initBrokerageBridge = (app: Express) => {
    // Endpoint para o MT5 buscar a próxima tarefa
    app.get('/broker/next-task', (req, res) => {
        const agentId = req.query.agentId || 'default';
        if (taskQueue.length > 0) {
            const task = taskQueue.shift();
            logger.info(`Entregando tarefa ${task!.id} para o agente ${agentId}`);
            res.json({ ok: true, task });
        } else {
            res.json({ ok: true, task: null });
        }
    });

    // Endpoint para limpar a fila (emergencial)
    app.post('/broker/clear-queue', (_req, res) => {
        logger.warn(`Limpando a fila de ordens, que continha ${taskQueue.length} item(s).`);
        taskQueue = [];
        res.json({ ok: true, cleared: true });
    });
    
    logger.info('✅ Ponte com a Corretora (Broker Bridge) inicializada.');
};