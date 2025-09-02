// backend/src/services/csvWatcher.ts (v7 — watcher resiliente + fix ENOENT + anti-duplicatas sem skipDuplicates)
// Novidades desta versão:
// - Continua observando o **diretório** (evita ENOENT) e faz heartbeat periódico.
// - Logs enxutos (sem payload enorme).
// - Lê tudo do .env.
// - **Anti-duplicatas robusto** para Prisma antigo:
//   1) Tenta createMany com skipDuplicates (quando suportado).
//   2) Se não suportar, tenta createMany **sem** skipDuplicates.
//   3) Se der **Unique constraint failed**, cai em fallback por registro
//      (create individual com **ignore de P2002**), com **concorrência limitada**.
//      Assim não estoura e não imprime o array de dados inteiro.

import chokidar from "chokidar";
import { promises as fs } from "fs";
import path from "path";
import { DateTime } from "luxon";
import { prisma } from "../prisma";
import logger from "../logger";
import dotenv from "dotenv";

dotenv.config();

type WatchCfg = {
  filePath: string; // caminho completo do arquivo alvo
  symbol: string; // ex.: WIN, WDO
  timeframe?: string; // ex.: M1, M5
  delimiter?: string; // força "," ou ";"; se omitido, autodetecta
  header?: string; // ex.: time,o,h,l,c,v (opcional)
  tzOffset?: string; // "-03:00" ou "America/Sao_Paulo"
};

// ==================== Carrega configuração de watchers ====================
const ENV_JSON = (() => {
  try {
    const raw = process.env.MT_CSV_WATCHERS?.trim();
    return raw ? (JSON.parse(raw) as WatchCfg[]) : [];
  } catch {
    return [];
  }
})();

const FALLBACK_SINGLE: WatchCfg[] = process.env.MT_CSV_PATH
  ? [
      {
        filePath: process.env.MT_CSV_PATH!,
        symbol: (process.env.MT_SYMBOL || "WIN").toUpperCase(),
        timeframe: (process.env.MT_TIMEFRAME || "M5").toUpperCase(),
        delimiter: process.env.MT_DELIMITER || undefined,
        header: process.env.MT_HEADER || undefined,
        tzOffset: process.env.MT_TZ_OFFSET || "-03:00",
      },
    ]
  : [];

const WATCHERS: WatchCfg[] = (ENV_JSON.length ? ENV_JSON : FALLBACK_SINGLE).map(
  (w) => ({
    ...w,
    symbol: (w.symbol || "WIN").toUpperCase(),
    timeframe: (w.timeframe || "M5").toUpperCase(),
    delimiter: w.delimiter || undefined,
    header: w.header || undefined,
    tzOffset: w.tzOffset || "-03:00",
  })
);

// ==================== .env (com defaults seguros) ====================
const LOG_SAMPLES = process.env.MT_CSV_LOG_SAMPLES === "1";
const MAX_SAMPLES = Math.max(1, Number(process.env.MT_CSV_MAX_SAMPLES || 5));
const USE_POLLING = process.env.CHOKIDAR_USEPOLLING === "1";
const POLL_INTERVAL = Math.max(
  250,
  Number(process.env.CHOKIDAR_INTERVAL || 1000)
);
const HEARTBEAT_SECONDS = Math.max(
  10,
  Number(process.env.MT_HEARTBEAT_SEC || 45)
);
const MIN_INTERVAL_MS = Math.max(
  500,
  Number(process.env.MT_MIN_INTERVAL_MS || 4000)
); // debounce entre imports
const BATCH_SIZE = Math.max(200, Number(process.env.MT_CSV_BATCH_SIZE || 1000));
const PRISMA_UPSERT_CONCURRENCY = Math.max(
  1,
  Number(process.env.PRISMA_UPSERT_CONCURRENCY || 16)
);
const PRISMA_DEDUPE = process.env.PRISMA_SKIP_DUPLICATES !== "0"; // tenta usar skipDuplicates se possível

// ==================== Utilitários CSV ====================
function guessDelimiterFromHeader(headerLine: string): "," | ";" {
  const commas = (headerLine.match(/,/g) || []).length;
  const semis = (headerLine.match(/;/g) || []).length;
  return semis > commas ? ";" : ",";
}

