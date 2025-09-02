import express from "express";
import { prisma } from "./prisma";
import { DateTime } from "luxon";
import { generateProjectedSignals } from "./services/engine";
import logger from "./logger";

const router = express.Router();
const ZONE = "America/Sao_Paulo";
const ROUTES_VERSION = "routes:v4-backtest-fallback-m1";

/* ---------------- utils de data ---------------- */
function toUtcRange(from?: string, to?: string): { gte?: Date; lte?: Date } {
  const out: { gte?: Date; lte?: Date } = {};
  const parse = (s: string, endOfDay = false) => {
    const hasTime = /T|\d{2}:\d{2}/.test(s);
    let dt = hasTime
      ? DateTime.fromISO(s, { zone: ZONE })
      : DateTime.fromISO(s, { zone: ZONE })[endOfDay ? "endOf" : "startOf"](
          "day"
        );
    if (!dt.isValid) return undefined as any;
    return dt.toUTC().toJSDate();
  };
  if (from) out.gte = parse(from, false);
  if (to) out.lte = parse(to, true);
  return out;
}
const toLocalDateStr = (d: Date) =>
  DateTime.fromJSDate(d).setZone(ZONE).toFormat("yyyy-LL-dd");

function rangeForLog(range?: { gte?: Date; lte?: Date }) {
  if (!range) return { gte: null, lte: null };
  return {
    gte: range.gte ? range.gte.toISOString() : null,
    lte: range.lte ? range.lte.toISOString() : null,
  };
}

/* ---------------- TF / agregação ---------------- */
type RawCandle = {
  time: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number | null;
};

function tfToMinutes(tf: string): number {
  const s = String(tf || "").toUpperCase();
  if (s.startsWith("M")) return parseInt(s.slice(1), 10) || 1;
  if (s.startsWith("H")) return (parseInt(s.slice(1), 10) || 1) * 60;
  if (s === "D1" || s === "D") return 24 * 60;
  return 1;
}
function bucketStartUTC(d: Date, tfMin: number): Date {
  const y = d.getUTCFullYear(),
    m = d.getUTCMonth(),
    day = d.getUTCDate();
  const H = d.getUTCHours(),
    M = d.getUTCMinutes();
  const bucketMin = Math.floor(M / tfMin) * tfMin;
  return new Date(Date.UTC(y, m, day, H, bucketMin, 0, 0));
}
function rollupFromM1(base: RawCandle[], tf: string): RawCandle[] {
  const tfMin = tfToMinutes(tf);
  if (tfMin <= 1) return base.slice();
  const map = new Map<number, RawCandle>();
  for (const c of base) {
    const b = bucketStartUTC(c.time, tfMin).getTime();
    const prev = map.get(b);
    if (!prev) {
      map.set(b, {
        time: new Date(b),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume ?? null,
      });
    } else {
      prev.high = Math.max(prev.high, c.high);
      prev.low = Math.min(prev.low, c.low);
      prev.close = c.close;
      if (prev.volume != null || c.volume != null)
        prev.volume = (prev.volume ?? 0) + (c.volume ?? 0);
    }
  }
  const out = Array.from(map.values());
  out.sort((a, b) => a.time.getTime() - b.time.getTime());
  return out;
}

/* ---------- resolução robusta do instrumento (sem collation especial) ---------- */
async function resolveInstrumentIds(
  sym: string
): Promise<{ ids: number[]; matched: string[] }> {
  const s = String(sym || "").trim();
  const variants = Array.from(new Set([s, s.toUpperCase(), s.toLowerCase()]));
  try {
    // igualdade por variantes
    let rows = await prisma.instrument.findMany({
      where: { OR: variants.map((v) => ({ symbol: v })) },
      select: { id: true, symbol: true },
    });

    // startsWith / contains se igualdade não achou
    if (rows.length === 0) {
      rows = await prisma.instrument.findMany({
        where: {
          OR: variants.flatMap((v) => [
            { symbol: { startsWith: v } },
            { symbol: { contains: v } },
          ]),
        },
        select: { id: true, symbol: true },
      });
    }

    return { ids: rows.map((r) => r.id), matched: rows.map((r) => r.symbol) };
  } catch (e: any) {
    logger.error("[resolveInstrumentIds] erro", { sym, message: e?.message });
    return { ids: [], matched: [] };
  }
}

