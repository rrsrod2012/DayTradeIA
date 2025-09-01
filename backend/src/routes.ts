import { Router } from "express";
import { prisma } from "./prisma";
import { generateProjectedSignals } from "./services/engine";

const router = Router();

/**
 * Helper: obtém Instrumento por símbolo.
 * Retorna null se não existir.
 */
async function findInstrumentBySymbol(symbol?: string) {
  if (!symbol) return null;
  return prisma.instrument.findUnique({ where: { symbol } });
}

/**
 * GET /api/candles
 * Query: symbol=WIN&timeframe=M5&from=YYYY-MM-DD&to=YYYY-MM-DD&limit=500
 * Retorna [] quando não houver dados (nunca 404).
 */
router.get("/api/candles", async (req, res) => {
  try {
    const symbol = String(req.query.symbol || "").toUpperCase();
    const timeframe = String(req.query.timeframe || "").toUpperCase();
    const limit = Number(req.query.limit || 500);
    const from = req.query.from ? new Date(String(req.query.from)) : undefined;
    const to = req.query.to ? new Date(String(req.query.to)) : undefined;

    if (!symbol || !timeframe) {
      return res.json([]); // parâmetros ausentes => resposta vazia
    }

    const ins = await findInstrumentBySymbol(symbol);
    if (!ins) return res.json([]);

    const where: any = {
      instrumentId: ins.id,
      timeframe,
    };
    if (from || to) {
      where.time = {};
      if (from) where.time.gte = from;
      if (to) where.time.lte = to;
    }

    const rows = await prisma.candle.findMany({
      where,
      orderBy: { time: "asc" },
      take: limit > 0 ? limit : undefined,
    });

    const out = rows.map((r) => ({
      time: r.time.toISOString(),
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
    }));

    return res.json(out);
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || String(err) });
  }
});

/**
 * GET /api/signals
 * Query: symbol=WIN&timeframe=M5&from=YYYY-MM-DD&to=YYYY-MM-DD&limit=500
 * Lista sinais confirmados (ENTRY/EXIT) ligados aos candles do símbolo/timeframe.
 */
router.get("/api/signals", async (req, res) => {
  try {
    const symbol = String(req.query.symbol || "").toUpperCase();
    const timeframe = String(req.query.timeframe || "").toUpperCase();
    const limit = Number(req.query.limit || 500);
    const from = req.query.from ? new Date(String(req.query.from)) : undefined;
    const to = req.query.to ? new Date(String(req.query.to)) : undefined;

    if (!symbol || !timeframe) {
      return res.json({ signals: [] });
    }

    const ins = await findInstrumentBySymbol(symbol);
    if (!ins) return res.json({ signals: [] });

    const where: any = {
      candle: {
        instrumentId: ins.id,
        timeframe,
      },
    };
    if (from || to) {
      where.candle.time = {};
      if (from) where.candle.time.gte = from;
      if (to) where.candle.time.lte = to;
    }

    const rows = await prisma.signal.findMany({
      where,
      orderBy: {
        candle: { time: "desc" }, // ord por tempo do candle
      },
      take: limit > 0 ? limit : undefined,
      include: {
        candle: { select: { time: true, close: true } },
      },
    });

    const signals = rows.map((s) => ({
      id: s.id,
      time: s.candle?.time?.toISOString(),
      type: s.signalType, // 'ENTRY' | 'EXIT'
      side: s.side, // 'BUY' | 'SELL' | 'FLAT' | null
      score: s.score ?? null,
      reason: s.reason ?? null,
      close: s.candle?.close ?? null,
    }));

    return res.json({ signals });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || String(err) });
  }
});

/**
 * GET /api/signals/projected
 * Query: symbol=WIN&timeframe=M5&horizon=&rr=&evalWindow=&adaptive=&cooldown=&regime=&tod=&conformal=&minProb=&minEV=
 * Respeita filtros de período from/to e limit quando fornecidos.
 */
router.get("/api/signals/projected", async (req, res) => {
  try {
    const symbol = String(req.query.symbol || "").toUpperCase();
    const timeframe = String(req.query.timeframe || "").toUpperCase();
    const limit = Number(req.query.limit || 500);
    const from = req.query.from ? String(req.query.from) : undefined;
    const to = req.query.to ? String(req.query.to) : undefined;

    // parâmetros preditivos
    const horizon = Number(req.query.horizon ?? 8);
    const rr = Number(req.query.rr ?? 2);
    const evalWindow = Number(req.query.evalWindow ?? 200);
    const adaptive = req.query.adaptive
      ? Number(req.query.adaptive) !== 0
      : true;
    const cooldown = req.query.cooldown
      ? Number(req.query.cooldown) !== 0
      : true;
    const regime = req.query.regime ? Number(req.query.regime) !== 0 : true;
    const tod = req.query.tod ? Number(req.query.tod) !== 0 : true;
    const conformal = req.query.conformal
      ? Number(req.query.conformal) !== 0
      : false;

    const minProb = req.query.minProb ? Number(req.query.minProb) : undefined;
    const minEV = req.query.minEV ? Number(req.query.minEV) : undefined;

    if (!symbol || !timeframe) {
      return res.json({ projected: [] });
    }

    // delega geração ao engine (ele usa prisma internamente)
    const projected = await generateProjectedSignals({
      symbol,
      timeframe,
      limit,
      from,
      to,
      horizon,
      rr,
      evalWindow,
      adaptive,
      cooldown,
      regime,
      tod,
      conformal,
      minProb,
      minEV,
    });

    return res.json({ projected });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || String(err) });
  }
});

/**
 * POST /api/backtest
 * Body: { symbol, timeframe, from?, to? }
 * Implementação simples (placeholder): retorna 0 se não houver trades.
 * Você pode evoluir com sua lógica real a partir daqui.
 */
router.post("/api/backtest", async (req, res) => {
  try {
    const symbol = String(req.body?.symbol || "").toUpperCase();
    const timeframe = String(req.body?.timeframe || "").toUpperCase();
    const from = req.body?.from ? new Date(String(req.body.from)) : undefined;
    const to = req.body?.to ? new Date(String(req.body.to)) : undefined;

    if (!symbol || !timeframe) {
      return res.json({ pnlPoints: 0, pnlMoney: 0 });
    }

    const ins = await findInstrumentBySymbol(symbol);
    if (!ins) return res.json({ pnlPoints: 0, pnlMoney: 0 });

    const whereC: any = {
      instrumentId: ins.id,
      timeframe,
    };
    if (from || to) {
      whereC.time = {};
      if (from) whereC.time.gte = from;
      if (to) whereC.time.lte = to;
    }

    // Exemplo: calcula um PnL bobo por variação somada de closes (apenas para não quebrar o front).
    const candles = await prisma.candle.findMany({
      where: whereC,
      orderBy: { time: "asc" },
      take: 2000,
    });

    let pnl = 0;
    for (let i = 1; i < candles.length; i++) {
      pnl += candles[i].close - candles[i - 1].close;
    }

    return res.json({ pnlPoints: Math.round(pnl), pnlMoney: 0 });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || String(err) });
  }
});

export default router;
