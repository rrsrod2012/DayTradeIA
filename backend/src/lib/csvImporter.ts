/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { DateTime } = require("luxon");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

// Tenta carregar o eventBus; se não existir, cai em no-op
let eventBus = null;
try {
  const eb = require("../services/events");
  eventBus = eb?.eventBus || eb?.default || null;
} catch (_) {
  eventBus = null;
}
const emit = (type, payload) => {
  if (!eventBus) return;
  try {
    eventBus.emit(type, payload);
  } catch {}
};

// ---------- Utils ----------
function detectDelimiter(line) {
  const sc = (line.match(/;/g) || []).length;
  const cc = (line.match(/,/g) || []).length;
  const tc = (line.match(/\t/g) || []).length;
  // prioriza ;, depois , e por último \t
  if (sc >= cc && sc >= tc) return ";";
  if (cc >= tc) return ",";
  return "\t";
}

function parseHeader(headerLine, delim) {
  const cols = headerLine.split(delim).map((s) =>
    String(s)
      .trim()
      .toLowerCase()
      .replace(/[“”"']/g, "")
      .replace(/\s+/g, "")
  );
  const idx = {};
  for (let i = 0; i < cols.length; i++) {
    const c = cols[i];
    if (["time", "datetime", "timestamp", "date"].includes(c)) idx.time = i;
    else if (c === "open" || c === "o" || c === "abertura") idx.open = i;
    else if (c === "high" || c === "h" || c === "max" || c === "alta")
      idx.high = i;
    else if (c === "low" || c === "l" || c === "min" || c === "baixa")
      idx.low = i;
    else if (c === "close" || c === "c" || c === "fechamento") idx.close = i;
    else if (["volume", "vol", "v"].includes(c)) idx.volume = i;
  }
  for (const r of ["time", "open", "high", "low", "close"]) {
    if (typeof idx[r] !== "number") {
      throw new Error(
        `Cabeçalho CSV precisa ter coluna '${r}' (detectei: ${cols.join(", ")})`
      );
    }
  }
  return idx;
}

function parseDateFlexible(s) {
  const raw = String(s)
    .trim()
    .replace(/[“”"']/g, "");
  // ISO (com ou sem Z)
  let dt = DateTime.fromISO(raw, { zone: "utc" });
  if (dt.isValid) return dt.toJSDate();
  // MT5: YYYY.MM.DD HH:mm[:ss]
  dt = DateTime.fromFormat(raw, "yyyy.LL.dd HH:mm:ss", { zone: "utc" });
  if (dt.isValid) return dt.toJSDate();
  dt = DateTime.fromFormat(raw, "yyyy.LL.dd HH:mm", { zone: "utc" });
  if (dt.isValid) return dt.toJSDate();
  // dd/MM/yyyy HH:mm[:ss]
  dt = DateTime.fromFormat(raw, "dd/LL/yyyy HH:mm:ss", { zone: "utc" });
  if (dt.isValid) return dt.toJSDate();
  dt = DateTime.fromFormat(raw, "dd/LL/yyyy HH:mm", { zone: "utc" });
  if (dt.isValid) return dt.toJSDate();
  // epoch (segundos ou ms)
  if (/^\d{10,13}$/.test(raw)) {
    const n = Number(raw);
    return new Date(n < 1e12 ? n * 1000 : n);
  }
  // Date nativo (última tentativa)
  const d = new Date(raw);
  if (!isNaN(d.getTime())) return d;
  throw new Error(`Não consegui interpretar data/hora: "${s}"`);
}

/**
 * WINM5.csv  → { symbol: "WIN", timeframe: "M5" }
 * WDOM5.csv  → { symbol: "WDO", timeframe: "M5" }
 * WINH1.csv  → { symbol: "WIN", timeframe: "H1" }
 */
function inferSymbolAndTFFromFilename(filePath) {
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
  // fallback conservador
  return {
    symbol: clean.slice(0, 3),
    timeframe: "M5",
  };
}

async function upsertInstrument(symbol) {
  // garante 'name' conforme seu schema
  const existed = await prisma.instrument.findFirst({ where: { symbol } });
  if (existed) return existed.id;
  const created = await prisma.instrument.create({
    data: { symbol, name: symbol },
  });
  return created.id;
}

async function upsertCandle({ instrumentId, timeframe, row }) {
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
    return { id: existing.id, action: "updated" };
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
    return { id: created.id, action: "inserted" };
  }
}

async function countLines(filePath) {
  try {
    let total = 0;
    await new Promise((resolve, reject) => {
      const s = fs.createReadStream(filePath);
      s.on("data", (buf) => {
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

// ---------- Import principal ----------
async function importCsv(filePath) {
  if (!fs.existsSync(filePath))
    throw new Error(`Arquivo não encontrado: ${filePath}`);

  const t0 = Date.now();
  const file = path.basename(filePath);
  const { symbol, timeframe } = inferSymbolAndTFFromFilename(filePath);
  const instrumentId = await upsertInstrument(symbol);

  // total de linhas para a barra (tenta subtrair 1 do cabeçalho)
  const totalLines = await countLines(filePath);
  const total =
    totalLines && totalLines > 0 ? Math.max(0, totalLines - 1) : totalLines;

  emit("import:started", { file, symbol, timeframe, total });

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  let delim = ",";
  let headerIdx = null;
  let lineNo = 0;
  let processed = 0;
  let inserted = 0;
  let updated = 0;
  let lastEmit = Date.now();

  for await (const rawLine of rl) {
    const line = String(rawLine).trim();
    if (!line) continue;

    if (lineNo === 0) {
      delim = detectDelimiter(line);
      headerIdx = parseHeader(line, delim);
      lineNo++;
      continue;
    }

    const parts = line.split(delim).map((s) => s.trim());
    try {
      const get = (name) => parts[headerIdx[name]] ?? "";
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
          total && total > 0
            ? Math.max(0, Math.min(100, Math.round((processed / total) * 100)))
            : null;
        emit("import:progress", {
          file,
          symbol,
          timeframe,
          processed,
          total,
          pct,
        });
      }
    }
  }

  const durationMs = Date.now() - t0;
  emit("import:done", {
    file,
    symbol,
    timeframe,
    processed,
    total,
    durationMs,
  });

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
  console.log(JSON.stringify({ msg: "[CSVImporter] concluído", ...out }));
  return out;
}

// ---------- Exports (mantidos) ----------
module.exports = importCsv; // default(filePath)
module.exports.default = importCsv; // ESModule default
module.exports.importCsv = importCsv; // nomeado
module.exports.handle = importCsv; // handler(filePath)
module.exports.run = importCsv; // run(filePath)
module.exports.importer = { importCsv, handle: importCsv, run: importCsv };
