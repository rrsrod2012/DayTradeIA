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
const toLocalDateTime = (d: Date) =>
  DateTime.fromJSDate(d).setZone(ZONE);
const toLocalDateStr = (d: Date) =>
  toLocalDateTime(d).toFormat("yyyy-LL-dd HH:mm:ss");

/* ---------------- helpers TF ---------------- */
function tfToMinutes(tf: string) {
  const s = String(tf || "").trim().toUpperCase();
  if (s === "H1") return 60;
  const m = s.match(/^M(\d+)$/);
  return m ? Number(m[1]) : 5;
}

/* ----------------- HEALTHCHECK ----------------- */
router.get("/healthz", (_req, res) => {
  res.json({ ok: true, now: new Date().toISOString() });
});

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

/* ---------------- util: último candle por símbolo ---------------- */
async function lastCandleTimeForSymbol(symbolUpper?: string): Promise<Date | null> {
  if (!symbolUpper) return null;
  const inst = await prisma.instrument.findFirst({
    where: { symbol: symbolUpper },
    select: { id: true },
  });
  if (!inst) return null;
  const last = await prisma.candle.findFirst({
    where: { instrumentId: inst.id },
    orderBy: { time: "desc" },
    select: { time: true },
  });
  return last?.time ?? null;
}

/* ------------------------ /signals (CONFIRMADOS) ----------------------- */
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
    const reqRange = toUtcRange(from, to);

    const nowUtc = new Date();
    // lte = min(agora, último candle do símbolo se houver)
    const lastCandle = await lastCandleTimeForSymbol(symbol);
    const hardUpper = lastCandle && lastCandle < nowUtc ? lastCandle : nowUtc;

    const timeWhere: { gte?: Date; lte?: Date } = {};
    if (reqRange?.gte) timeWhere.gte = reqRange.gte;
    timeWhere.lte =
      reqRange?.lte && reqRange.lte < hardUpper ? reqRange.lte : hardUpper;

    const effLimit = Number(limit) || 200;

    const whereBase: any = {
      candle: { is: { time: timeWhere, ...(symbol ? {} : {}) } },
    };

    const signals = await prisma.signal.findMany({
      where: whereBase,
      orderBy: [{ candle: { time: "desc" as const } }, { id: "desc" }],
      take: effLimit,
      include: {
        candle: {
          select: {
            id: true,
            time: true,
            timeframe: true,
            instrument: { select: { symbol: true } },
            open: true,
            high: true,
            low: true,
            close: true,
            volume: true,
          },
        },
      },
    });

    const items = signals
      .filter((s) => {
        if (symbol && s.candle.instrument.symbol.toUpperCase() !== symbol)
          return false;
        if (tfNum && String(s.candle.timeframe).toUpperCase() !== tfNum)
          return false;
        return true;
      })
      .map((s) => {
        const tJs = s.candle.time;
        const dtLocal = toLocalDateTime(tJs);
        return {
          id: s.id,
          candleId: s.candleId,
          time: tJs.toISOString(),               // UTC ISO
          date: toLocalDateStr(tJs),             // yyyy-LL-dd HH:mm:ss (BRT)
          timeframe: s.candle.timeframe,
          symbol: s.candle.instrument.symbol,
          type: s.type,
          side: s.side,
          score: s.score,
          meta: s.meta,
          // novos campos "display" para o frontend:
          dateLocalBr: dtLocal.toFormat("dd/LL/yyyy"),
          timeLocalBr: dtLocal.toFormat("HH:mm:ss"),
          tz: ZONE,
        };
      });

    res.json(items);
  } catch (err: any) {
    logger.error("[/signals] erro", { message: err?.message });
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

/* -------------------- /ml/projected (GET legacy) -------------------- */
router.get("/ml/projected", async (req, res) => {
  try {
    const { symbol = "WIN", timeframe = "M5", ...rest } = req.query as any;
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

/* -------------------- /signals/projected (POST para o frontend) -------------------- */
router.post("/signals/projected", async (req, res) => {
  try {
    const body = (req.body || {}) as Record<string, any>;
    const symbol = String(body.symbol || "").trim().toUpperCase();
    const timeframe = String(body.timeframe || "").trim().toUpperCase();
    const from = body.from ? String(body.from) : undefined;
    const to = body.to ? String(body.to) : undefined;
    const limit = body.limit != null ? Number(body.limit) : undefined;

    if (!symbol || !timeframe) {
      logger.warn("[/signals/projected] missing params", { symbol, timeframe });
      return res.json([]);
    }

    const range = toUtcRange(from, to);
    const effLimit = range ? undefined : (Number(limit || 500) as number | undefined);

    // carrega candles para garantir série mínima
    let candles: any[] = [];
    try {
      const rangeForLoad = {
        ...(range || {}),
        ...(effLimit ? { limit: effLimit } : {}),
      } as any;
      candles = await loadCandlesAnyTF(symbol, timeframe, rangeForLoad);
    } catch (e: any) {
      logger.warn("[/signals/projected] loadCandlesAnyTF falhou", {
        err: e?.message || e,
        symbol,
        timeframe,
        from,
        to,
      });
      return res.json([]);
    }

    if (!Array.isArray(candles) || candles.length < 30) {
      logger.info("[/signals/projected] série insuficiente", {
        count: Array.isArray(candles) ? candles.length : -1,
        symbol,
        timeframe,
      });
      return res.json([]);
    }

    let items: any[] = [];
    try {
      items =
        ((await generateProjectedSignals?.({
          symbol,
          timeframe,
          range,
          limit: effLimit,
          ...Object.fromEntries(
            Object.entries(body).filter(
              ([k]) => !["symbol", "timeframe", "from", "to", "limit"].includes(k)
            )
          ),
        })) as any[]) || [];
    } catch (e: any) {
      logger.warn("[/signals/projected] generateProjectedSignals falhou", {
        err: e?.message || e,
        symbol,
        timeframe,
      });
      items = [];
    }

    return res.json(items);
  } catch (err: any) {
    logger.error("[/signals/projected] erro inesperado", { message: err?.message });
    return res.json([]);
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

export default router;
