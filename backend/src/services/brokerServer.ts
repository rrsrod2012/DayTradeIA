/* eslint-disable no-console */
// Microservidor EXEC para integração FRONT ↔ MT5 (NodeBridgeEA)
// Endpoints principais: /enqueue, /poll, /ack, /enable, /debug/*

import express from "express";
import http from "http";

// Persistência mínima em memória (fornecida em ./brokerPersist.ts)
import {
    setEnabled,
    isEnabled,
    enqueue,
    poll as pollPersist,
    ack as ackPersist,
    getHistory,
    getStats,
    peek,
} from "./brokerPersist";

const app = express();

// --------- CORS básico (sem dependências externas) ---------
app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
        "Access-Control-Allow-Methods",
        "GET,POST,OPTIONS"
    );
    res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Accept"
    );
    if (req.method === "OPTIONS") {
        res.status(204).end();
        return;
    }
    next();
});

// --------- JSON/body ---------
app.use(express.json({ limit: "1mb" }));

// --------- Helpers de resposta ---------
function ok(data: any = {}) {
    return { ok: true, ...data };
}
function bad(error: string, extra?: any) {
    return { ok: false, error, ...(extra ? { extra } : {}) };
}

// --------- Raiz / version ---------
app.get("/", (_req, res) => {
    res.status(200).json(
        ok({
            service: "exec-broker",
            version: "brokerServer:v1.0",
            enabled: isEnabled(),
            now: new Date().toISOString(),
            endpoints: [
                "GET  /enable?on=1|0",
                "POST /enqueue  {agentId, tasks:[...]}",
                "POST /poll     {agentId, max}  | ?noop=1",
                "POST /ack      {agentId, done:[{id,ok,ticket?,error?}]}",
                "GET  /debug/peek?agentId=...",
                "GET  /debug/stats",
                "GET  /debug/history?agentId=...&limit=100",
                "GET  /version",
            ],
        })
    );
});

app.get("/version", (_req, res) => {
    res.status(200).json(ok({ service: "exec-broker", now: new Date().toISOString() }));
});

// --------- Toggle de execução ---------
app.get("/enable", (req, res) => {
    const raw = req.query?.on as string | undefined;
    const next = raw == null ? true : raw === "1" || raw.toLowerCase() === "true";
    const val = setEnabled(next);
    res.status(200).json(ok({ enabled: val }));
});

// --------- Enfileirar ordens ---------
app.post("/enqueue", (req, res) => {
    try {
        const body = req.body || {};
        const agentId = String(body.agentId || "mt5-ea-1").trim();
        const tasks = Array.isArray(body.tasks) ? body.tasks : [];

        if (!agentId) return res.status(200).json(bad("faltou agentId"));
        if (!tasks.length) return res.status(200).json(bad("tasks vazio"));

        // Mesmo com enabled=false, aceitamos enqueue (assim você pode ligar depois)
        const r = enqueue(agentId, tasks);
        return res.status(200).json(ok({ agentId, ...r }));
    } catch (e: any) {
        return res.status(200).json(bad("unexpected", { message: e?.message || String(e) }));
    }
});

// --------- Poll (EA busca tarefas) ---------
app.post("/poll", (req, res) => {
    try {
        // Se chamado como noop pelo front, só responde ok (telemetria)
        if (String(req.query?.noop || "") === "1") {
            return res.status(200).json(ok({ noop: true }));
        }

        const body = req.body || {};
        const agentId = String(body.agentId || "mt5-ea-1").trim();
        const max = Number(body.max || 10);

        if (!agentId) return res.status(200).json(bad("faltou agentId"));

        if (!isEnabled()) {
            // Execução pausada → responde vazio (EA não opera)
            return res.status(200).json(ok({ agentId, tasks: [] }));
        }

        const { tasks } = pollPersist(agentId, Math.max(0, max));
        return res.status(200).json(ok({ agentId, tasks }));
    } catch (e: any) {
        return res.status(200).json(bad("unexpected", { message: e?.message || String(e) }));
    }
});

// --------- ACK (EA confirma execução) ---------
app.post("/ack", (req, res) => {
    try {
        const body = req.body || {};
        const agentId = String(body.agentId || "mt5-ea-1").trim();
        const done = Array.isArray(body.done) ? body.done : [];

        if (!agentId) return res.status(200).json(bad("faltou agentId"));
        if (!done.length) return res.status(200).json(bad("done vazio"));

        const r = ackPersist(agentId, done);
        return res.status(200).json(ok({ agentId, ...r }));
    } catch (e: any) {
        return res.status(200).json(bad("unexpected", { message: e?.message || String(e) }));
    }
});

// --------- Debug/peek ---------
app.get("/debug/peek", (req, res) => {
    try {
        const agentId = String(req.query?.agentId || "mt5-ea-1").trim();
        const r = peek(agentId, 50);
        return res.status(200).json(ok({ agentId, pending: r.pending, tasks: r.tasks }));
    } catch (e: any) {
        return res.status(200).json(bad("unexpected", { message: e?.message || String(e) }));
    }
});

// --------- Debug/stats ---------
app.get("/debug/stats", (_req, res) => {
    try {
        const s = getStats();
        return res.status(200).json(ok(s));
    } catch (e: any) {
        return res.status(200).json(bad("unexpected", { message: e?.message || String(e) }));
    }
});

// --------- Debug/history ---------
app.get("/debug/history", (req, res) => {
    try {
        const agentId = String(req.query?.agentId || "mt5-ea-1").trim();
        const limit = Number(req.query?.limit || 100);
        const r = getHistory(agentId, Math.max(1, Math.min(1000, limit)));
        return res.status(200).json(ok(r));
    } catch (e: any) {
        return res.status(200).json(bad("unexpected", { message: e?.message || String(e) }));
    }
});

// --------- Start ---------
const PORT = Number(process.env.EXEC_PORT || process.env.PORT || 3002);
const server = http.createServer(app);

server.listen(PORT, () => {
    console.log(`[EXEC] brokerServer listening on http://127.0.0.1:${PORT}  enabled=${isEnabled() ? "Y" : "N"}`);
});
