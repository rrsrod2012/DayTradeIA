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

const router = express.Router();
const ZONE = "America/Sao_Paulo";

/* ---------------- utils de data ---------------- */
function toUtcRange(
  from?: string,
  to?: string
): { gte?: Date; lte?: Date } | undefined {
  const parse = (s: string, endOfDay = false) => {
    const hasTime = /T|\d{2}:\d{2}/.test(s);
    let dt = hasTime
      ? DateTime.fromISO(s, { zone: "utc" })
      : DateTime.fromISO(s + (endOfDay ? "T23:59:59.999Z" : "T00:00:00.000Z"), {
          zone: "utc",
        });
    if (!dt.isValid) dt = DateTime.fromJSDate(new Date(s));
    return dt.toJSDate();
  };
  if (!from && !to) return undefined;
  const out: { gte?: Date; lte?: Date } = {};
  if (from) out.gte = parse(from);
  if (to) out.lte = parse(to, true);
  return out;
}
const toLocalDateStr = (d: Date) =>
  DateTime.fromJSDate(d).setZone(ZONE).toFormat("yyyy-LL-dd");

/* ---------------- utils do TF ---------------- */
function tfToMinutes(tfRaw: string) {
  const s = String(tfRaw || "")
    .trim()
    .toUpperCase();
  if (s.startsWith("M")) return Number(s.slice(1)) || 5;
  if (s.startsWith("H")) return (Number(s.slice(1)) || 1) * 60;
  const m = /(\d+)\s*(M|min|minutes|MIN|MINUTES|h|H)/.exec(s);
  if (m) {
    const n = Number(m[1]) || 5;
    const unit = (m[2] || "M").toUpperCase();
    return unit.startsWith("H") ? n * 60 : n;
  }
  return 5;
}

