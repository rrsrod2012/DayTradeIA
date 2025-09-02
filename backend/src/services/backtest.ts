/* eslint-disable no-console */
import express from "express";
import { PrismaClient } from "@prisma/client";
import { backfillCandlesAndSignals } from "../workers/confirmedSignalsWorker";

const prisma = new PrismaClient();
export const router = express.Router();

/** util */
type TF = "M1" | "M5" | "M15" | "M30" | "H1";
const TF_MIN: Record<TF, number> = { M1: 1, M5: 5, M15: 15, M30: 30, H1: 60 };
const log = (...a: any[]) => console.log(...a);

function toUTC(d: string | Date) {
  return d instanceof Date ? d : new Date(d);
}
function floorTo(d: Date, tfMin: number) {
  const ms = d.getTime();
  const b = Math.floor(ms / (tfMin * 60000)) * tfMin * 60000;
  return new Date(b);
}
function ceilToExclusive(d: Date, tfMin: number) {
  const ms = d.getTime();
  const mod = ms % (tfMin * 60000);
  const target = mod === 0 ? ms : ms + (tfMin * 60000 - mod);
  return new Date(target);
}

async function ensureInstrumentId(symbol: string) {
  const found = await prisma.instrument.findUnique({ where: { symbol } });
  if (found) return found.id;
  const created = await prisma.instrument.create({
    data: { symbol, name: symbol },
  });
  return created.id;
}

/** EMA simples */
function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev: number | undefined;
  values.forEach((v, i) => {
    prev = i === 0 ? v : (v - (prev as number)) * k + (prev as number);
    out.push(prev as number);
  });
  return out;
}

/** Baseline de cruzamento para gerar sinais na hora (fallback) */
function computeBaselineSignals(
  candles: { id: number; time: Date; close: number }[]
) {
  const closes = candles.map((c) => c.close);
  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  type Sig = { candleId: number; idx: number; side: "BUY" | "SELL" };
  const sigs: Sig[] = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = e9[i - 1] - e21[i - 1];
    const curr = e9[i] - e21[i];
    if (prev <= 0 && curr > 0)
      sigs.push({ candleId: candles[i].id, idx: i, side: "BUY" });
    if (prev >= 0 && curr < 0)
      sigs.push({ candleId: candles[i].id, idx: i, side: "SELL" });
  }
  return sigs;
}

/** Constrói trades a partir de sinais ordenados e candles */
function buildTradesFromSignals(opts: {
  candles: { id: number; time: Date; open: number; close: number }[];
  signals: { candleId: number; side: "BUY" | "SELL" }[];
}) {
  const { candles } = opts;
  // index por candleId
  const idxById = new Map<number, number>();
  candles.forEach((c, i) => idxById.set(c.id, i));

  // ordena por tempo
  const sigs = opts.signals
    .map((s) => ({ ...s, idx: idxById.get(s.candleId) ?? -1 }))
    .filter((s) => s.idx >= 0)
    .sort((a, b) => a.idx - b.idx);

  type Row = {
    entryIdx: number;
    exitIdx: number;
    entryTime: string;
    exitTime: string;
    side: "BUY" | "SELL";
    entryPrice: number;
    exitPrice: number;
    pnl: number; // em pontos
  };

  const trades: Row[] = [];
  let pos: { side: "BUY" | "SELL"; entryIdx: number } | null = null;

  // para evitar lados repetidos (BUY->BUY), só consideramos quando muda
  let lastSide: "BUY" | "SELL" | null = null;

  for (const s of sigs) {
    if (s.side === lastSide) continue; // ignora repetido
    lastSide = s.side;

    // usa próxima barra para entrada (sem lookahead irreal), se houver
    const entryIdxCandidate = Math.min(s.idx + 1, candles.length - 1);

    if (!pos) {
      pos = { side: s.side, entryIdx: entryIdxCandidate };
    } else {
      // fecha se lado oposto
      if (pos.side !== s.side) {
        const exitIdx = entryIdxCandidate;
        const entry = candles[pos.entryIdx];
        const exit = candles[exitIdx];
        const entryPrice = entry.open ?? entry.close;
        const exitPrice = exit.open ?? exit.close;
        const pnl =
          pos.side === "BUY" ? exitPrice - entryPrice : entryPrice - exitPrice;

        trades.push({
          entryIdx: pos.entryIdx,
          exitIdx,
          entryTime: entry.time.toISOString(),
          exitTime: exit.time.toISOString(),
          side: pos.side,
          entryPrice,
          exitPrice,
          pnl,
        });

        pos = { side: s.side, entryIdx: entryIdxCandidate }; // inverte posição
      } else {
        // mesmo lado com posição aberta — mantém a primeira entrada
      }
    }
  }

  // fecha posição remanescente no último candle (saída conservadora)
  if (pos) {
    const entry = candles[pos.entryIdx];
    const exit = candles[candles.length - 1];
    const entryPrice = entry.open ?? entry.close;
    const exitPrice = exit.close;
    const pnl =
      pos.side === "BUY" ? exitPrice - entryPrice : entryPrice - exitPrice;

    trades.push({
      entryIdx: pos.entryIdx,
      exitIdx: candles.length - 1,
      entryTime: entry.time.toISOString(),
      exitTime: exit.time.toISOString(),
      side: pos.side,
      entryPrice,
      exitPrice,
      pnl,
    });
  }

  return trades;
}

