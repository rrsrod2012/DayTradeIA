// backend/src/mt5-server.ts
// Rodar:  npx tsx src/mt5-server.ts
// Node 18+

import express from "express";
import cors from "cors";
import bodyParser from "body-parser";

const app = express();
const PORT = Number(process.env.MT5_PORT || 3002);

app.use(cors());
app.use(bodyParser.json({ limit: "1mb" }));

// --- Logger simples de requisições (método, path, status, ms, ip) ---
app.use((req, res, next) => {
    const t0 = Date.now();
    const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || req.ip || "").toString();
    res.on("finish", () => {
        const ms = Date.now() - t0;
        console.log(`[mt5-server] ${ip} ${req.method} ${req.path} -> ${res.statusCode} ${ms}ms`);
    });
    next();
});

type Side = "BUY" | "SELL";

type Task = {
    id: string;
    symbol?: string | null;
    timeframe?: string | null;
    side: Side;
    time?: string | null;  // ISO
    price?: number | null;
    volume?: number | null;
    slPoints?: number | null;
    tpPoints?: number | null;
    beAtPoints?: number | null;
    beOffsetPoints?: number | null;
    comment?: string | null;
    agentId?: string | null;
};

// ---------- estado ----------
const QUEUES: Map<string, Task[]> = new Map();  // fila por agentId
const SEEN: Set<string> = new Set();            // dedupe global por id

// métricas/telemetria (por agentId)
type AgentStats = {
    polls: number;
    lastTs: number;        // timestamp do último /poll
    lastServed: number;    // quantas tasks servidas no último /poll
    lastPending: number;   // quantas tasks restaram após o último /poll
};
const STATS: Map<string, AgentStats> = new Map();

// histórico de tasks servidas (por agentId)
const HISTORY: Map<string, Task[]> = new Map();
const MAX_HISTORY = 200;

function truthy(v: any): boolean {
    if (typeof v === "boolean") return v;
    const s = String(v ?? "").trim().toLowerCase();
    return s === "1" || s === "true" || s === "on" || s === "yes" || s === "y";
}

// habilitado por default, pode ser controlado por env
let ENABLED = truthy(process.env.MT5_ENABLED ?? process.env.EXEC_ENABLED ?? "1");

// util: pega fila do agente
function q(agentId: string) {
    if (!QUEUES.has(agentId)) QUEUES.set(agentId, []);
    return QUEUES.get(agentId)!;
}

function hist(agentId: string) {
    if (!HISTORY.has(agentId)) HISTORY.set(agentId, []);
    return HISTORY.get(agentId)!;
}

function stat(agentId: string) {
    if (!STATS.has(agentId)) STATS.set(agentId, { polls: 0, lastTs: 0, lastServed: 0, lastPending: q(agentId).length });
    return STATS.get(agentId)!;
}

// -------------------- normalização do enqueue --------------------
function normalizeEnqueueBody(body: any): { agentId: string; tasks: Task[] } {
    const agentId = (body?.agentId as string) || "mt5-ea-1";

    // formatos aceitos:
    // 1) { tasks: [ { id, side, ... } ] }
    // 2) { id, side, ... }  (objeto único)
    // 3) { task: { ... } }
    // 4) { side: "BUY"|"SELL", ... } (gera id)
    let tasks: Task[] = [];

    if (Array.isArray(body?.tasks)) {
        tasks = body.tasks as Task[];
    } else if (body?.task && typeof body.task === "object") {
        tasks = [body.task as Task];
    } else if (body && typeof body === "object" && (body.id || body.side)) {
        tasks = [body as Task];
    }

    tasks = tasks
        .map((t: any) => {
            let id = t?.id as string;
            const side = String(t?.side || "").toUpperCase();
            if (!id) id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            if (side !== "BUY" && side !== "SELL") return null;
            const task: Task = {
                id,
                side: side as Side,
                symbol: t?.symbol ?? null,
                timeframe: t?.timeframe ?? null,
                time: t?.time ?? null,
                price: t?.price ?? null,
                volume: t?.volume ?? 1,
                slPoints: t?.slPoints ?? null,
                tpPoints: t?.tpPoints ?? null,
                beAtPoints: t?.beAtPoints ?? null,
                beOffsetPoints: t?.beOffsetPoints ?? null,
                comment: t?.comment ?? null,
                agentId,
            };
            return task;
        })
        .filter(Boolean) as Task[];

    return { agentId, tasks };
}

