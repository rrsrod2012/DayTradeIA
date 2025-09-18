// backend/src/mt5-server.ts
// Microservidor Express para fila MT5 (porta 3002)
// Rodar: npx tsx src/mt5-server.ts

import express from "express";
import cors from "cors";
import bodyParser from "body-parser";

const app = express();
const PORT = Number(process.env.MT5_PORT || 3002);

app.use(cors());
app.use(bodyParser.json({ limit: "1mb" }));

type Task = {
    id: string;
    symbol: string;
    timeframe: string;
    side: "BUY" | "SELL";
    time: string; // ISO
    price?: number | null;
    volume?: number | null;
    slPoints?: number | null;
    tpPoints?: number | null;
    beAtPoints?: number | null;
    beOffsetPoints?: number | null;
    comment?: string | null;
};

let ENABLED = false;
const QUEUE: Task[] = [];
const SEEN = new Set<string>(); // dedupe por id

app.get("/config", (_req, res) => {
    res.json({ ok: true, enabled: ENABLED, queueSize: QUEUE.length });
});

app.post("/enable", (req, res) => {
    ENABLED = !!req.body?.enabled;
    res.json({ ok: true, enabled: ENABLED });
});

app.post("/enqueue", (req, res) => {
    const tasks: Task[] = Array.isArray(req.body?.tasks) ? req.body.tasks : [];
    if (!ENABLED) return res.status(400).json({ ok: false, error: "disabled" });

    let queued = 0;
    for (const t of tasks) {
        if (!t || !t.id) continue;
        if (SEEN.has(t.id)) continue;
        SEEN.add(t.id);
        QUEUE.push(t);
        queued++;
    }
    res.json({ ok: true, queued, pending: QUEUE.length });
});

app.post("/poll", (req, res) => {
    if (!ENABLED) return res.json({ ok: true, tasks: [] });
    const max = Math.max(1, Math.min(50, Number(req.body?.max || 10)));
    const batch: Task[] = [];
    while (batch.length < max && QUEUE.length > 0) {
        const t = QUEUE.shift()!;
        batch.push(t);
    }
    res.json({ ok: true, tasks: batch });
});

app.post("/ack", (req, res) => {
    // opcionalmente poderíamos remover do SEEN para permitir reenfileirar no futuro (outro dia)
    res.json({ ok: true });
});

app.get("/health", (_req, res) => {
    res.json({ ok: true, enabled: ENABLED, queue: QUEUE.length, seen: SEEN.size });
});

app.listen(PORT, () => {
    console.log(`[mt5-server] listening on http://localhost:${PORT}`);
});
