/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { DateTime } = require("luxon");
const { PrismaClient } = require("@prisma/client"); // ✅ usa Prisma direto, sem TS
const prisma = new PrismaClient();

function detectDelimiter(line) {
  const sc = (line.match(/;/g) || []).length;
  const cc = (line.match(/,/g) || []).length;
  return sc > cc ? ";" : ",";
}

function parseHeader(headerLine, delim) {
  const cols = headerLine
    .split(delim)
    .map((s) => s.trim().toLowerCase().replace(/['"]/g, ""));
  const idx = {};
  for (let i = 0; i < cols.length; i++) {
    const c = cols[i];
    if (["time", "datetime", "timestamp", "date"].includes(c)) idx.time = i;
    else if (c === "open" || c === "o") idx.open = i;
    else if (c === "high" || c === "h") idx.high = i;
    else if (c === "low" || c === "l") idx.low = i;
    else if (c === "close" || c === "c") idx.close = i;
    else if (["volume", "vol"].includes(c)) idx.volume = i;
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
  const raw = String(s).trim().replace(/['"]/g, "");
  // ISO
  let dt = DateTime.fromISO(raw, { zone: "utc" });
  if (dt.isValid) return dt.toJSDate();
  // dd/MM/yyyy HH:mm[:ss]
  dt = DateTime.fromFormat(raw, "dd/LL/yyyy HH:mm:ss", { zone: "utc" });
  if (dt.isValid) return dt.toJSDate();
  dt = DateTime.fromFormat(raw, "dd/LL/yyyy HH:mm", { zone: "utc" });
  if (dt.isValid) return dt.toJSDate();
  // epoch
  if (/^\d{10,13}$/.test(raw)) {
    const n = Number(raw);
    return new Date(n < 1e12 ? n * 1000 : n);
  }
  // Date nativo
  const d = new Date(raw);
  if (!isNaN(d.getTime())) return d;
  throw new Error(`Não consegui interpretar data/hora: "${s}"`);
}

function inferSymbolAndTFFromFilename(filePath) {
  const base = path.basename(filePath);
  const clean = base.replace(/[\s-]/g, "");
  // WINM5.csv → WIN + 5
  let m = /^([A-Za-z]+)M?(\d+)\.csv$/i.exec(clean);
  if (!m) m = /^([A-Za-z]+)M?(\d+)/i.exec(clean);
  if (m) {
    const sym = m[1].toUpperCase();
    const mins = Number(m[2]);
    const tf = mins >= 60 ? `H${Math.round(mins / 60)}` : `M${mins}`;
    return { symbol: sym, timeframe: tf };
  }
  return {
    symbol: base.replace(/\..*$/, "").toUpperCase().slice(0, 3),
    timeframe: "M5",
  };
}

async function upsertInstrument(symbol) {
  const existed = await prisma.instrument.findFirst({ where: { symbol } });
  if (existed) return existed.id;
  const created = await prisma.instrument.create({ data: { symbol } });
  return created.id;
}

async function upsertCandle({ instrumentId, timeframe, row }) {
  const existing = await prisma.candle.findFirst({
    where: { instrumentId, time: row.time, timeframe: timeframe },
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

/** Importa um único arquivo CSV (streaming) */
async function importCsv(filePath) {
  if (!fs.existsSync(filePath))
    throw new Error(`Arquivo não encontrado: ${filePath}`);

  const { symbol, timeframe } = inferSymbolAndTFFromFilename(filePath);
  const instrumentId = await upsertInstrument(symbol);

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  let delim = ",";
  let headerIdx = null;
  let lineNo = 0;
  let inserted = 0;
  let updated = 0;

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
        continue; // ignora linha inválida
      }

      const r = await upsertCandle({ instrumentId, timeframe, row });
      if (r.action === "inserted") inserted++;
      else updated++;
    } catch {
      // ignora linha ruim
    } finally {
      lineNo++;
    }
  }

  const out = {
    ok: true,
    file: path.basename(filePath),
    symbol,
    timeframe,
    inserted,
    updated,
  };
  console.log(JSON.stringify({ msg: "[CSVImporter] concluído", ...out }));
  return out;
}

/** Exportações em estilos diferentes para maximizar compatibilidade com o watcher */
module.exports = importCsv; // default(filePath)
module.exports.default = importCsv; // ESModule default
module.exports.importCsv = importCsv; // nomeado
module.exports.handle = importCsv; // handler(filePath)
module.exports.run = importCsv; // run(filePath)
module.exports.importer = { importCsv, handle: importCsv, run: importCsv };
