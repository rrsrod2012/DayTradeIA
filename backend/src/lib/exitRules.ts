/* eslint-disable no-console */
import { prisma } from "../prisma";
import { loadCandlesAnyTF } from "../lib/aggregation";

/**
 * Motor de projeção de sinais (heurístico + filtros opcionais + IA opcional):
 * - Usa agregador central (M1 -> TF) para garantir consistência com Confirmed/Trades
 * - Indicadores: EMA9, EMA21, ATR14, VWAP, ADX, slope(EMA21)
 * - Regras base: cross EMA9/EMA21 + (opcional) breakout da máxima/mínima anterior
 * - Filtros: ADX mínimo, slope mínimo, distância VWAP mínima (em ATR),
 *            anti-overlap por ATR e cooldown por barras
 * - IA opcional: /predict repondera (prob/ev) se disponível
 * - Nunca lança exceção (rota continua estável)
 */

type Params = {
    symbol: string;
    timeframe: string;
    from?: string;
    to?: string;
    limit?: number;
    vwapFilter?: boolean; // BUY: close>=VWAP, SELL: close<=VWAP
    minEV?: number; // SELL normalizado para positivo
    minProb?: number; // prob mínima (quando IA está ativa)
    [k: string]: any;
};

type Candle = {
    id: number;
    time: Date;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number | null;
};

type Projected = {
    time: string; // ISO
    side: "BUY" | "SELL";
    score: number;
    reason: string;
    symbol: string;
    timeframe: string;
    prob?: number;
    expectedValuePoints?: number;
    ev?: number;
    expectedValue?: number;
    expected_value?: number;
    vwapOk?: boolean;
};

const tfToMinutes = (tfRaw: string) => {
    const s = String(tfRaw || "").trim().toUpperCase();
    if (s.startsWith("M")) return Number(s.slice(1)) || 5;
    if (s.startsWith("H")) return (Number(s.slice(1)) || 1) * 60;
    const m = /(\d+)\s*(M|min|h|H)/.exec(s);
    if (m) {
        const n = Number(m[1]) || 5;
        const unit = (m[2] || "M").toUpperCase();
        return unit.startsWith("H") ? n * 60 : n;
    }
    return 5;
};

/* ---------------- Helpers de env ---------------- */
function envNumber(name: string, def?: number) {
    const v = process.env[name];
    if (!v && v !== "0") return def;
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
}
function envBool(name: string, def = false) {
    const v = (process.env[name] || "").trim().toLowerCase();
    if (!v) return def;
    return v === "1" || v === "true" || v === "yes";
}

