import React, { useMemo } from "react";
import { Table, Badge } from "react-bootstrap";

type Item = {
  time?: string | null; // ISO
  date?: string | null; // yyyy-LL-dd
  side?: "BUY" | "SELL" | "FLAT" | string | null;
  suggestedEntry?: number | null;
  stopSuggestion?: number | null;
  takeProfitSuggestion?: number | null;
  conditionText?: string | null;
  score?: number | null;
  probHit?: number | null;
  probCalibrated?: number | null;
  expectedValuePoints?: number | null;
};

type Visible = {
  date?: boolean;
  time?: boolean;
  side?: boolean;
  entry?: boolean;
  stop?: boolean;
  take?: boolean;
  cond?: boolean;
  score?: boolean;
  prob?: boolean;
  ev?: boolean;
};

type Props = { items?: Item[]; visibleCols?: Visible };

function SideBadge({ side }: { side?: string | null }) {
  const s = String(side || "").toUpperCase();
  const variant =
    s === "BUY" ? "success" : s === "SELL" ? "danger" : "secondary";
  return <Badge bg={variant}>{s || "-"}</Badge>;
}

export default function ProjectedSignalsTable({
  items = [],
  visibleCols,
}: Props) {
  const v = {
    date: true,
    time: true,
    side: true,
    entry: true,
    stop: true,
    take: true,
    cond: true,
    score: true,
    prob: true,
    ev: true,
    ...(visibleCols || {}),
  };

  const rows = useMemo(() => {
    const safe = Array.isArray(items) ? items : [];
    return safe
      .map((s) => ({
        time: s?.time ?? null,
        date: s?.date ?? null,
        side: s?.side ?? "-",
        suggestedEntry: Number.isFinite(s?.suggestedEntry as number)
          ? (s!.suggestedEntry as number)
          : null,
        stopSuggestion: Number.isFinite(s?.stopSuggestion as number)
          ? (s!.stopSuggestion as number)
          : null,
        takeProfitSuggestion: Number.isFinite(s?.takeProfitSuggestion as number)
          ? (s!.takeProfitSuggestion as number)
          : null,
        conditionText: s?.conditionText ?? null,
        score: Number.isFinite(s?.score as number)
          ? (s!.score as number)
          : null,
        prob: Number.isFinite((s?.probCalibrated ?? s?.probHit) as number)
          ? ((s!.probCalibrated ?? s!.probHit) as number)
          : null,
        ev: Number.isFinite(s?.expectedValuePoints as number)
          ? (s!.expectedValuePoints as number)
          : null,
      }))
      .sort((a, b) => {
        const ta = a.time ? new Date(a.time).getTime() : 0;
        const tb = b.time ? new Date(b.time).getTime() : 0;
        return ta - tb;
      });
  }, [items]);

  if (!rows.length) {
    return (
      <div className="text-muted" style={{ fontSize: 14 }}>
        Nenhuma projeção no período.
      </div>
    );
  }

  return (
    <div style={{ overflowX: "auto" }}>
      <Table striped bordered hover size="sm">
        <thead>
          <tr>
            {v.date && <th>Data</th>}
            {v.time && <th>Hora</th>}
            {v.side && <th>Side</th>}
            {v.entry && <th>Entrada</th>}
            {v.stop && <th>Stop</th>}
            {v.take && <th>Alvo</th>}
            {v.cond && <th>Condição</th>}
            {v.score && <th>Score</th>}
            {v.prob && <th>Prob.</th>}
            {v.ev && <th>EV (pts)</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {v.date && (
                <td>
                  {r.date ??
                    (r.time ? new Date(r.time).toLocaleDateString() : "-")}
                </td>
              )}
              {v.time && (
                <td>
                  {r.time
                    ? new Date(r.time).toLocaleTimeString().slice(0, 5)
                    : "-"}
                </td>
              )}
              {v.side && (
                <td>
                  <SideBadge side={r.side} />
                </td>
              )}
              {v.entry && <td>{r.suggestedEntry ?? "-"}</td>}
              {v.stop && <td>{r.stopSuggestion ?? "-"}</td>}
              {v.take && <td>{r.takeProfitSuggestion ?? "-"}</td>}
              {v.cond && (
                <td
                  title={r.conditionText ?? ""}
                  style={{
                    maxWidth: 360,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {r.conditionText ?? "-"}
                </td>
              )}
              {v.score && (
                <td>
                  {typeof r.score === "number" ? r.score.toFixed(2) : "-"}
                </td>
              )}
              {v.prob && (
                <td>
                  {typeof r.prob === "number"
                    ? `${(r.prob * 100).toFixed(1)}%`
                    : "-"}
                </td>
              )}
              {v.ev && (
                <td>{typeof r.ev === "number" ? r.ev.toFixed(2) : "-"}</td>
              )}
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
