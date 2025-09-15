import React from "react";
import * as AIStoreModule from "../store/ai";
import { fetchCandles } from "../services/api";
const useAIStore: any =
  (AIStoreModule as any).useAIStore ?? (AIStoreModule as any).default;

/* ========= Helpers ========= */
function tfToMinutes(tf?: string | null) {
  const s = String(tf || "").trim().toUpperCase();
  if (s === "M1") return 1;
  if (s === "M5") return 5;
  if (s === "M15") return 15;
  if (s === "M30") return 30;
  if (s === "H1") return 60;
  const m = s.match(/^M(\d+)$/);
  if (m) return Math.max(1, Number(m[1]));
  const h = s.match(/^H(\d+)$/);
  if (h) return Math.max(1, Number(h[1]) * 60);
  return 5;
}
function toTs(iso?: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}
function minutesBetween(aIso?: string | null, bIso?: string | null): number {
  const a = toTs(aIso);
  const b = toTs(bIso);
  if (a == null || b == null) return Infinity;
  return Math.abs(b - a) / 60000;
}
function parseQS() {
  const sp =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search)
      : new URLSearchParams();
  const entriesOnly = (sp.get("entriesOnly") ?? "1").trim() !== "0";
  const reStr = sp.get("reEntryBars");
  const reEntryBars =
    reStr != null && reStr !== "" && Number.isFinite(Number(reStr))
      ? Number(reStr)
      : NaN;
  const syncWithTrades = (sp.get("syncWithTrades") ?? "1").trim() !== "0";
  const nextOpenEntry = (sp.get("nextOpenEntry") ?? "1").trim() !== "0"; // alinha com AIPnLPanel
  return { entriesOnly, reEntryBars, syncWithTrades, nextOpenEntry };
}