// -------------------- rotas util --------------------
function queuesSummary() {
    const out: Record<string, number> = {};
    for (const [agent, arr] of QUEUES.entries()) out[agent] = arr.length;
    return out;
}

app.get("/", (_req, res) => {
    const total = Array.from(QUEUES.values()).reduce((acc, arr) => acc + arr.length, 0);
    res.json({ ok: true, enabled: ENABLED, queues: QUEUES.size, pending: total, perAgent: queuesSummary() });
});

app.get("/health", (_req, res) => {
    const total = Array.from(QUEUES.values()).reduce((acc, arr) => acc + arr.length, 0);
    res.json({ ok: true, enabled: ENABLED, queues: QUEUES.size, pending: total, seen: SEEN.size, perAgent: queuesSummary() });
});

app.get("/ping", (_req, res) => res.json({ ok: true, pong: Date.now() }));

app.get("/config", (_req, res) => {
    const total = Array.from(QUEUES.values()).reduce((acc, arr) => acc + arr.length, 0);
    res.json({ ok: true, enabled: ENABLED, queues: QUEUES.size, pending: total, perAgent: queuesSummary() });
});

// -------- enable/disable (GET e POST; aceita on/enabled) --------
function readEnableFlag(req: express.Request): boolean | undefined {
    if (req.body && typeof req.body === "object") {
        if ("enabled" in req.body) return truthy((req.body as any).enabled);
        if ("on" in req.body) return truthy((req.body as any).on);
    }
    if ("enabled" in req.query) return truthy(req.query.enabled);
    if ("on" in req.query) return truthy(req.query.on);
    return undefined; // sem parâmetro -> alterna
}

function enableHandler(req: express.Request, res: express.Response) {
    const want = readEnableFlag(req);
    ENABLED = (want === undefined) ? !ENABLED : want;
    console.log(`[mt5-server] EXEC ${ENABLED ? "ENABLED" : "DISABLED"} via ${req.method} ${req.path}`);
    res.json({ ok: true, enabled: ENABLED });
}

app.post("/enable", enableHandler);
app.get("/enable", enableHandler);
// aliases
app.post("/exec/enable", enableHandler);
app.get("/exec/enable", enableHandler);

// -------- reset filas (para testes) --------
app.post("/reset", (_req, res) => {
    QUEUES.clear();
    SEEN.clear();
    STATS.clear();
    HISTORY.clear();
    console.log("[mt5-server] RESET queues & seen & stats & history");
    res.json({ ok: true });
});

// -------- ENQUEUE (POST JSON) --------
function enqueueHandler(req: express.Request, res: express.Response) {
    if (!ENABLED) {
        console.warn("[mt5-server] ENQUEUE rejected (disabled)");
        return res.status(400).json({ ok: false, error: "disabled" });
    }

    const { agentId, tasks } = normalizeEnqueueBody(req.body || {});
    if (!tasks.length) {
        console.warn("[mt5-server] ENQUEUE rejected (no tasks)");
        return res.status(400).json({ ok: false, error: "no tasks" });
    }

    let queued = 0;
    const bucket = q(agentId);
    for (const t of tasks) {
        if (SEEN.has(t.id)) continue;
        SEEN.add(t.id);
        bucket.push(t);
        queued++;
    }
    console.log(`[mt5-server] ENQUEUE agent=${agentId} add=${queued} pending=${bucket.length}`);
    return res.json({ ok: true, agentId, queued, pending: bucket.length });
}
app.post("/enqueue", enqueueHandler);
app.post("/api/enqueue", enqueueHandler);
app.post("/api/mt5/enqueue", enqueueHandler);
app.post("/exec/enqueue", enqueueHandler);
app.post("/task/enqueue", enqueueHandler);

