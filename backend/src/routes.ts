import express from "express";
import { prisma } from "./prisma";
import { DateTime } from "luxon";
import { generateProjectedSignals } from "./services/engine";
import logger from "./logger";
import {
  startAutoTrainer,
  stopAutoTrainer,
  statusAutoTrainer,
} from "./workers/autoTrainer";
import { loadCandlesAnyTF } from "./lib/aggregation";

const router = express.Router();
const ZONE = "America/Sao_Paulo";

/* ---------------- utils de data ---------------- */
function toUtcRange(from?: string, to?: string) {
  const parse = (s: string, endOfDay = false) => {
    if (!s) return null;
    let dt: DateTime;
    // ISO?
    if (/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(s))
      dt = DateTime.fromISO(s, { zone: "utc" });
    // BR (dd/MM/yyyy [HH:mm[:ss]])
    else if (/^\d{2}\/\d{2}\/\d{4}(\s+\d{2}:\d{2}(:\d{2})?)?$/.test(s)) {
      const [d, m, y, hh = "00:00:00"] = (s + (/\s/.test(s) ? "" : " 00:00:00"))
        .replace(/\//g, "-")
        .replace("  ", " ")
        .split(/[-\s:]/);
      const hhmmss =
        hh.length === 5 ? `${hh}:00` : hh.length === 2 ? `${hh}:00:00` : hh;
      dt = DateTime.fromISO(`${y}-${m}-${d}T${hhmmss}Z`, { zone: "utc" });
    } else {
      // tenta como ISO flexível
      dt = DateTime.fromISO(s, { zone: "utc" });
    }
    if (!dt.isValid) {
      const d = new Date(s);
      if (isNaN(d.getTime())) return null;
      dt = DateTime.fromJSDate(d).toUTC();
    }
    if (endOfDay) {
      dt = dt.set({ hour: 23, minute: 59, second: 59, millisecond: 999 });
    }
    return dt.toJSDate();
  };
  if (!from && !to) return undefined;
  const out: { gte?: Date; lte?: Date } = {};
  if (from) out.gte = parse(from);
  if (to) out.lte = parse(to, true);
  return out;
}
const toLocalDateStr = (d: Date) =>
  DateTime.fromJSDate(d).setZone(ZONE).toFormat("yyyy-LL-dd HH:mm:ss");

/* ---------------- helpers TF ---------------- */
function tfToMinutes(tf: string) {
  const s = String(tf || "").trim().toUpperCase();
  if (s === "H1") return 60;
  const m = s.match(/^M(\d+)$/);
  return m ? Number(m[1]) : 5;
}

/* ---------------- Indicadores p/ filtros de sinais ---------------- */
function EMA(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  const k = 2 / (period + 1);
  let ema: number | null = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!isFinite(v)) {
      out.push(ema);
      continue;
    }
    ema = ema == null ? v : v * k + (ema as number) * (1 - k);
    out.push(ema);
  }
  return out;
}
function ATR(
  candles: { high: number; low: number; close: number }[],
  period = 14
): (number | null)[] {
  const tr: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    const prev = i > 0 ? candles[i - 1].close : candles[i].close;
    const high = candles[i].high;
    const low = candles[i].low;
    const v = Math.max(
      high - low,
      Math.abs(high - prev),
      Math.abs(low - prev)
    );
    tr.push(v);
  }
  // RMA simples p/ aproximar ATR
  const out: (number | null)[] = [];
  const k = 1 / Math.max(1, period);
  let rma: number | null = null;
  for (let i = 0; i < tr.length; i++) {
    const v = tr[i];
    rma = rma == null ? v : (rma as number) * (1 - k) + v * k;
    out.push(rma);
  }
  return out;
}
function ADX(
  candles: { high: number; low: number; close: number }[],
  period = 14
): (number | null)[] {
  const len = candles.length;
  const plusDM: number[] = [];
  const minusDM: number[] = [];
  const tr: number[] = [];

  for (let i = 0; i < len; i++) {
    if (i === 0) {
      plusDM.push(0);
      minusDM.push(0);
      tr.push(candles[0].high - candles[0].low);
      continue;
    }
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);

    const _tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    tr.push(_tr);
  }

  // RMA de TR, +DM, -DM
  const rma = (arr: number[]): number[] => {
    const out: number[] = [];
    const k = 1 / period;
    let v: number | null = null;
    for (let i = 0; i < arr.length; i++) {
      v = v == null ? arr[i] : (v as number) * (1 - k) + arr[i] * k;
      out.push(v as number);
    }
    return out;
  };

  const trRMA = rma(tr);
  const plusDMRMA = rma(plusDM);
  const minusDMRMA = rma(minusDM);

  const dx: (number | null)[] = [];
  for (let i = 0; i < len; i++) {
    const trv = trRMA[i] || 0;
    const pdi = trv > 0 ? (plusDMRMA[i] / trv) * 100 : 0;
    const mdi = trv > 0 ? (minusDMRMA[i] / trv) * 100 : 0;
    const denom = pdi + mdi;
    dx.push(denom > 0 ? (Math.abs(pdi - mdi) / denom) * 100 : null);
  }

  const adx: (number | null)[] = [];
  const k = 1 / period;
  let val: number | null = null;
  for (let i = 0; i < len; i++) {
    const dxi = dx[i];
    if (dxi == null) {
      adx.push(val);
      continue;
    }
    val = val == null ? dxi : (val as number) * (1 - k) + dxi * k;
    adx.push(val);
  }
  return adx;
}

