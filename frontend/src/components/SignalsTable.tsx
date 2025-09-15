import React, { useMemo } from "react";
import { Table, Badge } from "react-bootstrap";

type ConfirmedSignal = {
  // sempre vem do backend
  time?: string | null;              // ISO UTC, ex.: "2025-09-15T12:31:00.000Z"
  date?: string | null;              // string auxiliar (pode estar em BRT)
  signalType?: string | null;
  side?: string | null;              // BUY | SELL | ...
  price?: number | null;
  reason?: string | null;            // "Observação" no seu print
  score?: number | null;

  // novos campos do backend para exibição direta em BRT
  dateLocalBr?: string | null;       // dd/MM/yyyy
  timeLocalBr?: string | null;       // HH:mm:ss
  tz?: string | null;                // "America/Sao_Paulo"
};

type Visible = {
  datetime?: boolean; // se true (default), mostra a coluna combinada Data/Hora (BRT)
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

/* ====== Helpers de formatação BRT (America/Sao_Paulo) ====== */
const TZ = "America/Sao_Paulo";

const fmtDateBR = new Intl.DateTimeFormat("pt-BR", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const fmtTimeBR = new Intl.DateTimeFormat("pt-BR", {
  timeZone: TZ,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function parseIso(iso?: string | null): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d; // Date entende 'Z' como UTC
}

function toDateBRT(d: Date | null): string {
  if (!d) return "-";
  return fmtDateBR.format(d); // dd/MM/aaaa
}

function toTimeBRT(d: Date | null): string {
  if (!d) return "-";
  return fmtTimeBR.format(d); // HH:mm:ss (sem .000)
}

function SideBadge({ side }: { side?: string | null }) {
  const s = String(side || "").toUpperCase();
  const variant =
    s === "BUY" ? "success" : s === "SELL" ? "danger" : "secondary";
  return <Badge bg={variant}>{s || "-"}</Badge>;
}

export default function SignalsTable({ items = [], visibleCols }: Props) {
  const v = {
    datetime: true,
    side: true,
    type: false,   // default para ficar parecido com seu print
    price: true,
    score: false,
    reason: true,  // "Observação"
    ...(visibleCols || {}),
  };

  const rows = useMemo(() => {
    const safe = Array.isArray(items) ? items : [];
    const nowMs = Date.now();

    return safe
      .map((s) => {
        const d = parseIso(s?.time);
        const tms = d ? d.getTime() : NaN;

        // usa campos “display” do backend se existirem; senão formata aqui
        const dateBRT = (s.dateLocalBr && s.dateLocalBr.trim())
          ? s.dateLocalBr
          : toDateBRT(d);
        const timeBRT = (s.timeLocalBr && s.timeLocalBr.trim())
          ? s.timeLocalBr
          : toTimeBRT(d);

        return {
          timeIso: s?.time ?? null,
          timeMs: tms, // para sort/filtragem
          dateBRT,
          timeBRT,
          tz: s?.tz || TZ,
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
        };
      })
      // Segurança extra: não renderiza sinais no futuro
      .filter((r) => Number.isFinite(r.timeMs) && (r.timeMs as number) <= nowMs)
      // Ordena crescente por horário
      .sort((a, b) => (a.timeMs as number) - (b.timeMs as number));
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
            {v.datetime && <th style={{ whiteSpace: "nowrap" }}>Data/Hora (BRT)</th>}
            {v.side && <th>Lado</th>}
            {v.price && <th>Preço</th>}
            {v.type && <th>Tipo</th>}
            {v.score && <th>Score</th>}
            {v.reason && <th>Observação</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, idx) => (
            <tr key={idx}>
              {v.datetime && (
                <td style={{ whiteSpace: "nowrap" }}>
                  <div className="text-muted" style={{ lineHeight: 1 }}>
                    {r.dateBRT}
                  </div>
                  <div className="tabular-nums" style={{ lineHeight: 1.2 }}>
                    {r.timeBRT}
                  </div>
                </td>
              )}
              {v.side && (
                <td>
                  <SideBadge side={r.side} />
                </td>
              )}
              {v.price && <td>{r.price ?? "-"}</td>}
              {v.type && <td>{r.signalType}</td>}
              {v.score && (
                <td>{typeof r.score === "number" ? r.score.toFixed(6) : "-"}</td>
              )}
              {v.reason && (
                <td
                  style={{
                    maxWidth: 420,
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
