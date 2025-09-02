import { promises as fs } from "fs";
import * as fssync from "fs";
import * as crypto from "crypto";

type CacheEntry = {
  etag: string; // size-mtime
  hash?: string; // opcional: sha256 do conteúdo (para arquivos onde mtime não muda)
};

const cache = new Map<string, CacheEntry>();

/**
 * Retorna true se o arquivo mudou desde a última chamada (por size/mtime).
 * Para máxima robustez, passe {withHash:true} e ele também compara SHA-256.
 */
export async function hasFileChanged(
  path: string,
  opts?: { withHash?: boolean }
): Promise<boolean> {
  const st = await fs.stat(path);
  const nextEtag = `${st.size}-${st.mtimeMs}`;
  const prev = cache.get(path);
  let changed = !prev || prev.etag !== nextEtag;

  let hash: string | undefined;
  if (opts?.withHash) {
    // Só calcula hash se não mudou etag OU se não há cache.
    if (!changed || !prev?.hash) {
      const buf = await fs.readFile(path);
      hash = crypto.createHash("sha256").update(buf).digest("hex");
      if (!prev || prev.hash !== hash) changed = true;
    }
  }

  cache.set(path, { etag: nextEtag, hash: hash ?? prev?.hash });
  return changed;
}

/**
 * Usa fs.watch para disparar callback quando arquivo mudar.
 * Observação: em alguns FS pode perder eventos; combine com hasFileChanged no polling.
 */
export function watchFile(path: string, onChange: () => void): () => void {
  const watcher = fssync.watch(path, { persistent: false }, () => onChange());
  return () => watcher.close();
}

/**
 * Leitura protegida: só chama reader() se o arquivo mudou.
 */
export async function readIfChanged<T>(
  path: string,
  reader: () => Promise<T>,
  opts?: { withHash?: boolean }
): Promise<{ changed: boolean; data?: T }> {
  const changed = await hasFileChanged(path, opts);
  if (!changed) return { changed: false };
  const data = await reader();
  return { changed: true, data };
}
