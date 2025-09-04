/* eslint-disable no-console */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

type Side = "BUY" | "SELL";

type Args = {
  symbol: string; // WIN/WDO...
  timeframe: string; // M1/M5/M15/H1...
  from?: string; // 2025-08-01 ou ISO
  to?: string; // 2025-09-04 ou ISO
  dry?: boolean; // só simula (não grava)
  limit?: number; // opcional: limitar leitura de M1
};

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (k: string) => {
    const i = a.findIndex((x) => x === `--${k}` || x.startsWith(`--${k}=`));
    if (i === -1) return undefined;
    const eq = a[i].indexOf("=");
    return eq >= 0 ? a[i].slice(eq + 1) : a[i + 1];
  };
  const flag = (k: string) => a.some((x) => x === `--${k}`);

  const symbol = String(get("symbol") || "WIN").toUpperCase();
  const timeframe = String(get("timeframe") || "M5").toUpperCase();
  const from = get("from");
  const to = get("to");
  const dry = flag("dry");
  const limit = Number(get("limit") || 0) || undefined;
  return { symbol, timeframe, from, to, dry, limit };
}

/* ---------------- Utils TF ---------------- */
function tfToMinutes(tfRaw: string) {
  const s = String(tfRaw || "")
    .trim()
    .toUpperCase();
  if (s.startsWith("M")) return Number(s.slice(1)) || 1;
  if (s.startsWith("H")) return (Number(s.slice(1)) || 1) * 60;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : 1;
}
function canonicalTF(tfRaw: string) {
  const m = tfToMinutes(tfRaw);
  return m % 60 === 0 ? `H${m / 60}` : `M${m}`;
}
function bucketStartUTC(d: Date, tfMin: number) {
  const y = d.getUTCFullYear(),
    m = d.getUTCMonth(),
    day = d.getUTCDate();
  const H = d.getUTCHours(),
    M = d.getUTCMinutes();
  const bucketMin = Math.floor(M / tfMin) * tfMin;
  return new Date(Date.UTC(y, m, day, H, bucketMin, 0, 0));
}

/* ---------------- Indicadores ---------------- */
function EMA(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  const k = 2 / (period + 1);
  let e: number | null = null;
  for (let i = 0; i < values.length; i++) {
    const v = Number(values[i]) || 0;
    e = e == null ? v : v * k + (e as number) * (1 - k);
    out.push(e);
  }
  return out;
}

// ADX simplificado (apenas placeholder para exemplo; ajuste conforme sua lib/formulação preferida)
function ADX(
  high: number[],
  low: number[],
  close: number[],
  period = 14
): (number | null)[] {
  const len = close.length;
  const out: (number | null)[] = [];
  let e: number | null = null;
  const k = 2 / (period + 1);
  for (let i = 0; i < len; i++) {
    const v = Math.max(0, high[i] - low[i]); // proxy simples de amplitude
    e = e == null ? v : v * k + (e as number) * (1 - k);
    out.push(e);
  }
  return out;
}

/* --------------- Sinais (EMA9 x EMA21) --------------- */
function detectCrossSignals(
  candles: {
    id: number;
    time: Date;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }[]
) {
  if (!candles.length)
    return [] as {
      candleId: number;
      side: Side;
      score: number;
      reason: string;
      signalType: string;
    }[];

  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);

  const e9 = EMA(closes, 9);
  const e21 = EMA(closes, 21);
  const adx = ADX(highs, lows, closes, 14);

  const out: {
    candleId: number;
    side: Side;
    score: number;
    reason: string;
    signalType: string;
  }[] = [];
  for (let i = 1; i < candles.length; i++) {
    const prevDiff =
      (e9[i - 1] ?? closes[i - 1]) - (e21[i - 1] ?? closes[i - 1]);
    const diff = (e9[i] ?? closes[i]) - (e21[i] ?? closes[i]);
    let side: Side | null = null;
    if (prevDiff <= 0 && diff > 0) side = "BUY";
    if (prevDiff >= 0 && diff < 0) side = "SELL";
    if (!side) continue;

    const score =
      Math.abs(diff) / Math.max(1e-6, Math.abs(e21[i] ?? closes[i]));
    const reason =
      side === "BUY" ? `EMA9 cross above EMA21` : `EMA9 cross below EMA21`;

    out.push({
      candleId: candles[i].id,
      side,
      score,
      reason,
      signalType: "EMA_CROSS",
    });
  }
  return out;
}

/* ---------------- Agregação M1 → TF ---------------- */
function aggregateToTF(
  m1: {
    time: Date;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number | null;
  }[],
  tfMin: number
): {
  time: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}[] {
  if (tfMin <= 1) {
    // já é M1 -> normaliza volume para número
    return m1.map((c) => ({
      time: new Date(c.time),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: Number(c.volume ?? 0),
    }));
  }
  const map = new Map<
    number,
    {
      time: Date;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
    }
  >();
  for (const c of m1) {
    const b = bucketStartUTC(c.time, tfMin).getTime();
    const prev = map.get(b);
    const vol = Number(c.volume ?? 0);
    if (!prev) {
      map.set(b, {
        time: new Date(b),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: vol,
      });
    } else {
      prev.high = Math.max(prev.high, c.high);
      prev.low = Math.min(prev.low, c.low);
      prev.close = c.close;
      prev.volume = (prev.volume ?? 0) + vol;
    }
  }
  return Array.from(map.values()).sort(
    (a, b) => a.time.getTime() - b.time.getTime()
  );
}

