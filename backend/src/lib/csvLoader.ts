import fs from "fs";
import path from "path";

// Diretório dos CSVs — pode sobrescrever via env
const CSV_DIR = process.env.CSV_DIR || path.resolve(process.cwd(), "dados"); // ex.: C:\tmp\daytrade-ia\dados

export type CsvCandle = {
  time: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

function parseMaybeNumber(x: any): number | undefined {
  const n = Number(x);
  return Number.isFinite(n) ? n : undefined;
}

function parseTime(s: string): Date | null {
  // Aceita ISO (…Z) ou "YYYY-MM-DD HH:mm:ss" (assume UTC)
  if (!s) return null;
  const isoLike = /^\d{4}-\d{2}-\d{2}T/.test(s);
  if (isoLike) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }
  // tenta "YYYY-MM-DD HH:mm:ss"
  if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(s)) {
    const s2 = s.replace(" ", "T") + "Z";
    const d = new Date(s2);
    return isNaN(d.getTime()) ? null : d;
  }
  // tenta timestamp numérico (ms)
  if (/^\d+$/.test(s)) {
    const d = new Date(Number(s));
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

export function csvPathFor(symbol: string, timeframe: string): string {
  const fname = `${symbol.toUpperCase()}${timeframe.toUpperCase()}.csv`;
  return path.join(CSV_DIR, fname);
}

export function fileExists(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export function loadCandlesFromCsv(
  symbol: string,
  timeframe: string,
  range?: { gte?: Date; lte?: Date }
): CsvCandle[] {
  const p = csvPathFor(symbol, timeframe);
  if (!fileExists(p)) {
    return [];
  }
  const raw = fs.readFileSync(p, "utf8");

  // Parser simples (CSV com cabeçalho time,open,high,low,close,volume)
  // Suporta vírgula como separador e linhas em branco
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length <= 1) return [];

  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const idx = {
    time: header.indexOf("time"),
    open: header.indexOf("open"),
    high: header.indexOf("high"),
    low: header.indexOf("low"),
    close: header.indexOf("close"),
    volume: header.indexOf("volume"),
  };
  if (
    idx.time < 0 ||
    idx.open < 0 ||
    idx.high < 0 ||
    idx.low < 0 ||
    idx.close < 0
  ) {
    return [];
  }

  const out: CsvCandle[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    const t = parseTime(cols[idx.time]?.trim?.());
    if (!t) continue;

    if (range?.gte && t < range.gte) continue;
    if (range?.lte && t > range.lte) continue;

    const open = parseMaybeNumber(cols[idx.open]);
    const high = parseMaybeNumber(cols[idx.high]);
    const low = parseMaybeNumber(cols[idx.low]);
    const close = parseMaybeNumber(cols[idx.close]);
    const volume =
      idx.volume >= 0 ? parseMaybeNumber(cols[idx.volume]) : undefined;

    if (open == null || high == null || low == null || close == null) {
      continue;
    }
    out.push({ time: t, open, high, low, close, volume });
  }

  return out.sort((a, b) => a.time.getTime() - b.time.getTime());
}
