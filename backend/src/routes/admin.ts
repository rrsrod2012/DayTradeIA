import { Router } from "express";
import { getRuntimeConfig, setRuntimeConfig, resetRuntimeConfig } from "../services/runtimeConfig";

const router = Router();

/**
 * IMPORTANTE:
 * Este router é montado em server.ts com:
 *   app.use("/admin", adminRoutes)
 *
 * Portanto, as rotas aqui devem ser relativas a "/admin".
 * Ex.: router.get("/runtime-config") -> URL final: GET /admin/runtime-config
 */

// ver o config atual (efetivo)
router.get("/runtime-config", (_req, res) => {
    res.json({ ok: true, data: getRuntimeConfig() });
});

// atualizar em memória (ex.: lots, rr, slAtr, beAtPts, beOffsetPts, debug)
router.post("/runtime-config", (req, res) => {
    const next = setRuntimeConfig(req.body || {});
    res.json({ ok: true, data: next });
});

// resetar p/ defaults do .env
router.post("/runtime-config/reset", (_req, res) => {
    const next = resetRuntimeConfig();
    res.json({ ok: true, data: next });
});

export default router;
