import React, { useMemo } from "react";
import * as AIStoreModule from "../store/ai";
const useAIStore: any =
  (AIStoreModule as any).useAIStore ?? (AIStoreModule as any).default;

/* ===== Helpers de data/hora em BRT ===== */
const TZ = "America/Sao_Paulo";

// yyyy-mm-dd (mantém estilo do seu print)
const fmtYmdBRT = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

// HH:mm:ss
const fmtTimeBRT = new Intl.DateTimeFormat("pt-BR", {
  timeZone: TZ,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function parseIso(iso?: string | null): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d; // 'Z' -> UTC ok
}

function toYmdBRT(d: Date | null) {
  if (!d) return "-";
  return fmtYmdBRT.format(d); // 2025-09-15
}
function toTimeBRT(d: Date | null) {
  if (!d) return "-";
  return fmtTimeBRT.format(d); // 10:31:00 (BRT)
}

export default function AIConfirmedPanel() {
  const rows = useAIStore((s: any) => s.confirmed);
  const params = useAIStore((s: any) => s.lastParams);

  const list = useMemo(() => {
    const src = Array.isArray(rows) ? rows : [];
    const nowMs = Date.now();

    // normaliza, aplica BRT e ordena
    const norm = src
      .map((r: any) => {
        const d = parseIso(r?.time);
        const timeMs = d ? d.getTime() : NaN;

        // Preferir campos do backend se existirem; senão formatar aqui
        const dateText =
          (r?.dateLocalBr && typeof r.dateLocalBr === "string"
            ? r.dateLocalBr
            : null) || toYmdBRT(d); // yyyy-mm-dd (BRT)

        const timeText =
          (r?.timeLocalBr && typeof r.timeLocalBr === "string"
            ? r.timeLocalBr
            : null) || toTimeBRT(d); // HH:mm:ss (BRT)

        return {
          ymd: dateText,
          hms: timeText,
          timeMs,
          side: r?.side ?? "-",
          price:
            typeof r?.price === "number" && isFinite(r.price) ? r.price : null,
          note: r?.note ?? r?.reason ?? null,
        };
      })
      // não mostra sinais no futuro
      .filter((r: any) => Number.isFinite(r.timeMs) && r.timeMs <= nowMs)
      // ordena crescente
      .sort((a: any, b: any) => a.timeMs - b.timeMs);

    return norm;
  }, [rows]);

  return (
    <div className="container my-3">
      <div className="card shadow-sm border-0">
        <div className="card-body">
          <div className="d-flex align-items-center gap-2 mb-2">
            <h6 className="mb-0">Sinais Confirmados</h6>
            <div className="text-muted small">
              {params ? (
                <>
                  <code>{params.symbol}</code> · <code>{params.timeframe}</code>
                  {params.from ? (
                    <>
                      {" "}
                      · de <code>{params.from}</code>
                    </>
                  ) : null}
                  {params.to ? (
                    <>
                      {" "}
                      até <code>{params.to}</code>
                    </>
                  ) : null}
                </>
              ) : (
                "—"
              )}
            </div>
          </div>

          <div className="table-responsive">
            <table className="table table-sm align-middle mb-0">
              <thead>
                <tr>
                  <th style={{ width: 180 }}>Data/Hora (BRT)</th>
                  <th style={{ width: 80 }}>Lado</th>
                  <th>Preço</th>
                  <th>Observação</th>
                </tr>
              </thead>
              <tbody>
                {list.length === 0 && (
                  <tr>
                    <td className="text-muted" colSpan={4}>
                      Sem dados. Use a barra para buscar.
                    </td>
                  </tr>
                )}
                {list.map((r: any, i: number) => (
                  <tr key={i}>
                    <td style={{ whiteSpace: "nowrap" }}>
                      <div className="text-danger" style={{ lineHeight: 1 }}>
                        {r.ymd}
                      </div>
                      <div className="tabular-nums" style={{ lineHeight: 1.2 }}>
                        {r.hms}
                      </div>
                    </td>
                    <td>
                      <span
                        className={
                          "badge " +
                          (r.side === "BUY"
                            ? "text-bg-success"
                            : r.side === "SELL"
                              ? "text-bg-danger"
                              : "text-bg-secondary")
                        }
                      >
                        {r.side}
                      </span>
                    </td>
                    <td>{r.price ?? "-"}</td>
                    <td className="text-muted">
                      {r.note ?? "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
              {list.length > 0 && (
                <tfoot>
                  <tr>
                    <td className="text-end text-muted" colSpan={4}>
                      {list.length} sinal(is)
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
