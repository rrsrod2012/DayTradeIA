import fs from "fs";
import path from "path";
import chokidar from "chokidar";
import { prisma } from "../prisma";
import logger from "../logger";

// ------------------------------------------------------------
// Tipos de configuração
// ------------------------------------------------------------
type WatchCfg = {
  filePath: string;
  symbol: string;
  timeframe?: string; // ex: "M1" (default MT_TIMEFRAME)
  delimiter?: string; // ex: "," ";" "\t" "|" (default MT_DELIMITER)
  header?: string; // ex: "Time,Open,High,Low,Close,Volume" (default MT_HEADER)
  tzOffset?: string; // ex: "-03:00" (default MT_TZ_OFFSET)
};

// Defaults vindos do .env
const DEF_TF = (process.env.MT_TIMEFRAME || "M5").toUpperCase();
const DEF_DELIM = process.env.MT_DELIMITER || ",";
const DEF_HEADER = process.env.MT_HEADER || "Time,Open,High,Low,Close,Volume";
const DEF_TZ = process.env.MT_TZ_OFFSET || "-03:00";

// ------------------------------------------------------------
// Utilitários
// ------------------------------------------------------------

// Normaliza números (aceita "143.210,50" e "143210.50")
function parseNum(s: string): number {
  if (s == null) return NaN;
  let t = String(s).trim();
  // remove espaços
  t = t.replace(/\s+/g, "");
  // se houver vírgula decimal e ponto milhar (ex: 1.234,56)
  if (/[.,]/.test(t)) {
    const lastComma = t.lastIndexOf(",");
    const lastDot = t.lastIndexOf(".");
    if (lastComma > lastDot) {
      // vírgula é decimal -> remove pontos
      t = t.replace(/\./g, "").replace(",", ".");
    }
  }
  return Number(t);
}

// Aceita:
// - "2025-08-27 09:00:00"
// - "2025.09.01 14:07"
// - "2025-08-27T12:00:00Z"
// - epoch (ms)
// Retorna Date em UTC.
function parseTimeToUTC(s: string, tzOffset: string): Date | null {
  if (!s) return null;
  const raw = String(s).trim();
  // epoch ms?
  if (/^\d{10,}$/.test(raw)) {
    const ms = Number(raw.length === 10 ? Number(raw) * 1000 : Number(raw));
    return new Date(ms);
  }
  // troca "." por "-" em datas com ponto (formato MetaTrader)
  let norm = raw.replace(/\./g, "-");

  // adereçar "YYYY-MM-DD HH:mm" ou "YYYY-MM-DD HH:mm:ss"
  if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(:\d{2})?$/.test(norm)) {
    // aplica offset manual: cria como se fosse "local" naquele offset
    // e converte para UTC subtraindo o offset.
    // tzOffset exemplo "-03:00"
    const m = tzOffset.match(/^([+-])(\d{2}):(\d{2})$/);
    let offsetMin = 0;
    if (m) {
      const sign = m[1] === "-" ? -1 : 1;
      offsetMin = sign * (Number(m[2]) * 60 + Number(m[3]));
    }
    const [datePart, timePart] = norm.split(/\s+/);
    const [Y, M, D] = datePart.split("-").map(Number);
    const [h, mi, s = "00"] = timePart.split(":").map(Number);
    // cria em UTC e depois subtrai offset para cair na hora correta UTC
    const dt = new Date(Date.UTC(Y, M - 1, D, h, mi, s));
    // tzOffset -03:00 -> precisamos somar 3h para virar UTC
    dt.setUTCMinutes(dt.getUTCMinutes() - offsetMin);
    return dt;
  }

  // ISO já com Z
  if (/Z$/.test(norm)) return new Date(norm);

  // Tenta Date direto
  const d = new Date(norm);
  if (!isNaN(d.getTime())) return d;

  return null;
}

function detectDelimiter(sample: string[]): string {
  const candidates = [",", ";", "\t", "|"];
  let best = DEF_DELIM;
  let bestCount = 0;
  for (const delim of candidates) {
    const counts = sample.map(
      (line) => (line.match(new RegExp(`\\${delim}`, "g")) || []).length
    );
    const sum = counts.reduce((a, b) => a + b, 0);
    if (sum > bestCount) {
      bestCount = sum;
      best = delim;
    }
  }
  return best;
}

