/* eslint-disable no-console */
// Microservidor EXEC + BACKTEST (FRONT ↔ MT5 + backtest endpoints)
// Agora pode ser montado dentro do servidor principal (mesmo processo/porta)
// ou executado em modo standalone via env BROKER_STANDALONE=1.

import express, { Application, Router } from "express";
import http from "http";
import fs from "fs";
import path from "path";

// ===== EXEC: persistência mínima em memória =====
import { persistAck, persistTask } from "./brokerPrisma";
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

/* --------- Helpers globais --------- */
const ok = (data: any = {}) => ({ ok: true, ...data });
const bad = (error: string, extra?: any) => ({ ok: false, error, ...(extra ? { extra } : {}) });

/* =========================================================================================
   Leitura defensiva da configuração “compartilhada” (mesmo store do AI-node)
   - Sem import fixo de módulos internos: lê o JSON gravado em MODEL_STORE/ui_runtime_config.json
   - Permite usar RR e BE como fallback quando a UI não enviar sl/tp/be nos tasks
   ========================================================================================= */
const MODEL_STORE =
    process.env.MODEL_STORE ||
    path.resolve(process.cwd(), "model_store");

const UI_CONFIG_FILE = path.join(MODEL_STORE, "ui_runtime_config.json");

type UiRuntimeConfig = Partial<{
    uiTimeframe: "M1" | "M5" | "M15" | "M30" | "H1";
    uiLots: number;
    rr: number;
    slAtr: number;
    beAtPts: number;
    beOffsetPts: number;
    entryDelayBars: number;
    decisionThreshold: number;
    debug: boolean;
}>;

function ensureDir(p: string) {
    try { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); } catch { }
}
ensureDir(MODEL_STORE);

function readJson<T>(file: string): T | null {
    try {
        const s = fs.readFileSync(file, "utf8");
        return JSON.parse(s) as T;
    } catch {
        return null;
    }
}

function readUiRuntimeConfig(): UiRuntimeConfig {
    const cfg = readJson<UiRuntimeConfig>(UI_CONFIG_FILE) || {};
    return cfg || {};
}

function applyTaskFallbacksFromConfig(task: any, cfg: UiRuntimeConfig) {
    // BE (break-even) — aplica quando não vier da UI
    if (task.beAtPoints == null && cfg.beAtPts != null) {
        task.beAtPoints = Number(cfg.beAtPts) || 0;
    }
    if (task.beOffsetPoints == null && cfg.beOffsetPts != null) {
        task.beOffsetPoints = Number(cfg.beOffsetPts) || 0;
    }

    // TP via RR como fallback: se SL>0 e TP não veio, tenta calcular TP = SL * RR
    const rr = Number(cfg.rr);
    const hasRR = Number.isFinite(rr) && rr > 0;
    if ((task.tpPoints == null || task.tpPoints === 0) && hasRR) {
        const sl = Number(task.slPoints);
        if (Number.isFinite(sl) && sl > 0) {
            task.tpPoints = Math.max(0, Math.round(sl * rr));
        }
    }

    // volume/lots: só usa como fallback se não vier nada
    if ((task.volume == null || task.volume <= 0) && cfg.uiLots != null) {
        const lots = Math.max(1, Math.floor(Number(cfg.uiLots) || 1));
        task.volume = lots;
    }

    return task;
}

/**
 * Cria e retorna um Router com todas as rotas do broker/backtest.
 * Esse Router pode ser montado em um app existente (ex.: app.use("/broker", router))
 * sem abrir porta própria.
 */