/* ---------------- Indicadores ---------------- */
function EMA(values: number[], period: number): (number | null)[] {
    const out: (number | null)[] = [];
    const k = 2 / (period + 1);
    let e: number | null = null;
    for (let i = 0; i < values.length; i++) {
        const v = Number(values[i]) || 0;
        e = e == null ? v : v * k + (e as number) * (1 - k);
        out.push(e);
    }
    return out;
}
function ATR(
    high: number[],
    low: number[],
    close: number[],
    period = 14
): (number | null)[] {
    const len = close.length;
    const tr: number[] = new Array(len).fill(0);
    for (let i = 1; i < len; i++) {
        const trueRange = Math.max(
            high[i] - low[i],
            Math.abs(high[i] - close[i - 1]),
            Math.abs(low[i] - close[i - 1])
        );
        tr[i] = trueRange;
    }
    const out: (number | null)[] = [];
    let acc = 0;
    for (let i = 0; i < len; i++) {
        const v = tr[i] || 0;
        if (i === 0) {
            out.push(null);
            acc = v;
        } else if (i < period) {
            acc += v;
            out.push(null);
        } else if (i === period) {
            const first = (acc + v) / period;
            out.push(first);
        } else {
            const prev = out[i - 1] as number;
            out.push((prev * (period - 1) + v) / period);
        }
    }
    return out;
}
function VWAP(
    high: number[],
    low: number[],
    close: number[],
    volume: number[]
): number[] {
    const out: number[] = [];
    let cumPV = 0;
    let cumV = 0;
    for (let i = 0; i < close.length; i++) {
        const typical = (high[i] + low[i] + close[i]) / 3;
        const v = Math.max(0, volume[i] || 0);
        cumPV += typical * v;
        cumV += v;
        out.push(cumV > 0 ? cumPV / cumV : typical);
    }
    return out;
}
function ADX(high: number[], low: number[], close: number[], period = 14) {
    const len = close.length;
    const plusDM: number[] = [0],
        minusDM: number[] = [0],
        tr: number[] = [0];
    for (let i = 1; i < len; i++) {
        const upMove = high[i] - high[i - 1];
        const downMove = low[i - 1] - low[i];
        plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0;
        minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;
        tr[i] = Math.max(
            high[i] - low[i],
            Math.abs(high[i] - close[i - 1]),
            Math.abs(low[i] - close[i - 1])
        );
    }
    const smooth = (arr: number[]) => EMA(arr, period).map((v) => (v ?? 0));
    const trN = smooth(tr);
    const pDMN = smooth(plusDM);
    const mDMN = smooth(minusDM);

    const pDI: number[] = [],
        mDI: number[] = [],
        dx: number[] = [];
    for (let i = 0; i < len; i++) {
        const trv = trN[i] || 1e-9;
        const p = 100 * (pDMN[i] || 0) / trv;
        const m = 100 * (mDMN[i] || 0) / trv;
        pDI.push(p);
        mDI.push(m);
        dx.push(100 * Math.abs(p - m) / Math.max(p + m, 1e-9));
    }
    return EMA(dx, period).map((v) => (v ?? 0));
}
function slope(arr: (number | null)[], lookback = 5) {
    const buf = arr.map((x) => (x == null ? NaN : Number(x)));
    const n = Math.min(lookback, buf.length);
    if (n < 2) return 0;
    const a = buf.slice(-n);
    if (a.some((v) => !Number.isFinite(v))) return 0;
    const xBar = (n - 1) / 2;
    const yBar = a.reduce((p, v) => p + v, 0) / n;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
        num += (i - xBar) * (a[i] - yBar);
        den += (i - xBar) * (i - xBar);
    }
    return den === 0 ? 0 : num / den;
}

/* ---------------- IA opcional (/predict) ---------------- */
async function rescoreWithML(
    items: Projected[],
    candles: Candle[]
): Promise<Projected[]> {
    try {
        const base = String(process.env.MICRO_MODEL_URL || "").replace(/\/+$/, "");
        if (!base) return items;

        const times = new Set(items.map((i) => i.time));
        const closes = candles.map((c) => c.close);
        const highs = candles.map((c) => c.high);
        const lows = candles.map((c) => c.low);
        const e9 = EMA(closes, 9);
        const e21 = EMA(closes, 21);
        const atr = ATR(highs, lows, closes, 14);

        const rows: any[] = [];
        for (let i = 0; i < candles.length; i++) {
            const iso = candles[i].time.toISOString();
            if (!times.has(iso)) continue;
            const _atr = (atr[i] ?? atr[i - 1] ?? 1) as number;
            rows.push({
                features: {
                    dist_ema21:
                        (closes[i] - (e21[i] ?? closes[i]!)) / Math.max(1e-6, _atr),
                    slope_e21:
                        ((e21[i] ?? closes[i]) - (e21[i - 1] ?? closes[i - 1] ?? closes[i])) /
                        Math.max(1e-6, _atr),
                    range_ratio: (highs[i] - lows[i]) / Math.max(1e-6, _atr),
                },
            });
        }

        if (!rows.length) return items;

        // @ts-ignore
        const r = await fetch(`${base}/predict`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ rows }),
        });
        const text = await r.text();
        const j = text ? JSON.parse(text) : null;
        if (!r.ok || !j?.ok) return items;

        const probs: number[] | undefined = Array.isArray(j?.scores) ? j.scores : undefined;
        const evArr: number[] | undefined =
            Array.isArray(j?.ev) ? j.ev :
                Array.isArray(j?.ev_points) ? j.ev_points :
                    Array.isArray(j?.expectedValuePoints) ? j.expectedValuePoints : undefined;

        const rescored: Projected[] = [];
        let k = 0;
        for (const it of items) {
            const p = probs && typeof probs[k] === "number" ? Math.min(1, Math.max(0, probs[k])) : undefined;
            const ev = evArr && typeof evArr[k] === "number" ? evArr[k] : undefined;

            let score = it.score;
            if (typeof p === "number") {
                score = Math.min(1, Math.max(0.1, (it.score * 0.6 + p * 0.8) / 1.2));
            }

            const out: Projected = { ...it, score };
            if (typeof p === "number") out.prob = p;
            if (typeof ev === "number") out.expectedValuePoints = ev;
            rescored.push(out);
            k++;
        }
        return rescored;
    } catch {
        return items; // tolerante a falha da IA
    }
}