// -------- ENQUEUE (GET debug: /enqueue?side=BUY&agentId=...&beAtPoints=10&beOffsetPoints=0) --------
app.get("/enqueue", (req, res) => {
    if (!ENABLED) return res.status(400).json({ ok: false, error: "disabled" });

    const agentId = String(req.query.agentId || "mt5-ea-1");
    const side = String(req.query.side || "").toUpperCase();
    if (side !== "BUY" && side !== "SELL") {
        return res.status(400).json({ ok: false, error: "bad side" });
    }
    const beAtPoints = req.query.beAtPoints != null ? Number(req.query.beAtPoints) : null;
    const beOffsetPoints = req.query.beOffsetPoints != null ? Number(req.query.beOffsetPoints) : null;

    const task: Task = {
        id: `debug-${Date.now()}`,
        side: side as Side,
        comment: "debug via GET",
        beAtPoints,
        beOffsetPoints,
        symbol: null,
        timeframe: null,
        time: null,
        price: null,
        volume: 1,
        slPoints: null,
        tpPoints: null,
        agentId,
    };
    const bucket = q(agentId);
    if (!SEEN.has(task.id)) {
        SEEN.add(task.id);
        bucket.push(task);
    }
    console.log(`[mt5-server] ENQUEUE (GET) agent=${agentId} side=${side} pending=${bucket.length}`);
    res.json({ ok: true, agentId, queued: 1, pending: bucket.length, task });
});

// -------- POLL (EA -> server) --------
// aceita query ?noop=1 para não drenar, mas retornar as próximas tasks.
app.post("/poll", (req, res) => {
    const agentId = (req.body?.agentId as string) || "mt5-ea-1";
    const max = Math.max(1, Math.min(50, Number(req.body?.max ?? 10)));
    const noop = truthy((req.query?.noop as any) ?? false);

    const bucket = q(agentId);
    const before = bucket.length;

    let batch: Task[] = [];
    if (ENABLED) {
        if (noop) {
            batch = bucket.slice(0, max); // não drena
        } else {
            while (batch.length < max && bucket.length > 0) batch.push(bucket.shift()!);
            // registra histórico
            if (batch.length > 0) {
                const h = hist(agentId);
                h.push(...batch);
                if (h.length > MAX_HISTORY) h.splice(0, h.length - MAX_HISTORY);
            }
        }
    }

    const after = bucket.length;
    const servedIds = batch.map(t => t.id);

    // atualiza métricas
    const s = stat(agentId);
    s.polls += 1;
    s.lastTs = Date.now();
    s.lastServed = noop ? 0 : batch.length;
    s.lastPending = after;

    console.log(`[mt5-server] POLL agent=${agentId} noop=${noop} max=${max} served=${noop ? 0 : batch.length} pending=${after} (was ${before})`);

    return res.json({
        ok: true,
        agentId,
        noop,
        served: noop ? 0 : batch.length,
        pendingBefore: before,
        pendingAfter: after,
        servedIds,
        echo: { agentId, max },
        tasks: batch.map(t => ({
            id: t.id,
            side: t.side,
            comment: t.comment ?? "",
            beAtPoints: t.beAtPoints ?? null,
            beOffsetPoints: t.beOffsetPoints ?? null,
            // extras (não atrapalham o EA):
            symbol: t.symbol ?? null,
            timeframe: t.timeframe ?? null,
            time: t.time ?? null,
            price: t.price ?? null,
            volume: t.volume ?? null,
            slPoints: t.slPoints ?? null,
            tpPoints: t.tpPoints ?? null,
        })),
    });
});

// -------- ACK --------
app.post("/ack", (req, res) => {
    const received = Array.isArray(req.body?.done) ? req.body.done.length : 0;
    console.log(`[mt5-server] ACK received=${received}`);
    res.json({ ok: true, received });
});

// -------- DEBUG: peek fila corrente --------
app.get("/debug/peek", (req, res) => {
    const agentId = String(req.query.agentId || "mt5-ea-1");
    const bucket = q(agentId);
    res.json({ ok: true, agentId, pending: bucket.length, tasks: bucket });
});

// -------- DEBUG: métricas --------
app.get("/debug/stats", (_req, res) => {
    const agents: Record<string, AgentStats> = {};
    for (const [k, v] of STATS.entries()) agents[k] = v;
    res.json({ ok: true, enabled: ENABLED, agents });
});

// -------- DEBUG: histórico de tasks servidas --------
app.get("/debug/history", (req, res) => {
    const agentId = String(req.query.agentId || "mt5-ea-1");
    const h = hist(agentId);
    res.json({ ok: true, agentId, count: h.length, items: h });
});

app.listen(PORT, () => {
    console.log(`[mt5-server] listening on http://127.0.0.1:${PORT} (enabled=${ENABLED})`);
});
