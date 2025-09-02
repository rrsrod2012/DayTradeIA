import express from "express";
import cors from "cors";
import { createServer } from "http";
import routes from "./routes";
import adminRoutes from "./routesAdmin";
import { bootCsvWatchersIfConfigured } from "./services/csvWatcher";
import {
  bootConfirmedSignalsWorker,
  backfillSignals,
} from "./workers/confirmedSignalsWorker";
import { setupWS } from "./services/ws";
import logger from "./logger";

// ==== deps extras para o /api/backtest ====
import { prisma } from "./prisma";
import { DateTime } from "luxon";

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

// =================== Middleware de LOG de requests ===================
app.use((req, _res, next) => {
  logger.info(`[REQ] ${req.method} ${req.originalUrl}`);
  next();
});

// =================== Utils locais (para /api/backtest) ===================
const ZONE = "America/Sao_Paulo";
const SERVER_VERSION = "server:v4-backtest-m1-signals-bucket+backfill";

function toUtcRange(from?: string, to?: string): { gte?: Date; lte?: Date } {
  const out: { gte?: Date; lte?: Date } = {};
  const parse = (s: string, endOfDay = false) => {
    const hasTime = /T|\d{2}:\d{2}/.test(String(s));
    const dt = hasTime
      ? DateTime.fromISO(String(s), { zone: ZONE })
      : DateTime.fromISO(String(s), { zone: ZONE })[
          endOfDay ? "endOf" : "startOf"
        ]("day");
    if (!dt.isValid) return undefined as any;
    return dt.toUTC().toJSDate();
  };
  if (from) out.gte = parse(from, false)!;
  if (to) out.lte = parse(to, true)!;
  return out;
}
const toLocalDateStr = (d: Date) =>
  DateTime.fromJSDate(d).setZone(ZONE).toFormat("yyyy-LL-dd");