function normalizeHeaderTokens(tokens: string[]) {
  const map: Record<string, string> = {
    time: "time",
    datetime: "time",
    date: "time",
    timestamp: "time",
    open: "o",
    o: "o",
    high: "h",
    h: "h",
    low: "l",
    l: "l",
    close: "c",
    c: "c",
    volume: "v",
    vol: "v",
    v: "v",
    qty: "v",
    quantidade: "v",
  };
  return tokens.map(
    (x) => map[x.trim().toLowerCase()] ?? x.trim().toLowerCase()
  );
}

function normalizeHeader(line: string, delim: "," | ";") {
  const toks = line.split(delim).map((s) => s.trim());
  return normalizeHeaderTokens(toks).join(",");
}

const DATE_FORMATS = [
  "yyyy-LL-dd HH:mm:ss",
  "yyyy-LL-dd HH:mm",
  "yyyy-LL-dd'T'HH:mm:ss",
  "yyyy-LL-dd'T'HH:mm",
  "dd/LL/yyyy HH:mm:ss",
  "dd/LL/yyyy HH:mm",
  "dd/LL/yyyy",
  "yyyy-LL-dd",
  "yyyy.MM.dd HH:mm:ss",
  "yyyy.MM.dd HH:mm",
  "dd.MM.yyyy HH:mm:ss",
  "dd.MM.yyyy HH:mm",
];

function parseTimeToISO(s: string, tzOffset?: string) {
  let dt: DateTime | null = null;
  for (const f of DATE_FORMATS) {
    const candidate = DateTime.fromFormat(s, f);
    if (candidate.isValid) {
      dt = candidate;
      break;
    }
  }
  if (!dt) {
    const iso = DateTime.fromISO(s);
    if (iso.isValid) dt = iso;
  }
  if (!dt || !dt.isValid) return null;

  const off = (tzOffset || "-03:00").trim();
  const tz = /^([+-]\d{2}):?(\d{2})$/.test(off)
    ? `UTC${off}`
    : off.startsWith("UTC")
    ? off
    : off === "America/Sao_Paulo"
    ? "America/Sao_Paulo"
    : `UTC${off}`;

  const withZone = dt.setZone(tz as any, { keepLocalTime: true });
  if (!withZone.isValid) return null;
  return withZone.toUTC().toISO();
}

