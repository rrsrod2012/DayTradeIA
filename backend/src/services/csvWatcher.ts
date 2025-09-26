/* eslint-disable no-console */
import fs from "fs";
import path from "path";
import chokidar from "chokidar";
import logger from "../logger";
import { bus } from "./events";
import { DateTime } from "luxon";
import { processImportedRange } from "./pipeline";
import { getRuntimeConfig } from "./runtimeConfig"; // requer o runtimeConfig.ts leve

function pick<T>(x: T | undefined | null, def: T): T {
  return x === undefined || x === null ? def : x;
}

// permite passar opções (ex: timeframe) sem quebrar importadores que ignorem args extras
type ImportFn = (fullPath: string, opts?: { timeframe?: string }) => Promise<any> | any;

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
// extrai apenas o símbolo do nome do arquivo, ignorando TF
function inferSymbolFromFilename(fileFullPath: string): string | undefined {
  const base = path.basename(fileFullPath);
  // formatos: WINM5.csv | WDOM1.csv | PETRH1.csv
  const m = /^([A-Za-z]+)(M\d+|H\d+)\.csv$/i.exec(base);
  if (m) return m[1].toUpperCase();
  // fallback: WIN.csv
  const m2 = /^([A-Za-z]+)\.csv$/i.exec(base);
  if (m2) return m2[1].toUpperCase();
  return undefined;
}

async function runTradesPipelineForToday(symbol: string) {
  const ZONE_BR = "America/Sao_Paulo";
  const nowBR = DateTime.now().setZone(ZONE_BR);
  const day = nowBR.startOf("day").toJSDate();

  // TF da UI tem prioridade; fallback para ENV/UI_DEFAULT_TF ou M1
  const uiCfg = (typeof getRuntimeConfig === "function" ? getRuntimeConfig() : {}) as any;
  const uiTf = (uiCfg?.uiTimeframe || process.env.UI_DEFAULT_TF || "M1").toUpperCase();

  try {
    const r = await processImportedRange({
      symbol,
      timeframe: uiTf, // usar TF escolhido na UI
      day,             // dia atual (o pipeline expande para [startOfDay, endOfDay])
    });

    logger?.info?.("[CSVWatcher] pipeline Trades pós-importação OK", {
      symbol,
      timeframe: uiTf,
      processedSignals: (r as any)?.processedSignals,
      tradesTouched: (r as any)?.tradesTouched,
      tp: (r as any)?.tp,
      sl: (r as any)?.sl,
      none: (r as any)?.none,
      ms: (r as any)?.ms,
    });

    // avisos p/ UI
    bus?.emit?.("ai:data-invalidated", { symbol, timeframe: uiTf, scope: "trades" });
    bus?.emit?.("daytrade:data-invalidate", { symbol, timeframe: uiTf });
  } catch (e: any) {
    logger?.warn?.("[CSVWatcher] falha no pipeline Trades pós-importação", {
      symbol,
      timeframe: uiTf,
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

  // TF que vai ser pedido ao importador (preferência: CSV_FORCE_TF -> CSV_TF -> "M1")
  const importTF = (process.env.CSV_FORCE_TF || process.env.CSV_TF || "M1").toUpperCase();

  logger?.info?.(
    `[CSVWatcher] Inicializando watcher(s)... dir="${dir}" files=[${filesEnv.join(
      ", "
    )}] polling=${polling} hasImporter=${!!importer} importTF=${importTF}`
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

          // IMPORTA no TF definido (default M1). Se o importador ignorar opts, ainda pode ler CSV_FORCE_TF/CSV_TF do process.env
          const r = await importer(full, { timeframe: importTF });

          bus?.emit?.("import:done", { file: full, event, result: r || null });
          logger?.info?.(
            `[CSVWatcher] import concluído file="${full}" result=${JSON.stringify(r || null)}`
          );

          // Pós-import: descobre símbolo e roda pipeline usando TF da UI
          const symbol = (r?.symbol
            ? String(r.symbol).toUpperCase()
            : inferSymbolFromFilename(full)) as string | undefined;

          if (symbol) {
            await runTradesPipelineForToday(symbol);
          } else {
            logger?.warn?.(
              "[CSVWatcher] não foi possível inferir symbol para rodar pipeline pós-importação",
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
        (global as any).__CSV_IMPORTING = false;
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
