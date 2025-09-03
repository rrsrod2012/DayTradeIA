/* eslint-disable no-console */
import fs from "fs";
import path from "path";
import chokidar from "chokidar";
import logger from "../logger";

/**
 * Observa arquivos CSV e, quando modificados, tenta reimportá-los.
 *
 * Como diferentes projetos usam nomes/caminhos distintos para o importador de CSV,
 * aqui fazemos uma RESOLUÇÃO DINÂMICA em tempo de execução:
 *
 * - Tenta carregar, nesta ordem (primeira função encontrada vence):
 *   1) process.env.CSV_IMPORTER (ex.: "../lib/csvImporter#importCsvFile")
 *   2) ../lib/csvImporter (export default ou named importCsvFile / importCandlesFromCsv / importCsv)
 *   3) ../lib/csvLoader   (mesma heurística de nomes)
 *   4) ../services/csvImport (mesma heurística de nomes)
 *
 * Se nada for encontrado, apenas LOGA um aviso e NÃO interrompe o servidor.
 *
 * Variáveis de ambiente:
 * - DADOS_DIR: diretório onde ficam os CSVs (ex.: C:\tmp\daytrade-ia\dados)
 * - CSV_FILES: lista separada por vírgula dos arquivos a observar (default: WINM1.csv,WINM5.csv,WDOM1.csv,WDOM5.csv)
 * - CSV_WATCH_POLLING=true/false (default: true no Windows)
 * - CSV_IMPORTER="caminho#exportName" (opcional, para apontar explicitamente quem importa)
 */

function pick<T>(x: T | undefined | null, def: T): T {
  return x === undefined || x === null ? def : x;
}

type ImportFn = (fullPath: string) => Promise<number | void> | number | void;

function tryPickExport(mod: any): ImportFn | null {
  if (!mod) return null;
  // named
  if (typeof mod.importCsvFile === "function")
    return mod.importCsvFile as ImportFn;
  if (typeof mod.importCandlesFromCsv === "function")
    return mod.importCandlesFromCsv as ImportFn;
  if (typeof mod.importCsv === "function") return mod.importCsv as ImportFn;
  if (typeof mod.loadCsv === "function") return mod.loadCsv as ImportFn;
  // default
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
  // 1) CSV_IMPORTER explícito
  const fromEnv = parseImporterEnv(process.env.CSV_IMPORTER || "");
  if (fromEnv?.modulePath) {
    try {
      // caminho relativo a este arquivo
      const baseDir = path.resolve(__dirname, "..");
      const resolved = require.resolve(
        path.resolve(baseDir, fromEnv.modulePath)
      );
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
        "[CSVWatcher] CSV_IMPORTER encontrado mas não expõe função válida: %s",
        process.env.CSV_IMPORTER
      );
    } catch (e: any) {
      logger?.warn?.(
        "[CSVWatcher] Falha ao carregar CSV_IMPORTER %s: %s",
        process.env.CSV_IMPORTER,
        e?.message || e
      );
    }
  }

  // 2..4) Heurística por caminhos comuns
  const candidates = [
    "../lib/csvImporter",
    "../lib/csvLoader",
    "../services/csvImport",
  ];
  for (const c of candidates) {
    try {
      const resolved = require.resolve(path.resolve(__dirname, c));
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require(resolved);
      const fn = tryPickExport(mod);
      if (fn) {
        logger?.info?.("[CSVWatcher] Importador CSV detectado em %s", c);
        return fn;
      }
    } catch {
      // segue tentando
    }
  }

  logger?.warn?.(
    "[CSVWatcher] Nenhum importador CSV encontrado. Defina CSV_IMPORTER ou adicione um dos módulos esperados."
  );
  return null;
}

export async function bootCsvWatchersIfConfigured() {
  const dir = process.env.DADOS_DIR || process.env.CSV_DIR || "";
  if (!dir) {
    logger?.warn?.("[CSVWatcher] DADOS_DIR não definido — watcher desativado");
    return;
  }
  const polling = pick(
    process.env.CSV_WATCH_POLLING === "false" ? false : true,
    true
  );
  const filesEnv = (
    process.env.CSV_FILES || "WINM1.csv,WINM5.csv,WDOM1.csv,WDOM5.csv"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const importer = await resolveImporter();

  logger?.info?.("[CSVWatcher] Inicializando watcher(s)...", {
    dir,
    files: filesEnv,
    polling,
    hasImporter: !!importer,
  });

  for (const fname of filesEnv) {
    const full = path.resolve(dir, fname);
    const exists = fs.existsSync(full);
    logger?.info?.(
      "[CSVWatcher] pronto para %s em %s (polling=%s, exists=%s)",
      fname,
      dir,
      polling ? "on" : "off",
      exists ? "yes" : "no"
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

    const processFile = async (event: string) => {
      try {
        if (!fs.existsSync(full)) {
          logger?.warn?.("[CSVWatcher] arquivo ausente %s (%s)", full, event);
          return;
        }
        const stats = fs.statSync(full);
        if (stats.size === 0) {
          logger?.warn?.("[CSVWatcher] arquivo vazio %s", full);
          return;
        }
        if (importer) {
          const ret = await importer(full);
          if (typeof ret === "number") {
            logger?.info?.(
              "[CSVWatcher] %s processado (%s): %d registros afetados",
              path.basename(full),
              event,
              ret
            );
          } else {
            logger?.info?.(
              "[CSVWatcher] %s processado (%s)",
              path.basename(full),
              event
            );
          }
        } else {
          // Sem importador: apenas log para não travar o servidor
          logger?.warn?.(
            "[CSVWatcher] Mudança detectada em %s, mas nenhum importador está configurado.",
            path.basename(full)
          );
        }
      } catch (e: any) {
        logger?.error?.(
          "[CSVWatcher] erro ao processar %s: %s",
          full,
          e?.message || e
        );
      }
    };

    watcher
      .on("add", () => processFile("add"))
      .on("change", () => processFile("change"))
      .on("rename", () => processFile("rename"))
      .on("error", (err) =>
        logger?.error?.(
          "[CSVWatcher] erro watcher %s: %s",
          full,
          err?.message || err
        )
      );
  }
}
