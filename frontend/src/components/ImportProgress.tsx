import React, { useEffect, useMemo, useRef, useState } from "react";
import { ProgressBar, Alert, Badge, Card } from "react-bootstrap";

/**
 * Este componente:
 * - Conecta ao WebSocket /stream (via hook interno que lê VITE_WS_URL/VITE_API_BASE/window.location)
 * - Escuta eventos: import:begin, import:progress, import:done, import:error
 * - Agrega progresso por arquivo
 * - Exibe status da conexão WS e um mini-log dos últimos eventos (para diagnóstico)
 *
 * Espera que o backend envie mensagens JSON no formato:
 *   { type: "import:begin"|"import:progress"|"import:done"|"import:error",
 *     payload: { file: string, total?: number, processed?: number, inserted?: number, updated?: number, message?: string } }
 */

type ImportEventPayload = {
  file: string;
  total?: number;
  processed?: number;
  inserted?: number;
  updated?: number;
  message?: string;
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

function getWSUrl(): string {
  // 1) variáveis do Vite
  const env: any = (import.meta as any).env || {};
  const explicit = env.VITE_WS_URL as string | undefined;
  if (explicit && explicit.trim()) return explicit.trim();

  // 2) derivar de VITE_API_BASE se existir
  const apiBase = (env.VITE_API_BASE as string | undefined)?.trim() || "";
  const base =
    apiBase !== ""
      ? apiBase.replace(/^http/i, "ws")
      : window.location.origin.replace(/^http/i, "ws");
  return base.replace(/\/?$/, "") + "/stream";
}

export default function ImportProgress() {
  const [status, setStatus] = useState<"connecting" | "open" | "closed">(
    "connecting"
  );
  const [progress, setProgress] = useState<Record<string, FileProgress>>({});
  const [log, setLog] = useState<string[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const url = getWSUrl();
    let closedByUs = false;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    const addLog = (line: string) =>
      setLog((prev) =>
        [new Date().toLocaleTimeString() + " " + line, ...prev].slice(0, 20)
      );

    ws.onopen = () => {
      setStatus("open");
      addLog(`WS conectado: ${url}`);
      // Opcional: informe seu símbolo/timeframe se o backend espera querystring.
      // Se o backend ignora, não tem problema.
      try {
        ws.send(
          JSON.stringify({
            type: "hello",
            payload: { source: "ImportProgress" },
          })
        );
      } catch {}
    };

    ws.onmessage = (evt) => {
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
        `evt: ${data.type}${
          data?.payload?.file ? " [" + data.payload.file + "]" : ""
        }`
      );

      // Aceitamos tanto eventos vindos diretamente (type começa com import:)
      // quanto envelopados em {channel:"import", type:"progress", payload:{...}}
      const isImportDirect =
        typeof data.type === "string" && data.type.startsWith("import:");
      const isImportChannel =
        data.channel === "import" &&
        typeof data.type === "string" &&
        ["begin", "progress", "done", "error"].includes(data.type);

      let normalized: ImportEvent | null = null;

      if (isImportDirect) {
        normalized = data as ImportEvent;
      } else if (isImportChannel) {
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
    };

    ws.onerror = () => {
      addLog("WS erro");
    };

    ws.onclose = () => {
      setStatus("closed");
      addLog("WS desconectado");
      if (!closedByUs) {
        // Tentativa simples de reconexão
        setTimeout(() => {
          if (!wsRef.current || wsRef.current.readyState === WebSocket.CLOSED) {
            setStatus("connecting");
            // efeito irá recriar pois dependências não mudam; forçamos remount:
            // Aqui mantemos simples: recarregue a página ou deixe como está.
          }
        }, 1500);
      }
    };

    return () => {
      closedByUs = true;
      try {
        ws.close();
      } catch {}
      wsRef.current = null;
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
