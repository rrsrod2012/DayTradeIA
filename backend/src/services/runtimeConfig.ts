// backend/src/workers/runtimeConfig.ts
import fs from "fs";
import path from "path";

// === Tipos ===
export type RuntimeConfig = {
    /** timeframe sugerido pela UI (ex.: "M1","M5","M15","M30","H1") */
    uiTimeframe?: "M1" | "M5" | "M15" | "M30" | "H1";
    /** quantidade de contratos/lotes (alias: lots) */
    uiLots: number;

    /** multiplicador do ATR para SL */
    slAtr: number;
    /** Risk/Reward (TP = RR * ATR) */
    rr: number;
    /** gatilho de BE em pontos; 0 = desligado */
    beAtPts: number;
    /** offset aplicado ao preço de entrada quando move para BE */
    beOffsetPts: number;

    /** atraso de entrada em barras (0 = na barra do sinal; 1 = próxima; etc.) */
    entryDelayBars: number;

    /** limiar de decisão para probabilidade do micro (0..1) */
    decisionThreshold: number;

    /** logs extras do pipeline */
    debug: boolean;
};

// === Utils ===
const toNum = (v: any, def: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
};
const toBool = (v: any, def: boolean) => {
    if (v === true || v === "true" || v === "1" || v === 1) return true;
    if (v === false || v === "false" || v === "0" || v === 0) return false;
    return def;
};
const toTF = (v: any): RuntimeConfig["uiTimeframe"] => {
    const s = String(v || "").toUpperCase();
    return (["M1", "M5", "M15", "M30", "H1"] as const).includes(s as any)
        ? (s as RuntimeConfig["uiTimeframe"])
        : undefined;
};

