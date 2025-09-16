/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { DateTime } = require("luxon");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

// Timezone dos CSVs (ex.: "America/Sao_Paulo")
const CSV_TZ = process.env.CSV_TIMEZONE || "America/Sao_Paulo";

// Tenta carregar o eventBus; se não existir, cai em no-op
let eventBus = null;
try {
  const eb = require("../services/events");
  eventBus = eb?.eventBus || eb?.default || null;
} catch (_) {
  eventBus = null;
}

async function upsertInstrument(symbol: string) {
  const s = String(symbol || "").trim().toUpperCase();
  if (!s) throw new Error("Símbolo inválido");
  const existing = await prisma.instrument.findFirst({
    where: { symbol: s },
    select: { id: true },
  });
  if (existing) return existing.id;
  const created = await prisma.instrument.create({
    data: { symbol: s, name: s },
    select: { id: true },
  });
  return created.id;
}

async function upsertCandle({
  instrumentId,
  timeframe,
  row,
}: {
  instrumentId: number;
  timeframe: string;
  row: {
    time: Date;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number | null;
  };
}) {
  const existing = await prisma.candle.findFirst({
    where: { instrumentId, time: row.time, timeframe },
    select: { id: true },
  });

  if (existing) {
    await prisma.candle.update({
      where: { id: existing.id },
      data: {
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume,
      },
    });
    return { id: existing.id, action: "updated" as const };
  } else {
    const created = await prisma.candle.create({
      data: {
        instrumentId,
        timeframe,
        time: row.time,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume,
      },
      select: { id: true },
    });
    return { id: created.id, action: "inserted" as const };
  }
}

async function countLines(filePath: string) {
  try {
    let total = 0;
    await new Promise((resolve, reject) => {
      const s = fs.createReadStream(filePath);
      s.on("data", (buf: Buffer) => {
        let i = -1;
        total--;
        do {
          i = buf.indexOf(10, i + 1); // \n
          total++;
        } while (i !== -1);
      });
      s.on("end", resolve);
      s.on("error", reject);
    });
    return Math.max(0, total);
  } catch {
    return null;
  }
}

/** WINM5.csv → { symbol: "WIN", timeframe: "M5" } */
function inferSymbolAndTFFromFilename(filePath: string) {
  const base = path.basename(filePath).replace(/\.[^.]+$/, "");
  const clean = base.replace(/[\s_-]+/g, "").toUpperCase();
  const m = /(M|H)?(\d+)$/.exec(clean);
  if (m) {
    const unit = m[1] || "M";
    const n = Number(m[2]);
    const timeframe = `${unit}${n}`;
    const symbol = clean.slice(0, m.index);
    return { symbol, timeframe };
  }
  return { symbol: clean.slice(0, 3), timeframe: "M5" };
}

function detectDelimiter(firstLine: string) {
  if (firstLine.includes(";")) return ";";
  if (firstLine.includes(",")) return ",";
  if (firstLine.includes("\t")) return "\t";
  return ",";
}