/* ----------------- ROTA CANDLES ----------------- */
router.get("/candles", async (req, res) => {
  try {
    const {
      symbol = "WIN",
      timeframe = "M5",
      from,
      to,
      limit = "1000",
    } = req.query as any;
    const tfMin = tfToMinutes(String(timeframe));
    const baseRange = toUtcRange(String(from || ""), String(to || ""));
    const symbolRaw = String(symbol || "").trim();
    const variants = Array.from(
      new Set([symbolRaw, symbolRaw.toUpperCase(), symbolRaw.toLowerCase()])
    );

    let rows: any[] = [];
    if (symbolRaw) {
      rows = await prisma.candle.findMany({
        where: {
          ...(baseRange ? { time: baseRange } : {}),
          instrument: { is: { symbol: { in: variants } } },
          timeframe: { in: [String(timeframe).toUpperCase(), String(tfMin)] },
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

    // fallback M1->TF (agregação em memória)
    const haveExactTF = rows.length > 0 && tfMin <= 1;
    if (!haveExactTF && tfMin > 1) {
      const m1 = await prisma.candle.findMany({
        where: {
          ...(baseRange ? { time: baseRange } : {}),
          instrument: { is: { symbol: { in: variants } } },
          timeframe: { in: ["M1", "1"] },
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

      function bucketStartUTC(d: Date, tfMin2: number) {
        const y = d.getUTCFullYear(),
          m = d.getUTCMonth(),
          day = d.getUTCDate();
        const H = d.getUTCHours(),
          M = d.getUTCMinutes();
        const bucketMin = Math.floor(M / tfMin2) * tfMin2;
        return new Date(Date.UTC(y, m, day, H, bucketMin, 0, 0));
      }
      const map = new Map<number, any>();
      for (const c of m1) {
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
      rows = Array.from(map.values()).sort(
        (a, b) => a.time.getTime() - b.time.getTime()
      );
    }

    const limitN = Number(limit) || 1000;
    const candles = rows.slice(-limitN);

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

/* ------------------------ /signals (CONFIRMADOS) ------------------------ */
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
    } = req.query as any;

    const symbol = (symbolQ ? String(symbolQ).trim() : "").toUpperCase();
    const tfUpper =
      (timeframeQ ? String(timeframeQ).trim().toUpperCase() : "") || undefined;
    const tfNum = tfUpper ? String(tfToMinutes(tfUpper)) : undefined;

    const from = (_from as string) || (dateFrom as string) || undefined;
    const to = (_to as string) || (dateTo as string) || undefined;
    const range = toUtcRange(from, to);
    const effLimit = Number(limit) || 200;

    const whereBase: any = {};
    if (range) whereBase.candle = { is: { time: range } } as any;

    const signals = await prisma.signal.findMany({
      where: whereBase,
      orderBy: [{ id: "desc" }],
      take: effLimit,
      include: {
        candle: {
          select: {
            id: true,
            time: true,
            open: true,
            high: true,
            low: true,
            close: true,
            volume: true,
            timeframe: true,
            instrument: { select: { symbol: true } },
          },
        },
      },
    });

    if (!signals.length) return res.json([]);

    const rows = signals
      .map((s) => {
        const c = s.candle;
        if (!c) return null;
        const sym = c.instrument?.symbol ?? null;
        const tf = c.timeframe ?? null;

        return {
          id: s.id,
          side: s.side,
          signalType: s.signalType,
          score: s.score ?? null,
          reason: s.reason ?? null,
          time: c.time.toISOString(),
          date: toLocalDateStr(c.time),
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume ?? null,
          symbol: sym,
          timeframe: tf,
          price: c.close, // necessário para o grid
        };
      })
      .filter(Boolean) as any[];

    const filtered = rows.filter((r) => {
      const okSym = symbol
        ? String(r.symbol || "").toUpperCase() === symbol
        : true;
      const okTf = tfUpper
        ? String(r.timeframe || "").toUpperCase() === tfUpper ||
          String(r.timeframe || "") === tfNum ||
          r.timeframe == null
        : true;
      if (range) {
        const t = new Date(r.time).getTime();
        const gte = (range as any).gte
          ? new Date((range as any).gte).getTime()
          : -Infinity;
        const lte = (range as any).lte
          ? new Date((range as any).lte).getTime()
          : Infinity;
        if (t < gte || t > lte) return false;
      }
      return okSym && okTf;
    });

    filtered.sort((a, b) => a.time.localeCompare(b.time));
    return res.json(filtered);
  } catch (err: any) {
    logger.error("[/signals] erro", { message: err?.message });
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

/* ----------------------- /signals/projected ----------------------- */
router.all("/signals/projected", async (req, res) => {
  try {
    const q = (req.method === "GET" ? req.query : req.query) as any;
    const {
      symbol = "WIN",
      timeframe = "M5",
      from: _from,
      to: _to,
      dateFrom,
      dateTo,
      limit = "500",
      ...rest
    } = q;

    const from = (_from as string) || (dateFrom as string);
    const to = (_to as string) || (dateTo as string);
    const userHasRange = Boolean(from || to);
    const effLimit = userHasRange ? undefined : Number(limit) || 500;

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
          from: (from as string) || undefined,
          to: (to as string) || undefined,
          limit: effLimit,
          ...extra,
        })) as any[]) ?? [];
    } catch (inner: any) {
      logger.warn("[/signals/projected] engine falhou, usando vazio", {
        message: inner?.message,
      });
      items = [];
    }

    const out: any[] = [];
    let prevKey = "";
    for (const it of items) {
      const key = `${it.time}-${it.side}`;
      if (key === prevKey) continue;
      out.push(it);
      prevKey = key;
    }

    res.json(out);
  } catch (e: any) {
    logger.error("[/signals/projected] erro inesperado", {
      message: e?.message,
      stack: e?.stack,
    });
    res.json([]);
  }
});

/* ------------------------ IA ONLINE: FEEDBACK / META ------------------------ */
router.post("/ml/feedback", express.json(), async (req, res) => {
  try {
    const base = String(process.env.MICRO_MODEL_URL || "").replace(/\/+$/, "");
    if (!base)
      return res
        .status(400)
        .json({
          ok: false,
          error: "MICRO_MODEL_URL não configurada no backend",
        });

    const body = req.body || {};
    let rows = Array.isArray(body?.rows) ? body.rows : null;
    if (!rows && body?.features && (body?.label === 0 || body?.label === 1)) {
      rows = [{ features: body.features, label: body.label }];
    }
    if (!rows || !Array.isArray(rows) || rows.length === 0) {
      return res
        .status(400)
        .json({ ok: false, error: "Informe {features,label} ou {rows:[...]}" });
    }
    const payload = {
      rows,
      epochs: Number(body?.epochs) || 1,
      lr: typeof body?.lr === "number" ? body.lr : undefined,
    };
    // @ts-ignore
    const r = await fetch(`${base}/train`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    const j = text ? JSON.parse(text) : null;
    if (!r.ok || !j?.ok) {
      return res
        .status(200)
        .json({ ok: false, error: j?.error || `HTTP ${r.status}` });
    }
    return res.status(200).json({ ok: true, ...j });
  } catch (err: any) {
    logger.error("[/ml/feedback] erro", { message: err?.message });
    return res
      .status(200)
      .json({ ok: false, error: String(err?.message || err) });
  }
});

router.get("/ml/meta", async (_req, res) => {
  try {
    const base = String(process.env.MICRO_MODEL_URL || "").replace(/\/+$/, "");
    if (!base)
      return res
        .status(400)
        .json({ ok: false, error: "MICRO_MODEL_URL não configurada" });
    // @ts-ignore
    const r = await fetch(`${base}/meta`);
    const txt = await r.text();
    const j = txt ? JSON.parse(txt) : null;
    return res.status(200).json({ ok: true, ...j });
  } catch (err: any) {
    return res
      .status(200)
      .json({ ok: false, error: String(err?.message || err) });
  }
});

/* ------------------------ CONTROLE DO AUTO-TRAINER ------------------------ */
router.post("/ml/auto/start", (_req, res) => {
  const r = startAutoTrainer();
  return res.status(r.ok ? 200 : 400).json(r);
});
router.post("/ml/auto/stop", (_req, res) => {
  const r = stopAutoTrainer();
  return res.status(200).json(r);
});
router.get("/ml/auto/status", (_req, res) => {
  return res.status(200).json(statusAutoTrainer());
});

/* ------------------------ DEBUG: signals ------------------------ */
router.get("/debug/signals", async (_req, res) => {
  try {
    const candles = await prisma.candle.count();
    const signals = await prisma.signal.count();
    const withCandle = await prisma.signal.count({
      where: { candleId: { gt: 0 } },
    });

    const lastSignals = await prisma.signal.findMany({
      orderBy: { id: "desc" },
      take: 5,
      include: {
        candle: {
          select: {
            id: true,
            time: true,
            open: true,
            high: true,
            low: true,
            close: true,
            volume: true,
            timeframe: true,
            instrument: { select: { symbol: true } },
          },
        },
      },
    });

    res.json({
      ok: true,
      totals: { candles, signals, signalsWithCandleId: withCandle },
      sample: lastSignals.map((s) => ({
        id: s.id,
        side: s.side,
        signalType: s.signalType,
        candleId: s.candleId,
        candle: s.candle
          ? {
              id: s.candle.id,
              time: s.candle.time,
              timeframe: s.candle.timeframe,
              symbol: s.candle.instrument?.symbol ?? null,
              close: s.candle.close,
            }
          : null,
      })),
    });
  } catch (e: any) {
    res.status(200).json({ ok: false, error: e?.message || String(e) });
  }
});

/* ------------------------ DEBUG: candles (com filtros) ------------------------ */
router.get("/debug/candles", async (req, res) => {
  try {
    const {
      symbol = "",
      timeframe = "",
      from,
      to,
      limit = "5000",
    } = req.query as any;
    const variants = symbol
      ? Array.from(
          new Set([
            String(symbol),
            String(symbol).toUpperCase(),
            String(symbol).toLowerCase(),
          ])
        )
      : [];
    const range = toUtcRange(from, to);

    const rows = await prisma.candle.findMany({
      where: {
        ...(range ? { time: range } : {}),
        ...(variants.length
          ? { instrument: { is: { symbol: { in: variants } } } }
          : {}),
        ...(timeframe
          ? {
              timeframe: {
                in: [
                  String(timeframe).toUpperCase(),
                  String(tfToMinutes(String(timeframe)).toString()),
                ],
              },
            }
          : {}),
      },
      orderBy: { time: "desc" },
      take: Number(limit) || 5000,
      select: {
        id: true,
        time: true,
        close: true,
        timeframe: true,
        instrument: { select: { symbol: true } },
      },
    });

    const bySymbol = new Map<string, number>();
    const byTF = new Map<string, number>();
    for (const r of rows) {
      const s = r.instrument?.symbol ?? "(sem instrument)";
      const tf = String(r.timeframe ?? "(sem tf)");
      bySymbol.set(s, (bySymbol.get(s) || 0) + 1);
      byTF.set(tf, (byTF.get(tf) || 0) + 1);
    }

    res.json({
      ok: true,
      count: rows.length,
      bySymbol: Array.from(bySymbol.entries()).map(([k, v]) => ({
        symbol: k,
        count: v,
      })),
      byTimeframe: Array.from(byTF.entries()).map(([k, v]) => ({
        timeframe: k,
        count: v,
      })),
      sample: rows.slice(0, 10),
    });
  } catch (e: any) {
    res.status(200).json({ ok: false, error: e?.message || String(e) });
  }
});

/* ------------------------ DEBUG: candles summary (NOVO) ------------------------ */
router.get("/debug/candles/summary", async (_req, res) => {
  try {
    // Pega uma amostra grande e sumariza por símbolo/timeframe, sem filtros.
    const rows = await prisma.candle.findMany({
      orderBy: { time: "desc" },
      take: 100000, // ajusta se quiser menor
      select: { timeframe: true, instrument: { select: { symbol: true } } },
    });

    const bySymbol = new Map<string, number>();
    const byTF = new Map<string, number>();
    for (const r of rows) {
      const s = r.instrument?.symbol ?? "(sem instrument)";
      const tf = String(r.timeframe ?? "(sem tf)");
      bySymbol.set(s, (bySymbol.get(s) || 0) + 1);
      byTF.set(tf, (byTF.get(tf) || 0) + 1);
    }

    res.json({
      ok: true,
      totalSampled: rows.length,
      symbols: Array.from(bySymbol.entries())
        .map(([k, v]) => ({ symbol: k, count: v }))
        .sort((a, b) => b.count - a.count),
      timeframes: Array.from(byTF.entries())
        .map(([k, v]) => ({ timeframe: k, count: v }))
        .sort((a, b) => b.count - a.count),
    });
  } catch (e: any) {
    res.status(200).json({ ok: false, error: e?.message || String(e) });
  }
});

export default router;
