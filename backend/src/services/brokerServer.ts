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

// >>> ADIÇÃO: importar rotas de admin (runtime-config)
import adminRoutes from "../routes/admin";

// >>> ADIÇÃO: CORS para /admin e para o app standalone
import cors from "cors";

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

// >>> ARQUIVO de guarda do PnL diário (pontos) e estado do guard
const DAILY_GUARD_FILE = path.join(MODEL_STORE, "daily_guard.json");

type UiRuntimeConfig = Partial<{
    uiTimeframe: "M1" | "M5" | "M15" | "M30" | "H1";
    uiLots: number;
    rr: number;
    slAtr: number;
    beAtPts: number;
    beOffsetPts: number;
    entryDelayBars: number;
    decisionThreshold: number;
    // Limites diários
    dailyMaxLoss: number;        // ex.: -1000 (pontos)
    dailyProfitTarget: number;   // ex.:  2000 (pontos)
    limitMode: "block" | "conservative";
    debug: boolean;
}>;

type DailyGuard = {
    date: string;      // YYYY-MM-DD (local)
    pnlPoints: number; // acumulado do dia em pontos (positivo/negativo)
    pontosGanhos: number;   // soma apenas dos positivos
    pontosPerdidos: number; // soma apenas dos negativos (valor negativo)
};

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

function writeJson<T>(file: string, data: T) {
    try {
        fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
        return true;
    } catch {
        return false;
    }
}

function todayLocalISODate(): string {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}

function readUiRuntimeConfig(): UiRuntimeConfig {
    const cfg = readJson<UiRuntimeConfig>(UI_CONFIG_FILE) || {};
    return cfg || {};
}

// ======== Guard diário (arquivo) ========
function readDailyGuard(): DailyGuard {
    const stored = readJson<DailyGuard>(DAILY_GUARD_FILE);
    const today = todayLocalISODate();
    if (!stored || stored.date !== today) {
        const initial: DailyGuard = { date: today, pnlPoints: 0, pontosGanhos: 0, pontosPerdidos: 0 };
        writeJson(DAILY_GUARD_FILE, initial);
        return initial;
    }
    // Backward-compat: se vier sem campos novos
    if (stored.pontosGanhos == null || stored.pontosPerdidos == null) {
        const fixed: DailyGuard = {
            date: stored.date,
            pnlPoints: stored.pnlPoints || 0,
            pontosGanhos: stored.pontosGanhos ?? Math.max(0, stored.pnlPoints || 0),
            pontosPerdidos: stored.pontosPerdidos ?? Math.min(0, stored.pnlPoints || 0),
        };
        writeJson(DAILY_GUARD_FILE, fixed);
        return fixed;
    }
    return stored;
}

function addPnLToDailyGuard(deltaPoints: number): DailyGuard {
    const guard = readDailyGuard();
    const nextPnL = (guard.pnlPoints || 0) + (Number(deltaPoints) || 0);
    const ganhos = guard.pontosGanhos || 0;
    const perdas = guard.pontosPerdidos || 0;

    const updated: DailyGuard = {
        date: guard.date,
        pnlPoints: nextPnL,
        pontosGanhos: deltaPoints > 0 ? ganhos + deltaPoints : ganhos,
        pontosPerdidos: deltaPoints < 0 ? perdas + deltaPoints : perdas,
    };
    writeJson(DAILY_GUARD_FILE, updated);
    return updated;
}