/* ---------------- Consulta de candles (via agregador) ---------------- */
async function fetchCandles(
    symbol: string,
    timeframe: string,
    from?: string,
    to?: string,
    limit?: number
): Promise<Candle[]> {
    try {
        const range: any = {};
        if (from) range.gte = new Date(from.includes("T") ? from : `${from}T00:00:00.000Z`);
        if (to) range.lte = new Date(to.includes("T") ? to : `${to}T23:59:59.999Z`);
        if (limit && Number(limit) > 0) range.limit = Number(limit);

        const rows = await loadCandlesAnyTF(
            String(symbol).toUpperCase(),
            String(timeframe).toUpperCase(),
            range
        );

        return rows.map((r: any, idx: number) => ({
            id: idx,
            time: r.time instanceof Date ? r.time : new Date(r.time),
            open: Number(r.open),
            high: Number(r.high),
            low: Number(r.low),
            close: Number(r.close),
            volume: r.volume == null ? null : Number(r.volume),
        }));
    } catch {
        // Fallback (mantém compatibilidade)
        const tfMin = tfToMinutes(timeframe);
        const variants = Array.from(new Set([symbol, symbol.toUpperCase(), symbol.toLowerCase()]));
        const whereAny: any = {};
        if (from || to) {
            const range: any = {};
            if (from) range.gte = new Date(from.includes("T") ? from : `${from}T00:00:00.000Z`);
            if (to) range.lte = new Date(to.includes("T") ? to : `${to}T23:59:59.999Z`);
            whereAny.time = range;
        }

        try {
            const rows = await prisma.candle.findMany({
                where: {
                    ...(whereAny.time ? { time: whereAny.time } : {}),
                    OR: variants.map((v) => ({ instrument: { is: { symbol: v } } })),
                    timeframe: { in: [String(timeframe).toUpperCase(), String(tfMin)] },
                },
                orderBy: { time: "asc" },
                take: limit && !whereAny.time ? Math.max(100, (limit as number) * 5) : undefined,
                select: { id: true, time: true, open: true, high: true, low: true, close: true, volume: true },
            });
            if (rows.length) return rows as any;
        } catch { }

        const rows = await prisma.candle.findMany({
            where: whereAny.time ? { time: whereAny.time } : undefined,
            orderBy: { time: "asc" },
            take: limit && !whereAny.time ? Math.max(100, (limit as number) * 5) : 1000,
            select: { id: true, time: true, open: true, high: true, low: true, close: true, volume: true },
        });
        return rows as any;
    }
}

