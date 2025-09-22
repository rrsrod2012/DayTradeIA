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

export type Trade = {
  side: "BUY" | "SELL";
  entryTime: string; // ISO
  exitTime?: string | null; // ISO
  entryPrice?: number | null;
  exitPrice?: number | null;
  pnlPoints?: number | null;
  pnlMoney?: number | null;
  rr?: number | null;
  note?: string | null;
  movedToBE?: boolean;
  trailEvents?: number | null;
};

type AIState = {
  // filtros usados na última consulta (qualquer tipo)
  lastParams: Record<string, any> | null;

  // dados
  projected: ProjectedSignal[];
  confirmed: ConfirmedSignal[];
  pnl: PnLSummary;
  trades: Trade[];

  // setters
  setProjected: (rows: ProjectedSignal[], params?: Record<string, any>) => void;
  setConfirmed: (rows: ConfirmedSignal[], params?: Record<string, any>) => void;
  setPnL: (summary: PnLSummary) => void;
  setTrades: (rows: any[], meta?: any) => void; // meta opcional para pointValue/summary
  clear: () => void;
};

// ---- Normalização robusta do lado (nunca “perder” SELL/BUY) ----
function normSide(raw: any): "BUY" | "SELL" | "FLAT" {
  const s = String(raw ?? "").trim().toUpperCase();
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
  // fallback: assume BUY para não sumir com o ponto
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

function toISO(t: any): string | null {
  if (!t && t !== 0) return null;
  if (typeof t === "string") {
    return /Z$|[+-]\d{2}:?\d{2}$/.test(t) ? t : new Date(t).toISOString();
  }
  if (t instanceof Date) return t.toISOString();
  if (typeof t === "number") return new Date(t).toISOString();
  return null;
}

// Normalização de trade (suporta vários formatos de backend)
function normalizeTrade(row: any): Trade | null {
  if (!row || typeof row !== "object") return null;

  const side = normSide(
    row.side ?? row.direction ?? row.type ?? row.signalSide ?? row.position
  );
  if (side === "FLAT") return null;

  const entryTime =
    toISO(
      row.entryTime ??
      row.openTime ??
      row.inTime ??
      row.timeIn ??
      row.time_open ??
      row.start ??
      row.time
    ) || new Date().toISOString();

  const exitTime =
    toISO(
      row.exitTime ??
      row.closeTime ??
      row.outTime ??
      row.timeOut ??
      row.time_close ??
      row.end ??
      row.closeAt
    ) || null;

  const num = (v: any) => (v === undefined || v === null ? null : Number(v));

  const entryPrice = num(
    row.entryPrice ?? row.openPrice ?? row.priceIn ?? row.entry
  );
  const exitPrice = num(
    row.exitPrice ?? row.closePrice ?? row.priceOut ?? row.exit
  );

  const pnlPoints = num(
    row.pnlPoints ??
    row.pnl_points ??
    row.points ??
    row.plPoints ??
    row.resultPoints ??
    row.pnl
  );
  const pnlMoney = num(
    row.pnlMoney ?? row.plMoney ?? row.money ?? row.resultMoney
  );
  const rr = num(
    row.rr ?? row.rmult ?? row.rMultiple ?? row.rMultipleCalc ?? row.RR
  );

  const note =
    row.note ??
    row.reason ??
    row.comment ??
    row.conditionText ??
    row.obs ??
    null;

  const movedToBE =
    (row.movedToBE ?? row.breakEven ?? row.beMoved ?? row.moved_be) ?? null;
  const trailEvents =
    (row.trailEvents ?? row.trails ?? row.trail_updates) ?? null;

  return {
    side: side as "BUY" | "SELL",
    entryTime,
    exitTime,
    entryPrice,
    exitPrice,
    pnlPoints,
    pnlMoney,
    rr,
    note: note != null ? String(note) : null,
    movedToBE: movedToBE != null ? Boolean(movedToBE) : undefined,
    trailEvents:
      trailEvents != null && Number.isFinite(Number(trailEvents))
        ? Number(trailEvents)
        : null,
  };
}

/* ---------- Config dinâmica para PnL$ e RR ----------

Você pode definir em runtime (no index.html, por exemplo):

  <script>
    window.DAYTRADE_CFG = {
      pointValueBySymbol: { WIN: 1.0, WDO: 10.0 },
      defaultRiskPoints: 100
    }
  </script>

Ou via .env do Vite:
  VITE_POINT_VALUE_WIN=1.0
  VITE_POINT_VALUE_WDO=10
  VITE_DEFAULT_RISK_POINTS=100

O store usa nessa ordem:
  meta.pointValue (do backtest) > window.DAYTRADE_CFG > variáveis .env
------------------------------------------------------- */

declare global {
  interface Window {
    DAYTRADE_CFG?: {
      pointValueBySymbol?: Record<string, number>;
      defaultRiskPoints?: number;
    };
  }
}

function readEnvPointValue(symbol: string): number | null {
  const key = `VITE_POINT_VALUE_${symbol}`;
  const val =
    (import.meta as any)?.env?.[key] ??
    (import.meta as any)?.env?.[key.toUpperCase()];
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}
function readEnvDefaultRiskPoints(): number | null {
  const val = (import.meta as any)?.env?.VITE_DEFAULT_RISK_POINTS;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

function inferPointValue(
  symbol: string | undefined,
  meta?: any
): number | null {
  // 1) meta.pointValue do backtest
  const m = meta?.pointValue ?? meta?.meta?.pointValue;
  if (m != null && Number.isFinite(Number(m))) return Number(m);

  const sym = String(symbol || "").toUpperCase();
  // 2) window.DAYTRADE_CFG
  const byWin = window?.DAYTRADE_CFG?.pointValueBySymbol?.[sym];
  if (byWin != null && Number.isFinite(Number(byWin))) return Number(byWin);
  // 3) .env
  const fromEnv = readEnvPointValue(sym);
  if (fromEnv != null) return fromEnv;

  return null; // sem palpite perigoso
}

function inferDefaultRiskPoints(meta?: any): number | null {
  // 1) do backtest meta
  const m = meta?.defaultRiskPoints ?? meta?.meta?.defaultRiskPoints;
  if (m != null && Number.isFinite(Number(m))) return Number(m);
  // 2) window
  const byWin = window?.DAYTRADE_CFG?.defaultRiskPoints;
  if (byWin != null && Number.isFinite(Number(byWin))) return Number(byWin);
  // 3) .env
  const fromEnv = readEnvDefaultRiskPoints();
  if (fromEnv != null) return fromEnv;

  return null;
}

/* ---------- Util: resumo PnL derivado (se precisar) ---------- */
function derivePnLSummary(
  trades: Trade[],
  pointValue?: number | null
): PnLSummary {
  if (!trades.length) {
    return {
      trades: 0,
      wins: 0,
      losses: 0,
      ties: 0,
      winRate: 0,
      pnlPoints: 0,
      pnlMoney: 0,
      avgPnL: 0,
      profitFactor: 0,
      maxDrawdown: 0,
    };
  }
  const vals = trades.map((t) => Number(t.pnlPoints ?? 0));
  const wins = vals.filter((v) => v > 0).length;
  const losses = vals.filter((v) => v < 0).length;
  const ties = vals.filter((v) => v === 0).length;
  const pnlPoints = Number(vals.reduce((a, b) => a + b, 0).toFixed(2));
  const avgPnL = Number((pnlPoints / trades.length).toFixed(2));
  const sumWin = vals.filter((v) => v > 0).reduce((a, b) => a + b, 0);
  const sumLossAbs = Math.abs(vals.filter((v) => v < 0).reduce((a, b) => a + b, 0));
  const profitFactor =
    sumLossAbs > 0 ? Number((sumWin / sumLossAbs).toFixed(3)) : wins > 0 ? Infinity : 0;

  // max drawdown em pontos
  let peak = 0,
    dd = 0,
    run = 0;
  for (const v of vals) {
    run += v;
    peak = Math.max(peak, run);
    dd = Math.min(dd, run - peak);
  }
  const maxDrawdown = Number(dd.toFixed(2));
  const pnlMoney =
    pointValue != null && Number.isFinite(pointValue)
      ? Number((pnlPoints * pointValue).toFixed(2))
      : undefined;

  return {
    trades: trades.length,
    wins,
    losses,
    ties,
    winRate: Number((wins / trades.length || 0).toFixed(4)),
    pnlPoints,
    pnlMoney,
    avgPnL,
    profitFactor,
    maxDrawdown,
  };
}

const useAIStore = create<AIState>((set) => ({
  lastParams: null,
  projected: [],
  confirmed: [],
  pnl: null,
  trades: [],

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

  setTrades: (rows, meta) =>
    set((state) => {
      // detecta coleção (agora também suporta rows.trades)
      const src = Array.isArray(rows)
        ? rows
        : Array.isArray(rows?.trades)
          ? rows.trades
          : Array.isArray(rows?.data)
            ? rows.data
            : Array.isArray(rows?.rows)
              ? rows.rows
              : Array.isArray(rows?.items)
                ? rows.items
                : [];

      const mapped = src
        .map((r) => normalizeTrade(r))
        .filter((x): x is Trade => !!x);

      // Fallbacks para pnlMoney e rr
      const symbol =
        String(state.lastParams?.symbol || "").toUpperCase() || undefined;
      const pointValue = inferPointValue(symbol, meta ?? rows);
      const defaultRiskPoints = inferDefaultRiskPoints(meta ?? rows);

      for (const t of mapped) {
        // PnL em $
        if (
          (t.pnlMoney == null || !Number.isFinite(Number(t.pnlMoney))) &&
          t.pnlPoints != null &&
          Number.isFinite(Number(t.pnlPoints)) &&
          pointValue != null &&
          Number.isFinite(Number(pointValue))
        ) {
          t.pnlMoney = Number(t.pnlPoints) * Number(pointValue);
        }

        // R/R
        if (t.rr == null || !Number.isFinite(Number(t.rr))) {
          if (
            t.pnlPoints != null &&
            Number.isFinite(Number(t.pnlPoints)) &&
            defaultRiskPoints != null &&
            Number.isFinite(Number(defaultRiskPoints)) &&
            Number(defaultRiskPoints) !== 0
          ) {
            t.rr = Number(t.pnlPoints) / Number(defaultRiskPoints);
          }
        }
      }

      // Se veio um summary do back-end, usa; senão, deriva
      const summaryFromMeta: PnLSummary =
        meta?.summary && typeof meta.summary === "object"
          ? {
            trades: Number(meta.summary.trades ?? mapped.length),
            wins: Number(meta.summary.wins ?? 0),
            losses: Number(meta.summary.losses ?? 0),
            ties: Number(meta.summary.ties ?? 0),
            winRate: Number(meta.summary.winRate ?? 0),
            pnlPoints: Number(meta.summary.pnlPoints ?? 0),
            pnlMoney:
              meta.summary.pnlMoney != null
                ? Number(meta.summary.pnlMoney)
                : pointValue != null
                  ? Number(
                    (Number(meta.summary.pnlPoints ?? 0) * pointValue).toFixed(
                      2
                    )
                  )
                  : undefined,
            avgPnL: Number(meta.summary.avgPnL ?? 0),
            profitFactor:
              typeof meta.summary.profitFactor === "number"
                ? meta.summary.profitFactor
                : Number(meta.summary.profitFactor ?? 0),
            maxDrawdown: Number(meta.summary.maxDrawdown ?? 0),
          }
          : null;

      const derived =
        summaryFromMeta ??
        derivePnLSummary(mapped, pointValue != null ? Number(pointValue) : null);

      if (process.env.NODE_ENV !== "production") {
        // eslint-disable-next-line no-console
        const buy = mapped.filter((t) => t.side === "BUY").length;
        const sell = mapped.filter((t) => t.side === "SELL").length;
        console.log("[AIStore] setTrades", {
          received: src.length,
          mapped: mapped.length,
          buy,
          sell,
          pointValue,
          defaultRiskPoints,
          example: mapped[0] || null,
        });
      }

      return { trades: mapped, pnl: derived };
    }),

  clear: () =>
    set({
      projected: [],
      confirmed: [],
      pnl: null,
      trades: [],
      lastParams: null,
    }),
}));

export { useAIStore };
export default useAIStore;
