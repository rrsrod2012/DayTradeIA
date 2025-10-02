// ===============================
// FILE: frontend/src/components/ImportProgress.tsx
// ===============================
import React, { useEffect, useMemo, useRef, useState } from "react";
import { ProgressBar, Alert, Badge, Card } from "react-bootstrap";

/**
 * Este componente:
 * - Conecta ao WebSocket /stream (via URL derivada)
 * - Escuta eventos: import:begin, import:progress, import:done, import:error
 * - Agrega progresso por arquivo
 * - Exibe status da conexão WS e um mini-log
 * - Dispara "daytrade:data-invalidate" no término da importação,
 * e repassa qualquer "data:invalidate" que vier do backend.
 * - HOTFIX: se ninguém tratar o evento em ~800ms, força um reload da página (uma vez).
 */

// Toggle opcional para não recarregar a página automaticamente
const DISABLE_FALLBACK_RELOAD =
  ((import.meta as any).env?.VITE_DISABLE_RELOAD ?? "") === "1";

type ImportEventPayload = {
  file: string;
  total?: number;
  processed?: number;
  inserted?: number;
  updated?: number;
  message?: string;
  symbol?: string;
  timeframe?: string;
};

type ImportEvent = {
  type: "import:begin" | "import:progress" | "import:done" | "import:error";
  payload: ImportEventPayload;
};

type FileProgress = {
  file: string;
  total: number;
  processed: number;
  inserted: number;
  updated: number;
  lastUpdateAt: number;
  done: boolean;
  error?: string;
};

// <<<<<<< FUNÇÃO DE URL DO WEBSOCKET CORRIGIDA >>>>>>>>
function getWSUrl(): string {
  // Constrói a URL do WebSocket de forma que o proxy do Vite possa interceptá-la.
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  // Usa o mesmo host do site, e o caminho /stream será redirecionado pelo proxy.
  const host = window.location.host;
  return `${protocol}//${host}/stream`;
}

// Heurística para extrair symbol/timeframe do nome do arquivo (fallback)
function guessFromFile(file?: string): { symbol?: string; timeframe?: string } {
  if (!file) return {};
  const base = (file.split(/[\\/]/).pop() || "").toUpperCase();
  const sym = base.match(/\b([A-Z]{3,5})\b/)?.[1];
  const tf = base.match(/\b((?:M|H)\d{1,2})\b/)?.[1];
  return { symbol: sym || undefined, timeframe: tf || undefined };
}

