import React, { useMemo } from "react";
import { Table, Badge } from "react-bootstrap";

type ConfirmedSignal = {
  time?: string | null; // ISO
  date?: string | null; // yyyy-LL-dd
  signalType?: string | null;
  side?: string | null; // BUY | SELL | ...
  price?: number | null;
  reason?: string | null;
  score?: number | null;
};

type Visible = {
  date?: boolean;
  time?: boolean;
  side?: boolean;
  type?: boolean;
  price?: boolean;
  score?: boolean;
  reason?: boolean;
};

type Props = {
  items?: ConfirmedSignal[];
  visibleCols?: Visible; // opcional: quais colunas mostrar
};

function formatTime(iso?: string | null) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "-";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function SideBadge({ side }: { side?: string | null }) {
  const s = String(side || "").toUpperCase();
  const variant =
    s === "BUY" ? "success" : s === "SELL" ? "danger" : "secondary";
  return <Badge bg={variant}>{s || "-"}</Badge>;
}

export default function SignalsTable({ items = [], visibleCols }: Props) {
  const v = {
    date: true,
    time: true,
    side: true,
    type: true,
    price: true,
    score: true,
    reason: true,
    ...(visibleCols || {}),
  };

  const rows = useMemo(() => {
    const safe = Array.isArray(items) ? items : [];
    return safe
      .map((s) => ({
        time: s?.time ?? null,
        date: s?.date ?? null,
        signalType: s?.signalType ?? "-",
        side: s?.side ?? "-",
        price:
          typeof s?.price === "number" && isFinite(s.price as number)
            ? (s.price as number)
            : null,
        reason: s?.reason ?? null,
        score:
          typeof s?.score === "number" && isFinite(s.score as number)
            ? (s.score as number)
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
        Nenhum sinal no período.
      </div>
    );
  }

  return (
    <div style={{ overflowX: "auto" }}>
      <Table striped bordered hover size="sm">
        <thead>
          <tr>
            {v.date && <th style={{ whiteSpace: "nowrap" }}>Data</th>}
            {v.time && <th>Hora</th>}
            {v.side && <th>Side</th>}
            {v.type && <th>Tipo</th>}
            {v.price && <th>Preço</th>}
            {v.score && <th>Score</th>}
            {v.reason && <th>Motivo</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, idx) => (
            <tr key={idx}>
              {v.date && (
                <td>
                  {r.date ??
                    (r.time ? new Date(r.time).toLocaleDateString() : "-")}
                </td>
              )}
              {v.time && <td>{formatTime(r.time)}</td>}
              {v.side && (
                <td>
                  <SideBadge side={r.side} />
                </td>
              )}
              {v.type && <td>{r.signalType}</td>}
              {v.price && <td>{r.price ?? "-"}</td>}
              {v.score && (
                <td>
                  {typeof r.score === "number" ? r.score.toFixed(6) : "-"}
                </td>
              )}
              {v.reason && (
                <td
                  style={{
                    maxWidth: 360,
                    whiteSpace: "nowrap",
                    textOverflow: "ellipsis",
                    overflow: "hidden",
                  }}
                  title={r.reason ?? ""}
                >
                  {r.reason ?? "-"}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
