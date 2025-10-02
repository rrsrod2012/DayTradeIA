// ===============================
// FILE: backend_new/src/modules/api/signalsRoutes.ts
// ===============================
import { Router, Request, Response } from 'express';
import { prisma } from '../../core/prisma';
import { logger } from '../../core/logger';
import { loadCandlesAnyTF } from '../data-import/lib/aggregation';
import { ADX, ATR, ema } from '../strategy/indicators';
import { normalizeApiDateRange, toLocalDateStr, tfToMinutes } from './api.helpers';
import { DateTime } from 'luxon';

const router = Router();
const ZONE = "America/Sao_Paulo";

router.get('/signals', async (req: Request, res: Response) => {
  try {
    const {
      symbol: symbolQ,
      timeframe: timeframeQ,
      from: _from,
      to: _to,
      dateFrom,
      dateTo,
      limit = "200",
      quality = "1",
      adxMin,
      spreadMinAtr,
      slopeMinAtr,
      cooldownBars,
      vwapSideRequired,
      vwapMinDistAtr,
      oppMinBars,
      pairPrefer,
      entriesOnly = "1",
      reEntryBars,
    } = req.query as any;

    const applyQuality = String(quality ?? "1") !== "0";
    const wantEntriesOnly = String(entriesOnly ?? "1") !== "0";

    const symbol = (symbolQ ? String(symbolQ).trim() : "").toUpperCase();
    const tfUpper = (timeframeQ ? String(timeframeQ).trim().toUpperCase() : "") || undefined;
    const tfNum = tfUpper ? tfToMinutes(tfUpper) : undefined;

    const from = (_from as string) || (dateFrom as string) || undefined;
    const to = (_to as string) || (dateTo as string) || undefined;

    // <<< CORREÇÃO DA LÓGICA DE DATAS AQUI >>>
    // Substituído 'toUtcRange' pela função correta 'normalizeApiDateRange'.
    const range = normalizeApiDateRange(from, to);
    const effLimit = Number(limit) || 200;

    const whereBase: any = {};
    // <<< CORREÇÃO DA SINTAXE DA CONSULTA PRISMA >>>
    if (range) {
      whereBase.candle = { time: range };
    }

    const signalsRaw = await prisma.signal.findMany({
      where: whereBase,
      orderBy: [{ id: "desc" }],
      take: effLimit,
      include: {
        candle: {
          select: {
            id: true, time: true, timeframe: true, close: true, open: true, high: true, low: true,
            instrument: { select: { symbol: true } },
          },
        },
      },
    });

    const signalsAsc = signalsRaw
      .filter((s) => {
        if (symbol && s.candle.instrument.symbol.toUpperCase() !== symbol) return false;
        if (tfNum != null && tfToMinutes(s.candle.timeframe) !== Number(tfNum)) return false;
        return true;
      })
      .sort((a, b) => a.candle.time.getTime() - b.candle.time.getTime());

    if (signalsAsc.length === 0) return res.json([]);

    if (!applyQuality) {
      const baseItems = signalsAsc.map((s) => ({
        id: s.id, candleId: s.candleId, time: s.candle.time.toISOString(), date: toLocalDateStr(s.candle.time),
        timeframe: s.candle.timeframe, symbol: s.candle.instrument.symbol, type: s.signalType, side: s.side,
        score: s.score, meta: (s as any).meta, price: s.candle.close, note: "EMA9xEMA21",
      }));
      return res.json(baseItems);
    }

    const firstT = signalsAsc[0].candle.time;
    const lastT = signalsAsc[signalsAsc.length - 1].candle.time;
    const tfM = tfNum ?? 5;
    const lookbackBars = 200;
    const fromCand = DateTime.fromJSDate(firstT).minus({ minutes: lookbackBars * tfM }).toJSDate();
    const toCand = DateTime.fromJSDate(lastT).plus({ minutes: 2 * tfM }).toJSDate();
    const sym = symbol || signalsAsc[0].candle.instrument.symbol.toUpperCase();
    const tfStr = tfUpper || `M${tfM}`;

    const candles = await loadCandlesAnyTF(sym, tfStr, { gte: fromCand, lte: toCand });
    if (!candles?.length) return res.json([]);

    const times = candles.map((c) => c.time.getTime());
    const closes = candles.map((c) => Number(c.close));
    const highs = candles.map((c) => Number(c.high));
    const lows = candles.map((c) => Number(c.low));

    const e9 = ema(closes, 9);
    const e21 = ema(closes, 21);
    const atr = ATR(candles.map((c) => ({ high: c.high, low: c.low, close: c.close })), 14);
    const adx = ADX(candles.map((c) => ({ high: c.high, low: c.low, close: c.close })), 14);

    const vwap: (number | null)[] = [];
    let accPV = 0, accVol = 0;
    let prevDay: string | null = null;
    for (let i = 0; i < candles.length; i++) {
      const day = DateTime.fromJSDate(candles[i].time).setZone(ZONE).toFormat("yyyy-LL-dd");
      if (day !== prevDay) {
        prevDay = day; accPV = 0; accVol = 0;
      }
      const typical = (highs[i] + lows[i] + closes[i]) / 3;
      const vol = Number.isFinite((candles[i] as any).volume) ? Number((candles[i] as any).volume) : 1;
      accPV += typical * vol;
      accVol += vol;
      vwap.push(accVol > 0 ? accPV / accVol : typical);
    }

    const idxByTime = new Map<number, number>();
    for (let i = 0; i < times.length; i++) idxByTime.set(times[i], i);

    const adxMinEff = Number.isFinite(Number(adxMin)) ? Number(adxMin) : (tfM <= 1 ? 18 : 20);
    const spreadMinEff = Number.isFinite(Number(spreadMinAtr)) ? Math.max(0, Number(spreadMinAtr)) : (tfM <= 1 ? 0.25 : 0.30);
    const slopeMinEff = Number.isFinite(Number(slopeMinAtr)) ? Math.max(0, Number(slopeMinAtr)) : (tfM <= 1 ? 0.06 : 0.07);
    const vwapSideReq = String(vwapSideRequired ?? "0") === "1";
    const vwapMinDistEff = Number.isFinite(Number(vwapMinDistAtr)) ? Math.max(0, Number(vwapMinDistAtr)) : 0;
    const minGap = Number.isFinite(Number(cooldownBars)) ? Math.max(0, Number(cooldownBars)) : (tfM <= 1 ? 3 : 2);
    const oppMinBarsEff = Number.isFinite(Number(oppMinBars)) ? Math.max(0, Number(oppMinBars)) : (tfM <= 1 ? 4 : 3);
    const pairPreferMode = String(pairPrefer || "stronger").toLowerCase() === "older" ? "older" : "stronger";

    function strengthAt(i: number): number {
      const atrv = atr[i] ?? 0;
      const atrRef = Math.max(atrv, 1e-6);
      const sNow = (e9[i] ?? closes[i]) - (e21[i] ?? closes[i]);
      const sPrev = i > 0 ? (e9[i - 1] ?? closes[i - 1]) - (e21[i - 1] ?? closes[i - 1]) : 0;
      const spreadAbs = Math.abs(sNow) / atrRef;
      const slopeAbs = Math.abs(sNow - sPrev) / atrRef;
      const adxVal = (adx[i] ?? 0) / 50;
      return spreadAbs * 1.0 + slopeAbs * 0.7 + adxVal * 0.5;
    }

    const accepted: typeof signalsAsc = [];
    let lastAcceptedIdx = -1;
    for (const s of signalsAsc) {
      const i = idxByTime.get(s.candle.time.getTime());
      if (i == null) continue;
      if (minGap > 0 && lastAcceptedIdx >= 0 && i - lastAcceptedIdx < minGap) continue;
      const atrv = atr[i] ?? 0;
      const atrRef = Math.max(atrv, 1e-6);
      const adxVal = adx[i] ?? null;
      if (adxVal == null || adxVal < adxMinEff) continue;
      const sNow = (e9[i] ?? closes[i]) - (e21[i] ?? closes[i]);
      const sPrev = i > 0 ? (e9[i - 1] ?? closes[i - 1]) - (e21[i - 1] ?? closes[i - 1]) : 0;
      const spreadAbs = Math.abs(sNow);
      const slopeAbs = Math.abs(sNow - sPrev);
      if (spreadAbs < spreadMinEff * atrRef) continue;
      if (slopeAbs < slopeMinEff * atrRef) continue;
      if (vwapSideReq || vwapMinDistEff > 0) {
        const v = vwap[i] ?? null;
        if (v != null) {
          if (vwapSideReq) {
            const okSide = s.side === "BUY" ? closes[i] >= v : closes[i] <= v;
            if (!okSide) continue;
          }
          if (vwapMinDistEff > 0) {
            const dist = Math.abs(closes[i] - (v as number));
            if (dist < vwapMinDistEff * atrRef) continue;
          }
        }
      }
      accepted.push(s);
      lastAcceptedIdx = i;
    }

    const paired: typeof accepted = [];
    const idxCache = new Map<number, number>();
    for (const s of accepted) {
      const i = idxByTime.get(s.candle.time.getTime());
      if (i == null) continue;
      if (paired.length === 0) {
        paired.push(s); idxCache.set(s.candle.id, i); continue;
      }
      const last = paired[paired.length - 1];
      if (s.side === last.side) {
        paired.push(s); idxCache.set(s.candle.id, i); continue;
      }
      const lastIdx = idxCache.get(last.candle.id) ?? idxByTime.get(last.candle.time.getTime())!;
      const gapBars = i - lastIdx;
      if (gapBars >= oppMinBarsEff) {
        paired.push(s); idxCache.set(s.candle.id, i); continue;
      }
      if (pairPreferMode === "older") continue;
      const sStrength = strengthAt(i);
      const lastStrength = strengthAt(lastIdx);
      if (sStrength > lastStrength) {
        paired.pop(); paired.push(s); idxCache.set(s.candle.id, i);
      } else {
        continue;
      }
    }

    let working = paired;
    if (wantEntriesOnly) {
      const reEntryBarsEff = Number.isFinite(Number(reEntryBars)) ? Math.max(0, Number(reEntryBars)) : oppMinBarsEff;
      const onlyEntries: typeof paired = [];
      let flat = true;
      let lastSide: "BUY" | "SELL" | null = null;
      let lastCloseIdx: number | null = null;
      for (const s of paired) {
        const i = idxByTime.get(s.candle.time.getTime());
        if (i == null) continue;
        if (flat) {
          if (lastCloseIdx != null && i - lastCloseIdx < reEntryBarsEff) continue;
          onlyEntries.push(s); flat = false; lastSide = (s.side as any) || null;
        } else {
          if (String(s.side).toUpperCase() !== String(lastSide)) {
            flat = true; lastSide = null; lastCloseIdx = i;
          }
        }
      }
      working = onlyEntries;
    }

    const items = working.map((s) => ({
      id: s.id, candleId: s.candleId, time: s.candle.time.toISOString(), date: toLocalDateStr(s.candle.time),
      timeframe: s.candle.timeframe, symbol: s.candle.instrument.symbol, type: s.signalType, side: s.side,
      score: s.score, meta: (s as any).meta, price: s.candle.close, note: "EMA9xEMA21",
    }));

    return res.json(items);
  } catch (err: any) {
    logger.error("[/signals] erro", { message: err?.message });
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

router.get('/signals/confirmed', async (req: Request, res: Response) => {
  try {
    const { symbol, timeframe, from, to, limit } = req.query;
    if (!symbol) {
      return res.status(400).json({ error: 'Parâmetro symbol é obrigatório.' });
    }

    const where: any = {
      symbol: String(symbol),
    };

    if (timeframe) {
      where.timeframe = String(timeframe);
    }

    const dateRange = normalizeApiDateRange(from, to);
    if (dateRange) {
      where.time = dateRange;
    }

    const signals = await prisma.signal.findMany({
      where,
      orderBy: {
        time: 'desc'
      },
      take: limit ? Number(limit) : 1000,
    });
    res.json(signals);

  } catch (err: any) {
    logger.error('[/signals/confirmed] erro', { message: err.message });
    res.status(500).json({ error: err.message });
  }
});

export const signalsRoutes = router;