/** Busca candles direto no Prisma (com instrumentId resolvido) */
async function getCandlesDB(
  symbol: string,
  timeframe: string,
  range?: { gte?: Date; lte?: Date }
): Promise<{ rows: RawCandle[]; usedInstrumentSymbols: string[] }> {
  const tf = String(timeframe).toUpperCase();
  const { ids, matched } = await resolveInstrumentIds(symbol);

  const baseWhere: any = { timeframe: tf, ...(range ? { time: range } : {}) };

  try {
    let rows;
    if (ids.length > 0) {
      rows = await prisma.candle.findMany({
        where: { ...baseWhere, instrumentId: { in: ids } },
        orderBy: { time: "asc" },
        select: {
          time: true,
          open: true,
          high: true,
          low: true,
          close: true,
          volume: true,
        },
      });
    } else {
      // último recurso por relacionamento simples (igualdade com variantes)
      const variants = Array.from(
        new Set([symbol, symbol.toUpperCase(), symbol.toLowerCase()])
      );
      rows = await prisma.candle.findMany({
        where: {
          ...baseWhere,
          OR: variants.map((v) => ({ instrument: { is: { symbol: v } } })),
        },
        orderBy: { time: "asc" },
        select: {
          time: true,
          open: true,
          high: true,
          low: true,
          close: true,
          volume: true,
        },
      });
    }

    return {
      rows: rows.map((c) => ({
        time: c.time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: (c as any).volume ?? null,
      })),
      usedInstrumentSymbols: matched,
    };
  } catch (e: any) {
    logger.error("[getCandlesDB] erro", {
      symbol,
      timeframe: tf,
      range: rangeForLog(range),
      message: e?.message,
    });
    return { rows: [], usedInstrumentSymbols: matched };
  }
}

/** Garante candles no TF; se não houver, agrega M1 → TF (com “margem” de 1h se necessário) */
async function ensureCandles(
  symbol: string,
  timeframe: string,
  range?: { gte?: Date; lte?: Date }
): Promise<{
  candles: RawCandle[];
  usedTF: string;
  baseM1Count: number;
  matchedInstruments: string[];
}> {
  const tf = String(timeframe).toUpperCase();

  logger.info("[ensureCandles] start", {
    symbol,
    timeframe: tf,
    range: rangeForLog(range),
  });

  // tenta TF direto
  let { rows, usedInstrumentSymbols } = await getCandlesDB(symbol, tf, range);
  logger.info("[ensureCandles] after TF query", {
    tf,
    rows: rows.length,
    matchedInstruments: usedInstrumentSymbols,
  });

  if (rows.length > 0)
    return {
      candles: rows,
      usedTF: tf,
      baseM1Count: 0,
      matchedInstruments: usedInstrumentSymbols,
    };

  // tenta M1
  if (tf !== "M1") {
    let base = (await getCandlesDB(symbol, "M1", range)).rows;
    logger.info("[ensureCandles] M1 base count", { base: base.length });

    if (base.length === 0 && range) {
      // margem 1h nas pontas
      const r2 = {
        gte: range.gte ? new Date(range.gte.getTime() - 3600_000) : undefined,
        lte: range.lte ? new Date(range.lte.getTime() + 3600_000) : undefined,
      };
      const retry = await getCandlesDB(symbol, "M1", r2);
      base = retry.rows;
      logger.info("[ensureCandles] M1 retry+margin", {
        base: base.length,
        marginRange: rangeForLog(r2),
      });

      // recorta de volta para o range original
      if (base.length)
        base = base.filter(
          (c) =>
            (!range.gte || c.time >= range.gte!) &&
            (!range.lte || c.time <= range.lte!)
        );
      logger.info("[ensureCandles] M1 trimmed to original range", {
        base: base.length,
      });
    }

    if (base.length > 0) {
      const agg = rollupFromM1(base, tf);
      logger.info("[ensureCandles] aggregated TF", {
        tf,
        aggregated: agg.length,
      });
      return {
        candles: agg,
        usedTF: tf,
        baseM1Count: base.length,
        matchedInstruments: usedInstrumentSymbols,
      };
    }
  }

  logger.warn("[ensureCandles] no candles found", {
    symbol,
    timeframe: tf,
    range: rangeForLog(range),
  });
  return {
    candles: [],
    usedTF: tf,
    baseM1Count: 0,
    matchedInstruments: usedInstrumentSymbols,
  };
}