function normalizeHeader(h: string): {
  time: string;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
} {
  // aceita "Time,Open,High,Low,Close,Volume" e "time,o,h,l,c,v"
  const raw = h.split(/[;,|\t]/).map((x) => x.trim());
  if (raw.length >= 6) {
    const lower = raw.map((x) => x.toLowerCase());
    // tenta mapear variações
    const timeIdx = lower.findIndex((x) => x === "time");
    const openIdx = lower.findIndex((x) => x === "open" || x === "o");
    const highIdx = lower.findIndex((x) => x === "high" || x === "h");
    const lowIdx = lower.findIndex((x) => x === "low" || x === "l");
    const closeIdx = lower.findIndex((x) => x === "close" || x === "c");
    const volIdx = lower.findIndex((x) => x === "volume" || x === "v");

    if (
      timeIdx >= 0 &&
      openIdx >= 0 &&
      highIdx >= 0 &&
      lowIdx >= 0 &&
      closeIdx >= 0 &&
      volIdx >= 0
    ) {
      return {
        time: raw[timeIdx],
        o: raw[openIdx],
        h: raw[highIdx],
        l: raw[lowIdx],
        c: raw[closeIdx],
        v: raw[volIdx],
      } as any;
    }
  }
  // fallback para apelidos
  return { time: "time", o: "o", h: "h", l: "l", c: "c", v: "v" } as any;
}

async function getOrCreateInstrumentId(symbol: string): Promise<number> {
  const s = symbol.toUpperCase();
  let ins = await prisma.instrument.findUnique({ where: { symbol: s } });
  if (!ins) {
    ins = await prisma.instrument.create({
      data: { symbol: s, name: s },
    });
  }
  return ins.id;
}

// ------------------------------------------------------------
// Agregação de M1 -> M5 / M15
// ------------------------------------------------------------
function floorToBucket(date: Date, minutes: number): Date {
  const d = new Date(date);
  const mm = d.getUTCMinutes();
  const floored = mm - (mm % minutes);
  d.setUTCMinutes(floored, 0, 0);
  return d;
}

