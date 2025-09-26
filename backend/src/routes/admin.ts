import { Router } from "express";
import { getRuntimeConfig, setRuntimeConfig, resetRuntimeConfig } from "../services/runtimeConfig";

const router = Router();

// ver o config atual (efetivo)
router.get("/admin/runtime-config", (_req, res) => {
    res.json({ ok: true, data: getRuntimeConfig() });
});

// atualizar em memória (ex.: lots, rr, slAtr, beAtPts, beOffsetPts, debug)
router.post("/admin/runtime-config", (req, res) => {
    const next = setRuntimeConfig(req.body || {});
    res.json({ ok: true, data: next });
});

// resetar p/ defaults do .env
router.post("/admin/runtime-config/reset", (_req, res) => {
    const next = resetRuntimeConfig();
    res.json({ ok: true, data: next });
});

export default router;