/* ------------------------ CANDLES ------------------------ */
router.get("/candles", async (req, res) => {
  try {
    const {
      symbol = "WIN",
      timeframe = "M5",
      from: _from,
      to: _to,
      dateFrom,
      dateTo,
      limit = "500",
    } = req.query as any;

    const from = (_from as string) || (dateFrom as string);
    const to = (_to as string) || (dateTo as string);
    const range = toUtcRange(from, to);
    const hasRange = Boolean(range.gte || range.lte);
    const takeN = Number(limit) > 0 && !hasRange ? Number(limit) : undefined;

    logger.info("[/candles] query", {
      symbol,
      timeframe,
      range: rangeForLog(range),
      limit,
      version: ROUTES_VERSION,
    });

    let { candles } = await ensureCandles(
      String(symbol),
      String(timeframe),
      hasRange ? range : undefined
    );
    if (!hasRange && takeN) candles = candles.slice(-takeN);

    res.json(
      candles.map((c) => ({
        time: c.time.toISOString(),
        date: toLocalDateStr(c.time),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: (c as any).volume ?? null,
      }))
    );
  } catch (err: any) {
    logger.error("[/candles] erro", { message: err?.message });
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

/* ------------------------ SINAIS CONFIRMADOS ------------------------ */
router.get("/signals", async (req, res) => {
  try {
    const {
      symbol = "WIN",
      timeframe = "M5",
      from: _from,
      to: _to,
      dateFrom,
      dateTo,
      limit = "500",
    } = req.query as any;

    const from = (_from as string) || (dateFrom as string);
    const to = (_to as string) || (dateTo as string);
    const range = toUtcRange(from, to);
    const hasRange = Boolean(range.gte || range.lte);
    const takeN = Number(limit) > 0 && !hasRange ? Number(limit) : undefined;

    logger.info("[/signals] query", {
      symbol,
      timeframe,
      range: rangeForLog(range),
      limit,
      version: ROUTES_VERSION,
    });

    if (!hasRange && takeN) {
      const recent = await prisma.signal.findMany({
        where: {
          candle: {
            is: {
              instrument: { is: { symbol: String(symbol) } },
              timeframe: String(timeframe).toUpperCase(),
            },
          },
        },
        include: { candle: true },
        orderBy: { candle: { time: "desc" } },
        take: takeN,
      });
      const rows = recent.reverse();
      return res.json({
        count: rows.length,
        signals: rows.map((s) => ({
          time: s.candle!.time.toISOString(),
          date: toLocalDateStr(s.candle!.time),
          signalType: s.signalType as any,
          side: s.side as any,
          price: s.candle!.close,
          reason: s.reason || null,
          score: (s as any).score ?? null,
        })),
      });
    }

    const signals = await prisma.signal.findMany({
      where: {
        candle: {
          is: {
            instrument: { is: { symbol: String(symbol) } },
            timeframe: String(timeframe).toUpperCase(),
            ...(hasRange ? { time: range } : {}),
          },
        },
      },
      include: { candle: true },
      orderBy: { candle: { time: "asc" } },
    });

    if (hasRange && signals.length === 0) {
      // fallback: calcula via candles garantidos
      const { candles } = await ensureCandles(
        String(symbol),
        String(timeframe),
        range
      );
      const closes = candles.map((c) => c.close);
      const ema = (arr: number[], p: number) => {
        if (p <= 1) return arr.slice();
        const k = 2 / (p + 1);
        const out: number[] = [];
        let prev = arr[0] ?? 0;
        out.push(prev);
        for (let i = 1; i < arr.length; i++) {
          const cur = arr[i] * k + prev * (1 - k);
          out.push(cur);
          prev = cur;
        }
        return out;
      };
      const emaF = ema(closes, 9);
      const emaS = ema(closes, 21);

      const computed: any[] = [];
      for (
        let i = 1;
        i < Math.min(emaF.length, emaS.length, candles.length);
        i++
      ) {
        const prevDiff = (emaF[i - 1] ?? 0) - (emaS[i - 1] ?? 0);
        const currDiff = (emaF[i] ?? 0) - (emaS[i] ?? 0);
        const side =
          prevDiff <= 0 && currDiff > 0
            ? "BUY"
            : prevDiff >= 0 && currDiff < 0
            ? "SELL"
            : null;
        if (!side) continue;
        const c = candles[i];
        const delta = currDiff - prevDiff;
        const score = Number(
          ((Math.abs(delta) / Math.max(Math.abs(c.close), 1e-9)) * 100).toFixed(
            6
          )
        );
        computed.push({
          time: c.time.toISOString(),
          date: toLocalDateStr(c.time),
          signalType: "EMA_CROSS",
          side,
          price: c.close,
          reason: "Cruzamento EMA9/EMA21",
          score,
        });
      }

      return res.json({ count: computed.length, signals: computed });
    }

    return res.json({
      count: signals.length,
      signals: signals.map((s) => ({
        time: s.candle!.time.toISOString(),
        date: toLocalDateStr(s.candle!.time),
        signalType: s.signalType as any,
        side: s.side as any,
        price: s.candle!.close,
        reason: s.reason || null,
        score: (s as any).score ?? null,
      })),
    });
  } catch (err: any) {
    logger.error("[/signals] erro", { message: err?.message });
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

/* ------------------------ SINAIS PROJETADOS ------------------------ */
router.get("/signals/projected", async (req, res) => {
  try {
    const {
      symbol = "WIN",
      timeframe = "M5",
      from: _from,
      to: _to,
      dateFrom,
      dateTo,
      limit = "500",
      ...rest
    } = req.query as any;

    const from = (_from as string) || (dateFrom as string);
    const to = (_to as string) || (dateTo as string);

    const userHasRange = Boolean(from || to);
    const effLimit = userHasRange ? undefined : Number(limit) || 500;

    const extra = Object.fromEntries(
      Object.entries(rest).map(([k, v]) => [
        k,
        isNaN(Number(v)) ? v : Number(v),
      ])
    ) as Record<string, any>;

    const items =
      ((await generateProjectedSignals?.({
        symbol: String(symbol).toUpperCase(),
        timeframe: String(timeframe).toUpperCase(),
        from: (from as string) || undefined,
        to: (to as string) || undefined,
        limit: effLimit,
        ...extra,
      } as any)) as any[]) || [];

    const range = toUtcRange(from, to);
    const normalized = (Array.isArray(items) ? items : []).map((it) => {
      const iso =
        typeof it.time === "string"
          ? DateTime.fromISO(it.time).toUTC().toISO()
          : it.time instanceof Date
          ? it.time.toISOString()
          : null;
      return {
        ...it,
        time: iso,
        date: iso ? toLocalDateStr(new Date(iso)) : null,
      };
    });

    const projected = normalized.filter((it) => {
      if (!it.time) return false;
      const d = new Date(it.time);
      if (range.gte && d < range.gte) return false;
      if (range.lte && d > range.lte) return false;
      return true;
    });

    return res.json({
      projected: userHasRange
        ? projected
        : projected.slice(-(Number(limit) || 500)),
    });
  } catch (err: any) {
    logger.error("[/signals/projected] erro", { message: err?.message });
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

/* ------------------------ BACKTEST (com fallback M1 forçado) ------------------------ */
router.post("/backtest", async (req, res) => {
  try {
    logger.info("[BACKTEST] POST /api/backtest acionado", {
      body: req.body,
      version: ROUTES_VERSION,
    });

    const {
      symbol = "WIN",
      timeframe = "M5",
      from,
      to,
      costPts = Number(process.env.COST_PER_TRADE_POINTS || 0),
      slippagePts = Number(process.env.SLIPPAGE_POINTS || 0),
      pointValue = Number(process.env.CONTRACT_POINT_VALUE || 1),
      seedInitial = true,
      forceFinalClose = true,
      useNextBarOpen = true,
      debug = false,
    } = req.body || {};

    const range = toUtcRange(from, to);
    const hasRange = Boolean(range.gte || range.lte);

    logger.info("[BACKTEST] ensureCandles() antes", {
      symbol,
      timeframe,
      range: rangeForLog(range),
    });
    let { candles, baseM1Count, matchedInstruments } = await ensureCandles(
      String(symbol),
      String(timeframe),
      hasRange ? range : undefined
    );

    // retry com margem, se necessário
    if (!candles.length && hasRange) {
      const r2 = {
        gte: range.gte ? new Date(range.gte.getTime() - 3600_000) : undefined,
        lte: range.lte ? new Date(range.lte.getTime() + 3600_000) : undefined,
      };
      logger.warn("[BACKTEST] retry ensureCandles com margem 1h", {
        range: rangeForLog(r2),
      });
      const retry = await ensureCandles(
        String(symbol),
        String(timeframe),
        r2 as any
      );
      candles = retry.candles.filter(
        (c) =>
          (!range.gte || c.time >= range.gte!) &&
          (!range.lte || c.time <= range.lte!)
      );
      baseM1Count = retry.baseM1Count;
      matchedInstruments = retry.matchedInstruments;
    }

    // **FORÇADO**: se ainda vazio, consulta M1 direto e agrega
    if (!candles.length && hasRange) {
      const m1 = await getCandlesDB(String(symbol), "M1", range);
      logger.warn("[BACKTEST] fallback forçado M1", {
        symbol,
        timeframe,
        range: rangeForLog(range),
        m1Count: m1.rows.length,
        matchedInstruments: m1.usedInstrumentSymbols,
      });
      if (m1.rows.length) {
        candles = rollupFromM1(m1.rows, String(timeframe));
        baseM1Count = m1.rows.length;
        matchedInstruments = m1.usedInstrumentSymbols;
        logger.info("[BACKTEST] fallback M1 agregado", {
          aggregated: candles.length,
        });
      }
    }

    logger.info("[BACKTEST] Candles carregados: " + candles.length, {
      symbol,
      timeframe,
      matchedInstruments,
      first: candles[0]?.time?.toISOString?.() ?? null,
      last: candles[candles.length - 1]?.time?.toISOString?.() ?? null,
      baseM1Count,
    });

    if (!candles.length) {
      return res.json({
        trades: 0,
        wins: 0,
        losses: 0,
        winRate: 0,
        pnlPoints: 0,
        pnlMoney: 0,
        profitFactor: 0,
        maxDrawdownPoints: 0,
        equityCurve: [],
        tradeList: [],
        ...(debug
          ? {
              debug: {
                reason: "no_candles_after_all_fallbacks",
                matchedInstruments,
              },
            }
          : {}),
      });
    }

    // séries
    const times = candles.map((c) => c.time.getTime());
    const opensArr = candles.map((c) => c.open);
    const closesArr = candles.map((c) => c.close);
    const lastIdx = times.length - 1;

    // sinais persistidos
    const signalsPersisted = await prisma.signal.findMany({
      where: {
        candle: {
          is: {
            instrument: { is: { symbol: String(symbol) } },
            timeframe: String(timeframe).toUpperCase(),
            ...(hasRange ? { time: range } : {}),
          },
        },
      },
      include: { candle: true },
      orderBy: { candle: { time: "asc" } },
    });

    // EMA cross on-the-fly
    const ema = (arr: number[], p: number) => {
      if (p <= 1) return arr.slice();
      const k = 2 / (p + 1);
      const out: number[] = [];
      let prev = arr[0] ?? 0;
      out.push(prev);
      for (let i = 1; i < arr.length; i++) {
        const cur = arr[i] * k + prev * (1 - k);
        out.push(cur);
        prev = cur;
      }
      return out;
    };
    const emaF = ema(closesArr, 9);
    const emaS = ema(closesArr, 21);

    type Sig = { idx: number; side: "BUY" | "SELL" };
    const crossSignals: Sig[] = [];
    for (
      let i = 1;
      i < Math.min(emaF.length, emaS.length, candles.length);
      i++
    ) {
      const prevDiff = (emaF[i - 1] ?? 0) - (emaS[i - 1] ?? 0);
      const currDiff = (emaF[i] ?? 0) - (emaS[i] ?? 0);
      const side =
        prevDiff <= 0 && currDiff > 0
          ? "BUY"
          : prevDiff >= 0 && currDiff < 0
          ? "SELL"
          : null;
      if (!side) continue;
      crossSignals.push({ idx: i, side });
    }

    // consolida
    const consolidated: Sig[] = [];
    if (signalsPersisted.length > 0) {
      for (const s of signalsPersisted) {
        const t = s.candle?.time?.getTime();
        if (t == null) continue;
        let idx = lowerBound(times, t);
        if (idx >= times.length) idx = times.length - 1;
        consolidated.push({
          idx,
          side: String(s.side).toUpperCase() as "BUY" | "SELL",
        });
      }
    }
    for (const s of crossSignals) consolidated.push(s);
    consolidated.sort((a, b) => a.idx - b.idx || (a.side === "BUY" ? -1 : 1));
    dedupeInPlace(consolidated);

    if (
      seedInitial &&
      consolidated.length === 0 &&
      emaF.length &&
      emaS.length
    ) {
      const firstDiff = (emaF[0] ?? 0) - (emaS[0] ?? 0);
      const side = firstDiff >= 0 ? "BUY" : "SELL";
      consolidated.push({ idx: 0, side });
    }
    if (forceFinalClose && consolidated.length > 0) {
      const last = consolidated[consolidated.length - 1];
      const closingSide: "BUY" | "SELL" = last.side === "BUY" ? "SELL" : "BUY";
      if (last.idx < lastIdx)
        consolidated.push({ idx: lastIdx, side: closingSide });
    }

    if (consolidated.length === 0) {
      return res.json({
        trades: 0,
        wins: 0,
        losses: 0,
        winRate: 0,
        pnlPoints: 0,
        pnlMoney: 0,
        profitFactor: 0,
        maxDrawdownPoints: 0,
        equityCurve: [],
        tradeList: [],
        ...(debug ? { debug: { reason: "no_signals" } } : {}),
      });
    }

    // monta trades
    type Pos = null | {
      side: "LONG" | "SHORT";
      entryIdx: number;
      entryTime: string;
      entryPrice: number;
    };
    type Trade = {
      side: "LONG" | "SHORT";
      entryTime: string;
      entryPrice: number;
      exitTime: string;
      exitPrice: number;
      pnlPoints: number;
    };

    const trades: Trade[] = [];
    const rtCost = Number(costPts) + Number(slippagePts);
    let pos: Pos = null;

    const pxAtOpenOrClose = (idx: number) =>
      Number.isFinite(opensArr[idx]) ? opensArr[idx] : closesArr[idx];

    for (const sig of consolidated) {
      let execIdx = Math.min(sig.idx + (useNextBarOpen ? 1 : 0), lastIdx);
      if (pos && execIdx <= pos.entryIdx)
        execIdx = Math.min(pos.entryIdx + 1, lastIdx);

      const execPx = pxAtOpenOrClose(execIdx);
      const side = sig.side === "BUY" ? "LONG" : "SHORT";

      if (!pos) {
        pos = {
          side,
          entryIdx: execIdx,
          entryTime: candles[execIdx].time.toISOString(),
          entryPrice: execPx,
        };
        continue;
      }
      if (pos.side === side) continue;

      let exitIdx = execIdx;
      if (exitIdx <= pos.entryIdx)
        exitIdx = Math.min(pos.entryIdx + 1, lastIdx);
      const exitPx = pxAtOpenOrClose(exitIdx);
      const pnl =
        pos.side === "LONG"
          ? exitPx - pos.entryPrice - rtCost
          : pos.entryPrice - exitPx - rtCost;

      trades.push({
        side: pos.side,
        entryTime: pos.entryTime,
        entryPrice: pos.entryPrice,
        exitTime: candles[exitIdx].time.toISOString(),
        exitPrice: exitPx,
        pnlPoints: Number(pnl.toFixed(2)),
      });
      pos = {
        side,
        entryIdx: execIdx,
        entryTime: candles[execIdx].time.toISOString(),
        entryPrice: execPx,
      };
    }
    if (pos) {
      let exitIdx = Math.max(pos.entryIdx + 1, lastIdx);
      const exitPx = pxAtOpenOrClose(exitIdx);
      const pnl =
        pos.side === "LONG"
          ? exitPx - pos.entryPrice - rtCost
          : pos.entryPrice - exitPx - rtCost;
      trades.push({
        side: pos.side,
        entryTime: pos.entryTime,
        entryPrice: pos.entryPrice,
        exitTime: candles[exitIdx].time.toISOString(),
        exitPrice: exitPx,
        pnlPoints: Number(pnl.toFixed(2)),
      });
      pos = null;
    }

    // KPIs
    let wins = 0,
      losses = 0,
      sumPnL = 0,
      sumWin = 0,
      sumLossAbs = 0;
    const equityCurve: { time: string; equity: number }[] = [];
    let equity = 0,
      peak = 0,
      maxDD = 0;

    for (const t of trades) {
      sumPnL += t.pnlPoints;
      equity += t.pnlPoints;
      peak = Math.max(peak, equity);
      maxDD = Math.min(maxDD, equity - peak);
      if (t.pnlPoints >= 0) {
        wins++;
        sumWin += t.pnlPoints;
      } else {
        losses++;
        sumLossAbs += Math.abs(t.pnlPoints);
      }
      equityCurve.push({ time: t.exitTime, equity: Number(equity.toFixed(2)) });
    }

    const tradeCount = trades.length;
    const winRate = tradeCount ? wins / tradeCount : 0;
    const profitFactor =
      sumLossAbs > 0
        ? Number((sumWin / sumLossAbs).toFixed(3))
        : wins > 0
        ? Infinity
        : 0;

    const pnlPoints = Number(sumPnL.toFixed(2));
    const pnlMoney = Number((pnlPoints * Number(pointValue)).toFixed(2));

    const payload: any = {
      trades: tradeCount,
      wins,
      losses,
      winRate,
      pnlPoints,
      pnlMoney,
      profitFactor,
      maxDrawdownPoints: Number(Math.abs(maxDD).toFixed(2)),
      equityCurve,
      tradeList: trades,
    };
    if (debug) {
      payload.debug = {
        matchedInstruments,
        candlesTF: candles.length,
        baseM1Count,
        first: candles[0]?.time?.toISOString?.() ?? null,
        last: candles[candles.length - 1]?.time?.toISOString?.() ?? null,
      };
    }

    return res.json(payload);
  } catch (err: any) {
    logger.error("[/backtest] erro", {
      message: err?.message,
      stack: err?.stack,
    });
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

/* ------------------------ DIAGNÓSTICO RÁPIDO ------------------------ */
router.get("/diagnostics/candles", async (req, res) => {
  try {
    const { symbol = "WIN", timeframe = "M5", from, to } = req.query as any;
    const range = toUtcRange(from, to);

    const tf = String(timeframe).toUpperCase();
    const { rows: tfRows, usedInstrumentSymbols } = await getCandlesDB(
      symbol,
      tf,
      range
    );
    const { rows: m1Rows } = await getCandlesDB(symbol, "M1", range);

    res.json({
      symbol,
      timeframe: tf,
      matchedInstruments: usedInstrumentSymbols,
      range: rangeForLog(range),
      counts: { tf: tfRows.length, m1: m1Rows.length },
      tfFirst: tfRows[0]?.time?.toISOString?.() ?? null,
      tfLast: tfRows[tfRows.length - 1]?.time?.toISOString?.() ?? null,
      m1First: m1Rows[0]?.time?.toISOString?.() ?? null,
      m1Last: m1Rows[m1Rows.length - 1]?.time?.toISOString?.() ?? null,
    });
  } catch (e: any) {
    logger.error("[/diagnostics/candles] erro", { message: e?.message });
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

export default router;

/* --------------- utils locais --------------- */
function lowerBound(arr: number[], x: number) {
  let lo = 0,
    hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
function dedupeInPlace(items: { idx: number; side: "BUY" | "SELL" }[]) {
  if (items.length <= 1) return;
  const out: typeof items = [];
  let prevKey = "";
  for (const it of items) {
    const key = `${it.idx}-${it.side}`;
    if (key === prevKey) continue;
    out.push(it);
    prevKey = key;
  }
  items.length = 0;
  for (const it of out) items.push(it);
}