function parseNum(s: string) {
  const t = s.replace(/\./g, "").replace(",", ".");
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

async function ensureInstrumentId(symbol: string) {
  const up = await prisma.instrument.upsert({
    where: { symbol },
    update: {},
    create: { symbol, name: symbol },
  });
  return up.id;
}

// ==================== Importação ====================

type CsvRow = {
  time: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
};

async function parseCsvFile(cfg: WatchCfg): Promise<CsvRow[]> {
  const raw = await fs.readFile(cfg.filePath, "utf8");
  const lines = raw.split(/\r?\n/).filter((ln) => ln.trim().length > 0);
  if (lines.length < 2) return [];

  const detected: "," | ";" =
    cfg.delimiter === ";" || cfg.delimiter === ","
      ? (cfg.delimiter as any)
      : guessDelimiterFromHeader(lines[0]);

  const headerLine = cfg.header ? cfg.header : lines[0];
  const headerNorm = normalizeHeader(headerLine, detected);
  const cols = headerNorm.split(",");
  const idx = {
    time: cols.indexOf("time"),
    o: cols.indexOf("o"),
    h: cols.indexOf("h"),
    l: cols.indexOf("l"),
    c: cols.indexOf("c"),
    v: cols.indexOf("v"),
  };
  if (Object.values(idx).some((i) => i < 0)) {
    logger.warn(
      `[CSVWatcher] Cabeçalho inesperado: "${headerLine}" (detected ${detected})`
    );
    return [];
  }

  const out: CsvRow[] = [];
  let badTime = 0,
    badNum = 0;
  const badSamples: string[] = [];
  const dataStart = cfg.header ? 0 : 1;

  for (let li = dataStart; li < lines.length; li++) {
    const parts = lines[li].split(detected).map((s) => s.trim());
    if (!parts.length || parts.length < cols.length) continue;

    const iso = parseTimeToISO(parts[idx.time], cfg.tzOffset || "-03:00");
    if (!iso) {
      badTime++;
      if (LOG_SAMPLES && badSamples.length < MAX_SAMPLES)
        badSamples.push(`L${li + 1}:${parts[idx.time]}`);
      continue;
    }

    const o = parseNum(parts[idx.o]);
    const h = parseNum(parts[idx.h]);
    const l = parseNum(parts[idx.l]);
    const c = parseNum(parts[idx.c]);
    const v = parseNum(parts[idx.v]);
    if ([o, h, l, c, v].some((n) => Number.isNaN(n))) {
      badNum++;
      continue;
    }

    out.push({ time: iso, o, h, l, c, v });
  }

  if (badTime || badNum) {
    logger.warn(
      `[CSVWatcher] ${path.basename(
        cfg.filePath
      )}: descartadas ${badTime} datas inválidas e ${badNum} valores numéricos inválidos.`
    );
    if (LOG_SAMPLES && badSamples.length)
      logger.warn(
        `[CSVWatcher] amostras (limit ${MAX_SAMPLES}): ${badSamples.join("; ")}`
      );
  }

  out.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  return out;
}

// ============== Inserção com dedupe (fallback por registro) ==============

async function createManyWithFallback(
  rows: CsvRow[],
  instrumentId: number,
  timeframe: string
) {
  // Primeiro tenta createMany com/sem skipDuplicates
  try {
    await prisma.candle.createMany({
      data: rows.map((r) => ({
        instrumentId,
        timeframe,
        time: new Date(r.time),
        open: r.o,
        high: r.h,
        low: r.l,
        close: r.c,
        volume: r.v,
      })),
      ...(PRISMA_DEDUPE ? { skipDuplicates: true as any } : {}),
    } as any);
    return { inserted: rows.length, dedupFallback: false };
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (/Unknown argument `skipDuplicates`/i.test(msg)) {
      // Tenta novamente sem skipDuplicates (algumas versões antigas aceitam createMany puro)
      try {
        await prisma.candle.createMany({
          data: rows.map((r) => ({
            instrumentId,
            timeframe,
            time: new Date(r.time),
            open: r.o,
            high: r.h,
            low: r.l,
            close: r.c,
            volume: r.v,
          })),
        });
        return { inserted: rows.length, dedupFallback: false };
      } catch (e2: any) {
        // Se mesmo assim houver violação de única, cai no fallback individual
        if (/Unique constraint failed/i.test(String(e2?.message || e2))) {
          const res = await createIndividuallyIgnoringDuplicates(
            rows,
            instrumentId,
            timeframe
          );
          return { ...res, dedupFallback: true };
        }
        logger.error(
          `[CSVWatcher] createMany falhou sem skipDuplicates: ${String(
            e2?.message || e2
          )}`
        );
        throw e2;
      }
    }
    if (/Unique constraint failed/i.test(msg)) {
      const res = await createIndividuallyIgnoringDuplicates(
        rows,
        instrumentId,
        timeframe
      );
      return { ...res, dedupFallback: true };
    }
    logger.error(`[CSVWatcher] createMany falhou: ${msg}`);
    throw e;
  }
}

async function createIndividuallyIgnoringDuplicates(
  rows: CsvRow[],
  instrumentId: number,
  timeframe: string
) {
  // Insere um a um, ignorando P2002 (duplicado) — com concorrência limitada
  let ok = 0,
    dup = 0,
    fail = 0;
  const limit = PRISMA_UPSERT_CONCURRENCY;
  let i = 0;
  async function worker() {
    while (i < rows.length) {
      const idx = i++;
      const r = rows[idx];
      try {
        await prisma.candle.create({
          data: {
            instrumentId,
            timeframe,
            time: new Date(r.time),
            open: r.o,
            high: r.h,
            low: r.l,
            close: r.c,
            volume: r.v,
          },
        });
        ok++;
      } catch (e: any) {
        // P2002 = Unique constraint failed
        if (
          String(e?.code) === "P2002" ||
          /Unique constraint failed/i.test(String(e?.message || e))
        ) {
          dup++;
        } else {
          fail++;
          logger.error(
            `[CSVWatcher] create(individual) falhou: ${String(e?.message || e)}`
          );
        }
      }
    }
  }
  const workers = Array.from({ length: limit }, () => worker());
  await Promise.all(workers);
  if (dup)
    logger.warn(`[CSVWatcher] ${dup} registros já existiam (ignorados).`);
  return { inserted: ok, duplicates: dup, failed: fail };
}

async function insertCandles(
  rows: CsvRow[],
  instrumentId: number,
  timeframe: string
) {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const slice = rows.slice(i, i + BATCH_SIZE);
    const { inserted, duplicates } = await createManyWithFallback(
      slice,
      instrumentId,
      timeframe
    );
    logger.info(
      `[CSVWatcher] lote processado: ${inserted} inseridos${
        duplicates ? `, ${duplicates} duplicados` : ""
      }`
    );
  }
}

