import { create } from "zustand";
import type { ProjectedSignal, ConfirmedSignal } from "../services/api";

type PnLSummary = {
  trades: number;
  wins: number;
  losses: number;
  ties: number;
  winRate: number;
  pnlPoints: number;
  pnlMoney?: number;
  avgPnL: number;
  profitFactor: number;
  maxDrawdown: number;
} | null;

type AIState = {
  // filtros usados na última consulta (qualquer tipo)
  lastParams: Record<string, any> | null;

  // dados
  projected: ProjectedSignal[];
  confirmed: ConfirmedSignal[];
  pnl: PnLSummary;

  // setters
  setProjected: (rows: ProjectedSignal[], params?: Record<string, any>) => void;
  setConfirmed: (rows: ConfirmedSignal[], params?: Record<string, any>) => void;
  setPnL: (summary: PnLSummary) => void;
  clear: () => void;
};

// ---- Normalização robusta do lado (nunca “perder” SELL/BUY) ----
function normSide(raw: any): "BUY" | "SELL" | "FLAT" {
  const s = String(raw ?? "")
    .trim()
    .toUpperCase();
  if (
    s === "SELL" ||
    s === "SHORT" ||
    s === "S" ||
    s === "-1" ||
    s === "DOWN" ||
    s.includes("SELL") ||
    s.includes("SHORT")
  ) {
    return "SELL";
  }
  if (
    s === "BUY" ||
    s === "LONG" ||
    s === "B" ||
    s === "1" ||
    s === "UP" ||
    s.includes("BUY") ||
    s.includes("LONG")
  ) {
    return "BUY";
  }
  if (s === "FLAT" || s === "NEUTRAL" || s === "0") return "FLAT";
  // fallback: não descartar; assume BUY para não sumir com o ponto
  return "BUY";
}

// Positivar EV para SELL (evita filtros minEV=0 eliminarem SELL)
function normalizeEVForSide(
  row: any,
  side: "BUY" | "SELL" | "FLAT"
): number | null {
  const candidates = [
    row?.expectedValuePoints,
    row?.ev,
    row?.expectedValue,
    row?.expected_value,
  ];
  const found = candidates.find(
    (v) => v !== undefined && v !== null && Number.isFinite(Number(v))
  );
  if (found === undefined) return row?.expectedValuePoints ?? null;
  const n = Number(found);
  if (!Number.isFinite(n)) return null;
  return side === "SELL" ? Math.abs(n) : n;
}

const useAIStore = create<AIState>((set) => ({
  lastParams: null,
  projected: [],
  confirmed: [],
  pnl: null,

  setProjected: (rows, params) =>
    set(() => {
      const src = Array.isArray(rows) ? rows : [];
      let buy = 0,
        sell = 0;

      const mapped: ProjectedSignal[] = src.map((r: any) => {
        const side = normSide(
          r?.side ?? r?.direction ?? r?.type ?? r?.signalSide
        );
        if (side === "BUY") buy++;
        else if (side === "SELL") sell++;

        // Coerção numérica sem engolir 0
        const num = (v: any) =>
          v === undefined || v === null ? null : Number(v);

        // EV positivado para SELL
        const evPos = normalizeEVForSide(r, side);

        const out: ProjectedSignal = {
          side,
          suggestedEntry: num(r?.suggestedEntry ?? r?.entry),
          stopSuggestion: num(r?.stopSuggestion ?? r?.sl ?? r?.stop),
          takeProfitSuggestion: num(r?.takeProfitSuggestion ?? r?.tp),
          conditionText: r?.conditionText ?? r?.note ?? r?.reason ?? null,
          score: num(r?.score),
          probHit: r?.probHit != null ? Number(r.probHit) : null,
          probCalibrated:
            r?.probCalibrated != null ? Number(r.probCalibrated) : null,
          expectedValuePoints:
            evPos !== null ? Number(evPos) : r?.expectedValuePoints ?? null,
          time: r?.time,
          date: r?.date ?? null,
        };
        return out;
      });

      if (process.env.NODE_ENV !== "production") {
        // eslint-disable-next-line no-console
        console.log("[AIStore] setProjected", {
          received: src.length,
          buy,
          sell,
          exampleSELL: mapped.find((x) => x.side === "SELL") || null,
        });
      }

      return { projected: mapped, lastParams: params ?? null };
    }),

  setConfirmed: (rows, params) =>
    set(() => {
      const src = Array.isArray(rows) ? rows : [];
      let buy = 0,
        sell = 0;

      const mapped: ConfirmedSignal[] = src.map((r: any) => {
        const side = normSide(
          r?.side ?? r?.direction ?? r?.type ?? r?.signalSide
        );
        if (side === "BUY") buy++;
        else if (side === "SELL") sell++;

        const out: ConfirmedSignal = {
          side,
          time: String(r?.time ?? r?.timestamp ?? new Date().toISOString()),
          price:
            r?.price != null
              ? Number(r.price)
              : r?.entry != null
              ? Number(r.entry)
              : r?.value != null
              ? Number(r.value)
              : r?.execPrice != null
              ? Number(r.execPrice)
              : null,
          note: r?.note ?? r?.reason ?? r?.conditionText ?? r?.comment ?? null,
        };
        return out;
      });

      if (process.env.NODE_ENV !== "production") {
        // eslint-disable-next-line no-console
        console.log("[AIStore] setConfirmed", {
          received: src.length,
          buy,
          sell,
        });
      }

      return { confirmed: mapped, lastParams: params ?? null };
    }),

  setPnL: (summary) => set(() => ({ pnl: summary })),

  clear: () =>
    set({ projected: [], confirmed: [], pnl: null, lastParams: null }),
}));

// Exporte nos dois formatos para eliminar divergência de import em qualquer componente.
export { useAIStore };
export default useAIStore;
