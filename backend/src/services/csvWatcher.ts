/* eslint-disable no-console */
import fs from "fs";
import path from "path";
import chokidar from "chokidar";
import logger from "../logger";
import { bus } from "./events";
import { DateTime } from "luxon";                   // +++
import { processImportedRange } from "./pipeline";  // +++

function pick<T>(x: T | undefined | null, def: T): T {
  return x === undefined || x === null ? def : x;
}

type ImportFn = (fullPath: string) => Promise<any> | any; // <— deixa 'any' p/ pegar {symbol,timeframe,...} também

function tryPickExport(mod: any): ImportFn | null {
  if (!mod) return null;
  if (typeof mod.importCsvFile === "function") return mod.importCsvFile as ImportFn;
  if (typeof mod.importCandlesFromCsv === "function") return mod.importCandlesFromCsv as ImportFn;
  if (typeof mod.importCsv === "function") return mod.importCsv as ImportFn;
  if (typeof mod.loadCsv === "function") return mod.loadCsv as ImportFn;
  if (typeof mod.default === "function") return mod.default as ImportFn;
  return null;
}

function parseImporterEnv(
  s: string
): { modulePath: string; exportName?: string } | null {
  if (!s) return null;
  const [m, e] = s.split("#");
  return { modulePath: m, exportName: e || undefined };
}

async function resolveImporter(): Promise<ImportFn | null> {
  const fromEnv = parseImporterEnv(process.env.CSV_IMPORTER || "");
  if (fromEnv?.modulePath) {
    try {
      const baseDir = path.resolve(__dirname, "..");
      const resolved = require.resolve(path.resolve(baseDir, fromEnv.modulePath));
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require(resolved);
      if (fromEnv.exportName) {
        const fn = mod?.[fromEnv.exportName];
        if (typeof fn === "function") return fn as ImportFn;
      } else {
        const fn = tryPickExport(mod);
        if (fn) return fn;
      }
      logger?.warn?.(
        `[CSVWatcher] CSV_IMPORTER encontrado mas não expõe função válida: ${process.env.CSV_IMPORTER}`
      );
    } catch (e: any) {
      logger?.warn?.(
        `[CSVWatcher] Falha ao carregar CSV_IMPORTER ${process.env.CSV_IMPORTER}: ${e?.message || e}`
      );
    }
  }

  const candidates = ["../lib/csvImporter", "../lib/csvLoader", "../services/csvImport"];
  for (const rel of candidates) {
    try {
      const baseDir = path.resolve(__dirname, "..");
      const resolved = require.resolve(path.resolve(baseDir, rel));
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require(resolved);
      const fn = tryPickExport(mod);
      if (fn) return fn;
    } catch {
      /* segue tentando */
    }
  }

  logger?.warn?.(
    "[CSVWatcher] Nenhum importador encontrado — defina CSV_IMPORTER ou adicione um módulo esperado."
  );
  return null;
}

/** ----- helpers p/ pós-importação -> Trades ----- */
// tenta extrair {symbol,timeframe} do retorno do importador ou do nome do arquivo (ex: WINM5.csv, WDOM1.csv)
function inferSymbolAndTf(fileFullPath: string, importerResult: any): { symbol?: string; timeframe?: string } {
  const out: { symbol?: string; timeframe?: string } = {};
  if (importerResult && typeof importerResult === "object") {
    if (importerResult.symbol) out.symbol = String(importerResult.symbol).toUpperCase();
    if (importerResult.timeframe) out.timeframe = String(importerResult.timeframe).toUpperCase();
  }
  if (!out.symbol || !out.timeframe) {
    const base = path.basename(fileFullPath);
    // Formatos comuns: WINM5.csv | WDOM1.csv | PETRH1.csv etc.
    const m = /^([A-Za-z]+)(M\d+|H\d+)\.csv$/i.exec(base);
    if (m) {
      if (!out.symbol) out.symbol = m[1].toUpperCase();
      if (!out.timeframe) out.timeframe = m[2].toUpperCase();
    }
  }
  return out;
}

