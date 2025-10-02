// ===============================
// FILE: backend_new/src/modules/backtest/backtest.engine.ts
// ===============================
import { DateTime } from 'luxon';
import { loadCandlesAnyTF } from '../data-import/lib/aggregation';
<<<<<<< HEAD
import { ema, ATR, VWAP } from '../strategy/indicators';
import { logger } from '../../core/logger';
=======
import { ema, ADX } from '../strategy/indicators';
>>>>>>> 366c209d194f3a00ff5fc64ff7310018020f914f

// Tipos auxiliares
type BacktestParams = {
  symbol: string;
  timeframe: string;
  from?: string;
  to?: string;
  rr?: number;
  tpViaRR?: boolean;
  slPoints?: number;
  tpPoints?: number;
  atrPeriod?: number;
  k_sl?: number;
  k_tp?: number;
  vwapFilter?: boolean;
  sameBarExit?: boolean;
  breakEvenAtPts?: number;
  beOffsetPts?: number;
  debug?: boolean;
};

type Trade = {
  id: number;
  symbol: string;
  timeframe: string;
  side: "BUY" | "SELL";
  entryTime: string;
  exitTime: string | null;
  entryPrice: number;
  exitPrice: number | null;
  pnlPoints: number | null;
  diag?: any;
};

// Funções utilitárias de conversão e normalização (privadas ao módulo)
const toBool = (v: any): boolean => {
  if (typeof v === "boolean") return v;
  const s = String(v ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "on" || s === "yes";
};

const toNum = (v: any, def = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

// Função principal do motor de backtesting
export async function runBacktest(params: BacktestParams) {
  const {
    symbol,
    timeframe,
    from,
    to,
    rr = 2,
    tpViaRR = false,
    slPoints = 0,
    tpPoints = 0,
    atrPeriod = 14,
    k_sl = 1.0,
    k_tp = rr,
    vwapFilter = false,
    sameBarExit = false,
    breakEvenAtPts = 0,
    beOffsetPts = 0,
    debug = false,
  } = params;

  // 1. Carregar Candles
  const candles = await loadCandlesAnyTF(symbol, timeframe, {
    gte: from ? new Date(from) : undefined,
    lte: to ? new Date(to) : undefined,
  });

<<<<<<< HEAD
  if (!candles || candles.length < 22) {
    return { ok: true, trades: [], summary: { points: 0 }, count: 0 };
  }
=======
    if (pF.ok && !pT.ok) to = from.endOf('day');
    if (!pF.ok && pT.ok) from = to.startOf('day');

    return { from: from.startOf('day'), to: to.endOf('day') };
};
>>>>>>> 366c209d194f3a00ff5fc64ff7310018020f914f

  // 2. Calcular Indicadores
  const closes = candles.map((c) => Number(c.close));
  const highs = candles.map((c) => Number(c.high));
  const lows = candles.map((c) => Number(c.low));
  
  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  const atr = ATR(candles, toNum(atrPeriod, 14));
  const vwap = VWAP(candles);

  // 3. Lógica de Simulação
  const trades: Trade[] = [];
  let inTrade = false;
  let tradeSide: "BUY" | "SELL" | null = null;
  let entryIdx = -1;
  let entryPrice = 0;

  for (let i = 1; i < candles.length - 1; i++) {
    // Gerenciamento de posição aberta
    if (inTrade && entryIdx >= 0) {
      const iTest = sameBarExit ? i : Math.max(i, entryIdx + 1);
      if (iTest <= entryIdx) continue;

      const atrPts = slPoints > 0 || tpPoints > 0 ? null : Math.max(atr[entryIdx] ?? atr[iTest] ?? 0, 0);
      const slPts = slPoints > 0 ? slPoints : atrPts ? atrPts * toNum(k_sl, 1.0) : 0;
      let tpPtsCalc = tpPoints > 0 ? tpPoints : atrPts ? atrPts * (toNum(k_tp, rr) || rr) : 0;
      if (toBool(tpViaRR) && slPts > 0) tpPtsCalc = slPts * toNum(rr, 2);

<<<<<<< HEAD
      let slPrice: number | null = slPts > 0 ? (tradeSide === "BUY" ? entryPrice - slPts : entryPrice + slPts) : null;
      const tpPrice: number | null = tpPtsCalc > 0 ? (tradeSide === "BUY" ? entryPrice + tpPtsCalc : entryPrice - tpPtsCalc) : null;
      
      const beTrigger = toNum(breakEvenAtPts, 0);
      if (beTrigger > 0) {
        const movedEnough = (tradeSide === "BUY" && highs[iTest] - entryPrice >= beTrigger) || (tradeSide === "SELL" && entryPrice - lows[iTest] >= beTrigger);
        if (movedEnough) {
          const bePrice = tradeSide === "BUY" ? entryPrice + toNum(beOffsetPts, 0) : entryPrice - toNum(beOffsetPts, 0);
          slPrice = slPrice == null ? bePrice : (tradeSide === "BUY" ? Math.max(slPrice, bePrice) : Math.min(slPrice, bePrice));
        }
      }
=======
    const candles = await loadCandlesAnyTF(symbol, timeframe, { gte: fromDate, lte: toDate });
    if (candles.length < 22) {
        return { trades: [], summary: { pnlPoints: 0, count: 0 } };
    }

    const closes = candles.map(c => c.close);
    const e9 = ema(closes, 9);
    const e21 = ema(closes, 21);

    type Trade = {
        id: number;
        symbol: string;
        timeframe: string;
        side: "BUY" | "SELL";
        entryTime: string;
        exitTime: string | null;
        entryPrice: number;
        exitPrice: number | null;
        pnlPoints: number | null;
    };
    const trades: Trade[] = [];
    let inTrade = false;
    let currentTrade: Partial<Trade> = {};

    for (let i = 1; i < candles.length; i++) {
        const prevDiff = e9[i - 1] - e21[i - 1];
        const diff = e9[i] - e21[i];

        let side: 'BUY' | 'SELL' | null = null;
        if (prevDiff <= 0 && diff > 0) side = 'BUY';
        if (prevDiff >= 0 && diff < 0) side = 'SELL';

        if (!inTrade && side) {
            inTrade = true;
            currentTrade = {
                id: trades.length + 1,
                symbol,
                timeframe,
                side,
                entryTime: candles[i].time.toISOString(),
                entryPrice: candles[i].close,
            };
        } else if (inTrade && side && side !== currentTrade.side) {
            currentTrade.exitTime = candles[i].time.toISOString();
            currentTrade.exitPrice = candles[i].close;

            const pnl = currentTrade.side === 'BUY'
                ? currentTrade.exitPrice - (currentTrade.entryPrice ?? 0)
                : (currentTrade.entryPrice ?? 0) - currentTrade.exitPrice;
            currentTrade.pnlPoints = pnl;

            trades.push(currentTrade as Trade);
            inTrade = false;
            currentTrade = {};

            // Entra no novo trade
            inTrade = true;
            currentTrade = {
                id: trades.length + 1,
                symbol,
                timeframe,
                side,
                entryTime: candles[i].time.toISOString(),
                entryPrice: candles[i].close,
            };
        }
    }

    if (inTrade && currentTrade.entryPrice) {
        const lastCandle = candles[candles.length - 1];
        currentTrade.exitTime = lastCandle.time.toISOString();
        currentTrade.exitPrice = lastCandle.close;
        const pnl = currentTrade.side === 'BUY'
            ? currentTrade.exitPrice - currentTrade.entryPrice
            : currentTrade.entryPrice - currentTrade.exitPrice;
        currentTrade.pnlPoints = pnl;
        trades.push(currentTrade as Trade);
    }

    const totalPnl = trades.reduce((sum, trade) => sum + (trade.pnlPoints || 0), 0);
>>>>>>> 366c209d194f3a00ff5fc64ff7310018020f914f

      let hit: "SL" | "TP" | null = null;
      if (slPrice != null && ((tradeSide === "BUY" && lows[iTest] <= slPrice) || (tradeSide === "SELL" && highs[iTest] >= slPrice))) {
        hit = "SL";
      } else if (tpPrice != null && ((tradeSide === "BUY" && highs[iTest] >= tpPrice) || (tradeSide === "SELL" && lows[iTest] <= tpPrice))) {
        hit = "TP";
      }

      if (hit) {
        const exitPrice = hit === "SL" ? (slPrice as number) : (tpPrice as number);
        const pnl = tradeSide === "BUY" ? exitPrice - entryPrice : entryPrice - exitPrice;
        trades.push({
          id: trades.length + 1, symbol, timeframe, side: tradeSide!,
          entryTime: candles[entryIdx].time.toISOString(),
          exitTime: candles[iTest].time.toISOString(),
          entryPrice, exitPrice, pnlPoints: Number(pnl.toFixed(2)),
        });
        inTrade = false; tradeSide = null; entryIdx = -1; entryPrice = 0;
        continue;
      }
    }

    // Lógica de entrada
    if (!inTrade) {
      const prevUp = e9[i - 1] != null && e21[i - 1] != null && (e9[i - 1] as number) <= (e21[i - 1] as number);
      const nowUp = e9[i] != null && e21[i] != null && (e9[i] as number) > (e21[i] as number);
      const prevDn = e9[i - 1] != null && e21[i - 1] != null && (e9[i - 1] as number) >= (e21[i - 1] as number);
      const nowDn = e9[i] != null && e21[i] != null && (e9[i] as number) < (e21[i] as number);
      const crossUp = prevUp && nowUp;
      const crossDn = prevDn && nowDn;
      
      if (!crossUp && !crossDn) continue;
      
      if (toBool(vwapFilter)) {
        const vw = vwap[i];
        if (vw != null) {
          if (crossUp && closes[i] < (vw as number)) continue;
          if (crossDn && closes[i] > (vw as number)) continue;
        }
      }
      
      const j = i + 1;
      const entry = Number.isFinite((candles[j] as any).open) ? Number((candles[j] as any).open) : Number(candles[j].close);
      inTrade = true;
      tradeSide = crossUp ? "BUY" : "SELL";
      entryIdx = j;
      entryPrice = entry;
    }
  }

  // Fechamento forçado no final
  if (inTrade && entryIdx >= 0) {
    const last = candles.length - 1;
    const exitPrice = Number(candles[last].close);
    const pnl = tradeSide === "BUY" ? exitPrice - entryPrice : entryPrice - exitPrice;
    trades.push({
      id: trades.length + 1, symbol, timeframe, side: tradeSide!,
      entryTime: candles[entryIdx].time.toISOString(),
      exitTime: candles[last].time.toISOString(),
      entryPrice, exitPrice, pnlPoints: Number(pnl.toFixed(2)),
    });
  }

  const totalPts = trades.reduce((s, t) => s + (t.pnlPoints || 0), 0);

  return {
    ok: true,
    symbol,
    timeframe,
    from: from,
    to: to,
    count: trades.length,
    summary: { points: Number(totalPts.toFixed(2)) },
    trades: trades,
  };
}