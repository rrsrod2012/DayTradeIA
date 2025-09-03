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
...
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


/** Aplica loss cap diário (em pontos). Para cada dia (UTC por simplicidade),
 * acumula PnL e interrompe novas entradas após atingir -cap. */
function applyDailyLossCap(trades: { entryTime: string; exitTime: string; pnl: number }[], capPts: number) {
  if (!capPts || capPts <= 0) return trades;
  let out: typeof trades = [];
  let currDate: string | null = null;
  let dayCum = 0;
  for (const t of trades) {
    const d = (t.entryTime || t.exitTime || "").slice(0, 10) || "1970-01-01";
    if (currDate !== d) {
      currDate = d;
      dayCum = 0;
    }
    // Se já estourou o cap no dia, ignora demais trades do dia
    if (dayCum <= -capPts) continue;
    out.push(t);
    dayCum += t.pnl || 0;
  }
  return out;
}
function summarize(trades: { pnl: number }[]) {
  const total = trades.length;
  const wins = trades.filter((t) => t.pnl > 0).length;
  const losses = trades.filter((t) => t.pnl < 0).length;
  const ties = trades.filter((t) => (t.pnl || 0) === 0).length;
  const pnlPoints = trades.reduce((a, b) => a + (b.pnl || 0), 0);
  const grossProfit = trades.filter(t => (t.pnl || 0) > 0).reduce((a,b)=>a + (b.pnl || 0), 0);
  const grossLoss = trades.filter(t => (t.pnl || 0) < 0).reduce((a,b)=>a + (b.pnl || 0), 0);
  const profitFactor = grossLoss !== 0 ? (grossProfit / Math.abs(grossLoss)) : (grossProfit > 0 ? Infinity : 0);
  return {
    trades: total,
    wins,
    losses,
    ties,
    winRate: total ? (wins / total) * 100 : 0,
    pnlPoints,
    avgPnL: total ? pnlPoints / total : 0,
    profitFactor,
  };
}

router.post("/api/backtest", express.json(), async (req, res) => {
...
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
    const candles =
...
      });
      log("[BACKTEST] Trades (baseline):", trades.length, { version });
    }

const lossCap = Number((req as any)?.body?.lossCap) || 0;
const tradesOut = lossCap > 0 ? applyDailyLossCap(trades as any[], lossCap) : trades;
const summary = summarize(tradesOut);

return res.json({
  ok: true,
  symbol,
  timeframe,
  candles: candles.length,
  trades: tradesOut,
  summary,
  version,
  lossCapApplied: lossCap,
});
  } catch (err: any) {
    console.error(err);
    return res
      .status(500)
      .json({ ok: false, error: String(err?.message || err), version });
  }
});