async function runTradesPipelineForToday(symbol: string, timeframe: string) {
  const ZONE_BR = "America/Sao_Paulo";
  const now = DateTime.now().setZone(ZONE_BR);
  const from = now.startOf("day").toUTC().toJSDate();
  const to = now.endOf("day").toUTC().toJSDate();

  try {
    const r = await processImportedRange({ symbol, timeframe: timeframe.toUpperCase(), from, to });
    logger?.info?.("[CSVWatcher] pipeline Trades pós-importação OK", {
      symbol,
      timeframe,
      processedSignals: r?.processedSignals,
      tradesTouched: r?.tradesTouched,
      tp: r?.tp,
      sl: r?.sl,
      none: r?.none,
      ms: r?.ms,
    });
    // avisa a UI (se você já estiver escutando algo assim)
    bus?.emit?.("ai:data-invalidated", { symbol, timeframe, scope: "trades" });
    // também mantemos o evento que sua UI já escuta (caso seja esse o nome)
    bus?.emit?.("daytrade:data-invalidate", { symbol, timeframe });
  } catch (e: any) {
    logger?.warn?.("[CSVWatcher] falha no pipeline Trades pós-importação", {
      symbol,
      timeframe,
      err: e?.message || e,
    });
  }
}

export async function bootCsvWatchersIfConfigured() {
  const dir =
    process.env.DADOS_DIR ||
    process.env.CSV_DIR ||
    path.resolve(process.cwd(), "dados");

  const polling = pick(process.env.CSV_WATCH_POLLING === "false" ? false : true, true);
  const filesEnv = (process.env.CSV_FILES || "WINM1.csv,WDOM1.csv")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const importer = await resolveImporter();

  logger?.info?.(
    `[CSVWatcher] Inicializando watcher(s)... dir="${dir}" files=[${filesEnv.join(
      ", "
    )}] polling=${polling} hasImporter=${!!importer}`
  );

  for (const fname of filesEnv) {
    const full = path.resolve(dir, fname);
    const exists = fs.existsSync(full);
    logger?.info?.(
      `[CSVWatcher] pronto para "${fname}" em "${dir}" (polling=${polling}, exists=${exists ? "yes" : "no"})`
    );

    const watcher = chokidar.watch(full, {
      persistent: true,
      ignoreInitial: false,
      usePolling: polling,
      interval: 1000,
      binaryInterval: 1500,
      awaitWriteFinish: {
        stabilityThreshold: 1500,
        pollInterval: 250,
      },
    });

    const processFile = async (event: "add" | "change" | "rename") => {
      try {
        (global as any).__CSV_IMPORTING = true;
        bus?.emit?.("import:begin", { file: full, event });

        if (importer) {
          bus?.emit?.("import:progress", { file: full, event, progress: 10 });

          const r = await importer(full);

          bus?.emit?.("import:done", { file: full, event, result: r || null });
          logger?.info?.(
            `[CSVWatcher] import concluído file="${full}" result=${JSON.stringify(r || null)}`
          );

          // >>> NOVO: aciona pipeline de Trades automaticamente (dia atual)
          const { symbol, timeframe } = inferSymbolAndTf(full, r || {});
          if (symbol && timeframe) {
            await runTradesPipelineForToday(symbol, timeframe);
          } else {
            logger?.warn?.(
              "[CSVWatcher] não foi possível inferir symbol/timeframe para rodar pipeline pós-importação",
              { file: full, importerResult: r }
            );
          }
        } else {
          logger?.warn?.(
            `[CSVWatcher] mudança detectada em "${path.basename(
              full
            )}", mas nenhum importador está configurado.`
          );
        }
      } catch (e: any) {
        const msg = e?.message || String(e);
        logger?.error?.(`[CSVWatcher] erro ao processar "${full}": ${msg}`);
        bus?.emit?.("import:error", { file: full, error: msg });
      } finally {
        (global as any).__CSV_IMPORTING = false; // +++ garante reset do flag
      }
    };

    watcher
      .on("add", () => processFile("add"))
      .on("change", () => processFile("change"))
      .on("rename", () => processFile("rename"))
      .on("error", (err) => {
        const msg = (err as any)?.message || String(err);
        logger?.error?.(`[CSVWatcher] erro watcher "${full}": ${msg}`);
      });
  }
}