/* ----------------- BACKFILL ----------------- */
async function main() {
  const { symbol, timeframe, from, to, dry, limit } = parseArgs();
  const tfMin = tfToMinutes(timeframe);
  const tfLabel = canonicalTF(timeframe); // "M5", "H1", ...

  console.log(
    `[RebuildSignals] symbol=${symbol} timeframe=${tfLabel} (${tfMin}m) from=${
      from || "-"
    } to=${to || "-"} dry=${!!dry} limit=${limit ?? "-"}`
  );

  // 0) Instrument
  const instrument = await prisma.instrument.findFirst({
    where: {
      symbol: { in: [symbol, symbol.toUpperCase(), symbol.toLowerCase()] },
    },
  });
  if (!instrument) {
    console.error(
      `Instrumento não encontrado para symbol=${symbol}. Importe candles primeiro.`
    );
    process.exit(2);
  }

  // 1) Buscar M1 do período
  const whereTime: any = {};
  if (from)
    whereTime.gte = new Date(
      from.includes("T") ? from : `${from}T00:00:00.000Z`
    );
  if (to)
    whereTime.lte = new Date(to.includes("T") ? to : `${to}T23:59:59.999Z`);

  // aceitamos variações de M1 no banco (ex.: "M1", "1")
  const m1Candles = await prisma.candle.findMany({
    where: {
      instrumentId: instrument.id,
      ...(from || to ? { time: whereTime } : {}),
      OR: [{ timeframe: "M1" }, { timeframe: "1" }],
    },
    orderBy: { time: "asc" },
    take: limit,
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

  console.log(`[RebuildSignals] M1 carregados: ${m1Candles.length}`);
  if (!m1Candles.length) {
    console.error(
      "Nenhum candle M1 encontrado para o período/símbolo informado."
    );
    process.exit(0);
  }

  // 2) Agregar para o TF alvo
  const agg = aggregateToTF(
    m1Candles.map((c) => ({
      time: c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: Number(c.volume ?? 0),
    })),
    tfMin
  );

  console.log(
    `[RebuildSignals] Candles agregados para ${tfLabel}: ${agg.length}`
  );
  if (!agg.length) {
    console.error("Agregação resultou vazia.");
    process.exit(0);
  }

  if (dry) {
    console.log(
      `[RebuildSignals] (dry-run) Não haverá gravação de candles/sinais.`
    );
    process.exit(0);
  }

  // 3) Upsert dos candles agregados no banco (Candle timeframe = tfLabel)
  //    - Critério: (instrumentId, time, timeframe=tfLabel)
  //    - Se existir, atualiza OHLCV; senão, cria.
  const createdCandles: number[] = [];
  const updatedCandles: number[] = [];

  for (const c of agg) {
    const found = await prisma.candle.findFirst({
      where: { instrumentId: instrument.id, time: c.time, timeframe: tfLabel },
      select: { id: true },
    });

    if (found) {
      await prisma.candle.update({
        where: { id: found.id },
        data: {
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: Number(c.volume ?? 0), // <- garante number
        },
      });
      updatedCandles.push(found.id);
    } else {
      const created = await prisma.candle.create({
        data: {
          instrumentId: instrument.id,
          time: c.time,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: Number(c.volume ?? 0), // <- garante number
          timeframe: tfLabel,
        },
        select: { id: true },
      });
      createdCandles.push(created.id);
    }
  }
  console.log(
    `[RebuildSignals] Candles ${tfLabel}: created=${createdCandles.length} updated=${updatedCandles.length}`
  );

  // 4) Carregar a série agregada (já persistida) para gerar SINAIS e vincular por candleId do TF
  const tfCandles = await prisma.candle.findMany({
    where: {
      instrumentId: instrument.id,
      timeframe: tfLabel,
      ...(from || to ? { time: whereTime } : {}),
    },
    orderBy: { time: "asc" },
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

  console.log(
    `[RebuildSignals] Série ${tfLabel} carregada do banco: ${tfCandles.length}`
  );

  // 5) Gera sinais sobre a série TF
  const tfSeries = tfCandles.map((c) => ({
    id: c.id,
    time: c.time,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: Number(c.volume ?? 0), // <- garante number
  }));
  const signals = detectCrossSignals(tfSeries);
  console.log(
    `[RebuildSignals] Sinais detectados (${tfLabel}): ${signals.length}`
  );
  if (!signals.length) {
    console.log(
      "Nenhum sinal detectado (isso pode acontecer dependendo do período)."
    );
    process.exit(0);
  }

  // 6) Upsert de sinais (unique aproximado por (candleId, signalType, side))
  let created = 0;
  let updated = 0;
  for (const s of signals) {
    const existing = await prisma.signal.findFirst({
      where: { candleId: s.candleId, signalType: s.signalType, side: s.side },
      select: { id: true },
    });

    if (existing) {
      await prisma.signal.update({
        where: { id: existing.id },
        data: { score: s.score, reason: s.reason },
      });
      updated++;
    } else {
      await prisma.signal.create({
        data: {
          candleId: s.candleId,
          signalType: s.signalType,
          side: s.side,
          score: s.score,
          reason: s.reason,
        },
      });
      created++;
    }
  }

  console.log(
    `[RebuildSignals] Concluído. signals created=${created} updated=${updated}`
  );
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("[RebuildSignals] erro:", e?.message || e);
  await prisma.$disconnect();
  process.exit(1);
});