/* ---------------- Heurística com filtros ---------------- */
function buildHeuristicSignals(
    symbol: string,
    timeframe: string,
    candles: Candle[]
): Projected[] {
    if (candles.length < 30) return [];

    // Config (com defaults seguros)
    const MIN_ADX = envNumber("ENGINE_MIN_ADX", 20)!;
    const ADX_LEN = envNumber("ENGINE_ADX_LEN", 14)!;
    const MIN_SLOPE = envNumber("ENGINE_MIN_SLOPE", 0.02)!; // em ATR
    const MAX_DIST_VWAP_ATR = envNumber("ENGINE_MAX_DIST_VWAP_ATR", 0.15)!; // 0 desliga
    const REQUIRE_BREAKOUT = envBool("ENGINE_REQUIRE_BREAKOUT", true);
    const ANTI_OVERLAP_ATR = envNumber("ENGINE_ANTI_OVERLAP_ATR", 0.75)!; // 0 desliga
    const COOLDOWN = Math.max(0, envNumber("ENGINE_COOLDOWN", 3)!);

    const closes = candles.map((c) => c.close);
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);
    const vols = candles.map((c) => Number(c.volume ?? 0));

    const e9 = EMA(closes, 9);
    const e21 = EMA(closes, 21);
    const atr = ATR(highs, lows, closes, 14);
    const adx = ADX(highs, lows, closes, ADX_LEN);
    const vwap = VWAP(highs, lows, closes, vols);

    const out: Projected[] = [];
    const N = 10;

    // estado para filtros de overlap/cooldown
    let lastIdxBuy = -Infinity;
    let lastIdxSell = -Infinity;
    let lastPriceBuy: number | undefined;
    let lastPriceSell: number | undefined;

    for (let i = 2; i < candles.length; i++) {
        const c = candles[i];
        const ema9 = (e9[i] ?? closes[i]) as number;
        const ema21 = (e21[i] ?? closes[i]) as number;
        const prevDiff = (e9[i - 1] ?? closes[i - 1])! - (e21[i - 1] ?? closes[i - 1])!;
        const diff = ema9 - ema21;

        const win = candles.slice(Math.max(0, i - N), i);
        const winHigh = Math.max(...win.map((x) => x.high));
        const winLow = Math.min(...win.map((x) => x.low));
        const _atr = (atr[i] ?? atr[i - 1] ?? 1) as number;

        // Filtros globais
        const adxOk = (adx[i] ?? 0) >= MIN_ADX;

        // slope(EMA21) normalizado por ATR
        const s21 = slope(e21, Math.min(5, i));
        const sNorm = _atr > 0 ? s21 / _atr : 0;
        const slopeOkBuy = sNorm >= MIN_SLOPE;
        const slopeOkSell = sNorm <= -MIN_SLOPE;

        const distVWAP = Math.abs(c.close - vwap[i]);
        const distOk = MAX_DIST_VWAP_ATR <= 0 ? true : distVWAP >= MAX_DIST_VWAP_ATR * _atr;

        // Regras base cross
        const crossedUp = (e9[i - 1] ?? closes[i - 1])! <= (e21[i - 1] ?? closes[i - 1])! && ema9 > ema21;
        const crossedDn = (e9[i - 1] ?? closes[i - 1])! >= (e21[i - 1] ?? closes[i - 1])! && ema9 < ema21;

        const breakoutUp = REQUIRE_BREAKOUT ? c.close > winHigh : true;
        const breakoutDn = REQUIRE_BREAKOUT ? c.close < winLow : true;

        // Cooldown & anti-overlap
        const okCooldownBuy = i - lastIdxBuy >= COOLDOWN;
        const okCooldownSell = i - lastIdxSell >= COOLDOWN;
        const okOverlapBuy =
            !ANTI_OVERLAP_ATR ||
            lastPriceBuy == null ||
            Math.abs(c.close - lastPriceBuy) >= ANTI_OVERLAP_ATR * _atr;
        const okOverlapSell =
            !ANTI_OVERLAP_ATR ||
            lastPriceSell == null ||
            Math.abs(c.close - lastPriceSell) >= ANTI_OVERLAP_ATR * _atr;

        // BUY
        if (crossedUp && breakoutUp && adxOk && slopeOkBuy && distOk && okCooldownBuy && okOverlapBuy) {
            const strength = (c.close - ema21) / Math.max(1e-6, _atr);
            out.push({
                time: c.time.toISOString(),
                side: "BUY",
                score: Math.max(0.1, Math.min(1, Math.abs(strength))),
                reason: `EMA9>EMA21 + breakout (${N}) • ADX=${(adx[i] ?? 0).toFixed(1)} • slope21=${s21.toFixed(4)} • dVWAP/ATR=${(distVWAP / Math.max(_atr, 1e-6)).toFixed(2)}`,
                symbol,
                timeframe,
            });
            lastIdxBuy = i;
            lastPriceBuy = c.close;
            continue;
        }

        // SELL
        if (crossedDn && breakoutDn && adxOk && slopeOkSell && distOk && okCooldownSell && okOverlapSell) {
            const strength = (ema21 - c.close) / Math.max(1e-6, _atr);
            out.push({
                time: c.time.toISOString(),
                side: "SELL",
                score: Math.max(0.1, Math.min(1, Math.abs(strength))),
                reason: `EMA9<EMA21 + breakdown (${N}) • ADX=${(adx[i] ?? 0).toFixed(1)} • slope21=${s21.toFixed(4)} • dVWAP/ATR=${(distVWAP / Math.max(_atr, 1e-6)).toFixed(2)}`,
                symbol,
                timeframe,
            });
            lastIdxSell = i;
            lastPriceSell = c.close;
            continue;
        }
    }

    // Fallback suave
    if (out.length === 0) {
        const i = candles.length - 1;
        const slope9 = (e9[i] ?? closes[i])! - (e9[i - 1] ?? closes[i - 1] ?? closes[i])!;
        const slope21v = (e21[i] ?? closes[i])! - (e21[i - 1] ?? closes[i - 1] ?? closes[i])!;
        const bias = slope9 + 0.5 * slope21v;
        const side = bias >= 0 ? "BUY" : "SELL";
        const score = Math.min(0.35, Math.max(0.15, Math.abs(bias) / Math.max(1e-6, closes[i])));
        out.push({
            time: candles[i].time.toISOString(),
            side,
            score,
            reason: `bias EMA (fallback) • slope9=${slope9.toFixed(2)} • slope21=${slope21v.toFixed(2)}`,
            symbol,
            timeframe,
        });
    }

    return out;
}

