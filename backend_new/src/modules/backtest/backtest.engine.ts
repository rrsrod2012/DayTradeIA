import { DateTime } from 'luxon';
import { loadCandlesAnyTF } from '../data-import/lib/aggregation';
import { ema, ADX } from '../strategy/lib/indicators';

const ZONE_BR = "America/Sao_Paulo";

// Helpers
const toNum = (v: any, def = 0): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
};

const toBool = (v: any): boolean => {
    if (typeof v === "boolean") return v;
    const s = String(v ?? "").trim().toLowerCase();
    return s === "1" || s === "true" || s === "on" || s === "yes";
};

// Normalização de datas
const parseUserDate = (raw: any): { ok: boolean; dt: DateTime } => {
    if (raw == null) return { ok: false, dt: DateTime.invalid("empty") };
    const s = String(raw).trim();
    const dtISO = DateTime.fromISO(s, { zone: ZONE_BR });
    if (dtISO.isValid) return { ok: true, dt: dtISO };
    return { ok: false, dt: DateTime.invalid("unparsed") };
};

const normalizeDayRange = (fromRaw: any, toRaw: any): { from: DateTime; to: DateTime } | null => {
    const pF = parseUserDate(fromRaw);
    const pT = parseUserDate(toRaw);
    if (!pF.ok && !pT.ok) return null;

    let from = pF.ok ? pF.dt : DateTime.now().setZone(ZONE_BR).minus({ days: 1 });
    let to = pT.ok ? pT.dt : DateTime.now().setZone(ZONE_BR);

    if (pF.ok && !pT.ok) to = from.endOf('day');
    if (!pF.ok && pT.ok) from = to.startOf('day');
    
    return { from: from.startOf('day'), to: to.endOf('day') };
};


export const runBacktest = async (params: any) => {
    const { symbol, timeframe, from, to, rr = 2, slPoints = 0, tpPoints = 0, tpViaRR = true } = params;

    if (!symbol || !timeframe) {
        throw new Error("Símbolo e timeframe são obrigatórios para o backtest.");
    }

    const range = normalizeDayRange(from, to);
    const fromDate = range ? range.from.toJSDate() : DateTime.now().minus({ days: 1 }).startOf('day').toJSDate();
    const toDate = range ? range.to.toJSDate() : DateTime.now().endOf('day').toJSDate();

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

    return {
        trades,
        summary: {
            pnlPoints: parseFloat(totalPnl.toFixed(2)),
            count: trades.length,
            winRate: trades.length > 0 ? trades.filter(t => (t.pnlPoints ?? 0) > 0).length / trades.length : 0,
        },
        params: { symbol, timeframe, from: fromDate.toISOString(), to: toDate.toISOString() }
    };
};