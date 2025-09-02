import express from "express";
import cors from "cors";
import { createServer } from "http";
import routes from "./routes";
import adminRoutes from "./routesAdmin";
import { bootCsvWatchersIfConfigured } from "./services/csvWatcher";
import { bootConfirmedSignalsWorker } from "./workers/confirmedSignalsWorker";
import { setupWS } from "./services/ws";
import logger from "./logger";

// ==== deps extras para o /api/backtest inline ====
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

// =================== Lógica compartilhada do Backtest ===================
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
    exitMode = "opposite", // "opposite" | "bars"
    barsHold = 3,
    initialCapital = 0,
    limit = 0,
  } = params || {};

  const from = _from ?? dateFrom;
  const to = _to ?? dateTo;

  const barsHoldNum = Math.max(1, Number(barsHold) || 3);
  const initialCap = Number(initialCapital) || 0;

  const range = toUtcRange(
    from as string | undefined,
    to as string | undefined
  );

  // 1) Carrega candles
  const candleWhere: any = {
    instrument: { is: { symbol: String(symbol).toUpperCase() } },
    timeframe: String(timeframe).toUpperCase(),
    ...(range.gte || range.lte ? { time: range } : {}),
  };

  const candles = await prisma.candle.findMany({
    where: candleWhere,
    orderBy: { time: "asc" },
    take:
      Number(limit) > 0 && !(range.gte || range.lte)
        ? Number(limit)
        : undefined,
    select: { id: true, time: true, close: true },
  });

  logger.info(`[BACKTEST] Candles carregados: ${candles.length}`);

  if (candles.length === 0) {
    return {
      params: {
        symbol,
        timeframe,
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
    };
  }

  const candleIndexById = new Map<string | number, number>();
  candles.forEach((c, i) => candleIndexById.set(c.id as any, i));

  // 2) Carrega sinais confirmados
  const signals = await prisma.signal.findMany({
    where: {
      candle: {
        is: {
          instrument: { is: { symbol: String(symbol).toUpperCase() } },
          timeframe: String(timeframe).toUpperCase(),
          ...(range.gte || range.lte ? { time: range } : {}),
        },
      },
    },
    include: { candle: true },
    orderBy: { candle: { time: "asc" } },
  });

  logger.info(`[BACKTEST] Sinais carregados: ${signals.length}`);

  if (signals.length === 0) {
    return {
      params: {
        symbol,
        timeframe,
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
      note: "Sem sinais confirmados no período informado.",
    };
  }

  const sList = signals.map((s) => ({
    side: (s.side as Side) || "BUY",
    candleId: s.candleId as any,
    time: s.candle!.time,
  }));

  const trades: Trade[] = [];
  for (let i = 0; i < sList.length; i++) {
    const s = sList[i];
    const entryIdx = candleIndexById.get(s.candleId);
    if (entryIdx === undefined) continue;
    const entryPrice = candles[entryIdx].close;
    const side = s.side;

    let exitIdx = -1;
    if (String(exitMode).toLowerCase() === "bars") {
      exitIdx = Math.min(
        candles.length - 1,
        entryIdx + (Number(barsHoldNum) || 3)
      );
    } else {
      // exitMode = "opposite"
      for (let j = i + 1; j < sList.length; j++) {
        if (sList[j].side !== side) {
          const idx = candleIndexById.get(sList[j].candleId);
          if (idx !== undefined) {
            exitIdx = idx;
            break;
          }
        }
      }
      if (exitIdx < 0) exitIdx = candles.length - 1;
    }

    const exitPrice = candles[exitIdx].close;
    const dir = side === "BUY" ? 1 : -1;
    const pnl = (exitPrice - entryPrice) * dir;

    trades.push({
      entryIdx,
      exitIdx,
      entryTime: candles[entryIdx].time.toISOString(),
      exitTime: candles[exitIdx].time.toISOString(),
      side,
      entryPrice,
      exitPrice,
      pnl,
    });
  }

  // 4) Equity curve e métricas
  const equityCurve: {
    time: string;
    date: string;
    equity: number;
    idx: number;
  }[] = [];
  let equity = initialCap;

  const closePnLByIdx = new Map<number, number>();
  trades.forEach((t) => {
    const prev = closePnLByIdx.get(t.exitIdx) || 0;
    closePnLByIdx.set(t.exitIdx, prev + t.pnl);
  });

  for (let i = 0; i < candles.length; i++) {
    if (closePnLByIdx.has(i)) {
      equity += closePnLByIdx.get(i)!;
    }
    const c = candles[i];
    equityCurve.push({
      time: c.time.toISOString(),
      date: toLocalDateStr(c.time),
      equity,
      idx: i,
    });
  }

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
    params: {
      symbol,
      timeframe,
      from,
      to,
      exitMode,
      barsHold: Number(barsHoldNum),
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
  };
}

// =================== ENDPOINTS INLINE PARA EVITAR 404 ===================
// GET compatível (mantido)
app.get("/api/backtest", async (req, res) => {
  logger.info("[BACKTEST] GET /api/backtest acionado", { query: req.query });
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

// NOVO: POST compatível com o Dashboard
app.post("/api/backtest", async (req, res) => {
  logger.info("[BACKTEST] POST /api/backtest acionado", { body: req.body });
  try {
    const payload = { ...(req.query || {}), ...(req.body || {}) }; // aceita params no body e/ou query
    const data = await handleBacktest(payload);
    return res.json(data);
  } catch (err: any) {
    logger.error("[BACKTEST][POST] Erro", { error: err?.message || err });
    return res
      .status(500)
      .json({ ok: false, error: err?.message || String(err) });
  }
});

// =================== Montagem dos routers existentes ===================
app.use("/api", routes);
app.use("/admin", adminRoutes);

const port = Number(process.env.PORT || 4000);
const server = createServer(app);

server.listen(port, () => {
  logger.info({ msg: `API up on http://localhost:${port}` });
  logger.info({
    msg: "Endpoints prontos: GET/POST /api/backtest (inline), + rotas de /api/* via routes.ts",
  });

  try {
    bootCsvWatchersIfConfigured?.();
  } catch (e: any) {
    logger.warn("[CSVWatcher] módulo não carregado", { err: e?.message || e });
  }

  try {
    bootConfirmedSignalsWorker?.(); // garante geração de sinais confirmados
  } catch (e: any) {
    logger.warn("[SignalsWorker] módulo não carregado", {
      err: e?.message || e,
    });
  }

  try {
    setupWS?.(server); // streaming opcional para o CandleChart
  } catch (e: any) {
    logger.warn("[WS] módulo não iniciado", { err: e?.message || e });
  }
});
