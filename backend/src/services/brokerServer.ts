/* eslint-disable no-console */
// Microservidor EXEC + BACKTEST (FRONT ↔ MT5 + backtest endpoints)

import express from "express";
import http from "http";

// ===== EXEC: persistência mínima em memória =====
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

/* --------- CORS básico --------- */
app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
});

/* --------- JSON/body --------- */
app.use(express.json({ limit: "2mb" }));

/* --------- Helpers --------- */
const ok = (data: any = {}) => ({ ok: true, ...data });
const bad = (error: string, extra?: any) => ({ ok: false, error, ...(extra ? { extra } : {}) });

/* --------- Raiz / version --------- */
app.get("/", (_req, res) => {
    res.status(200).json(
        ok({
            service: "exec-broker+backtest",
            version: "brokerServer:v1.5 (no PORT clash)",
            enabled: isEnabled(),
            now: new Date().toISOString(),
            endpoints: [
                // EXEC
                "GET  /enable?on=1|0",
                "POST /enqueue  {agentId, tasks:[...]}",
                "POST /poll     {agentId, max}  | ?noop=1",
                "POST /ack      {agentId, done:[{id,ok,ticket?,error?}]}",
                "GET  /debug/peek?agentId=...",
                "GET  /debug/stats",
                "GET  /debug/history?agentId=...&limit=100",
                // BACKTEST (sob /api)
                "GET  /api/backtest/ping",
                "GET  /api/backtest/version",
                "GET  /api/backtest/health?symbol=...&timeframe=...&from=...&to=...",
                "POST /api/backtest  { symbol, timeframe, ... }",
                "GET  /api/backtest/runs",
                "GET  /api/backtest/run/:id",
            ],
        })
    );
});

app.get("/version", (_req, res) => {
    res.status(200).json(ok({ service: "exec-broker+backtest", now: new Date().toISOString() }));
});

// Healthcheck simples (útil p/ curl)
app.get("/healthz", (_req, res) => {
    res.status(200).json(ok({ service: "exec-broker", enabled: isEnabled() }));
});

/* =======================
   EXEC (MT5 NodeBridgeEA)
   ======================= */
app.get("/enable", (req, res) => {
    const raw = req.query?.on as string | undefined;
    const next = raw == null ? true : raw === "1" || raw.toLowerCase() === "true";
    const val = setEnabled(next);
    res.status(200).json(ok({ enabled: val }));
});

app.post("/enqueue", (req, res) => {
    try {
        const body = req.body || {};
        const agentId = String(body.agentId || "mt5-ea-1").trim();
        const tasks = Array.isArray(body.tasks) ? body.tasks : [];
        if (!agentId) return res.status(200).json(bad("faltou agentId"));
        if (!tasks.length) return res.status(200).json(bad("tasks vazio"));
        const r = enqueue(agentId, tasks); // aceita mesmo com enabled=false
        return res.status(200).json(ok({ agentId, ...r }));
    } catch (e: any) {
        return res.status(200).json(bad("unexpected", { message: e?.message || String(e) }));
    }
});

app.post("/poll", (req, res) => {
    try {
        if (String(req.query?.noop || "") === "1") {
            return res.status(200).json(ok({ noop: true }));
        }
        const body = req.body || {};
        const agentId = String(body.agentId || "mt5-ea-1").trim();
        const max = Number(body.max || 10);
        if (!agentId) return res.status(200).json(bad("faltou agentId"));
        if (!isEnabled()) return res.status(200).json(ok({ agentId, tasks: [] }));
        const { tasks } = pollPersist(agentId, Math.max(0, max));
        return res.status(200).json(ok({ agentId, tasks }));
    } catch (e: any) {
        return res.status(200).json(bad("unexpected", { message: e?.message || String(e) }));
    }
});

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

app.get("/debug/peek", (req, res) => {
    try {
        const agentId = String(req.query?.agentId || "mt5-ea-1").trim();
        const r = peek(agentId, 50);
        return res.status(200).json(ok({ agentId, pending: r.pending, tasks: r.tasks }));
    } catch (e: any) {
        return res.status(200).json(bad("unexpected", { message: e?.message || String(e) }));
    }
});

app.get("/debug/stats", (_req, res) => {
    try {
        return res.status(200).json(ok(getStats()));
    } catch (e: any) {
        return res.status(200).json(bad("unexpected", { message: e?.message || String(e) }));
    }
});

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

/* =======================
   BACKTEST (montado em /api)
   ======================= */

// 1) Ponto de diagnóstico rápido (sempre existe)
app.get("/api/backtest/ping", (_req, res) => res.status(200).json(ok({ ping: "pong" })));

// 2) Tenta montar o router do backtest em /api a partir de múltiplas origens
(function mountBacktest() {
    type MaybeRouter = any;
    const candidates: string[] = [
        "../routes/backtest", // caminho original
        "./routes/backtest",
        "../backtest",
        "./backtest",
    ];

    let mounted = false;
    for (const modPath of candidates) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const mod: MaybeRouter = require(modPath);
            const r: MaybeRouter = mod?.default ?? mod?.router ?? mod;
            if (r && typeof r === "function" && (r as any).use) {
                app.use("/api", r); // => /api/backtest, /api/backtest/health, etc.
                app.use("/", r);    // alias extra: /backtest também funciona
                console.log(`[EXEC+BT] Backtest router montado de '${modPath}' em '/api' (e alias '/')`);
                mounted = true;
                break;
            }
        } catch {
            // tenta próximo
        }
    }

    if (!mounted) {
        console.warn("[EXEC+BT] AVISO: não achei router do backtest; ativando stubs para evitar 404.");
        app.get("/api/backtest/version", (_req, res) =>
            res.status(200).json(ok({ service: "backtest-stub", note: "router não montado", now: new Date().toISOString() }))
        );
        app.all("/api/backtest", (_req, res) => res.status(501).json(bad("backtest router não montado")));
    }
})();

// 3) Stubs p/ painel de runs (evitam 404 até você persistir execuções)
app.get("/api/backtest/runs", (_req, res) => res.status(200).json(ok({ items: [], count: 0 })));
app.get("/api/backtest/run/:id", (req, res) => {
    const id = String(req.params?.id || "");
    res.status(200).json(bad(`run '${id}' não encontrado`));
});

/* --------- Start (PORTA PRÓPRIA DO BROKER) --------- */
// ⚠️ NÃO usar process.env.PORT aqui para não colidir com o servidor principal/front.
// Ordem de precedência: BROKER_HTTP_PORT > EXEC_PORT > 3005 (default do broker)
const PORT = Number(process.env.BROKER_HTTP_PORT || process.env.EXEC_PORT || 3005);
const server = http.createServer(app);

server.on("error", (err: any) => {
    if (err?.code === "EADDRINUSE") {
        console.warn(`[EXEC+BT] porta ${PORT} ocupada — desativando broker sem derrubar o processo.`);
        console.warn(`[EXEC+BT] Dica: defina BROKER_HTTP_PORT=3005 (ou outra livre).`);
        // Não relança: só não inicia o broker; o restante da app (se importado) continua vivo.
        return;
    }
    console.error("[EXEC+BT] erro ao subir broker:", err?.message || err);
});

server.listen(PORT, () => {
    console.log(`[EXEC+BT] listening on http://127.0.0.1:${PORT}  enabled=${isEnabled() ? "Y" : "N"}`);
});

export { };
