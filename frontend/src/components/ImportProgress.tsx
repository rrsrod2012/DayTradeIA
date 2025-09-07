import React, { useMemo, useState } from "react";
import { Card, ProgressBar } from "react-bootstrap";
import { useWebSocketStream } from "../hooks/useWebSocket";

type Entry = {
  stage?: string;
  processed?: number;
  inserted?: number;
  updated?: number;
  progress?: number; // 0..100
};
type State = Record<string, Entry>;

export default function ImportProgress() {
  const [state, setState] = useState<State>({});

  useWebSocketStream(
    true,
    () => {},
    (p: any) => {
      const file = p.file || "unknown.csv";
      setState((prev) => {
        const cur = prev[file] || {};
        // Se vier progress, mantém o maior (evita “voltar” % em casos raros)
        const nextProgress =
          typeof p.progress === "number"
            ? Math.max(p.progress, cur.progress ?? 0)
            : cur.progress;

        const next: Entry = {
          stage: p.stage || cur.stage || "progress",
          processed: p.processed ?? cur.processed,
          inserted: p.inserted ?? cur.inserted,
          updated: p.updated ?? cur.updated,
          progress: nextProgress,
        };

        // Se chegar evento 'done' e não tiver progress 100, força 100
        if (
          (p.stage === "done" || p.type === "done") &&
          (next.progress ?? 0) < 100
        ) {
          next.progress = 100;
        }

        return { ...prev, [file]: next };
      });
    }
  );

  const entries = useMemo(() => Object.entries(state), [state]);
  if (entries.length === 0) return null;

  return (
    <div className="container my-3">
      <Card className="shadow-sm border-0">
        <Card.Body>
          <h6 className="mb-2">Leitura de CSV</h6>
          {entries.map(([file, st]) => {
            const pct = Math.min(
              100,
              Math.max(
                0,
                Math.round(st.progress ?? (st.stage === "done" ? 100 : 0))
              )
            );
            return (
              <div key={file} className="mb-2">
                <div className="d-flex justify-content-between small">
                  <span>
                    <code>{file}</code> • {st.stage || "progress"}
                  </span>
                  <span>
                    {st.processed || 0} linhas · +{st.inserted || 0}/
                    {st.updated || 0}
                  </span>
                </div>
                <ProgressBar
                  now={pct}
                  label={`${pct}%`}
                  animated={pct < 100}
                  striped={pct < 100}
                />
              </div>
            );
          })}
        </Card.Body>
      </Card>
    </div>
  );
}
