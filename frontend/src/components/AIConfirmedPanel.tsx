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
  return 1;
}

function toTs(iso?: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function minutesBetween(a?: string | null, b?: string | null) {
  if (!a || !b) return Infinity;
  const ta = toTs(a);
  const tb = toTs(b);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return Infinity;
  return Math.abs((tb! - ta!) / 60000);
}

function findIndexForTs(
  candles: Array<{ time: string }>,
  targetIso: string | null
) {
  if (!targetIso) return -1;
  const t = toTs(targetIso);
  if (!Number.isFinite(t)) return -1;
  let lo = 0,
    hi = candles.length - 1,
    ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const tm = toTs(candles[mid]?.time) ?? 0;
    if (tm >= (t as number)) {
      ans = mid;
      hi = mid - 1;
    } else lo = mid + 1;
  }
  return ans;
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
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: undefined,
    hour12: false,
  });
}

/* ========= Painel ========= */
function AIConfirmedPanel() {
  const rows = useAIStore((s: any) => s.confirmed);
  const params = useAIStore((s: any) => s.lastParams);

  // Controles de URL para alternar filtros sem recarregar
  const [, __forceRerender] = React.useReducer((c) => c + 1, 0);
  const setQS = React.useCallback((patch: Partial<{ entriesOnly: boolean; syncWithTrades: boolean; nextOpenEntry: boolean; reEntryBars: number | string | null; }>) => {
    if (typeof window === "undefined") return;
    const sp = new URLSearchParams(window.location.search);
    if (patch.entriesOnly !== undefined) sp.set("entriesOnly", patch.entriesOnly ? "1" : "0");
    if (patch.syncWithTrades !== undefined) sp.set("syncWithTrades", patch.syncWithTrades ? "1" : "0");
    if (patch.nextOpenEntry !== undefined) sp.set("nextOpenEntry", patch.nextOpenEntry ? "1" : "0");
    if (patch.reEntryBars !== undefined) {
      const v: any = patch.reEntryBars;
      if (v === null || v === "" || (typeof v === "number" && !Number.isFinite(v))) sp.delete("reEntryBars");
      else sp.set("reEntryBars", String(v));
    }
    const url = window.location.pathname + "?" + sp.toString();
    window.history.replaceState(null, "", url);
    __forceRerender();
  }, []);

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
      const t = s?.time ? String(s.time) : null;
      const side = String(s?.side ?? "").toUpperCase();
      if (!t || side === "FLAT" || side === "NEUTRAL") continue;

      if (flat) {
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
    Array<{ time: string; open: number; high: number; low: number; close: number }>
  >([]);

  React.useEffect(() => {
    let alive = true;
    (async () => {
      if (!syncWithTrades || !nextOpenEntry) return;
      if (!symbol || !timeframe) return;
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

    const selectedEntries: any[] = [];
    let positionOpen = false;
    let lastSide: "BUY" | "SELL" | null = null;
    let lastCloseIdx: number | null = null;

    const tfMinLocal = tfToMinutes(timeframe);
    const cooldownMin = Math.max(0, reEntryBarsEff * tfMinLocal);

    for (const s of entriesOnlyList) {
      const t = String(s.time);
      const side = String(s.side ?? "").toUpperCase() as "BUY" | "SELL";
      if (!t || (side !== "BUY" && side !== "SELL")) continue;

      const idx = findIndexForTs(candles, t);
      if (idx < 0) continue;
      const nextIdx = Math.min(idx + 1, candles.length - 1);

      // cooldown desde o fechamento lógico?
      if (lastCloseIdx != null) {
        const tClose = candles[lastCloseIdx]?.time || null;
        const nextOpenIso = candles[nextIdx]?.time || null;
        if (
          tClose &&
          nextOpenIso &&
          minutesBetween(tClose, nextOpenIso) < cooldownMin
        ) {
          continue; // ainda no cooldown
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

          {/* Controles rápidos (não alteram nomes/estrutura) */}
          <div className="d-flex flex-wrap align-items-center gap-3 mb-3">
            <div className="form-check form-switch">
              <input
                className="form-check-input"
                type="checkbox"
                id="swEntriesOnly"
                checked={entriesOnly}
                onChange={(e) => setQS({ entriesOnly: e.target.checked })}
              />
              <label className="form-check-label" htmlFor="swEntriesOnly">
                Só entradas
              </label>
            </div>
            <div className="form-check form-switch">
              <input
                className="form-check-input"
                type="checkbox"
                id="swSyncNextOpen"
                checked={syncWithTrades}
                onChange={(e) => setQS({ syncWithTrades: e.target.checked })}
              />
              <label className="form-check-label" htmlFor="swSyncNextOpen">
                Sync (next-open)
              </label>
            </div>
            <div className="input-group input-group-sm" style={{ maxWidth: 260 }}>
              <span className="input-group-text">reEntryBars</span>
              <input
                type="number"
                min={0}
                className="form-control"
                value={Number.isFinite(reEntryBars) ? (reEntryBars as number) : ("" as any)}
                placeholder={String(reEntryBarsEff) + " (auto)"}
                onChange={(e) => {
                  const v = e.target.value;
                  setQS({ reEntryBars: v === "" ? "" : Math.max(0, Number(v)) });
                }}
              />
              <span className="input-group-text">× {tfMin}m</span>
            </div>

            <span className="badge text-bg-light border">
              entriesOnly={String(entriesOnly)} · syncWithTrades={String(syncWithTrades)} · nextOpenEntry={String(nextOpenEntry)} · reEntryBars={Number.isFinite(reEntryBars) ? String(reEntryBars) : "auto(" + String(reEntryBarsEff) + ")"}
            </span>
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
                {view.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="text-center text-muted py-4">
                      Nenhum sinal para os filtros atuais.
                    </td>
                  </tr>
                ) : (
                  view.map((s: any, i: number) => (
                    <tr key={i}>
                      <td className="text-muted">{fmtLocalDateTime(s.time)}</td>
                      <td>
                        <span
                          className={
                            String(s.side).toUpperCase() === "BUY"
                              ? "badge text-bg-primary"
                              : "badge text-bg-warning"
                          }
                        >
                          {String(s.side).toUpperCase()}
                        </span>
                      </td>
                      <td>{Number.isFinite(Number(s.price)) ? Number(s.price) : "—"}</td>
                      <td className="text-muted">
                        {s.note ?? s.comment ?? s.obs ?? "—"}
                      </td>
                    </tr>
                  ))
                )}
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

export default AIConfirmedPanel;