function tfToMinutes(tf: string): number {
  const s = String(tf || "").toUpperCase();
  if (s.startsWith("M")) return parseInt(s.slice(1), 10) || 1;
  if (s.startsWith("H")) return (parseInt(s.slice(1), 10) || 1) * 60;
  if (s === "D1" || s === "D") return 24 * 60;
  return 1;
}
function bucketStartUTC(d: Date, tfMin: number): number {
  const y = d.getUTCFullYear(),
    m = d.getUTCMonth(),
    day = d.getUTCDate(),
    H = d.getUTCHours(),
    M = d.getUTCMinutes();
  const bucketMin = Math.floor(M / tfMin) * tfMin;
  return Date.UTC(y, m, day, H, bucketMin, 0, 0);
}
type RawCandle = {
  id?: number;
  time: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number | null;
};
function aggregateFromM1(base: RawCandle[], tf: string): RawCandle[] {
  const tfMin = tfToMinutes(tf);
  if (tfMin <= 1) return base.slice();
  const map = new Map<number, RawCandle>();
  for (const c of base) {
    const b = bucketStartUTC(c.time, tfMin);
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

type Side = "BUY" | "SELL";
interface Trade {
  entryIdx: number;
  exitIdx: number;
  entryTime: string;
  exitTime: string;
  side: Side;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
}

async function handleBacktest(params: any) {
  const {
    symbol = "WIN",
    timeframe = "M5",
    from: _from,
    to: _to,
    dateFrom,
    dateTo,
    exitMode = "opposite",
    barsHold = 3,
    initialCapital = 0,
    limit = 0,
  } = params || {};

  const from = _from ?? dateFrom;
  const to = _to ?? dateTo;
  const barsHoldNum = Number(barsHold) || 3;
  const initialCap = Number(initialCapital) || 0;
  const pointValue = Number(process.env.CONTRACT_POINT_VALUE || 1);
  const tf = String(timeframe).toUpperCase();
  const tfMin = tfToMinutes(tf);

  const range = toUtcRange(
    from as string | undefined,
    to as string | undefined
  );

  const candleWhere: any = {
    instrument: { is: { symbol: String(symbol).toUpperCase() } },
    timeframe: tf,
    ...(range.gte || range.lte ? { time: range } : {}),
  };

  let candles: RawCandle[] = await prisma.candle.findMany({
    where: candleWhere,
    orderBy: { time: "asc" },
    take:
      Number(limit) > 0 && !(range.gte || range.lte)
        ? Number(limit)
        : undefined,
    select: {
      id: true,
      time: true,
      open: true,
      high: true,
      low: true,
      close: true,
    },
  });

  if (candles.length === 0 && tf !== "M1") {
    const baseM1 = await prisma.candle.findMany({
      where: {
        instrument: { is: { symbol: String(symbol).toUpperCase() } },
        timeframe: "M1",
        ...(range.gte || range.lte ? { time: range } : {}),
      },
      orderBy: { time: "asc" },
      select: { time: true, open: true, high: true, low: true, close: true },
    });

    logger.info("[BACKTEST] Fallback M1→TF", {
      symbol,
      timeframe: tf,
      baseM1: baseM1.length,
      version: SERVER_VERSION,
    });

    if (baseM1.length) {
      candles = aggregateFromM1(
        baseM1.map((c) => ({
          time: c.time,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        })),
        tf
      );
    }
  }

  logger.info(`[BACKTEST] Candles carregados: ${candles.length}`, {
    version: SERVER_VERSION,
    symbol,
    timeframe: tf,
    first: candles[0]?.time?.toISOString?.() ?? null,
    last: candles[candles.length - 1]?.time?.toISOString?.() ?? null,
  });

  if (candles.length === 0) {
    return {
      pnlPoints: 0,
      pnlMoney: 0,
      params: {
        symbol,
        timeframe: tf,
        from,
        to,
        exitMode,
        barsHold: barsHoldNum,
        initialCapital: initialCap,
      },
      summary: {
        trades: 0,
        wins: 0,
        losses: 0,
        winRate: 0,
        pnl: 0,
        avgPnL: 0,
        maxDrawdown: 0,
      },
      equityCurve: [],
      trades: [],
      note: "Sem candles no período informado.",
      version: SERVER_VERSION,
    };
  }

  const times = candles.map((c) => c.time.getTime());
  const closes = candles.map((c) => c.close);
  const candleIndexById = new Map<string | number, number>();
  candles.forEach((c, i) => {
    if (c.id != null) candleIndexById.set(c.id as any, i);
  });

  const signalsTF = await prisma.signal.findMany({
    where: {
      candle: {
        is: {
          instrument: { is: { symbol: String(symbol).toUpperCase() } },
          timeframe: tf,
          ...(range.gte || range.lte ? { time: range } : {}),
        },
      },
    },
    include: { candle: true },
    orderBy: { candle: { time: "asc" } },
  });

  logger.info(`[BACKTEST] Sinais carregados: ${signalsTF.length}`, {
    version: SERVER_VERSION,
  });

  type Sig = { idx: number; side: Side };
  let sList: Sig[] = [];

  if (signalsTF.length > 0) {
    sList = signalsTF.map((s) => {
      let idx = candleIndexById.get(s.candleId as any);
      if (idx === undefined) {
        const t = s.candle!.time.getTime();
        idx = Math.min(lowerBound(times, t), times.length - 1);
      }
      return { idx, side: (s.side as Side) || "BUY" };
    });
  } else if (tf !== "M1") {
    const signalsM1 = await prisma.signal.findMany({
      where: {
        candle: {
          is: {
            instrument: { is: { symbol: String(symbol).toUpperCase() } },
            timeframe: "M1",
            ...(range.gte || range.lte ? { time: range } : {}),
          },
        },
      },
      include: { candle: true },
      orderBy: { candle: { time: "asc" } },
    });

    if (signalsM1.length > 0) {
      const tfMin = tfToMinutes(tf);
      const bucketLast = new Map<number, { side: Side; when: number }>();
      for (const s of signalsM1) {
        const t = s.candle!.time;
        const b = bucketStartUTC(t, tfMin);
        const prev = bucketLast.get(b);
        const tMs = t.getTime();
        const side = (s.side as Side) || "BUY";
        if (!prev || tMs >= prev.when) bucketLast.set(b, { side, when: tMs });
      }
      const buckets = Array.from(bucketLast.entries()).sort(
        (a, b) => a[0] - b[0]
      );
      for (const [b, info] of buckets) {
        const idx = Math.min(lowerBound(times, b), times.length - 1);
        sList.push({ idx, side: info.side });
      }
      const compact: Sig[] = [];
      for (const s of sList.sort((a, b) => a.idx - b.idx)) {
        const last = compact[compact.length - 1];
        if (!last || last.idx !== s.idx || last.side !== s.side)
          compact.push(s);
      }
      sList = compact;
      logger.info("[BACKTEST] Usando sinais confirmados M1 agregados", {
        count: sList.length,
        timeframe: tf,
        version: SERVER_VERSION,
      });
    }
  }

  if (sList.length === 0) {
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
    const f = ema(closes, 9);
    const g = ema(closes, 21);
    for (let i = 1; i < Math.min(f.length, g.length); i++) {
      const prev = (f[i - 1] ?? 0) - (g[i - 1] ?? 0);
      const cur = (f[i] ?? 0) - (g[i] ?? 0);
      const side =
        prev <= 0 && cur > 0 ? "BUY" : prev >= 0 && cur < 0 ? "SELL" : null;
      if (!side) continue;
      sList.push({ idx: i, side });
    }
    logger.info(
      "[BACKTEST] Usando baseline EMA 9/21 (sem sinais confirmados)",
      {
        count: sList.length,
        version: SERVER_VERSION,
      }
    );
  }

  if (sList.length === 0) {
    return {
      pnlPoints: 0,
      pnlMoney: 0,
      params: {
        symbol,
        timeframe: tf,
        from,
        to,
        exitMode,
        barsHold: barsHoldNum,
        initialCapital: initialCap,
      },
      summary: {
        trades: 0,
        wins: 0,
        losses: 0,
        winRate: 0,
        pnl: 0,
        avgPnL: 0,
        maxDrawdown: 0,
      },
      equityCurve: candles.map((c, i) => ({
        time: c.time.toISOString(),
        date: toLocalDateStr(c.time),
        equity: initialCap,
        idx: i,
      })),
      trades: [],
      note: "Sem sinais para backtest no período informado.",
      version: SERVER_VERSION,
    };
  }

  const trades: Trade[] = [];
  for (let i = 0; i < sList.length; i++) {
    const s = sList[i];
    const entryIdx = Math.max(0, Math.min(s.idx, candles.length - 1));
    const entryPrice = candles[entryIdx].close;
    const side = s.side;

    let exitIdx = -1;
    if (String(exitMode).toLowerCase() === "bars") {
      exitIdx = Math.min(candles.length - 1, entryIdx + barsHoldNum);
    } else {
      let j = i + 1;
      for (; j < sList.length; j++) {
        if (sList[j].side !== side) break;
      }
      exitIdx = Math.min(
        candles.length - 1,
        j < sList.length ? sList[j].idx : candles.length - 1
      );
    }

    if (exitIdx <= entryIdx)
      exitIdx = Math.min(entryIdx + 1, candles.length - 1);
    const exitPrice = candles[exitIdx].close;
    const pnl =
      side === "BUY" ? exitPrice - entryPrice : entryPrice - exitPrice;

    trades.push({
      entryIdx,
      exitIdx,
      entryTime: candles[entryIdx].time.toISOString(),
      exitTime: candles[exitIdx].time.toISOString(),
      side,
      entryPrice,
      exitPrice,
      pnl: Number(pnl.toFixed(2)),
    });
  }

  const equityCurve = trades.map((t, k) => {
    const equity =
      trades.slice(0, k + 1).reduce((a, b) => a + b.pnl, 0) + initialCap;
    const c = candles[Math.min(candles.length - 1, Math.max(0, t.exitIdx))];
    return {
      time: c.time.toISOString(),
      date: toLocalDateStr(c.time),
      equity: Number(equity.toFixed(2)),
      idx: t.exitIdx,
    };
  });

  const totalTrades = trades.length;
  const wins = trades.filter((t) => t.pnl > 0).length;
  const losses = trades.filter((t) => t.pnl <= 0).length;
  const totalPnl = trades.reduce((a, b) => a + b.pnl, 0);
  const avgPnl = totalTrades > 0 ? totalPnl / totalTrades : 0;

  let peak = initialCap;
  let maxDD = 0;
  for (const pt of equityCurve) {
    if (pt.equity > peak) peak = pt.equity;
    const dd = peak - pt.equity;
    if (dd > maxDD) maxDD = dd;
  }

  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;

  return {
    pnlPoints: Number(totalPnl.toFixed(2)),
    pnlMoney: Number(
      (totalPnl * Number(process.env.CONTRACT_POINT_VALUE || 1)).toFixed(2)
    ),
    params: {
      symbol,
      timeframe: tf,
      from,
      to,
      exitMode,
      barsHold: barsHoldNum,
      initialCapital: initialCap,
    },
    summary: {
      trades: totalTrades,
      wins,
      losses,
      winRate: Number(winRate.toFixed(2)),
      pnl: Number(totalPnl.toFixed(2)),
      avgPnL: Number(avgPnl.toFixed(2)),
      maxDrawdown: Number(maxDD.toFixed(2)),
    },
    equityCurve,
    trades,
    version: SERVER_VERSION,
  };
}

// =================== ENDPOINTS INLINE PARA EVITAR 404 ===================
app.get("/api/backtest", async (req, res) => {
  logger.info("[BACKTEST] GET /api/backtest acionado", {
    query: req.query,
    version: SERVER_VERSION,
  });
  try {
    const data = await handleBacktest(req.query || {});
    return res.json(data);
  } catch (err: any) {
    logger.error("[BACKTEST][GET] Erro", { error: err?.message || err });
    return res
      .status(500)
      .json({ ok: false, error: err?.message || String(err) });
  }
});

app.post("/api/backtest", async (req, res) => {
  logger.info("[BACKTEST] POST /api/backtest acionado", {
    body: req.body,
    version: SERVER_VERSION,
  });
  try {
    const payload = { ...(req.query || {}), ...(req.body || {}) };
    const data = await handleBacktest(payload);
    return res.json(data);
  } catch (err: any) {
    logger.error("[BACKTEST][POST] Erro", { error: err?.message || err });
    return res
      .status(500)
      .json({ ok: false, error: err?.message || String(err) });
  }
});

// =================== ADMIN: Backfill de sinais confirmados ===================
app.post("/admin/signals/backfill", async (req, res) => {
  const { symbol, timeframe, from, to, emaFast, emaSlow } = req.body || {};
  logger.info("[ADMIN] POST /admin/signals/backfill", {
    symbol,
    timeframe,
    from,
    to,
    emaFast,
    emaSlow,
  });

  if (!symbol || !timeframe) {
    return res
      .status(400)
      .json({ ok: false, error: "symbol e timeframe são obrigatórios" });
  }
  try {
    const result = await backfillSignals({
      symbol,
      timeframe,
      from,
      to,
      emaFast,
      emaSlow,
    });
    return res.json({ ok: true, ...result });
  } catch (err: any) {
    logger.error("[ADMIN][backfill] Erro", { error: err?.message || err });
    return res
      .status(500)
      .json({ ok: false, error: err?.message || String(err) });
  }
});

// =================== Montagem dos routers existentes ===================
app.use("/api", routes);
app.use("/admin", adminRoutes);

// =================== Bootstraps/infra ===================
const server = createServer(app);
const PORT = Number(process.env.PORT || 4000);

server.listen(PORT, () => {
  logger.info(`[SERVER] ouvindo em http://localhost:${PORT}`, {
    version: SERVER_VERSION,
  });
  try {
    bootCsvWatchersIfConfigured?.();
  } catch (e: any) {
    logger.warn("[CSVWatcher] módulo não carregado", { err: e?.message || e });
  }

  try {
    bootConfirmedSignalsWorker?.();
  } catch (e: any) {
    logger.warn("[SignalsWorker] módulo não carregado", {
      err: e?.message || e,
    });
  }

  try {
    setupWS?.(server);
  } catch (e: any) {
    logger.warn("[WS] módulo não iniciado", { err: e?.message || e });
  }
});