function parseDateFlexible(s: string) {
  const raw = String(s).trim().replace(/[“”"']/g, "");
  const hasOffset = /[zZ]$|[+-]\d{2}:\d{2}$/.test(raw);

  // 1) ISO
  let dt = hasOffset
    ? DateTime.fromISO(raw, { setZone: true }) // respeita 'Z' ou offset presente
    : DateTime.fromISO(raw, { zone: CSV_TZ }); // sem offset → CSV_TZ

  if (dt.isValid) return dt.toUTC().toJSDate();

  // 2) MT5: YYYY.MM.DD HH:mm[:ss]
  dt = DateTime.fromFormat(raw, "yyyy.LL.dd HH:mm:ss", { zone: CSV_TZ });
  if (dt.isValid) return dt.toUTC().toJSDate();
  dt = DateTime.fromFormat(raw, "yyyy.LL.dd HH:mm", { zone: CSV_TZ });
  if (dt.isValid) return dt.toUTC().toJSDate();

  // 3) BR: dd/MM/yyyy HH:mm[:ss]
  dt = DateTime.fromFormat(raw, "dd/LL/yyyy HH:mm:ss", { zone: CSV_TZ });
  if (dt.isValid) return dt.toUTC().toJSDate();
  dt = DateTime.fromFormat(raw, "dd/LL/yyyy HH:mm", { zone: CSV_TZ });
  if (dt.isValid) return dt.toUTC().toJSDate();

  // 4) epoch
  if (/^\d{10,13}$/.test(raw)) {
    const n = Number(raw);
    return new Date(n < 1e12 ? n * 1000 : n);
  }

  // 5) fallback
  const d = new Date(raw);
  if (!isNaN(d.getTime())) return d;

  throw new Error(`Não consegui interpretar data/hora: "${s}"`);
}

function findHeaderIndexes(header: string, delim = ",") {
  const cols = header.split(delim).map((s) => s.trim().toLowerCase());
  const idx = {
    time: -1,
    open: -1,
    high: -1,
    low: -1,
    close: -1,
    volume: -1,
  };
  for (let i = 0; i < cols.length; i++) {
    const c = cols[i];
    if (idx.time < 0 && /^(time|date|datetime|data|hora)$/i.test(c)) idx.time = i;
    if (idx.open < 0 && /^open$/i.test(c)) idx.open = i;
    if (idx.high < 0 && /^high$/i.test(c)) idx.high = i;
    if (idx.low < 0 && /^low$/i.test(c)) idx.low = i;
    if (idx.close < 0 && /^close$/i.test(c)) idx.close = i;
    if (idx.volume < 0) {
      if (/^(volume|vol|tickvol)$/i.test(c)) idx.volume = i;
    }
  }
  return idx;
}

/** Tenta inferir se a 1ª linha é dado (headerless) do MT5 */
function looksLikeDataRow(line: string, delim: string) {
  const parts = line.split(delim).map((s) => s.trim());
  if (parts.length < 5) return false;
  // primeira coluna: data/hora (yyyy.MM.dd HH:mm[:ss] ou ISO)
  try {
    parseDateFlexible(parts[0]);
  } catch {
    return false;
  }
  // colunas seguintes: números
  for (let i = 1; i <= 4; i++) {
    if (!/^-?\d+(\.\d+)?$/.test(parts[i])) return false;
  }
  // volume (se existir) também numérico
  if (parts[5] != null && parts[5] !== "" && !/^\d+(\.\d+)?$/.test(parts[5]))
    return false;
  return true;
}

/* ------------------ Import principal ------------------ */
async function importCsv(filePath: string) {
  if (!fs.existsSync(filePath))
    throw new Error(`Arquivo não encontrado: ${filePath}`);

  const t0 = Date.now();
  const file = path.basename(filePath);
  const { symbol, timeframe } = inferSymbolAndTFFromFilename(filePath);

  // ---- Guardrail opcional: aceitar apenas CSVs M1 quando IMPORT_M1_ONLY=true
  const __M1_ONLY = String(process.env.IMPORT_M1_ONLY || "").toLowerCase() === "true";
  if (__M1_ONLY && timeframe !== "M1") {
    const totalLines = await countLines(filePath);
    try {
      eventBus?.emit?.("csv:skipped", {
        file,
        symbol,
        timeframe,
        reason: "IMPORT_M1_ONLY",
        total: totalLines ?? null,
      });
    } catch { }
    const durationMs = Date.now() - t0;
    const outSkip = {
      ok: true,
      skipped: true,
      reason: "IMPORT_M1_ONLY",
      file,
      symbol,
      timeframe,
      inserted: 0,
      updated: 0,
      processed: 0,
      total: totalLines ?? 0,
      durationMs,
    };
    console.warn(JSON.stringify({ msg: "[CSVImporter] ignorado IMPORT_M1_ONLY", ...outSkip }));
    return outSkip;
  }

  const instrumentId = await upsertInstrument(symbol);

  const totalLines = await countLines(filePath);

  console.log(
    JSON.stringify({
      msg: "[CSVImporter] iniciando",
      file,
      instrumentId,
      symbol,
      timeframe,
      totalLines,
      CSV_TZ,
    })
  );

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });

  let inserted = 0;
  let updated = 0;
  let processed = 0;
  let total = totalLines || 0;
  let lineNo = 0;

  let header = "";
  let delim = ",";
  let headerIdx = {
    time: -1,
    open: -1,
    high: -1,
    low: -1,
    close: -1,
    volume: -1,
  };
  let headerIsData = false;

  let lastEmit = Date.now();

  for await (const lineRaw of rl) {
    const line = String(lineRaw || "").trim();
    if (!line) continue;

    if (lineNo === 0) {
      delim = detectDelimiter(line);
      // Se a primeira linha parece dado (MT5 headerless), não trate como header
      if (looksLikeDataRow(line, delim)) {
        headerIsData = true;
        // fallback de índices padrão: time, open, high, low, close, (volume)
        headerIdx = { time: 0, open: 1, high: 2, low: 3, close: 4, volume: 5 };
      } else {
        header = line;
        headerIdx = findHeaderIndexes(header, delim);
        // se não localizou colunas essenciais, tente tratar como dado mesmo assim
        if (
          headerIdx.time < 0 ||
          headerIdx.open < 0 ||
          headerIdx.high < 0 ||
          headerIdx.low < 0 ||
          headerIdx.close < 0
        ) {
          if (looksLikeDataRow(header, delim)) {
            headerIsData = true;
            headerIdx = { time: 0, open: 1, high: 2, low: 3, close: 4, volume: 5 };
          } else {
            throw new Error(
              `Cabeçalho inválido para candles (esperado time/open/high/low/close[/(volume)]): "${header}"`
            );
          }
        }
      }

      // Se a primeira linha já é dado, caímos para o processamento dela
      if (!headerIsData) {
        lineNo++;
        continue;
      }
    }

    const parts = line.split(delim).map((s) => s.trim());

    try {
      const get = (name: keyof typeof headerIdx) => {
        const i = headerIdx[name];
        return i >= 0 ? parts[i] ?? "" : "";
      };
      const row = {
        time: parseDateFlexible(get("time")),
        open: Number(get("open")),
        high: Number(get("high")),
        low: Number(get("low")),
        close: Number(get("close")),
        volume: get("volume") === "" ? null : Number(get("volume")),
      };

      if (
        !isFinite(row.open) ||
        !isFinite(row.high) ||
        !isFinite(row.low) ||
        !isFinite(row.close) ||
        !(row.time instanceof Date) ||
        isNaN(row.time.getTime())
      ) {
        // ignora linha inválida
      } else {
        const r = await upsertCandle({ instrumentId, timeframe, row });
        if (r.action === "inserted") inserted++;
        else updated++;
      }
    } catch {
      // ignora linha ruim
    } finally {
      lineNo++;
      processed++;

      const now = Date.now();
      if (processed % 500 === 0 || now - lastEmit > 250) {
        lastEmit = now;
        const pct =
          total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
        try {
          eventBus?.emit?.("csv:progress", {
            file,
            symbol,
            timeframe,
            processed,
            total,
            pct,
          });
        } catch { }
        console.log(
          JSON.stringify({
            msg: "[CSVImporter] progress",
            file,
            processed,
            total,
            pct,
          })
        );
      }
    }
  }

  const durationMs = Date.now() - t0;
  const out = {
    ok: true,
    file,
    symbol,
    timeframe,
    inserted,
    updated,
    processed,
    total,
    durationMs,
  };

  // ---- Gatilho opcional: rodar uma passada do AutoTrainer imediatamente
  try {
    const POKE = String(process.env.AUTO_TRAINER_POKE_ON_IMPORT || "").toLowerCase() === "true";
    if (POKE) {
      const at = require("../workers/autoTrainer");
      const runOnce =
        at?.runOnce ||
        at?.pokeAutoTrainer || // fallback se existir com outro nome
        (typeof at === "function" ? at : null);
      if (typeof runOnce === "function") {
        console.log(JSON.stringify({ msg: "[CSVImporter] AUTO_TRAINER_POKE_ON_IMPORT → runOnce" }));
        await runOnce();
      }
    }
  } catch (err) {
    console.warn(
      JSON.stringify({
        msg: "[CSVImporter] erro ao acionar AutoTrainer",
        err: String((err && err.message) || err),
      })
    );
  }

  console.log(JSON.stringify({ msg: "[CSVImporter] concluído", ...out }));
  return out;
}

// ---------- Exports (mantidos) ----------
module.exports = importCsv;
module.exports.default = importCsv;
module.exports.importCsv = importCsv;
module.exports.handle = importCsv;
module.exports.run = importCsv;
module.exports.importer = { importCsv, handle: importCsv, run: importCsv };