/* ----------------- ROTA CANDLES ----------------- */
router.get("/candles", async (req, res) => {
  try {
    const {
      symbol = "WIN",
      timeframe = "M1",
      from,
      to,
      limit = "1000",
    } = req.query as any;

    const sym = String(symbol || "").trim().toUpperCase();
    const tf = String(timeframe || "").trim().toUpperCase();

    const baseRange = toUtcRange(String(from || ""), String(to || ""));
    const range = {
      ...(baseRange || {}),
      ...(Number(limit) ? { limit: Number(limit) } : {}),
    } as any;

    const rows = await loadCandlesAnyTF(sym, tf, range);

    const out = (Number(limit) ? rows.slice(-Number(limit)) : rows).map((c) => ({
      time: c.time.toISOString(),
      date: toLocalDateStr(c.time),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: (c as any).volume ?? null,
    }));

    res.json(out);
  } catch (err: any) {
    logger.error("[/candles] erro", { message: err?.message });
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

/* ------------------------ /signals (CONFIRMADOS) ----------------------- */
/* Agora com “entries-only” por padrão (entriesOnly=1).
   Use entriesOnly=0 para ver o comportamento alternando BUY/SELL. */
router.get("/signals", async (req, res) => {
  try {
    const {
      symbol: symbolQ,
      timeframe: timeframeQ,
      from: _from,
      to: _to,
      dateFrom,
      dateTo,
      limit = "200",

      // Qualidade (liga/desliga filtros técnicos)
      quality = "1",

      // Filtros técnicos (se quality=1)
      adxMin,
      spreadMinAtr,
      slopeMinAtr,
      cooldownBars,
      vwapSideRequired,
      vwapMinDistAtr,

      // Anti-whipsaw de pares
      oppMinBars,                // barras mínimas entre lados opostos (default M1=4, M1+=3)
      pairPrefer,                // stronger|older (default stronger)

      // NOVO: modo de “somente entradas”
      entriesOnly = "1",         // 1 = liga gating (flat/position), 0 = lista “crua”
      reEntryBars,               // barras mínimas após “fechamento” lógico para aceitar nova entrada (default = oppMinBars)
    } = req.query as any;

    const applyQuality = String(quality ?? "1") !== "0";
    const wantEntriesOnly = String(entriesOnly ?? "1") !== "0";

    const symbol = (symbolQ ? String(symbolQ).trim() : "").toUpperCase();
    const tfUpper =
      (timeframeQ ? String(timeframeQ).trim().toUpperCase() : "") || undefined;
    const tfNum = tfUpper ? tfToMinutes(tfUpper) : undefined;

    const from = (_from as string) || (dateFrom as string) || undefined;
    const to = (_to as string) || (dateTo as string) || undefined;
    const range = toUtcRange(from, to);
    const effLimit = Number(limit) || 200;

    const whereBase: any = {};
    if (range) whereBase.candle = { is: { time: range } } as any;

    const signalsRaw = await prisma.signal.findMany({
      where: whereBase,
      orderBy: [{ id: "desc" }],
      take: effLimit,
      include: {
        candle: {
          select: {
            id: true,
            time: true,
            timeframe: true,
            close: true,
            open: true,
            high: true,
            low: true,
            instrument: { select: { symbol: true } },
          },
        },
      },
    });

    // Filtro por símbolo/timeframe + ASC
    const signalsAsc = signalsRaw
      .filter((s) => {
        if (symbol && s.candle.instrument.symbol.toUpperCase() !== symbol)
          return false;
        if (tfNum != null && Number(s.candle.timeframe) !== Number(tfNum))
          return false;
        return true;
      })
      .sort((a, b) => a.candle.time.getTime() - b.candle.time.getTime());

    if (signalsAsc.length === 0) return res.json([]);

    // Se não for aplicar qualidade, ainda assim podemos aplicar entriesOnly (se pedido)
    if (!applyQuality) {
      const baseItems = signalsAsc.map((s) => ({
        id: s.id,
        candleId: s.candleId,
        time: s.candle.time.toISOString(),
        date: toLocalDateStr(s.candle.time),
        timeframe: s.candle.timeframe,
        symbol: s.candle.instrument.symbol,
        type: s.type,
        side: s.side,
        score: s.score,
        meta: s.meta,
        price: s.candle.close,
        note: "EMA9xEMA21",
      }));

      if (!wantEntriesOnly) return res.json(baseItems);

      // aplica apenas o gating de “entradas”
      const tfM = tfNum ?? 5;
      const oppMinBarsEff =
        Number.isFinite(Number(oppMinBars)) ? Math.max(0, Number(oppMinBars)) : (tfM <= 1 ? 4 : 3);
      const reEntryBarsEff =
        Number.isFinite(Number(reEntryBars)) ? Math.max(0, Number(reEntryBars)) : oppMinBarsEff;

      let flat = true;
      let lastSide: "BUY" | "SELL" | null = null;
      let lastCloseIdx: number | null = null;

      // índice de barras por tempo (precisamos dos candles para contar barras)
      const firstT = signalsAsc[0].candle.time;
      const lastT = signalsAsc[signalsAsc.length - 1].candle.time;
      const fromCand = DateTime.fromJSDate(firstT).minus({ minutes: 200 * (tfNum ?? 5) }).toJSDate();
      const toCand = DateTime.fromJSDate(lastT).plus({ minutes: 2 * (tfNum ?? 5) }).toJSDate();
      const sym = symbol || signalsAsc[0].candle.instrument.symbol.toUpperCase();
      const tfStr = tfUpper || `M${tfNum ?? 5}`;
      const candles = await loadCandlesAnyTF(sym, tfStr, { gte: fromCand, lte: toCand });
      const ts = candles.map((c) => c.time.getTime());
      const idxByTime = new Map<number, number>();
      for (let i = 0; i < ts.length; i++) idxByTime.set(ts[i], i);

      const onlyEntries = [];
      for (const s of baseItems) {
        const i = idxByTime.get(new Date(s.time).getTime());
        if (i == null) continue;

        if (flat) {
          // re-entry cooldown (depois de “fechamento lógico”)
          if (lastCloseIdx != null && i - lastCloseIdx < reEntryBarsEff) {
            continue;
          }
          onlyEntries.push(s);
          flat = false;
          lastSide = (s.side as any) || null;
        } else {
          // estamos “posicionados”
          if (String(s.side).toUpperCase() !== String(lastSide)) {
            // oposto => trata como saída lógica e NÃO adiciona (entries-only)
            flat = true;
            lastSide = null;
            lastCloseIdx = i;
            // não empilha nada aqui
          } else {
            // mesmo lado enquanto posicionado => ignora
          }
        }
      }

      return res.json(onlyEntries);
    }

    /* --------- A partir daqui: qualidade + indicadores + anti-whipsaw + entriesOnly --------- */
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

    const e9 = EMA(closes, 9);
    const e21 = EMA(closes, 21);
    const atr = ATR(
      candles.map((c) => ({ high: c.high, low: c.low, close: c.close })),
      14
    );
    const adx = ADX(
      candles.map((c) => ({ high: c.high, low: c.low, close: c.close })),
      14
    );

    // VWAP por sessão (BRT)
    const vwap: (number | null)[] = [];
    let accPV = 0, accVol = 0;
    let prevDay: string | null = null;
    for (let i = 0; i < candles.length; i++) {
      const day = DateTime.fromJSDate(candles[i].time).setZone(ZONE).toFormat("yyyy-LL-dd");
      if (day !== prevDay) {
        prevDay = day;
        accPV = 0;
        accVol = 0;
      }
      const typical = (highs[i] + lows[i] + closes[i]) / 3;
      const vol = Number.isFinite((candles[i] as any).volume) ? Number((candles[i] as any).volume) : 1;
      accPV += typical * vol;
      accVol += vol;
      vwap.push(accVol > 0 ? accPV / accVol : typical);
    }

    // lookup: time->index
    const idxByTime = new Map<number, number>();
    for (let i = 0; i < times.length; i++) idxByTime.set(times[i], i);

    // Defaults
    const adxMinEff =
      Number.isFinite(Number(adxMin)) ? Number(adxMin) : (tfM <= 1 ? 18 : 20);
    const spreadMinEff =
      Number.isFinite(Number(spreadMinAtr)) ? Math.max(0, Number(spreadMinAtr)) : (tfM <= 1 ? 0.25 : 0.30);
    const slopeMinEff =
      Number.isFinite(Number(slopeMinAtr)) ? Math.max(0, Number(slopeMinAtr)) : (tfM <= 1 ? 0.06 : 0.07);
    const vwapSideReq = String(vwapSideRequired ?? "0") === "1";
    const vwapMinDistEff =
      Number.isFinite(Number(vwapMinDistAtr)) ? Math.max(0, Number(vwapMinDistAtr)) : 0;
    const minGap =
      Number.isFinite(Number(cooldownBars)) ? Math.max(0, Number(cooldownBars)) : (tfM <= 1 ? 3 : 2);

    const oppMinBarsEff =
      Number.isFinite(Number(oppMinBars)) ? Math.max(0, Number(oppMinBars)) : (tfM <= 1 ? 4 : 3);
    const pairPreferMode =
      String(pairPrefer || "stronger").toLowerCase() === "older" ? "older" : "stronger";

    // helpers para métricas de força
    function strengthAt(i: number): number {
      const atrv = atr[i] ?? 0;
      const atrRef = Math.max(atrv, 1e-6);
      const sNow = (e9[i] ?? closes[i]) - (e21[i] ?? closes[i]);
      const sPrev = i > 0 ? (e9[i - 1] ?? closes[i - 1]) - (e21[i - 1] ?? closes[i - 1]) : 0;
      const spreadAbs = Math.abs(sNow) / atrRef; // em ATR
      const slopeAbs = Math.abs(sNow - sPrev) / atrRef;
      const adxVal = (adx[i] ?? 0) / 50; // normaliza ~0..2
      // score simples, ponderado
      return spreadAbs * 1.0 + slopeAbs * 0.7 + adxVal * 0.5;
    }

    // 1) Filtro base (ADX/Spread/Slope/VWAP/Cooldown)
    const accepted: typeof signalsAsc = [];
    let lastAcceptedIdx = -1;

    for (const s of signalsAsc) {
      const t = s.candle.time.getTime();
      const i = idxByTime.get(t);
      if (i == null) continue;

      if (minGap > 0 && lastAcceptedIdx >= 0 && i - lastAcceptedIdx < minGap) {
        continue;
      }

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

    // 2) ANTI-WHIPSAW DE PARES (se muito perto, mantém o mais forte/antigo)
    const paired: typeof accepted = [];
    const idxCache = new Map<number, number>(); // candleId->i
    for (const s of accepted) {
      const i = idxByTime.get(s.candle.time.getTime());
      if (i == null) continue;

      if (paired.length === 0) {
        paired.push(s);
        idxCache.set(s.candle.id, i);
        continue;
      }

      const last = paired[paired.length - 1];
      if (s.side === last.side) {
        paired.push(s);
        idxCache.set(s.candle.id, i);
        continue;
      }

      const lastIdx = idxCache.get(last.candle.id) ?? idxByTime.get(last.candle.time.getTime())!;
      const gapBars = i - lastIdx;

      if (gapBars >= oppMinBarsEff) {
        paired.push(s);
        idxCache.set(s.candle.id, i);
        continue;
      }

      if (pairPreferMode === "older") {
        // descarta o novo
        continue;
      }

      // stronger
      const sStrength = strengthAt(i);
      const lastStrength = strengthAt(lastIdx);
      if (sStrength > lastStrength) {
        paired.pop();
        paired.push(s);
        idxCache.set(s.candle.id, i);
      } else {
        continue;
      }
    }

    // 3) ENTRIES-ONLY (gating FLAT/POSITION): descarta o oposto como “saída”
    let working = paired;
    if (wantEntriesOnly) {
      const reEntryBarsEff =
        Number.isFinite(Number(reEntryBars)) ? Math.max(0, Number(reEntryBars)) : oppMinBarsEff;

      const onlyEntries: typeof paired = [];
      let flat = true;
      let lastSide: "BUY" | "SELL" | null = null;
      let lastCloseIdx: number | null = null;

      for (const s of paired) {
        const i = idxByTime.get(s.candle.time.getTime());
        if (i == null) continue;

        if (flat) {
          if (lastCloseIdx != null && i - lastCloseIdx < reEntryBarsEff) {
            continue; // respeita cooldown para reentrada
          }
          onlyEntries.push(s);
          flat = false;
          lastSide = (s.side as any) || null;
        } else {
          if (String(s.side).toUpperCase() !== String(lastSide)) {
            // oposto => saída lógica; NÃO adiciona
            flat = true;
            lastSide = null;
            lastCloseIdx = i;
          } else {
            // mesmo lado com posição aberta => ignora
          }
        }
      }
      working = onlyEntries;
    }

    const items = working.map((s) => ({
      id: s.id,
      candleId: s.candleId,
      time: s.candle.time.toISOString(),
      date: toLocalDateStr(s.candle.time),
      timeframe: s.candle.timeframe,
      symbol: s.candle.instrument.symbol,
      type: s.type,
      side: s.side,
      score: s.score,
      meta: s.meta,
      price: s.candle.close,
      note: "EMA9xEMA21",
    }));

    return res.json(items);
  } catch (err: any) {
    logger.error("[/signals] erro", { message: err?.message });
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

/* -------------------- /ml/projected (SINAIS PROJETADOS) -------------------- */
router.get("/ml/projected", async (req, res) => {
  try {
    const { symbol = "WIN", timeframe = "M1", ...rest } = req.query as any;
    const range = toUtcRange(rest?.from, rest?.to);
    const effLimit = (range ? undefined : Number(rest?.limit || 500)) as
      | number
      | undefined;

    const extra = Object.fromEntries(
      Object.entries(rest || {}).map(([k, v]) => [
        k,
        isNaN(Number(v as any)) ? v : Number(v),
      ])
    ) as Record<string, any>;

    let items: any[] = [];
    try {
      items =
        ((await generateProjectedSignals?.({
          symbol: String(symbol).toUpperCase(),
          timeframe: String(timeframe).toUpperCase(),
          range,
          limit: effLimit,
          ...extra,
        })) as any[]) || [];
    } catch (e: any) {
      logger.warn("[/ml/projected] generateProjectedSignals falhou", {
        err: e?.message || e,
      });
      items = [];
    }

    res.json(items);
  } catch (err: any) {
    logger.error("[/ml/projected] erro", { message: err?.message });
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

/* -------------------- /ml/auto (controle do AutoTrainer) -------------------- */
router.post("/ml/auto/start", async (_req, res) => {
  try {
    const r = await startAutoTrainer?.();
    res.json(r ?? { ok: true });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});
router.post("/ml/auto/stop", async (_req, res) => {
  try {
    const r = await stopAutoTrainer?.();
    res.json(r ?? { ok: true });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});
router.get("/ml/auto/status", async (_req, res) => {
  try {
    const r = await statusAutoTrainer?.();
    res.json(r ?? { ok: true, running: false });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});


/* -------------------- /trades (TABELA DE TRADES CONSOLIDADOS) -------------------- */
/* Agora com modo timeframe=auto (ou ausência do parâmetro):
   - Se timeframe não vier ou vier "AUTO", tentamos resolver um TF existente na janela.
   - A resposta inclui `resolvedTimeframe` para a UI exibir o TF efetivo. */
router.get("/trades", async (req, res) => {
  try {
    const { symbol, timeframe, from, to, limit = 500, offset = 0 } = req.query as any;

    // Constrói filtros relacionais sobre Instrument e Signals
    const where: any = {};

    let resolvedTimeframe: string | null = null;
    const tfRaw = (timeframe ? String(timeframe) : "").trim().toUpperCase();
    const autoTF = !tfRaw || tfRaw === "AUTO";
    if (!autoTF && tfRaw) {
      where.timeframe = tfRaw;
      resolvedTimeframe = tfRaw;
    }

    // Filtro por símbolo (relacional via Instrument.symbol)
    if (symbol) {
      const sym = String(symbol).toUpperCase().trim();
      where.instrument = { is: { symbol: sym } };
    }

    // Filtro por intervalo de tempo baseado no entrySignal.time
    let range: { from?: Date; to?: Date } = {};
    try {
      range = toUtcRange(from as any, to as any) || {};
    } catch {
      const fromD = from ? new Date(String(from)) : undefined;
      const toD = to ? new Date(String(to)) : undefined;
      range = { from: fromD, to: toD };
    }

    if (range.from || range.to) {
      where.entrySignal = { is: {} as any };
      if (range.from) (where.entrySignal.is as any).time = { ...((where.entrySignal.is as any).time || {}), gte: range.from };
      if (range.to) (where.entrySignal.is as any).time = { ...((where.entrySignal.is as any).time || {}), lt: range.to };
    }

    const takeNum = Math.min(1000, Math.max(1, Number(limit) || 500));
    const skipNum = Math.max(0, Number(offset) || 0);

    const rows = await prisma.trade.findMany({
      where,
      include: {
        entrySignal: true,
        exitSignal: true,
        instrument: true,
      },
      orderBy: { id: "desc" },
      take: takeNum,
      skip: skipNum,
    });

    let finalRows = rows;

    // Auto-resolve timeframe: se pediram AUTO ou omitiram e veio vazio, procurar TF disponível
    if (autoTF) {
      if (finalRows.length === 0) {
        const tfCandidate = await prisma.trade.findFirst({
          where: {
            ...where,
            timeframe: undefined as any, // ignora tf para achar qualquer um
          },
          select: { timeframe: true },
          orderBy: { id: "desc" },
        });
        if (tfCandidate?.timeframe) {
          resolvedTimeframe = tfCandidate.timeframe;
          finalRows = await prisma.trade.findMany({
            where: { ...where, timeframe: resolvedTimeframe },
            include: {
              entrySignal: true,
              exitSignal: true,
              instrument: true,
            },
            orderBy: { id: "desc" },
            take: takeNum,
            skip: skipNum,
          });
        }
      } else {
        resolvedTimeframe = finalRows[0]?.timeframe ?? null;
      }
    } else {
      finalRows = rows;
    }

    const items = finalRows.map((r: any) => ({
      id: r.id,
      symbol: r.instrument?.symbol || null,
      timeframe: r.timeframe,
      qty: r.qty,
      side: r.entrySignal?.side ?? null,
      entrySignalId: r.entrySignalId,
      exitSignalId: r.exitSignalId,
      entryPrice: r.entryPrice,
      exitPrice: r.exitPrice,
      pnlPoints: r.pnlPoints,
      pnlMoney: r.pnlMoney ?? null,
      entryTime: r.entrySignal?.time ? new Date(r.entrySignal.time).toISOString() : null,
      exitTime: r.exitSignal?.time ? new Date(r.exitSignal.time).toISOString() : null,
    }));

    return res.status(200).json({ ok: true, count: items.length, trades: items, resolvedTimeframe });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

/* -------------------- /order-logs (LOGS DO BROKER / EXECUÇÕES) -------------------- */
router.get("/order-logs", async (req, res) => {
  try {
    const { taskId, symbol, from, to, limit = 300 } = req.query as any;

    const where: any = {};
    if (taskId) where.taskId = String(taskId);
    if (symbol) where.symbol = String(symbol).toUpperCase();

    const baseRange = toUtcRange(String(from || ""), String(to || ""));
    if (baseRange?.gte || baseRange?.lte) {
      (where as any).time = {};
      if (baseRange.gte) (where as any).time.gte = baseRange.gte;
      if (baseRange.lte) (where as any).time.lt = baseRange.lte;
    }

    const takeNum = Math.min(1000, Math.max(1, Number(limit) || 300));

    // BrokerExecution é a tabela de logs de execução
    const rows = await prisma.brokerExecution.findMany({
      where,
      orderBy: { createdAt: "asc" },
      take: takeNum,
    });

    const logs = rows.map((r: any) => ({
      id: r.id,
      taskId: r.taskId ?? null,
      agentId: r.agentId ?? null,
      side: r.side ?? null,
      symbol: r.symbol ?? null,
      orderId: r.orderId ?? null,
      status: r.status ?? null,
      time: r.time ? new Date(r.time).toISOString() : null,
      price: r.price ?? null,
      volume: r.volume ?? null,
      pnlPoints: r.pnlPoints ?? null,
      raw: r.raw ? (() => { try { return JSON.parse(r.raw); } catch { return r.raw; } })() : null,
      createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
    }));

    return res.status(200).json({ ok: true, key: taskId ?? null, count: logs.length, logs });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});


/* -------------------- /admin/trades/rebuild (RECONSOLIDAR TRADES) -------------------- */
/**
 * Reconsolida trades a partir de sinais (entry = primeiro sinal quando flat; exit = primeiro sinal do lado oposto).
 * - symbol: obrigatório (ex.: WIN, WDO)
 * - timeframe: opcional (ex.: M1). Se omitido, reconstrói todos os TFs existentes na janela.
 * - from/to: janela (ISO). Se omitidos, usa todo o histórico.
 * - dry: se 1, não grava; apenas simula e retorna amostra.
 *
 * Idempotente: apaga trades existentes da janela antes de recriar (mesmo instrument/timeframe).
 */

// Helper: busca preço de execução no BrokerExecution próximo ao horário alvo
async function findExecutionPrice(symbol: string, side: string, time: Date, windowMinutes = 10) {
  const startA = new Date(time.getTime());
  const endA = new Date(time.getTime() + windowMinutes * 60 * 1000);
  const startB = new Date(time.getTime() - windowMinutes * 60 * 1000);
  try {
    // primeira tentativa: [t, t+window]
    const rowA = await prisma.brokerExecution.findFirst({
      where: {
        symbol,
        side,
        time: { gte: startA, lt: endA },
      },
      orderBy: { time: "asc" },
    });
    if (rowA && Number.isFinite(rowA.price as any)) return Number(rowA.price);

    // fallback: [t-window, t+window]
    const rowB = await prisma.brokerExecution.findFirst({
      where: {
        symbol,
        side,
        time: { gte: startB, lt: endA },
      },
      orderBy: { time: "asc" },
    });
    if (rowB && Number.isFinite(rowB.price as any)) return Number(rowB.price);
  } catch (e) {
    // silencioso
  }
  return null;
}
router.post("/admin/trades/rebuild", async (req, res) => {
  try {
    const { symbol, timeframe, from, to, dry = "0", sample = 5 } = (req.query as any) || {};
    if (!symbol) return res.status(400).json({ ok: false, error: "faltou symbol" });
    const sym = String(symbol).toUpperCase().trim();
    const tf = timeframe ? String(timeframe).toUpperCase().trim() : undefined;
    const isDry = String(dry) === "1";

    // Local util para range
    let range: { from?: Date; to?: Date } = {};
    try {
      range = toUtcRange(from as any, to as any) || {};
    } catch {
      const fD = from ? new Date(String(from)) : undefined;
      const tD = to ? new Date(String(to)) : undefined;
      range = { from: fD, to: tD };
    }

    // Instrument
    const instrument = await prisma.instrument.findUnique({ where: { symbol: sym } });
    if (!instrument) return res.status(200).json({ ok: false, error: `instrumento não encontrado para ${sym}` });

    // Carregar sinais no período (com candle/timeframe)
    const whereSignal: any = {
      candle: {
        instrumentId: instrument.id,
      },
    };
    if (tf) whereSignal.candle.timeframe = tf;
    if (range.from || range.to) {
      whereSignal.candle.time = {};
      if (range.from) whereSignal.candle.time.gte = range.from;
      if (range.to) whereSignal.candle.time.lt = range.to;
    }

    const signals = await prisma.signal.findMany({
      where: whereSignal,
      include: { candle: true },
      orderBy: [{ candle: { timeframe: "asc" } }, { candle: { time: "asc" } }, { id: "asc" }],
    });

    if (!signals.length) {
      return res.status(200).json({ ok: true, rebuilt: 0, deleted: 0, trades: [] });
    }

    // Se não foi especificado timeframe, vamos reconstruir por TF existente
    const byTF = new Map<string, any[]>();
    for (const s of signals) {
      const tframe = s.candle.timeframe.toUpperCase();
      if (tf && tframe !== tf) continue;
      if (!byTF.has(tframe)) byTF.set(tframe, []);
      byTF.get(tframe)!.push(s);
    }

    let totalDeleted = 0;
    let totalCreated = 0;
    const sampleTrades: any[] = [];

    for (const [tframe, list] of byTF.entries()) {
      // Apagar trades existentes deste TF na janela selecionada (buscando ids primeiro)
      const existing = await prisma.trade.findMany({
        where: {
          instrumentId: instrument.id,
          timeframe: tframe,
          ...(range.from || range.to
            ? {
              entrySignal: {
                is: {
                  candle: {
                    time: {
                      ...(range.from ? { gte: range.from } : {}),
                      ...(range.to ? { lt: range.to } : {}),
                    },
                  },
                },
              },
            }
            : {}),
        },
        select: { id: true },
      });
      const existingIds = existing.map((r) => r.id);

      if (!isDry && existingIds.length) {
        await prisma.trade.deleteMany({ where: { id: { in: existingIds } } });
        totalDeleted += existingIds.length;
      }

      // Reconstruir pairing simples: abre com o primeiro sinal; fecha no primeiro oposto
      let position: null | { entry: any } = null;
      const creations: any[] = [];

      for (const s of list) {
        if (!position) {
          // abre posição
          position = { entry: s };
          continue;
        } else {
          // já em posição; só fecha se for lado oposto
          const entrySide = String(position.entry.side).toUpperCase();
          const thisSide = String(s.side).toUpperCase();
          if (entrySide !== thisSide) {
            const entryC = position.entry.candle;
            const exitC = s.candle;
            const entryPrice = Number(entryC.close);
            const exitPrice = Number(exitC.close);
            const pnlPoints = entrySide === "BUY" ? (exitPrice - entryPrice) : (entryPrice - exitPrice);

            creations.push({
              instrumentId: instrument.id,
              timeframe: tframe,
              entrySignalId: position.entry.id,
              exitSignalId: s.id,
              qty: 1,
              entryPrice,
              exitPrice,
              pnlPoints,
            });
            position = null;
          }
        }
      }

      if (!isDry && creations.length) {
        // createMany só aceita escalares (ok)
        const batchSize = 500;
        for (let i = 0; i < creations.length; i += batchSize) {
          const slice = creations.slice(i, i + batchSize);
          await prisma.trade.createMany({ data: slice, skipDuplicates: true });
        }
      }

      totalCreated += creations.length;

      // Amostra para retorno
      for (const c of creations.slice(0, Number(sample) || 5)) {
        sampleTrades.push({
          ...c,
          symbol: sym,
          entryTime: list.find((x) => x.id === c.entrySignalId)?.candle?.time ?? null,
          exitTime: list.find((x) => x.id === c.exitSignalId)?.candle?.time ?? null,
        });
      }
    }

    return res.status(200).json({
      ok: true,
      dryRun: isDry,
      deleted: totalDeleted,
      rebuilt: totalCreated,
      sample: sampleTrades,
    });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

export default router;

/* ===== Broker: execuções reais e comparativo ===== */
/* Corrigido: agora usa toUtcRange para from/to */
router.get("/api/broker/executions", async (req, res) => {
  try {
    const { symbol, from, to } = req.query as any;
    const where: any = {};
    if (symbol) where.symbol = String(symbol).toUpperCase();

    const baseRange = toUtcRange(String(from || ""), String(to || ""));
    if (baseRange?.gte || baseRange?.lte) {
      where.time = {};
      if (baseRange.gte) where.time.gte = baseRange.gte;
      if (baseRange.lte) where.time.lt = baseRange.lte;
    }

    const rows = await prisma.brokerExecution.findMany({
      where,
      orderBy: { time: "asc" },
    });
    return res.status(200).json({ ok: true, rows });
  } catch (e: any) {
    return res.status(200).json({ ok: false, error: e?.message || String(e) });
  }
});

router.get("/api/broker/compare", async (req, res) => {
  try {
    const tradeId = Number((req.query?.tradeId as any) || 0);
    if (!tradeId) return res.status(200).json({ ok: false, error: "faltou tradeId" });
    const trade = await prisma.trade.findUnique({ where: { id: tradeId } });
    if (!trade) return res.status(200).json({ ok: false, error: "trade não encontrado" });
    const rows = await prisma.brokerExecution.findMany({
      where: { taskId: { contains: `trade-${tradeId}-` } },
      orderBy: { createdAt: "asc" },
    });
    return res.status(200).json({ ok: true, trade, executions: rows });
  } catch (e: any) {
    return res.status(200).json({ ok: false, error: e?.message || String(e) });
  }
});

/* ===== Diagnóstico consolidado para bater números (novo) =====
   GET /admin/diag/recap?symbol=WIN&timeframe=M1&from=2025-09-30&to=2025-09-30
   Retorna: execuções MT5 por lado, confirmados, projetados, trades e PnL total. */
router.get("/admin/diag/recap", async (req, res) => {
  try {
    const symbol = String((req.query.symbol as any) || "").toUpperCase();
    const timeframe = String((req.query.timeframe as any) || "").toUpperCase();
    const from = String((req.query.from as any) || "");
    const to = String((req.query.to as any) || "");
    if (!symbol) return res.status(400).json({ ok: false, error: "missing_symbol" });

    const r = from && to ? toUtcRange(from, to) : undefined;
    const today = DateTime.now().toUTC().toISODate()!;
    const range = r ?? toUtcRange(today, today)!;

    const instr = await prisma.instrument.findUnique({ where: { symbol } });
    if (!instr) return res.status(200).json({ ok: true, data: { note: "instrument_not_found", symbol } });

    // MT5 execuções por lado (conta taskId únicos no intervalo)
    const execRows = await prisma.brokerExecution.findMany({
      where: { symbol, time: { gte: range.gte!, lte: range.lte! } },
      select: { taskId: true, side: true },
    });
    const execBySide: Record<string, number> = {};
    const seenTask: Record<string, string> = {};
    for (const r of execRows) {
      const tid = r.taskId || "";
      if (!tid) continue;
      if (!seenTask[tid]) {
        seenTask[tid] = r.side || "";
        const s = (r.side || "").toUpperCase();
        execBySide[s] = (execBySide[s] || 0) + 1;
      }
    }

    // Confirmados por lado
    const sigRows = await prisma.signal.findMany({
      where: {
        side: { in: ["BUY", "SELL"] },
        candle: {
          instrumentId: instr.id,
          timeframe: timeframe || undefined,
          time: { gte: range.gte!, lte: range.lte! },
        },
      },
      select: { side: true },
    });
    const confirmedBySide: Record<string, number> = { BUY: 0, SELL: 0 };
    for (const s of sigRows) {
      const sd = (s.side || "").toUpperCase();
      if (sd === "BUY" || sd === "SELL") confirmedBySide[sd]++;
    }

    // Trades por lado e PnL
    const trades = await prisma.trade.findMany({
      where: {
        timeframe: timeframe || undefined,
        instrumentId: instr.id,
        entrySignal: { time: { gte: range.gte!, lte: range.lte! } },
      },
      include: { entrySignal: true },
    });
    const tradesBySide: Record<string, number> = { BUY: 0, SELL: 0 };
    let pnlPoints = 0;
    for (const t of trades) {
      const sd = (t.entrySignal?.side || "").toUpperCase();
      if (sd === "BUY" || sd === "SELL") tradesBySide[sd] = (tradesBySide[sd] || 0) + 1;
      if (Number.isFinite(t.pnlPoints as any)) pnlPoints += Number(t.pnlPoints);
    }

    // Projetados por lado (usa motor atual)
    let projectedBySide: Record<string, number> = { BUY: 0, SELL: 0 };
    try {
      const items = await generateProjectedSignals({
        symbol,
        timeframe: timeframe || "M1",
        range,
        limit: 2000,
      } as any);
      for (const it of items || []) {
        const sd = String((it as any).side || "").toUpperCase();
        if (sd === "BUY" || sd === "SELL") projectedBySide[sd] = (projectedBySide[sd] || 0) + 1;
      }
    } catch {
      projectedBySide = { BUY: -1, SELL: -1 };
    }

    return res.status(200).json({
      ok: true,
      data: {
        symbol,
        timeframe: timeframe || null,
        range,
        mt5_executions_by_side: execBySide,
        confirmed_by_side: confirmedBySide,
        projected_by_side: projectedBySide,
        trades_by_side: tradesBySide,
        pnl_points_sum: pnlPoints,
      },
    });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});
