// src/logs.ts
export type LogEvent = {
    ts: number;                       // Date.now()
    level: 'info' | 'warn' | 'error';
    tag: string;                      // ex: 'enqueue','poll','ack','notify:order_ok'
    msg: string;
    taskId?: string;
    agentId?: string;
    orderId?: string;
    dealId?: string;
    data?: any;
};

const MAX_PER_TASK = 300;

const taskLogs = new Map<string, LogEvent[]>();
const orderToTask = new Map<string, string>(); // opcional (index por orderId)

export function addLog(ev: LogEvent) {
    // index por orderId -> taskId (quando houver)
    if (ev.orderId && ev.taskId) orderToTask.set(ev.orderId, ev.taskId);

    // só registramos se houver taskId (o modal consulta por taskId)
    if (!ev.taskId) return;

    const arr = taskLogs.get(ev.taskId) ?? [];
    arr.push(ev);
    if (arr.length > MAX_PER_TASK) arr.splice(0, arr.length - MAX_PER_TASK);
    taskLogs.set(ev.taskId, arr);
}

export function getLogsByTask(taskId: string): LogEvent[] {
    return (taskLogs.get(taskId) ?? []).slice().sort((a, b) => a.ts - b.ts);
}

export function getTaskIdByOrder(orderId: string): string | undefined {
    return orderToTask.get(orderId);
}