function ensureDir(p: string) {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}
function readJsonFile<T = any>(file: string): T | null {
    try {
        const s = fs.readFileSync(file, "utf8");
        return JSON.parse(s) as T;
    } catch {
        return null;
    }
}
function writeJsonFile(file: string, data: any) {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

// === Onde está o MODEL_STORE do micro? (resolver de forma resiliente) ===
function resolveModelStoreDir(): string {
    // 1) honors envs explícitos
    const envs = [
        process.env.MODEL_STORE,          // preferível: setar igual no backend e no micro
        process.env.AI_NODE_MODEL_STORE,  // opcional
    ].filter(Boolean) as string[];
    for (const e of envs) {
        const p = path.resolve(e);
        if (fs.existsSync(p)) return p;
    }

    // 2) tenta localizar o da pasta ai-node (irmã do backend)
    const candidates = [
        path.resolve(process.cwd(), "..", "ai-node", "model_store"),
        path.resolve(process.cwd(), "ai-node", "model_store"),
        // se backend estiver rodando a partir da raiz do monorepo:
        path.resolve(process.cwd(), "model_store"),
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }

    // 3) se nada existir ainda, crie no local mais provável (irmão do backend)
    const fallback = path.resolve(process.cwd(), "..", "ai-node", "model_store");
    ensureDir(fallback);
    return fallback;
}

const MODEL_STORE = resolveModelStoreDir();
const CONFIG_FILE = path.join(MODEL_STORE, "ui_runtime_config.json");
const MICRO_URL = process.env.MICRO_MODEL_URL || "http://127.0.0.1:5001";

// === Defaults (ENV como fallback; arquivo tem prioridade) ===
const defaults: RuntimeConfig = {
    uiTimeframe: toTF(process.env.UI_TIMEFRAME) || "M5",
    uiLots: toNum(process.env.UI_DEFAULT_LOTS ?? process.env.AUTO_TRAINER_DEFAULT_QTY, 1),

    slAtr: toNum(process.env.AUTO_TRAINER_SL_ATR, 1.0),
    rr: toNum(process.env.AUTO_TRAINER_RR, 2.0),
    beAtPts: toNum(process.env.AUTO_TRAINER_BE_AT_PTS, 0),
    beOffsetPts: toNum(process.env.AUTO_TRAINER_BE_OFFSET_PTS, 0),

    entryDelayBars: toNum(process.env.UI_ENTRY_DELAY_BARS, 1),
    decisionThreshold: Number.isFinite(Number(process.env.UI_DECISION_THRESHOLD))
        ? Number(process.env.UI_DECISION_THRESHOLD)
        : 0.5,

    debug: toBool(process.env.AUTO_TRAINER_DEBUG, false),
};

// === Estado atual + mtime do arquivo para hot-reload leve ===
let current: RuntimeConfig = { ...defaults, ...(readJsonFile(CONFIG_FILE) || {}) };
let lastMtimeMs = (() => {
    try { return fs.statSync(CONFIG_FILE).mtimeMs; } catch { return 0; }
})();

// normaliza aliases e faixas
function normalize(c: Partial<RuntimeConfig>): RuntimeConfig {
    const lotsAlias = (c as any).lots ?? (c as any).uiLots;
    const out: RuntimeConfig = {
        uiTimeframe: toTF(c.uiTimeframe ?? current.uiTimeframe ?? defaults.uiTimeframe),
        uiLots: Math.max(1, toNum(lotsAlias ?? current.uiLots ?? defaults.uiLots, defaults.uiLots)),

        slAtr: Math.max(0, toNum(c.slAtr ?? current.slAtr ?? defaults.slAtr, defaults.slAtr)),
        rr: Math.max(0, toNum(c.rr ?? current.rr ?? defaults.rr, defaults.rr)),
        beAtPts: Math.max(0, toNum(c.beAtPts ?? current.beAtPts ?? defaults.beAtPts, defaults.beAtPts)),
        beOffsetPts: Math.max(0, toNum(c.beOffsetPts ?? current.beOffsetPts ?? defaults.beOffsetPts, defaults.beOffsetPts)),

        entryDelayBars: Math.max(0, toNum(c.entryDelayBars ?? current.entryDelayBars ?? defaults.entryDelayBars, defaults.entryDelayBars)),
        decisionThreshold: Math.min(1, Math.max(0, toNum(c.decisionThreshold ?? current.decisionThreshold ?? defaults.decisionThreshold, defaults.decisionThreshold))),

        debug: toBool(c.debug ?? current.debug ?? defaults.debug, defaults.debug),
    };
    return out;
}

// carrega do arquivo se mudou no disco
function maybeReloadFromDisk() {
    try {
        const st = fs.statSync(CONFIG_FILE);
        if (st.mtimeMs > lastMtimeMs) {
            const fileCfg = readJsonFile(CONFIG_FILE) || {};
            current = normalize({ ...current, ...fileCfg });
            lastMtimeMs = st.mtimeMs;
        }
    } catch {
        // arquivo ainda não existe — mantém current
    }
}

// mapeamentos micro <-> backend
function microToBackend(m: any): Partial<RuntimeConfig> {
    if (!m || typeof m !== "object") return {};
    return normalize({
        uiTimeframe: toTF(m.uiTimeframe),
        uiLots: toNum(m.uiLots, current.uiLots),
        slAtr: toNum(m.slAtr, current.slAtr),
        rr: toNum(m.rr, current.rr),
        beAtPts: toNum(m.beAtPts, current.beAtPts),
        beOffsetPts: toNum(m.beOffsetPts, current.beOffsetPts),
        entryDelayBars: toNum(m.entryDelayBars, current.entryDelayBars),
        decisionThreshold: toNum(m.decisionThreshold, current.decisionThreshold),
        debug: typeof m.debug === "boolean" ? m.debug : current.debug,
    });
}

function backendToMicroPatch(r: Partial<RuntimeConfig>) {
    const out: any = {};
    if (r.uiTimeframe) out.uiTimeframe = r.uiTimeframe;
    if (r.uiLots != null) out.uiLots = Number(r.uiLots);
    if (r.slAtr != null) out.slAtr = Number(r.slAtr);
    if (r.rr != null) out.rr = Number(r.rr);
    if (r.beAtPts != null) out.beAtPts = Number(r.beAtPts);
    if (r.beOffsetPts != null) out.beOffsetPts = Number(r.beOffsetPts);
    if (r.entryDelayBars != null) out.entryDelayBars = Number(r.entryDelayBars);
    if (r.decisionThreshold != null) out.decisionThreshold = Number(r.decisionThreshold);
    if (r.debug != null) out.debug = !!r.debug;
    return out;
}

// tenta puxar do micro e fundir no estado
async function refreshFromMicroOnce(): Promise<void> {
    try {
        const resp = await fetch(`${MICRO_URL}/config`);
        if (!resp.ok) return;
        const j = await resp.json().catch(() => null);
        const microCfg = j?.config ?? j;
        if (microCfg && typeof microCfg === "object") {
            const merged = microToBackend(microCfg);
            // aplica local mas NÃO sobrescreve arquivo se nada mudou
            const next = normalize({ ...current, ...merged });
            if (JSON.stringify(next) !== JSON.stringify(current)) {
                current = next;
                writeJsonFile(CONFIG_FILE, current);
                try { lastMtimeMs = fs.statSync(CONFIG_FILE).mtimeMs; } catch { }
            }
        }
    } catch {
        // micro pode estar offline — ignore
    }
}

// push para o micro
async function pushToMicro(patch: Partial<RuntimeConfig>) {
    try {
        const payload = backendToMicroPatch(patch);
        if (Object.keys(payload).length === 0) return;
        await fetch(`${MICRO_URL}/config`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        }).catch(() => { });
    } catch {
        // ignore
    }
}

// === API ===
export function getRuntimeConfig(): RuntimeConfig {
    maybeReloadFromDisk();
    // dispara um pull assíncrono só para alinhar se alguém mexeu direto no micro
    // (não bloqueia a resposta)
    refreshFromMicroOnce();
    return { ...current };
}

export function setRuntimeConfig(update: Partial<RuntimeConfig>): RuntimeConfig {
    // aplica update local + arquivo
    current = normalize({ ...current, ...update });
    writeJsonFile(CONFIG_FILE, current);
    try { lastMtimeMs = fs.statSync(CONFIG_FILE).mtimeMs; } catch { }

    // replica para o micro
    pushToMicro(update); // fire-and-forget

    return { ...current };
}

export function resetRuntimeConfig(): RuntimeConfig {
    current = normalize({ ...defaults });
    writeJsonFile(CONFIG_FILE, current);
    try { lastMtimeMs = fs.statSync(CONFIG_FILE).mtimeMs; } catch { }
    // também reseta no micro
    pushToMicro(current);
    return { ...current };
}

// (opcional) util p/ debug
export function __debugPaths() {
    return { MODEL_STORE, CONFIG_FILE, MICRO_URL };
}
