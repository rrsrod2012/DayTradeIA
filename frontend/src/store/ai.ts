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

export const useAIStore = create<AIState>((set) => ({
  lastParams: null,
  projected: [],
  confirmed: [],
  pnl: null,

  setProjected: (rows, params) =>
    set(() => ({ projected: rows, lastParams: params ?? null })),
  setConfirmed: (rows, params) =>
    set(() => ({ confirmed: rows, lastParams: params ?? null })),
  setPnL: (summary) => set(() => ({ pnl: summary })),
  clear: () =>
    set({ projected: [], confirmed: [], pnl: null, lastParams: null }),
}));