export default function ImportProgress() {
  const [status, setStatus] = useState<"connecting" | "open" | "closed">(
    "connecting"
  );
  const [progress, setProgress] = useState<Record<string, FileProgress>>({});
  const [log, setLog] = useState<string[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  // flags do fallback
  const handledRef = useRef(false);
  const reloadedRef = useRef(false);

  // Qualquer parte do app pode sinalizar que tratou a invalidação:
  // window.dispatchEvent(new CustomEvent("daytrade:data-invalidate:handled"))
  useEffect(() => {
    const onHandled = () => {
      handledRef.current = true;
    };
    window.addEventListener("daytrade:data-invalidate:handled", onHandled);
    return () =>
      window.removeEventListener(
        "daytrade:data-invalidate:handled",
        onHandled
      );
  }, []);

  const scheduleFallbackReload = () => {
    if (DISABLE_FALLBACK_RELOAD) return; // não força reload se desativado
    // Aguarda um pouquinho para dar tempo de componentes reagirem ao evento
    setTimeout(() => {
      if (!handledRef.current && !reloadedRef.current) {
        reloadedRef.current = true;
        try {
          // eslint-disable-next-line no-console
          console.log(
            "[ImportProgress] ninguém tratou data-invalidate → recarregando página"
          );
        } catch { }
        window.location.reload();
      }
    }, 800);
  };

  useEffect(() => {
    const url = getWSUrl();
    let closedByUs = false;
    let alive = true;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    const addLog = (line: string) =>
      setLog((prev) =>
        [new Date().toLocaleTimeString() + " " + line, ...prev].slice(0, 40)
      );

    ws.onopen = () => {
      if (!alive) return;
      setStatus("open");
      addLog(`WS conectado: ${url}`);
      try {
        ws.send(
          JSON.stringify({
            type: "hello",
            payload: { source: "ImportProgress" },
          })
        );
      } catch { }
    };

    ws.onmessage = (evt) => {
      if (!alive) return;
      let data: any = null;
      try {
        data = JSON.parse(evt.data);
      } catch {
        addLog("WS msg (texto): " + String(evt.data).slice(0, 120));
        return;
      }
      if (!data || !data.type) {
        addLog("WS msg desconhecida");
        return;
      }

      // Log leve
      addLog(
        `evt: ${data.type}${data?.payload?.file ? " [" + data.payload.file + "]" : ""
        }`
      );

      // ===== Pass-through de invalidação do backend =====
      if (data.type === "data:invalidate") {
        try {
          window.dispatchEvent(
            new CustomEvent("daytrade:data-invalidate", {
              detail: { source: "WS", ...(data.payload || {}) },
            })
          );
        } catch { }
        // Se ninguém no app tratar, recarrega
        scheduleFallbackReload();
        // Continua para processar mensagens import:* caso venham juntas
      }

      // Normalização dos eventos de import
      const isImportDirect =
        typeof data.type === "string" && data.type.startsWith("import:");
      const isImportChannel =
        data.channel === "import" &&
        typeof data.type === "string" &&
        ["begin", "progress", "done", "error"].includes(data.type);

      let normalized: ImportEvent | null = null;
      if (isImportDirect) normalized = data as ImportEvent;
      else if (isImportChannel) {
        normalized = {
          type: ("import:" + data.type) as ImportEvent["type"],
          payload: data.payload as ImportEventPayload,
        };
      }
      if (!normalized) return;

      const { type, payload } = normalized;
      if (!payload?.file) return;

      setProgress((prev) => {
        const cur =
          prev[payload.file] ||
          ({
            file: payload.file,
            total: 0,
            processed: 0,
            inserted: 0,
            updated: 0,
            lastUpdateAt: Date.now(),
            done: false,
          } as FileProgress);

        if (type === "import:begin") {
          return {
            ...prev,
            [payload.file]: {
              ...cur,
              total: payload.total ?? cur.total ?? 0,
              processed: payload.processed ?? 0,
              inserted: payload.inserted ?? 0,
              updated: payload.updated ?? 0,
              lastUpdateAt: Date.now(),
              done: false,
              error: undefined,
            },
          };
        }

        if (type === "import:progress") {
          return {
            ...prev,
            [payload.file]: {
              ...cur,
              total: payload.total ?? cur.total ?? 0,
              processed:
                payload.processed ??
                Math.max(
                  cur.processed,
                  (payload.total ?? cur.total) > 0
                    ? cur.processed + 1
                    : cur.processed
                ),
              inserted: payload.inserted ?? cur.inserted,
              updated: payload.updated ?? cur.updated,
              lastUpdateAt: Date.now(),
            },
          };
        }

        if (type === "import:done") {
          return {
            ...prev,
            [payload.file]: {
              ...cur,
              total: payload.total ?? cur.total,
              processed: payload.processed ?? cur.processed,
              inserted: payload.inserted ?? cur.inserted,
              updated: payload.updated ?? cur.updated,
              lastUpdateAt: Date.now(),
              done: true,
            },
          };
        }

        if (type === "import:error") {
          return {
            ...prev,
            [payload.file]: {
              ...cur,
              lastUpdateAt: Date.now(),
              error: payload.message || "Erro desconhecido",
              done: true,
            },
          };
        }

        return prev;
      });

      // Ao concluir, disparamos o evento global e, se ninguém tratar, recarrega
      if (type === "import:done") {
        const g = guessFromFile(payload.file);
        const symbol = (payload.symbol || g.symbol || "WIN").toUpperCase();
        const timeframe = (payload.timeframe || g.timeframe || "M1").toUpperCase();

        try {
          window.dispatchEvent(
            new CustomEvent("daytrade:data-invalidate", {
              detail: {
                source: "ImportProgress",
                reason: "import-done",
                kinds: ["candles", "signals", "projected", "pnl"],
                file: payload.file,
                symbol,
                timeframe,
                totals: {
                  total: payload.total ?? null,
                  processed: payload.processed ?? null,
                  inserted: payload.inserted ?? null,
                  updated: payload.updated ?? null,
                },
              },
            })
          );
        } catch { }
        scheduleFallbackReload();
      }
    };

    ws.onerror = () => {
      if (!alive) return;
      addLog("WS erro");
    };

    ws.onclose = () => {
      if (!alive) return;
      setStatus("closed");
      addLog("WS desconectado");
      if (!closedByUs) {
        setTimeout(() => {
          if (!wsRef.current || wsRef.current.readyState === WebSocket.CLOSED) {
            setStatus("connecting");
          }
        }, 1500);
      }
    };

    return () => {
      alive = false;
      closedByUs = true;

      const w = wsRef.current;
      wsRef.current = null;

      try {
        if (!w) return;

        switch (w.readyState) {
          case WebSocket.OPEN:
          case WebSocket.CLOSING:
            w.close();
            break;

          case WebSocket.CONNECTING: {
            // StrictMode: se desmontar enquanto conecta, fecha assim que abrir,
            // evitando "WebSocket is closed before the connection is established".
            const closeOnOpen = () => {
              try {
                w.close();
              } catch { }
            };
            try {
              w.addEventListener("open", closeOnOpen, { once: true });
            } catch { }
            break;
          }

          case WebSocket.CLOSED:
          default:
            // nada
            break;
        }
      } catch { }
    };
  }, []);

  const items = useMemo(
    () =>
      Object.values(progress).sort((a, b) => b.lastUpdateAt - a.lastUpdateAt),
    [progress]
  );

  return (
    <div className="mb-3">
      <div className="d-flex align-items-center gap-2 mb-2">
        <strong>Importação de CSV</strong>
        {status === "open" && <Badge bg="success">WS: conectado</Badge>}
        {status === "connecting" && <Badge bg="warning">WS: conectando…</Badge>}
        {status === "closed" && <Badge bg="danger">WS: desconectado</Badge>}
      </div>

      {items.length === 0 && (
        <Alert variant="secondary" className="py-2 mb-3">
          Nenhum progresso recebido ainda. Inicie uma importação para ver a
          barra em tempo real.
        </Alert>
      )}

      {items.map((fp) => {
        const total = fp.total > 0 ? fp.total : Math.max(fp.processed, 0);
        const pct =
          total > 0
            ? Math.min(100, Math.round((fp.processed / total) * 100))
            : fp.done
              ? 100
              : 0;

        return (
          <Card className="mb-2" key={fp.file}>
            <Card.Body>
              <div className="d-flex justify-content-between align-items-center mb-1">
                <div>
                  <div className="fw-semibold">{fp.file}</div>
                  <div className="text-muted small">
                    {fp.processed}/{total} linhas • ins: {fp.inserted} • upd:{" "}
                    {fp.updated}
                    {fp.done && (
                      <Badge bg="info" className="ms-2">
                        concluído
                      </Badge>
                    )}
                    {fp.error && (
                      <Badge bg="danger" className="ms-2">
                        erro
                      </Badge>
                    )}
                  </div>
                </div>
                <div style={{ minWidth: 80, textAlign: "right" }}>{pct}%</div>
              </div>
              <ProgressBar
                now={pct}
                animated={!fp.done}
                striped={!fp.done}
                variant={fp.error ? "danger" : fp.done ? "success" : "primary"}
              />
              {fp.error && (
                <Alert variant="danger" className="mt-2 mb-0 py-2">
                  {fp.error}
                </Alert>
              )}
            </Card.Body>
          </Card>
        );
      })}

      <details>
        <summary>Ver log de eventos</summary>
        <pre className="mt-2 mb-0" style={{ maxHeight: 180, overflow: "auto" }}>
          {log.join("\n")}
        </pre>
      </details>
    </div>
  );
}