// ai-node/src/server.ts
import "dotenv/config";
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { z } from "zod";
import { OnlineBinaryClassifier } from "./model";

const PORT = Number(process.env.PORT || 5001);

// Diretório onde guardamos modelo e config vindas da UI (PRECISA ser o MESMO do backend)
const MODEL_STORE =
  process.env.MODEL_STORE || path.resolve(process.cwd(), "model_store");

// ===== Persistência simples de config (JSON) =====
const CONFIG_FILE = path.join(MODEL_STORE, "ui_runtime_config.json");

function ensureDir(p: string) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}
function readJson<T>(file: string): T | null {
  try {
    const s = fs.readFileSync(file, "utf8");
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}
function writeJson(file: string, data: any) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

// Helpers
const num = (v: any, def: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};
const str = (v: any, def: string) => (v ? String(v) : def);

// ===== Schema da config (controlada pela tela) =====
const cfgSchema = z.object({
  uiTimeframe: z.enum(["M1", "M5", "M15", "M30", "H1"]).optional(),
  uiLots: z.number().int().min(1).max(100).optional(),
  rr: z.number().positive().max(10).optional(),
  slAtr: z.number().positive().max(10).optional(),
  beAtPts: z.number().nonnegative().max(100000).optional(),
  beOffsetPts: z.number().nonnegative().max(100000).optional(),
  entryDelayBars: z.number().int().min(0).max(20).optional(),
  decisionThreshold: z.number().min(0).max(1).optional(),
  debug: z.boolean().optional(),
});

// ===== Defaults (ENV tem prioridade) =====
const defaultConfig = {
  uiTimeframe: (str(process.env.UI_TIMEFRAME, "M1") as "M1" | "M5" | "M15" | "M30" | "H1"),
  uiLots: num(process.env.UI_LOTS, 1),

  rr: num(process.env.UI_RR, 2),
  slAtr: num(process.env.UI_SL_ATR, 1),
  beAtPts: num(process.env.UI_BE_AT_PTS, 0),
  beOffsetPts: num(process.env.UI_BE_OFFSET_PTS, 0),
  entryDelayBars: num(process.env.UI_ENTRY_DELAY_BARS, 1),
  decisionThreshold: Number.isFinite(Number(process.env.UI_DECISION_THRESHOLD))
    ? Number(process.env.UI_DECISION_THRESHOLD)
    : 0.5,
  debug: !!Number(process.env.AUTO_TRAINER_DEBUG || "0"),
};

type RuntimeConfig = z.infer<typeof cfgSchema> & typeof defaultConfig;

// garante diretório do store
ensureDir(MODEL_STORE);

// carrega config salva (se houver) por cima dos defaults
let runtimeConfig: RuntimeConfig = {
  ...defaultConfig,
  ...(readJson<Partial<RuntimeConfig>>(CONFIG_FILE) || {}),
};

// controle de mtime para hot-reload
let lastMtimeMs: number = (() => {
  try {
    return fs.statSync(CONFIG_FILE).mtimeMs;
  } catch {
    return 0;
  }
})();

/** Recarrega do disco se o arquivo foi modificado por outro processo (ex.: backend/tela) */
function maybeReloadFromDisk() {
  try {
    const st = fs.statSync(CONFIG_FILE);
    if (st.mtimeMs > lastMtimeMs) {
      const fileCfg = readJson<Partial<RuntimeConfig>>(CONFIG_FILE) || {};
      runtimeConfig = { ...runtimeConfig, ...fileCfg };
      lastMtimeMs = st.mtimeMs;
    }
  } catch {
    // arquivo ainda não existe — ok
  }
}

// ===== Modelo global =====
const clf = new OnlineBinaryClassifier();

// ===== App =====
const app = express();
app.use(
  cors({
    origin: true,
    credentials: false,
  })
);
app.use(express.json({ limit: "2mb" }));

// ---------- Health ----------
app.get("/healthz", async (_req, res) => {
  maybeReloadFromDisk();
  const ok = await clf.load().catch(() => false);
  return res.json({
    ok,
    loaded: !!ok,
    modelStore: MODEL_STORE,
    configFile: CONFIG_FILE,
    config: runtimeConfig,
  });
});

// ---------- Config (UI) ----------
app.get("/config", (_req, res) => {
  maybeReloadFromDisk();
  return res.json({ ok: true, config: runtimeConfig, modelStore: MODEL_STORE, configFile: CONFIG_FILE });
});

app.patch("/config", (req, res) => {
  try {
    const patch = cfgSchema.parse(req.body || {});
    runtimeConfig = { ...runtimeConfig, ...patch };
    writeJson(CONFIG_FILE, runtimeConfig);
    try {
      lastMtimeMs = fs.statSync(CONFIG_FILE).mtimeMs;
    } catch { }
    return res.json({ ok: true, config: runtimeConfig });
  } catch (e: any) {
    return res.status(400).json({ ok: false, error: e?.message || "bad request" });
  }
});

// (opcional) replace total
app.put("/config", (req, res) => {
  try {
    const next = cfgSchema.partial().parse(req.body || {});
    runtimeConfig = { ...defaultConfig, ...next };
    writeJson(CONFIG_FILE, runtimeConfig);
    try {
      lastMtimeMs = fs.statSync(CONFIG_FILE).mtimeMs;
    } catch { }
    return res.json({ ok: true, config: runtimeConfig });
  } catch (e: any) {
    return res.status(400).json({ ok: false, error: e?.message || "bad request" });
  }
});

// ---------- Predição ----------
app.post("/predict", async (req, res) => {
  try {
    maybeReloadFromDisk();
    const schema = z.object({
      features: z.record(z.number()).default({}),
      threshold: z.number().min(0).max(1).optional(), // sobrepõe se vier na chamada
      returnDecision: z.boolean().default(true),
    });
    const { features, threshold, returnDecision } = schema.parse(req.body || {});
    const thr = threshold ?? runtimeConfig.decisionThreshold;

    if (!(await clf.load())) {
      const p = 0.5;
      return res.json({
        p,
        threshold: thr,
        decision: returnDecision ? (p >= thr ? 1 : 0) : undefined,
      });
    }

    const p = await clf.predictProba(features);
    return res.json({
      p,
      threshold: thr,
      decision: returnDecision ? (p >= thr ? 1 : 0) : undefined,
    });
  } catch (e: any) {
    return res.status(400).json({ error: e?.message || "bad request" });
  }
});

// ---------- Treino incremental ----------
app.post("/train", async (req, res) => {
  try {
    maybeReloadFromDisk();
    const row = z.object({
      features: z.record(z.number()),
      label: z.number().int().min(0).max(1),
    });
    const schema = z.object({
      rows: z.array(row).min(1),
      epochs: z.number().int().min(1).max(20).default(1),
      lr: z.number().positive().max(1).optional(),
    });

    const { rows, epochs, lr } = schema.parse(req.body || {});
    await clf.load().catch(() => false); // se não houver, cria novo no save

    const info = await clf.train(
      rows.map((r) => ({
        features: r.features,
        label: r.label as 0 | 1,
      })),
      epochs,
      lr
    );
    return res.json({
      ok: true,
      ...info,
      meta: clf.metaInfo(),
      config: runtimeConfig,
    });
  } catch (e: any) {
    return res.status(400).json({ ok: false, error: e?.message || "bad request" });
  }
});

// ---------- Meta ----------
app.get("/meta", async (_req, res) => {
  maybeReloadFromDisk();
  await clf.load().catch(() => false);
  return res.json({ meta: clf.metaInfo(), config: runtimeConfig, modelStore: MODEL_STORE, configFile: CONFIG_FILE });
});

app.listen(PORT, () => {
  console.log(
    JSON.stringify({
      msg: `ai-node up on http://localhost:${PORT}`,
      modelStore: MODEL_STORE,
      configFile: CONFIG_FILE,
      initialConfig: runtimeConfig,
    })
  );
});