function resetDailyGuard(): DailyGuard {
    const fresh: DailyGuard = { date: todayLocalISODate(), pnlPoints: 0, pontosGanhos: 0, pontosPerdidos: 0 };
    writeJson(DAILY_GUARD_FILE, fresh);
    return fresh;
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

// Checagem dos limites diários
function checkDailyLimits(cfg: UiRuntimeConfig) {
    const daily = readDailyGuard();
    const maxLoss = cfg.dailyMaxLoss;
    const profitTarget = cfg.dailyProfitTarget;
    const mode: "block" | "conservative" = (cfg.limitMode === "conservative" ? "conservative" : "block");

    const hitLoss = Number.isFinite(maxLoss as number) && daily.pnlPoints <= (maxLoss as number);
    const hitProfit = Number.isFinite(profitTarget as number) && daily.pnlPoints >= (profitTarget as number);

    return {
        mode,
        dailyPnL: daily.pnlPoints,
        pontosGanhos: daily.pontosGanhos,
        pontosPerdidos: daily.pontosPerdidos,
        hitLoss,
        hitProfit,
        maxLoss,
        profitTarget,
    };
}

// Extrai pontos de PnL de um item de ACK de forma resiliente
function extractPnLPointsFromAckItem(item: any): number {
    if (!item) return 0;
    const direct = Number(item.pnlPoints ?? item.points ?? item.profitPoints);
    if (Number.isFinite(direct)) return direct as number;

    const nested = item.pnl || item.profit || item.result;
    if (nested && Number.isFinite(Number(nested.points))) {
        return Number(nested.points);
    }
    return 0;
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
                version: "brokerServer:v2.3 (UI-fallbacks + daily-limits + ganhos/perdas)",
                enabled: isEnabled(),
                now: new Date().toISOString(),
                endpoints: [
                    // EXEC
                    "GET  /enable?on=1|0",
                    "POST /enqueue  {agentId, tasks:[...]}",
                    "POST /poll     {agentId, max}  | ?noop=1",
                    "POST /ack      {agentId, done:[{id,ok,ticket?,error?,pnlPoints?}]}",
                    "GET  /debug/peek?agentId=...",
                    "GET  /debug/stats",
                    "GET  /debug/history?agentId=...&limit=100",
                    // RISK
                    "GET  /risk/state",
                    "POST /risk/reset",
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
       RISK (paradas e metas)
       ======================= */
    router.get("/risk/state", (_req, res) => {
        try {
            const cfg = readUiRuntimeConfig();
            const state = checkDailyLimits(cfg);
            return res.status(200).json(ok(state));
        } catch (e: any) {
            return res.status(200).json(bad("unexpected", { message: e?.message || String(e) }));
        }
    });

    router.post("/risk/reset", (_req, res) => {
        try {
            const fresh = resetDailyGuard();
            return res.status(200).json(ok({ reset: true, state: fresh }));
        } catch (e: any) {
            return res.status(200).json(bad("unexpected", { message: e?.message || String(e) }));
        }
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

            // Fallbacks a partir do runtime compartilhado
            const cfg = readUiRuntimeConfig();

            // Checar limites diários ANTES de aceitar novas tarefas
            const risk = checkDailyLimits(cfg);
            if (risk.hitLoss || risk.hitProfit) {
                if (risk.mode === "block") {
                    const reason = risk.hitLoss ? "daily loss limit reached" : "daily profit target reached";
                    return res.status(200).json(
                        bad(reason, {
                            dailyPnL: risk.dailyPnL,
                            pontosGanhos: risk.pontosGanhos,
                            pontosPerdidos: risk.pontosPerdidos,
                            dailyMaxLoss: risk.maxLoss,
                            dailyProfitTarget: risk.profitTarget,
                            mode: risk.mode,
                        })
                    );
                }
                // modo "conservative": permite a tarefa, mas marca flag nos tasks
            }

            const patchedTasks = tasks.map((t) => {
                const copy: any = { ...t };
                applyTaskFallbacksFromConfig(copy, cfg);

                if (risk.hitLoss || risk.hitProfit) {
                    copy.riskMode = "conservative";
                    copy.riskNote = risk.hitLoss ? "dailyLossHit" : "dailyProfitHit";
                }
                return copy;
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

            // ACK na persistência em memória
            const r = ackPersist(agentId, done);

            // Acumular PnL (pontos) a partir do payload "done"
            try {
                let deltaSum = 0;
                for (const it of done) {
                    const delta = extractPnLPointsFromAckItem(it);
                    if (Number.isFinite(delta)) deltaSum += Number(delta);
                }
                if (deltaSum !== 0) {
                    const state = addPnLToDailyGuard(deltaSum);
                    if (process.env.NODE_ENV !== "test") {
                        console.log(`[RISK] ACK dia: PnL=${state.pnlPoints}  ganhos=${state.pontosGanhos}  perdas=${state.pontosPerdidos}  (Δ=${deltaSum})`);
                    }
                }
            } catch {
                // ignore errors
            }

            // Persistência externa (Prisma)
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

    // >>> ADIÇÃO: expor rotas de admin também quando anexado (em RAIZ /admin, não sob /broker)
    const adminLayer = Router();
    adminLayer.use(cors()); // CORS para /admin
    adminLayer.use(express.json({ limit: "2mb" })); // body parser para POST
    adminLayer.use(adminRoutes);
    app.use("/admin", adminLayer);
    console.log(`[EXEC+BT] Admin routes montadas em '/admin' (runtime-config disponível quando anexado).`);
}

/* =========================================================================================
   Modo standalone (opcional): só inicia servidor próprio se BROKER_STANDALONE === "1".
   Mantém compatibilidade com sua execução anterior sem colidir com o backend principal.
   ========================================================================================= */
if (process.env.BROKER_STANDALONE === "1") {
    // Ordem de precedência: BROKER_HTTP_PORT > EXEC_PORT > 3002 (default do broker)
    const PORT = Number(process.env.BROKER_HTTP_PORT || process.env.EXEC_PORT || 3002);
    const appStandalone = express();

    // >>> ADIÇÃO: CORS e body parser no app standalone (vale para /admin)
    appStandalone.use(cors());
    appStandalone.use(express.json({ limit: "2mb" }));

    // >>> ALTERAÇÃO: expor o router tanto em "/" quanto em "/broker"
    const brokerRouter = createBrokerRouter();
    appStandalone.use("/", brokerRouter);        // sem prefixo
    appStandalone.use("/broker", brokerRouter);  // com prefixo (compat UI)

    // >>> ADIÇÃO: expor rotas de admin no standalone (RAIZ /admin) com CORS/JSON
    appStandalone.use("/admin", adminRoutes);

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
        console.log(`[EXEC+BT] Endpoints admin habilitados em: GET/POST http://127.0.0.1:${PORT}/admin/runtime-config`);
        console.log(`[EXEC+BT] Endpoints broker disponíveis em: / (sem prefixo) e /broker (compat UI).`);
    });
}

// Export default como conveniência (import attachBrokerToApp from "./brokerServer")
export default attachBrokerToApp;
