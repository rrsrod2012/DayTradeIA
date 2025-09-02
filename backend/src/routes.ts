import express from "express";
import { prisma } from "./prisma";
import { DateTime } from "luxon";
import { generateProjectedSignals } from "./services/engine";
import { loadCandlesAnyTF } from "./lib/aggregation";
import logger from "./logger";

const router = express.Router();

const ZONE = "America/Sao_Paulo";

function toUtcRange(from?: string, to?: string): { gte?: Date; lte?: Date } {
  const out: { gte?: Date; lte?: Date } = {};
  const parse = (s: string, endOfDay = false) => {
    const hasTime = /T|\d{2}:\d{2}/.test(s);
    let dt = hasTime
      ? DateTime.fromISO(s, { zone: ZONE })
      : DateTime.fromISO(s, { zone: ZONE })[endOfDay ? "endOf" : "startOf"](
          "day"
        );
    if (!dt.isValid) return undefined;
    return dt.toUTC().toJSDate();
  };
  if (from) out.gte = parse(from, false);
  if (to) out.lte = parse(to, true);
  return out;
}

const toLocalDateStr = (d: Date) =>
  DateTime.fromJSDate(d).setZone(ZONE).toFormat("yyyy-LL-dd");

// ----------------- CANDLES -----------------
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

    let rows = await loadCandlesAnyTF(
      String(symbol),
      String(timeframe),
      hasRange ? range : undefined
    );
    if (!hasRange && takeN) rows = rows.slice(-takeN);

    res.json(
      rows.map((c) => ({
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
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// -------------- SINAIS (CONFIRMADOS) --------------
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

    if (!hasRange && takeN) {
      const recent = await prisma.signal.findMany({
        where: {
          candle: {
            is: {
              instrument: { is: { symbol: String(symbol).toUpperCase() } },
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
            instrument: { is: { symbol: String(symbol).toUpperCase() } },
            timeframe: String(timeframe).toUpperCase(),
            ...(hasRange ? { time: range } : {}),
          },
        },
      },
      include: { candle: true },
      orderBy: { candle: { time: "asc" } },
    });

    if (hasRange && signals.length === 0) {
      const candles = await loadCandlesAnyTF(
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

      const computed = [];
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

      return res.json({
        count: computed.length,
        signals: computed,
      });
    }

    res.json({
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
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// -------------- SINAIS PROJETADOS -----------------
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

    res.json({
      projected: userHasRange
        ? projected
        : projected.slice(-(Number(limit) || 500)),
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// -------------- BACKTEST (corrigido) --------------
router.post("/backtest", async (req, res) => {
  try {
    const {
      symbol = "WIN",
      timeframe = "M5",
      from,
      to,
      costPts = Number(process.env.COST_PER_TRADE_POINTS || 0),
      slippagePts = Number(process.env.SLIPPAGE_POINTS || 0),
      pointValue = Number(process.env.CONTRACT_POINT_VALUE || 1),

      // controles
      seedInitial = true, // abre posição conforme viés inicial se não houver cruzamento
      forceFinalClose = true, // força fechamento no último candle
      useNextBarOpen = true, // entrada/saída pelo open da barra seguinte ao sinal
    } = req.body || {};

    const range = toUtcRange(from, to);
    const hasRange = Boolean(range.gte || range.lte);

    // 1) Candles do TF (agregando M1 se preciso)
    let candles = await loadCandlesAnyTF(
      String(symbol),
      String(timeframe),
      hasRange ? range : undefined
    );
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
      });
    }

    // Helpers de série
    const times = candles.map((c) => c.time.getTime());
    const opensArr = candles.map((c) => c.open);
    const closesArr = candles.map((c) => c.close);
    const lastIdx = times.length - 1;

    // 2) Sinais persistidos no período
    const signalsPersisted = await prisma.signal.findMany({
      where: {
        candle: {
          is: {
            instrument: { is: { symbol: String(symbol).toUpperCase() } },
            timeframe: String(timeframe).toUpperCase(),
            ...(hasRange ? { time: range } : {}),
          },
        },
      },
      include: { candle: true },
      orderBy: { candle: { time: "asc" } },
    });

    // 3) Cruzamentos EMA9/21 on-the-fly (sempre calculamos para robustez)
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

    type Sig = { idx: number; iso: string; side: "BUY" | "SELL" };
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
      crossSignals.push({ idx: i, iso: candles[i].time.toISOString(), side });
    }

    // 4) Consolidar sinais: persistidos (se houver) + cruzamentos
    const consolidated: Sig[] = [];
    if (signalsPersisted.length > 0) {
      for (const s of signalsPersisted) {
        if (!s.candle?.time) continue;
        const t = s.candle.time.getTime();
        // achar índice mais próximo >= t
        let idx = binaryLowerBound(times, t);
        if (idx >= times.length) idx = times.length - 1;
        consolidated.push({
          idx,
          iso: candles[idx].time.toISOString(),
          side: String(s.side).toUpperCase() as "BUY" | "SELL",
        });
      }
    }
    // junta cruzamentos também
    for (const s of crossSignals) consolidated.push(s);

    // ordenar e deduplicar por idx
    consolidated.sort(
      (a, b) => a.idx - b.idx || cmpSide(a.side) - cmpSide(b.side)
    );
    dedupeInPlace(consolidated);

    // 5) Seed inicial se ainda vazio
    if (
      seedInitial &&
      consolidated.length === 0 &&
      emaF.length &&
      emaS.length
    ) {
      const firstDiff = (emaF[0] ?? 0) - (emaS[0] ?? 0);
      const side = firstDiff >= 0 ? "BUY" : "SELL";
      consolidated.push({ idx: 0, iso: candles[0].time.toISOString(), side });
    }

    // 6) Força fechamento no último candle (gera sinal oposto ao atual para fechar)
    if (forceFinalClose) {
      if (consolidated.length === 0) {
        // sem nada ainda? abre na primeira e fecha no fim
        consolidated.push({
          idx: 0,
          iso: candles[0].time.toISOString(),
          side: "BUY",
        });
        consolidated.push({
          idx: lastIdx,
          iso: candles[lastIdx].time.toISOString(),
          side: "SELL",
        });
      } else {
        const lastSig = consolidated[consolidated.length - 1];
        const closingSide: "BUY" | "SELL" =
          lastSig.side === "BUY" ? "SELL" : "BUY";
        if (lastSig.idx !== lastIdx) {
          consolidated.push({
            idx: lastIdx,
            iso: candles[lastIdx].time.toISOString(),
            side: closingSide,
          });
        }
      }
    }

    // Se mesmo assim não há nada, retorna vazio
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
      });
    }

    // 7) Montagem dos trades (entra/sai no próximo candle open quando possível)
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

    for (const sig of consolidated) {
      // índice de execução = próximo candle (se existir)
      const execIdx = Math.min(sig.idx + (useNextBarOpen ? 1 : 0), lastIdx);
      const execOpen = Number.isFinite(opensArr[execIdx])
        ? opensArr[execIdx]
        : closesArr[execIdx];
      const side = sig.side === "BUY" ? "LONG" : "SHORT";

      if (!pos) {
        pos = {
          side,
          entryIdx: execIdx,
          entryTime: candles[execIdx].time.toISOString(),
          entryPrice: execOpen,
        };
        continue;
      }

      // se sinal do mesmo lado, ignora
      if (pos.side === side) continue;

      // fechar posição atual
      const exitIdx = execIdx;
      const exitPx = Number.isFinite(opensArr[exitIdx])
        ? opensArr[exitIdx]
        : closesArr[exitIdx];
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

      // virar a mão
      pos = {
        side,
        entryIdx: execIdx,
        entryTime: candles[execIdx].time.toISOString(),
        entryPrice: execOpen,
      };
    }

    // 8) Fecha no último candle se ainda ficou aberto (sanidade extra)
    if (pos) {
      const exitIdx = lastIdx;
      const exitPx = Number.isFinite(opensArr[exitIdx])
        ? opensArr[exitIdx]
        : closesArr[exitIdx];
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

    // 9) KPIs
    let wins = 0;
    let losses = 0;
    let sumPnL = 0;
    let sumWin = 0;
    let sumLossAbs = 0;
    const equityCurve: { time: string; equity: number }[] = [];
    let equity = 0;
    let peak = 0;
    let maxDD = 0;

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

    return res.json({
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
    });
  } catch (err: any) {
    logger.error("[/backtest] erro", err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

export default router;

/* Utils locais */
function binaryLowerBound(arr: number[], x: number) {
  let lo = 0,
    hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
function cmpSide(s: "BUY" | "SELL") {
  return s === "BUY" ? 0 : 1;
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
