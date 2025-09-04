import express from "express";
import { prisma } from "./prisma";
import { DateTime } from "luxon";
import { generateProjectedSignals } from "./services/engine";
import logger from "./logger";

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
const TF_MINUTES: Record<string, number> = {
  M1: 1,
  M5: 5,
  M15: 15,
  M30: 30,
  H1: 60,
};
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

/* ----------------- ROTA CANDLES (sem alterações de lógica) ----------------- */
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
          OR: variants.map((v) => ({ instrument: { is: { symbol: v } } })),
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

    // fallback: agregação M1->TF em memória, caso aplicável
    const haveExactTF = rows.length > 0 && tfMin <= 1;
    if (!haveExactTF && tfMin > 1) {
      const m1 = await prisma.candle.findMany({
        where: {
          ...(baseRange ? { time: baseRange } : {}),
          OR: variants.map((v) => ({ instrument: { is: { symbol: v } } })),
          timeframe: { in: ["M1", "1", "M-1"] },
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

/* ------------------------ SINAIS CONFIRMADOS (robusto por candleId) ------------------------ */
router.get("/signals", async (req, res) => {
  try {
    const {
      // symbol ignorado por enquanto para evitar dependência de relação
      from: _from,
      to: _to,
      dateFrom,
      dateTo,
      limit = "200",
    } = req.query as any;

    const from = (_from as string) || (dateFrom as string) || undefined;
    const to = (_to as string) || (dateTo as string) || undefined;
    const range = toUtcRange(from, to);
    const effLimit = Number(limit) || 200;

    let signalRows: {
      id: number;
      side: "BUY" | "SELL";
      signalType: string | null;
      score: number | null;
      reason: string | null;
      candleId: number | null;
    }[] = [];

    if (range) {
      // 1) Busca IDs de candles no período (sem depender de relações)
      const candleIds = await prisma.candle.findMany({
        where: { time: range },
        select: { id: true },
        orderBy: { time: "asc" },
      });
      const ids = candleIds.map((c) => c.id);
      if (ids.length) {
        // 2) Busca signals por candleId IN ids
        signalRows = await prisma.signal.findMany({
          where: { candleId: { in: ids } },
          orderBy: [{ candleId: "asc" }, { id: "asc" }],
          select: {
            id: true,
            side: true,
            signalType: true,
            score: true,
            reason: true,
            candleId: true,
          },
        });
      } else {
        signalRows = [];
      }
    } else {
      // Sem range: pega últimos N signals
      signalRows = await prisma.signal.findMany({
        orderBy: { id: "desc" },
        take: effLimit,
        select: {
          id: true,
          side: true,
          signalType: true,
          score: true,
          reason: true,
          candleId: true,
        },
      });
      // ordena crescente por id para UX consistente
      signalRows = signalRows.sort((a, b) => a.id - b.id);
    }

    if (!signalRows.length) {
      return res.json([]); // nada no banco (ou nenhum no range)
    }

    // 3) Junta candles por ID (sem depender de relação Prisma)
    const uniqCandleIds = Array.from(
      new Set(signalRows.map((s) => s.candleId).filter(Boolean))
    ) as number[];
    const candles = await prisma.candle.findMany({
      where: { id: { in: uniqCandleIds } },
      select: {
        id: true,
        time: true,
        open: true,
        high: true,
        low: true,
        close: true,
        volume: true,
      },
    });
    const byId = new Map(candles.map((c) => [c.id, c]));

    // 4) Projeta resposta
    const out = signalRows
      .map((s) => {
        const c = s.candleId ? byId.get(s.candleId) : undefined;
        if (!c) return null; // ignora signals sem candle correspondente
        return {
          id: s.id,
          side: s.side,
          type: s.signalType,
          score: s.score ?? null,
          reason: s.reason ?? null,
          time: c.time.toISOString(),
          date: toLocalDateStr(c.time),
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume ?? null,
        };
      })
      .filter(Boolean);

    return res.json(out);
  } catch (err: any) {
    logger.error("[/signals] erro", { message: err?.message });
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

/* ----------------------- SINAIS PROJETADOS (sem mudanças) ----------------------- */
router.post("/signals/projected", async (req, res) => {
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
      })) as any[]) ?? [];

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
    logger.error("[/signals/projected] erro", { message: e?.message });
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

/* ------------------------ IA ONLINE: FEEDBACK (mesmo) ------------------------ */
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

export default router;