type CandleRow = {
  time: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

async function aggregateFromM1(instrumentId: number, targetTf: "M5" | "M15") {
  const bucketSize = targetTf === "M5" ? 5 : 15;

  // Busca último agregado para fazer CDC incremental
  const lastAgg = await prisma.candle.findFirst({
    where: { instrumentId, timeframe: targetTf },
    orderBy: { time: "desc" },
    select: { time: true },
  });

  const whereM1: any = { instrumentId, timeframe: "M1" };
  if (lastAgg?.time) {
    // para evitar perder borda, traga 1h antes
    const back = new Date(lastAgg.time.getTime() - 60 * 60 * 1000);
    whereM1.time = { gte: back };
  }

  const m1 = await prisma.candle.findMany({
    where: whereM1,
    orderBy: { time: "asc" },
    select: {
      time: true,
      open: true,
      high: true,
      low: true,
      close: true,
      volume: true,
    },
  });
  if (!m1.length) return { upserts: 0 };

  // Agrupa em buckets
  const byBucket = new Map<number, CandleRow[]>();
  for (const c of m1) {
    const bucket = floorToBucket(c.time, bucketSize).getTime();
    if (!byBucket.has(bucket)) byBucket.set(bucket, []);
    byBucket.get(bucket)!.push({
      time: c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    });
  }

  let upserts = 0;
  const ops: any[] = [];

  for (const [bucketMs, rows] of byBucket) {
    if (!rows.length) continue;
    // garante ordenação
    rows.sort((a, b) => a.time.getTime() - b.time.getTime());
    const time = new Date(bucketMs);
    const open = rows[0].open;
    const close = rows[rows.length - 1].close;
    const high = Math.max(...rows.map((r) => r.high));
    const low = Math.min(...rows.map((r) => r.low));
    const volume = rows.reduce((s, r) => s + (r.volume || 0), 0);

    ops.push(
      prisma.candle.upsert({
        where: {
          instrumentId_timeframe_time: {
            instrumentId,
            timeframe: targetTf,
            time,
          },
        },
        update: { open, high, low, close, volume },
        create: {
          instrumentId,
          timeframe: targetTf,
          time,
          open,
          high,
          low,
          close,
          volume,
        },
        select: { id: true },
      })
    );
  }

  if (ops.length) {
    await prisma.$transaction(ops, { timeout: 30000 });
    upserts = ops.length;
  }
  return { upserts };
}

// ------------------------------------------------------------
// Importação CSV (pode ser chamada pelo watcher ou manual)
// ------------------------------------------------------------
export async function importCsvFile(cfg: WatchCfg) {
  const filePath = cfg.filePath;
  const symbol = cfg.symbol.toUpperCase();
  const timeframe = (cfg.timeframe || DEF_TF).toUpperCase();
  let delimiter = cfg.delimiter || DEF_DELIM;
  const headerCfg = cfg.header || DEF_HEADER;
  const tzOffset = cfg.tzOffset || DEF_TZ;

  if (!fs.existsSync(filePath)) {
    logger.warn(`[CSVWatcher] arquivo não encontrado: ${filePath}`);
    return;
  }

  const instrumentId = await getOrCreateInstrumentId(symbol);

  // Lê as linhas brutas
  const rawText = fs.readFileSync(filePath, "utf8");
  let lines = rawText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (!lines.length) {
    logger.warn(`[CSVWatcher] ${path.basename(filePath)}: arquivo vazio`);
    return;
  }

  // Detecta delimitador (amostra)
  const sample = lines.slice(0, Math.min(lines.length, 10));
  const detected = detectDelimiter(sample);
  if (detected !== delimiter) {
    logger.info(
      `[CSVWatcher] ${path.basename(
        filePath
      )}: delimitador auto-detectado "${detected}" (preferido era "${delimiter}")`
    );
    delimiter = detected;
  }

  // Header: se a 1ª linha contiver header, usamos; caso contrário usamos headerCfg.
  let headerLine = lines[0];
  let hasHeader = /time|Time/.test(headerLine);
  let dataLines = hasHeader ? lines.slice(1) : lines.slice(0); // sem header no arquivo
  const headerNorm = hasHeader ? headerLine : headerCfg;
  const header = normalizeHeader(headerNorm);

  logger.info(
    `[CSVWatcher] ${path.basename(
      filePath
    )}: header usado = ${headerNorm}, registros = ${dataLines.length}`
  );

  if (!dataLines.length) {
    logger.warn(
      `[CSVWatcher] ${path.basename(
        filePath
      )}: nenhum registro parseado (delim="${delimiter}")`
    );
    return;
  }

  // Parse linhas para objetos (aceita colunas longas ou curtas)
  type RawRec = { [k: string]: string };
  const records: {
    time: Date;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }[] = [];

  for (const ln of dataLines) {
    const parts = ln.split(delimiter);
    if (parts.length < 6) continue;

    // tenta localizar índices conforme header
    const cols = hasHeader
      ? headerNorm.split(delimiter).map((s) => s.trim())
      : headerCfg.split(/[;,|\t]/).map((s) => s.trim());
    const lower = cols.map((c) => c.toLowerCase());

    function getVal(key: string, alias: string[]) {
      let idx = lower.findIndex((x) => x === key || alias.includes(x));
      if (idx === -1) {
        // fallback ao formato curto time,o,h,l,c,v
        const shortIdx = ["time", "o", "h", "l", "c", "v"].indexOf(key);
        idx = shortIdx >= 0 && shortIdx < parts.length ? shortIdx : -1;
      }
      return idx >= 0 ? parts[idx] : undefined;
    }

    const tStr = getVal("time", []);
    const oStr = getVal("open", ["o"]);
    const hStr = getVal("high", ["h"]);
    const lStr = getVal("low", ["l"]);
    const cStr = getVal("close", ["c"]);
    const vStr = getVal("volume", ["v"]);

    const t = tStr ? parseTimeToUTC(tStr, tzOffset) : null;
    const o = parseNum(oStr || "");
    const h = parseNum(hStr || "");
    const l = parseNum(lStr || "");
    const c = parseNum(cStr || "");
    const v = parseNum(vStr || "");

    if (!t || isNaN(o) || isNaN(h) || isNaN(l) || isNaN(c) || isNaN(v)) {
      continue;
    }
    records.push({ time: t, open: o, high: h, low: l, close: c, volume: v });
  }

  if (!records.length) {
    logger.warn(
      `[CSVWatcher] ${path.basename(
        filePath
      )}: nenhum registro válido após parse`
    );
    return;
  }

  // Muitos CSV do MT vêm ordenados do último para o primeiro -> reordena ASC (mais antigo -> mais novo)
  records.sort((a, b) => a.time.getTime() - b.time.getTime());

  // Upserts em transação (batch)
  const ops: any[] = [];
  for (const r of records) {
    ops.push(
      prisma.candle.upsert({
        where: {
          instrumentId_timeframe_time: {
            instrumentId,
            timeframe,
            time: r.time,
          },
        },
        update: {
          open: r.open,
          high: r.high,
          low: r.low,
          close: r.close,
          volume: r.volume,
        },
        create: {
          instrumentId,
          timeframe,
          time: r.time,
          open: r.open,
          high: r.high,
          low: r.low,
          close: r.close,
          volume: r.volume,
        },
        select: { id: true },
      })
    );
  }

  // executa em lotes para não estourar a transação
  const chunkSize = 500;
  let upserts = 0;
  for (let i = 0; i < ops.length; i += chunkSize) {
    const slice = ops.slice(i, i + chunkSize);
    const res = await prisma.$transaction(slice, { timeout: 60000 });
    upserts += res.length;
  }

  logger.info(
    `[CSVWatcher] ${path.basename(
      filePath
    )}: upserts=${upserts} (timeframe=${timeframe})`
  );

  // Agregação automática M1 -> M5/M15, se este arquivo é de M1
  if (timeframe === "M1") {
    const a5 = await aggregateFromM1(instrumentId, "M5");
    const a15 = await aggregateFromM1(instrumentId, "M15");
    logger.info(
      `[CSVWatcher] agregação: M5 upserts=${a5.upserts}, M15 upserts=${a15.upserts} (symbol=${symbol})`
    );
  }
}

// ------------------------------------------------------------
// Boot do watcher a partir do MT_CSV_WATCHERS (JSON)
// ------------------------------------------------------------
export function bootCsvWatchersIfConfigured() {
  let watchers: WatchCfg[] = [];
  try {
    const raw = process.env.MT_CSV_WATCHERS || "[]";
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      watchers = arr as WatchCfg[];
    }
  } catch (e) {
    logger.warn(
      "[CSVWatcher] MT_CSV_WATCHERS inválido (esperado JSON de objetos)."
    );
    watchers = [];
  }

  if (!watchers.length) {
    logger.info(
      "[CSVWatcher] nenhum watcher configurado (MT_CSV_WATCHERS vazio)."
    );
    return;
  }

  logger.info(
    "[CSVWatcher] Inicializando " + watchers.length + " watcher(s)..."
  );

  for (const w of watchers) {
    const filePath = w.filePath;
    if (!filePath) continue;

    const dir = path.dirname(filePath);
    const file = path.basename(filePath);

    logger.info(`[CSVWatcher] Watching dir: ${dir}\\ (file=${file})`);
    logger.info(
      `[CSVWatcher] Symbol=${w.symbol} Timeframe=${
        w.timeframe || DEF_TF
      } Delim="${w.delimiter || DEF_DELIM}" HeaderCfg="${
        w.header || DEF_HEADER
      }"`
    );
    logger.info(
      `[CSVWatcher] options: usePolling=true interval=1000 awaitWriteFinish(stability=750, poll=200)`
    );

    const watcher = chokidar.watch(dir, {
      persistent: true,
      ignoreInitial: false,
      usePolling: true,
      interval: 1000,
      awaitWriteFinish: { stabilityThreshold: 750, pollInterval: 200 },
      depth: 0,
    });

    const handle = async (changedPath: string) => {
      if (path.basename(changedPath) !== file) return;
      try {
        await importCsvFile(w);
      } catch (err: any) {
        logger.error("[CSVWatcher] erro ao importar", {
          err: err?.message || err,
        });
      }
    };

    watcher.on("add", handle);
    watcher.on("change", handle);

    // Import inicial (se o arquivo já existe)
    if (fs.existsSync(filePath)) {
      importCsvFile(w).catch((err) =>
        logger.error("[CSVWatcher] erro import inicial", {
          err: err?.message || err,
        })
      );
    }
  }
}
