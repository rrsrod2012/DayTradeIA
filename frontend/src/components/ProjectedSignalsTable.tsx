import React, { useMemo, useState } from "react";
import { Table, Badge, Form } from "react-bootstrap";

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
  // NOVO: campos opcionais que o backend pode enviar
  ev?: number | null;
  expectedValue?: number | null;
  expected_value?: number | null;
  prob?: number | null;
  vwapOk?: boolean | null;
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

function normalizeSide(val: any): "BUY" | "SELL" | "FLAT" {
  if (val == null) return "FLAT";
  const s = String(val).toUpperCase();
  if (s.includes("BUY") || s.includes("LONG") || s === "1") return "BUY";
  if (s.includes("SELL") || s.includes("SHORT") || s === "-1") return "SELL";
  return "FLAT";
}

function SideBadge({ side }: { side?: string | null }) {
  const s = normalizeSide(side);
  const variant = s === "BUY" ? "success" : s === "SELL" ? "danger" : "secondary";
  return <Badge bg={variant}>{s}</Badge>;
}

export default function ProjectedSignalsTable({ items = [], visibleCols }: Props) {
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

  // Filtro de Side (ALL/BUY/SELL/FLAT)
  const [sideFilter, setSideFilter] = useState<"ALL" | "BUY" | "SELL" | "FLAT">("ALL");

  const rows = useMemo(() => {
    const safe = Array.isArray(items) ? items : [];
    return safe
      .map((s) => {
        const side = normalizeSide(s?.side ?? "-");
        const time = s?.time ?? null;
        const date = s?.date ?? null;
        const n = (x: any) => (Number.isFinite(Number(x)) ? Number(x) : null);

        // prob cai para probCalibrated -> probHit -> prob
        const prob = n(s?.probCalibrated ?? s?.probHit ?? (s as any)?.prob);
        // EV cai para expectedValuePoints -> ev -> expectedValue -> expected_value
        const ev = n(
          s?.expectedValuePoints ??
          (s as any)?.ev ??
          (s as any)?.expectedValue ??
          (s as any)?.expected_value
        );

        const vwapOk =
          typeof (s as any)?.vwapOk === "boolean" ? ((s as any).vwapOk as boolean) : null;

        return {
          time,
          date,
          side,
          suggestedEntry: n(s?.suggestedEntry),
          stopSuggestion: n(s?.stopSuggestion),
          takeProfitSuggestion: n(s?.takeProfitSuggestion),
          conditionText: s?.conditionText ?? null,
          score: n(s?.score),
          prob,
          ev,
          vwapOk,
        };
      })
      // filtro por side
      .filter((r) => (sideFilter === "ALL" ? true : r.side === sideFilter))
      // mais recentes primeiro
      .sort((a, b) => {
        const ta = a.time ? new Date(a.time).getTime() : 0;
        const tb = b.time ? new Date(b.time).getTime() : 0;
        return tb - ta;
      });
  }, [items, sideFilter]);

  if (!rows.length) {
    return (
      <div className="text-muted" style={{ fontSize: 14 }}>
        Nenhuma projeção no período.
      </div>
    );
  }

  return (
    <div style={{ overflowX: "auto" }}>
      {/* Barra de filtro (lado direito) */}
      <div className="d-flex justify-content-end mb-2" style={{ gap: 8 }}>
        <Form.Select
          size="sm"
          style={{ width: 140 }}
          value={sideFilter}
          onChange={(e) => setSideFilter(e.target.value as any)}
          aria-label="Filtrar por side"
        >
          <option value="ALL">Side: ALL</option>
          <option value="BUY">Side: BUY</option>
          <option value="SELL">Side: SELL</option>
          <option value="FLAT">Side: FLAT</option>
        </Form.Select>
      </div>

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
          {rows.map((r, i) => {
            const evClass =
              typeof r.ev === "number"
                ? r.ev > 0
                  ? "text-success"
                  : r.ev < 0
                    ? "text-danger"
                    : ""
                : "";
            return (
              <tr key={i}>
                {v.date && (
                  <td>{r.date ?? (r.time ? new Date(r.time).toLocaleDateString() : "-")}</td>
                )}
                {v.time && (
                  <td>{r.time ? new Date(r.time).toLocaleTimeString().slice(0, 5) : "-"}</td>
                )}
                {v.side && (
                  <td>
                    <div className="d-flex align-items-center" style={{ gap: 6 }}>
                      <SideBadge side={r.side} />
                      {r.vwapOk === true && (
                        <Badge bg="success" pill title="Preço alinhado à VWAP para o lado do sinal">
                          VWAP+
                        </Badge>
                      )}
                      {r.vwapOk === false && (
                        <Badge bg="danger" pill title="Preço contra a VWAP para o lado do sinal">
                          VWAP-
                        </Badge>
                      )}
                    </div>
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
                {v.score && <td>{typeof r.score === "number" ? r.score.toFixed(2) : "-"}</td>}
                {v.prob && (
                  <td>{typeof r.prob === "number" ? `${(r.prob * 100).toFixed(1)}%` : "-"}</td>
                )}
                {v.ev && (
                  <td className={evClass}>
                    {typeof r.ev === "number" ? r.ev.toFixed(2) : "-"}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </Table>
    </div>
  );
}