function createBrokerRouter(): Router {
    const router = Router();

    /* --------- CORS básico --------- */
    router.use((req, res, next) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
        if (req.method === "OPTIONS") return res.status(204).end();
        next();
    });

    /* --------- JSON/body --------- */
    router.use(express.json({ limit: "2mb" }));

    /* --------- Raiz / version --------- */
    router.get("/", (_req, res) => {
        res.status(200).json(
            ok({
                service: "exec-broker+backtest",
                version: "brokerServer:v2.1 (attach-friendly + UI-fallbacks)",
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

    router.get("/version", (_req, res) => {
        res.status(200).json(ok({ service: "exec-broker+backtest", now: new Date().toISOString() }));
    });

    // Healthcheck simples (útil p/ curl)
    router.get("/healthz", (_req, res) => {
        res.status(200).json(ok({ service: "exec-broker", enabled: isEnabled(), modelStore: MODEL_STORE, uiConfigFile: UI_CONFIG_FILE }));
    });

    /* =======================
       EXEC (MT5 NodeBridgeEA)
       ======================= */
    router.get("/enable", (req, res) => {
        const raw = req.query?.on as string | undefined;
        const next = raw == null ? true : raw === "1" || raw.toLowerCase() === "true";
        const val = setEnabled(next);
        res.status(200).json(ok({ enabled: val }));
    });

    router.post("/enqueue", async (req, res) => {
        try {
            const body = req.body || {};
            const agentId = String(body.agentId || "mt5-ea-1").trim();
            const tasks = Array.isArray(body.tasks) ? body.tasks : [];
            if (!agentId) return res.status(200).json(bad("faltou agentId"));
            if (!tasks.length) return res.status(200).json(bad("tasks vazio"));

            // ------- (NOVO) Fallbacks a partir do runtime compartilhado -------
            // Só aplica quando o campo não vier da UI. Mantém o que veio.
            const cfg = readUiRuntimeConfig();
            const patchedTasks = tasks.map((t) => {
                const copy = { ...t };
                return applyTaskFallbacksFromConfig(copy, cfg);
            });

            const r = enqueue(agentId, patchedTasks); // aceita mesmo com enabled=false

            // persist each task
            try {
                for (const t of patchedTasks) {
                    await persistTask(agentId, t);
                }
            } catch {
                /* ignore persist errors */
            }
            return res.status(200).json(ok({ agentId, ...r }));
        } catch (e: any) {
            return res.status(200).json(bad("unexpected", { message: e?.message || String(e) }));
        }
    });

    router.post("/poll", (req, res) => {
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

    router.post("/ack", async (req, res) => {
        try {
            const body = req.body || {};
            const agentId = String(body.agentId || "mt5-ea-1").trim();
            const done = Array.isArray(body.done) ? body.done : [];
            if (!agentId) return res.status(200).json(bad("faltou agentId"));
            if (!done.length) return res.status(200).json(bad("done vazio"));
            const r = ackPersist(agentId, done);
            try {
                await persistAck(agentId, done);
            } catch {
                /* ignore persist errors */
            }
            return res.status(200).json(ok({ agentId, ...r }));
        } catch (e: any) {
            return res.status(200).json(bad("unexpected", { message: e?.message || String(e) }));
        }
    });

    router.get("/debug/peek", (req, res) => {
        try {
            const agentId = String(req.query?.agentId || "mt5-ea-1").trim();
            const r = peek(agentId, 50);
            return res.status(200).json(ok({ agentId, pending: r.pending, tasks: r.tasks }));
        } catch (e: any) {
            return res.status(200).json(bad("unexpected", { message: e?.message || String(e) }));
        }
    });

    router.get("/debug/stats", (_req, res) => {
        try {
            return res.status(200).json(ok(getStats()));
        } catch (e: any) {
            return res.status(200).json(bad("unexpected", { message: e?.message || String(e) }));
        }
    });

    router.get("/debug/history", (req, res) => {
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
    router.get("/api/backtest/ping", (_req, res) => res.status(200).json(ok({ ping: "pong" })));

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
                    router.use("/api", r); // => /api/backtest, /api/backtest/health, etc.
                    router.use("/", r); // alias extra: /backtest também funciona (respeita prefixo quando anexado)
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
            router.get("/api/backtest/version", (_req, res) =>
                res
                    .status(200)
                    .json(ok({ service: "backtest-stub", note: "router não montado", now: new Date().toISOString() }))
            );
            router.all("/api/backtest", (_req, res) => res.status(501).json(bad("backtest router não montado")));
        }
    })();

    // 3) Stubs p/ painel de runs (evitam 404 até você persistir execuções)
    router.get("/api/backtest/runs", (_req, res) => res.status(200).json(ok({ items: [], count: 0 })));
    router.get("/api/backtest/run/:id", (req, res) => {
        const id = String(req.params?.id || "");
        res.status(200).json(bad(`run '${id}' não encontrado`));
    });

    return router;
}

/**
 * Anexa o broker/backtest a um app Express existente (mesmo processo/porta).
 * @param app Express Application do servidor principal.
 * @param basePath Caminho base para montar as rotas. Default: "/broker".
 *                 Ex.: "/broker" => endpoints ficam em /broker/..., /broker/api/...
 */
export function attachBrokerToApp(app: Application, basePath: string = "/broker") {
    const router = createBrokerRouter();
    app.use(basePath, router);
    console.log(`[EXEC+BT] Broker anexado ao app principal em '${basePath}' (sem abrir porta própria).`);
}

/* =========================================================================================
   Modo standalone (opcional): só inicia servidor próprio se BROKER_STANDALONE === "1".
   Mantém compatibilidade com sua execução anterior sem colidir com o backend principal.
   ========================================================================================= */
if (process.env.BROKER_STANDALONE === "1") {
    // Ordem de precedência: BROKER_HTTP_PORT > EXEC_PORT > 3002 (default do broker)
    const PORT = Number(process.env.BROKER_HTTP_PORT || process.env.EXEC_PORT || 3002);
    const appStandalone = express();
    appStandalone.use("/", createBrokerRouter());
    const server = http.createServer(appStandalone);

    server.on("error", (err: any) => {
        if (err?.code === "EADDRINUSE") {
            console.warn(`[EXEC+BT] porta ${PORT} ocupada — desativando broker standalone.`);
            console.warn(`[EXEC+BT] Dica: defina BROKER_HTTP_PORT=3003 (ou outra livre).`);
            return;
        }
        console.error("[EXEC+BT] erro ao subir broker standalone:", err?.message || err);
    });

    server.listen(PORT, () => {
        console.log(
            `[EXEC+BT] (standalone) listening on http://127.0.0.1:${PORT}  enabled=${isEnabled() ? "Y" : "N"}`
        );
    });
}

// Export default como conveniência (import attachBrokerToApp from "./brokerServer")
export default attachBrokerToApp;