/* ========= Formatação LOCAL (igual ao AIPnLPanel) ========= */
function fmtLocalDateTime(iso?: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

/* ========= Componente ========= */
export default function AIConfirmedPanel() {
  const rows = useAIStore((s: any) => s.confirmed);
  const params = useAIStore((s: any) => s.lastParams);

  const { entriesOnly, reEntryBars, syncWithTrades, nextOpenEntry } = parseQS();
  const tfMin = tfToMinutes(params?.timeframe);
  const reEntryBarsEff = Number.isFinite(reEntryBars)
    ? Math.max(0, Number(reEntryBars))
    : tfMin <= 1
      ? 4
      : 3;

  // Lista original, protegida e ordenada por tempo (ASC)
  const listAsc = React.useMemo(() => {
    const base = Array.isArray(rows) ? rows : [];
    return [...base].sort((a: any, b: any) => {
      const ta = toTs(a?.time) ?? 0;
      const tb = toTs(b?.time) ?? 0;
      return ta - tb;
    });
  }, [rows]);

  // ---------- Modo "somente entradas" básico (sem sincronização) ----------
  const entriesOnlyList = React.useMemo(() => {
    if (!entriesOnly) return listAsc;

    const out: any[] = [];
    let flat = true;
    let lastSide: "BUY" | "SELL" | null = null;
    let lastCloseTime: string | null = null;

    for (const s of listAsc) {
      const side = String(s?.side || "").toUpperCase();
      const t = s?.time ?? null;

      if (flat) {
        // cooldown após "fechamento" lógico
        if (
          lastCloseTime &&
          minutesBetween(lastCloseTime, t) < reEntryBarsEff * tfMin
        ) {
          continue;
        }
        out.push(s); // registra entrada
        flat = false;
        lastSide = (side as any) || null;
      } else {
        if (side !== String(lastSide)) {
          // saída lógica (não exibida), inicia cooldown
          flat = true;
          lastSide = null;
          lastCloseTime = t;
        } else {
          // mesmo lado durante posição -> ignora
        }
      }
    }

    return out;
  }, [listAsc, entriesOnly, reEntryBarsEff, tfMin]);

  // ---------- (N O V O) Sincronização com a política "next-open" ----------
  // Em vez de depender dos trades do store, reconstruímos as ENTRADAS
  // com a política "entrada no próximo open" diretamente a partir
  // dos sinais confirmados + candles. Isso garante 1:1 com o AIPnLPanel.
  const symbol = String(params?.symbol || "").toUpperCase();
  const timeframe = String(params?.timeframe || "").toUpperCase();

  const [candles, setCandles] = React.useState<
    { time: string; open: number; high: number; low: number; close: number }[]
  >([]);

  React.useEffect(() => {
    let alive = true;
    (async () => {
      if (!syncWithTrades || !nextOpenEntry || !params) {
        setCandles([]);
        return;
      }
      try {
        const rows = await fetchCandles({
          symbol,
          timeframe,
          from: params.from,
          to: params.to,
          limit: 5000,
        });
        if (!alive) return;
        const asc = [...rows].sort((a, b) => {
          const ta = toTs(a.time) ?? 0;
          const tb = toTs(b.time) ?? 0;
          return ta - tb;
        });
        setCandles(asc);
      } catch (_e) {
        if (!alive) return;
        setCandles([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [symbol, timeframe, params?.from, params?.to, syncWithTrades, nextOpenEntry]);

  const view = React.useMemo(() => {
    // Se sync off ou next-open off ou sem candles => volta para entriesOnlyList
    if (!syncWithTrades || !nextOpenEntry || candles.length === 0) {
      return entriesOnlyList;
    }

    // Reconstroi as ENTRADAS "next-open" a partir dos confirmados
    const times = candles.map((c) => toTs(c.time) as number);
    const idxByTs = new Map<number, number>();
    for (let i = 0; i < times.length; i++) idxByTs.set(times[i], i);

    function findIndexForTs(ts: number): number | null {
      if (!Number.isFinite(ts) || times.length === 0) return null;
      let lo = 0,
        hi = times.length - 1;
      if (ts <= times[lo]) return lo;
      if (ts >= times[hi]) return hi;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const v = times[mid];
        if (v === ts) return mid;
        if (v < ts) lo = mid + 1;
        else hi = mid - 1;
      }
      return hi >= 0 ? hi : lo;
    }

    // Simulador: queremos apenas a lista de ENTRADAS (sinais) que realmente abririam posição
    const selectedEntries: any[] = [];

    let positionOpen = false;
    let lastSide: "BUY" | "SELL" | null = null;
    let lastCloseIdx: number | null = null;

    for (const s of listAsc) {
      const side = String(s?.side || "").toUpperCase();
      const st = toTs(s?.time);
      if (st == null) continue;

      let idx = idxByTs.get(st) ?? findIndexForTs(st);
      if (idx == null) continue;

      const nextIdx = idx + 1;
      if (nextIdx >= candles.length) continue;

      // cooldown após fechamento lógico
      if (!positionOpen && lastCloseIdx != null) {
        if (nextIdx - lastCloseIdx < reEntryBarsEff) {
          continue;
        }
      }

      if (!positionOpen) {
        // abriremos posição neste sinal => registra ESTE confirmado como "entrada válida"
        selectedEntries.push(s);
        positionOpen = true;
        lastSide = side as any;
      } else {
        // posição aberta: se vier oposto, "fechamos" (lógico) e habilitamos nova entrada após cooldown
        if (side !== String(lastSide)) {
          positionOpen = false;
          lastSide = null;
          lastCloseIdx = nextIdx; // fechamento no open do N+1 do oposto
          // (não abrimos imediatamente; aguardamos próximo sinal respeitando cooldown)
        } else {
          // mesmo lado => ignoramos enquanto posição aberta
        }
      }
    }

    // O painel mostra os próprios "sinais de ENTRADA" (não as saídas).
    // selectedEntries é exatamente a lista esperada pelo AIPnLPanel (quem gerará o trade).
    return selectedEntries;
  }, [syncWithTrades, nextOpenEntry, candles, listAsc, reEntryBarsEff]);

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
            <div className="ms-auto d-flex gap-3 text-muted small">
              {entriesOnly && <em>Somente entradas</em>}
              {syncWithTrades && nextOpenEntry && <em>Sincronizado (next-open)</em>}
            </div>
          </div>

          <div className="table-responsive">
            <table className="table table-sm align-middle mb-0">
              <thead>
                <tr>
                  <th style={{ width: 180 }}>Data/Hora</th>
                  <th style={{ width: 80 }}>Lado</th>
                  <th>Preço</th>
                  <th>Observação</th>
                </tr>
              </thead>
              <tbody>
                {view.length === 0 && (
                  <tr>
                    <td className="text-muted" colSpan={4}>
                      Sem dados. Use a barra para buscar.
                    </td>
                  </tr>
                )}
                {view.map((r: any, i: number) => (
                  <tr key={i}>
                    <td>
                      <code>{fmtLocalDateTime(r.time)}</code>
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
                    <td className="text-muted">{r.note ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
              {view.length > 0 && (
                <tfoot>
                  <tr>
                    <td className="text-end text-muted" colSpan={4}>
                      {view.length} sinal(is)
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