function summarize(trades: { pnl: number }[]) {
  const total = trades.length;
  const wins = trades.filter((t) => t.pnl > 0).length;
  const losses = trades.filter((t) => t.pnl < 0).length;
  const pnlPoints = trades.reduce((a, b) => a + b.pnl, 0);
  return {
    trades: total,
    wins,
    losses,
    winRate: total ? (wins / total) * 100 : 0,
    pnlPoints,
    avgPnL: total ? pnlPoints / total : 0,
  };
}

router.post("/api/backtest", express.json(), async (req, res) => {
  const { symbol, timeframe, from, to } = req.body as {
    symbol: string;
    timeframe: TF;
    from: string;
    to: string;
  };

  const version = "server:v5-backtest-fill-signals+fallback";
  try {
    log("[BACKTEST] POST /api/backtest acionado", { body: req.body, version });

    if (!symbol || !timeframe || !from || !to) {
      return res
        .status(400)
        .json({
          ok: false,
          error: "Parâmetros obrigatórios: symbol, timeframe, from, to",
        });
    }

    const tfMin = TF_MIN[timeframe];
    const fromD = floorTo(toUTC(from), tfMin);
    const toD = ceilToExclusive(toUTC(to), tfMin);
    const instrumentId = await ensureInstrumentId(symbol);

    // 1) Garante candles TF agregados e tenta gerar sinais confirmados persistidos
    await backfillCandlesAndSignals({
      symbol,
      timeframe,
      from: fromD,
      to: toD,
    });

    // 2) Carrega candles TF
    const candles = await prisma.candle.findMany({
      where: { instrumentId, timeframe, time: { gte: fromD, lt: toD } },
      orderBy: { time: "asc" },
      select: { id: true, time: true, open: true, close: true },
    });

    log("[BACKTEST] Candles carregados:", candles.length, {
      version,
      symbol,
      timeframe,
      first: candles[0]?.time,
      last: candles.at(-1)?.time,
    });

    if (!candles.length) {
      return res.json({
        ok: true,
        symbol,
        timeframe,
        candles: 0,
        trades: [],
        summary: summarize([]),
        note: "Sem candles no período informado.",
      });
    }

    // 3) Tenta ler sinais confirmados persistidos
    const signals = await prisma.signal.findMany({
      where: {
        candle: { instrumentId, timeframe, time: { gte: fromD, lt: toD } },
        signalType: "EMA_CROSS",
      },
      orderBy: { candleId: "asc" },
      select: { candleId: true, side: true },
    });

    log("[BACKTEST] Sinais carregados:", signals.length, { version });

    let trades: ReturnType<typeof buildTradesFromSignals> = [];

    if (signals.length > 0) {
      // 4A) Monta trades a partir dos sinais confirmados
      trades = buildTradesFromSignals({ candles, signals: signals as any });
      log("[BACKTEST] Trades (confirmados):", trades.length, { version });
    } else {
      // 4B) Fallback baseline (EMA 9/21) – calcula na hora
      const baselineSigs = computeBaselineSignals(
        candles.map((c) => ({ id: c.id, time: c.time, close: c.close }))
      ).map((s) => ({ candleId: s.candleId, side: s.side }));

      log("[BACKTEST] Usando baseline EMA 9/21 (sem sinais confirmados)", {
        count: baselineSigs.length,
        version,
      });

      trades = buildTradesFromSignals({
        candles,
        signals: baselineSigs as any,
      });
      log("[BACKTEST] Trades (baseline):", trades.length, { version });
    }

    const summary = summarize(trades);

    return res.json({
      ok: true,
      symbol,
      timeframe,
      candles: candles.length,
      trades,
      summary,
      version,
    });
  } catch (err: any) {
    console.error(err);
    return res
      .status(500)
      .json({ ok: false, error: String(err?.message || err), version });
  }
});