// ==================== Ciclo de importação ====================

type FileState = { mtimeMs: number; size: number; lastRun: number };
const fileStates = new Map<string, FileState>();
const missingWarned = new Set<string>(); // evita flood de ENOENT

async function importIfChanged(cfg: WatchCfg) {
  try {
    const st = await fs.stat(cfg.filePath);
    const prev = fileStates.get(cfg.filePath);
    const now = Date.now();
    if (prev && now - prev.lastRun < MIN_INTERVAL_MS) return; // debounce
    if (!prev || prev.mtimeMs !== st.mtimeMs || prev.size !== st.size) {
      const rows = await parseCsvFile(cfg);
      if (rows.length) {
        const instrumentId = await ensureInstrumentId(cfg.symbol);
        const timeframe = cfg.timeframe || "M5";
        await insertCandles(rows, instrumentId, timeframe);
        logger.info(
          `[CSVWatcher] importados ${rows.length} candles de ${path.basename(
            cfg.filePath
          )} (${cfg.symbol}/${timeframe})`
        );
      }
      fileStates.set(cfg.filePath, {
        mtimeMs: st.mtimeMs,
        size: st.size,
        lastRun: now,
      });
    }
    // se conseguiu stat, zera o aviso de ausente
    missingWarned.delete(cfg.filePath);
  } catch (e: any) {
    if ((e as any)?.code === "ENOENT") {
      if (!missingWarned.has(cfg.filePath)) {
        missingWarned.add(cfg.filePath);
        logger.warn(`[CSVWatcher] aguardando arquivo: ${cfg.filePath}`);
      }
      return;
    }
    logger.warn(
      `[CSVWatcher] importIfChanged falhou para ${cfg.filePath}: ${String(
        e?.message || e
      )}`
    );
  }
}

function watchOne(cfg: WatchCfg) {
  const abs = path.resolve(cfg.filePath);
  const dir = path.dirname(abs);
  const base = path.basename(abs);

  // Observa o DIRETÓRIO; filtra pelo nome do arquivo.
  const watcher = chokidar.watch(dir, {
    persistent: true,
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 800, pollInterval: 200 },
    usePolling: USE_POLLING,
    interval: POLL_INTERVAL,
    binaryInterval: POLL_INTERVAL,
    ignorePermissionErrors: true,
    depth: 0,
  });

  const onChange = async (changedPath: string) => {
    if (path.basename(changedPath) !== base) return;
    await importIfChanged({ ...cfg, filePath: path.join(dir, base) });
  };

  watcher
    .on("add", onChange)
    .on("change", onChange)
    .on("unlink", (p) => {
      if (path.basename(p) === base) missingWarned.add(abs);
    })
    .on("error", (e) => logger.error(`[CSVWatcher] erro no watcher: ${e}`))
    .on("ready", () =>
      logger.info(
        `[CSVWatcher] pronto para ${base} em ${dir} (polling=${
          USE_POLLING ? "on" : "off"
        })`
      )
    );

  // Heartbeat (fallback): rescan periódico do arquivo alvo
  const interval = setInterval(
    () => importIfChanged({ ...cfg, filePath: path.join(dir, base) }),
    HEARTBEAT_SECONDS * 1000
  );

  // Primeira passada (se já existir)
  importIfChanged({ ...cfg, filePath: path.join(dir, base) });

  return () => {
    clearInterval(interval);
    watcher.close();
  };
}

export function bootCsvWatchersIfConfigured() {
  if (!WATCHERS.length) {
    logger.info(`[CSVWatcher] módulo não configurado.`);
    return;
  }
  logger.info(`[CSVWatcher] Inicializando ${WATCHERS.length} watcher(s)...`);
  const stops: Array<() => void> = [];
  for (const cfg of WATCHERS) stops.push(watchOne(cfg));
  return () => stops.forEach((s) => s());
}
