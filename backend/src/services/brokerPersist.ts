// src/services/brokerPersist.ts
// Persistência mínima em memória para o brokerServer

type Task = {
    id: string;
    side: "BUY" | "SELL";
    comment?: string;
    symbol?: string;
    timeframe?: any;
    time?: any;
    price?: number;
    volume?: number;
    slPoints?: number | null;
    tpPoints?: number | null;
    beAtPoints?: number | null;
    beOffsetPoints?: number | null;
};

type Enqueued = Task & { enqueuedAt: number };

type DoneItem = {
    id: string;
    ok: boolean;
    ticket?: string;
    error?: string;
    ts: number;
    agentId: string;
};

type AgentStats = {
    polls: number;
    lastTs: number;       // epoch ms do último /poll
    lastServed: number;   // quantas tasks servidas no último /poll
    lastPending: number;  // quantas ficaram pendentes após o /poll
};

type State = {
    enabled: boolean;
    queues: Record<string, Enqueued[]>;
    history: Record<string, DoneItem[]>;
    agents: Record<string, AgentStats>;
};

const state: State = {
    enabled: true,
    queues: Object.create(null),
    history: Object.create(null),
    agents: Object.create(null),
};

function ensureAgent(agentId: string) {
    if (!state.queues[agentId]) state.queues[agentId] = [];
    if (!state.history[agentId]) state.history[agentId] = [];
    if (!state.agents[agentId]) {
        state.agents[agentId] = { polls: 0, lastTs: 0, lastServed: 0, lastPending: 0 };
    }
}

export function setEnabled(on?: boolean) {
    state.enabled = on === undefined ? true : !!on;
    return state.enabled;
}
export function isEnabled() {
    return state.enabled;
}

export function enqueue(agentId: string, tasks: Task[]) {
    ensureAgent(agentId);
    const now = Date.now();
    const arr: Enqueued[] = tasks.map((t) => ({ ...t, enqueuedAt: now }));
    state.queues[agentId].push(...arr);
    return { queued: arr.length, pending: state.queues[agentId].length };
}

export function poll(agentId: string, max = 10) {
    ensureAgent(agentId);
    const q = state.queues[agentId];
    const n = Math.max(0, Math.min(Number(max) || 0, q.length));
    const tasks = q.splice(0, n);
    // stats
    const st = state.agents[agentId];
    st.polls += 1;
    st.lastTs = Date.now();
    st.lastServed = tasks.length;
    st.lastPending = q.length;
    return { tasks };
}

export function ack(agentId: string, done: Array<{ id: string; ok: boolean; ticket?: string; error?: string }>) {
    ensureAgent(agentId);
    const now = Date.now();
    const hist = state.history[agentId];
    for (const d of done || []) {
        hist.push({
            id: String(d.id || ""),
            ok: !!d.ok,
            ticket: d.ticket || "",
            error: d.error || "",
            ts: now,
            agentId,
        });
    }
    // mantém histórico enxuto
    if (hist.length > 2000) {
        state.history[agentId] = hist.slice(hist.length - 1000);
    }
    return { saved: done?.length || 0, history: state.history[agentId].length };
}

export function getHistory(agentId: string, limit = 100) {
    ensureAgent(agentId);
    const hist = state.history[agentId] || [];
    const arr = hist.slice(-Math.max(1, limit)).reverse();
    return { agentId, count: arr.length, items: arr };
}

export function getStats() {
    return { enabled: state.enabled, agents: state.agents };
}

// opcional: para debug/integração
export function peek(agentId: string, limit = 50) {
    ensureAgent(agentId);
    const q = state.queues[agentId] || [];
    return { agentId, pending: q.length, tasks: q.slice(0, Math.max(1, limit)) };
}

// default export (se preferir importar como default)
export default {
    setEnabled,
    isEnabled,
    enqueue,
    poll,
    ack,
    getHistory,
    getStats,
    peek,
};