/* ---------------- API principal ---------------- */
export async function generateProjectedSignals(params: Params): Promise<Projected[]> {
    try {
        const symbol = (params.symbol || "WIN").toString().toUpperCase();
        const timeframe = (params.timeframe || "M5").toString().toUpperCase();
        const limit = Number(params.limit) || 500;
        const from = params.from ? String(params.from) : undefined;
        const to = params.to ? String(params.to) : undefined;

        const candles = await fetchCandles(symbol, timeframe, from, to, limit);
        if (!candles.length) return [];

        const tail = from || to ? candles : candles.slice(-Math.max(120, Math.min(limit, 600)));

        // Heurística + filtros
        let items = buildHeuristicSignals(symbol, timeframe, tail);

        // Ordena e limita
        items = items.sort((a, b) => a.time.localeCompare(b.time)).slice(-limit);

        // IA opcional — preenche prob/EV se existir
        items = await rescoreWithML(items, tail);

        // Enriquecimento VWAP lado-sensível
        const highs = tail.map((c) => c.high);
        const lows = tail.map((c) => c.low);
        const closes = tail.map((c) => c.close);
        const volumes = tail.map((c) => Number(c.volume ?? 0));
        const vwap = VWAP(highs, lows, closes, volumes);
        const isoToIndex = new Map(tail.map((c, i) => [c.time.toISOString(), i]));

        items = items.map((s: Projected) => {
            const idx = isoToIndex.get(s.time);
            if (idx == null) return s;
            const ok = s.side === "BUY" ? closes[idx] >= vwap[idx] : closes[idx] <= vwap[idx];
            return { ...s, vwapOk: ok };
        });

        // vwapFilter opcional
        if (params?.vwapFilter) {
            items = items.filter((s) => s.vwapOk !== false);
        }

        // Normaliza EV (SELL => positivo)
        items = items.map((s: any) => {
            const side = String(s?.side || "").toUpperCase();
            const out: any = { ...s };
            for (const f of ["expectedValuePoints", "ev", "expectedValue", "expected_value"]) {
                if (out[f] != null && isFinite(Number(out[f]))) {
                    const val = Number(out[f]);
                    out[f] = side === "SELL" ? -val : val;
                }
            }
            return out as Projected;
        });

        // Thresholds mínimos
        const minProbCfg = envNumber("ENGINE_MIN_PROB", 0.55)!;
        const minEVCfg = envNumber("ENGINE_MIN_EV", 0)!;

        const minProb = typeof params?.minProb === "number" ? params.minProb : minProbCfg;
        const minEV = typeof params?.minEV === "number" ? params.minEV : minEVCfg;

        items = items.filter((s: any) => (typeof s.prob === "number" ? s.prob >= minProb : true));
        items = items.filter((s: any) => {
            const ev = s.expectedValuePoints ?? s.ev ?? s.expectedValue ?? s.expected_value;
            return typeof ev === "number" ? ev >= minEV : true;
        });

        return items;
    } catch (e: any) {
        console.warn("[engine] erro em generateProjectedSignals:", e?.message || String(e));
        return [];
    }
}

export default { generateProjectedSignals };
