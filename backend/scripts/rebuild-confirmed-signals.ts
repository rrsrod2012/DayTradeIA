/* eslint-disable no-console */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

type Side = "BUY" | "SELL";

type Args = {
  symbol: string;
  timeframe: string;
  from?: string;
  to?: string;
  dry?: boolean;
};

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (k: string) => {
    const i = a.findIndex(x => x === `--${k}` || x.startsWith(`--${k}=`));
    if (i === -1) return undefined;
    const eq = a[i].indexOf("=");
    return eq >= 0 ? a[i].slice(eq + 1) : a[i + 1];
  };
  const flag = (k: string) => a.some(x => x === `--${k}`);

  const symbol = String(get("symbol") || "WIN").toUpperCase();
  const timeframe = String(get("timeframe") || "M5").toUpperCase();
  const from = get("from");
  const to = get("to");
  const dry = flag("dry");
  return { symbol, timeframe, from, to, dry };
}

/* ---------------- INDICADORES BÁSICOS (inline p/ independência) ---------------- */
function EMA(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  const k = 2 / (period + 1);
  let e: number | null = null;
  for (let i = 0; i < values.length; i++) {
    const v = Number(values[i]) || 0;
    e = e == null ? v : v * k + e * (1 - k);
    out.push(e);
  }
  return out;
}

function ADX(high: number[], low: number[], close: number[], period = 14): (number | null)[] {
  const len = close.length;
  const dx: number[] = new Array(len).fill(0);
  const tr: number[] = new Array(len).fill(0);
  const plusDM: number[] = new Array(len).fill(0);
  const minusDM: number[] = new Array(len).fill(0);

  for (let i = 1; i < len; i++) {
    const upMove = high[i] - high[i - 1];
    const downMove = low[i - 1] - low[i];
    plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;
    const trueRange = Math.max(
      high[i] - low[i],
      Math.abs(high[i] - close[i - 1]),
      Math.abs(low[i] - close[i - 1])
    );
    tr[i] = trueRange;
  }

  function rma(src: number[], p: number): number[] {
    const out: number[] = [];
    let sum = 0;
    for (let i = 0; i < src.length; i++) {
      const v = src[i];
      if (i < p) {
        sum += v;
        out.push(i === p - 1 ? sum / p : NaN);
      } else if (i === p) {
        sum = (sum - out[p - 1] + v); // não é RMA real; corrige já no else
        out.push((out[p - 1] * (p - 1) + v) / p);
      } else {
        const prev = out[i - 1];
        out.push((prev * (p - 1) + v) / p);
      }
    }
    return out;
  }

  const ATR = rma(tr, period);
  const plus = rma(plusDM, period);
  const minus = rma(minusDM, period);

  for (let i = 0; i < len; i++) {
    const atr = ATR[i];
    const pdi = atr ? (plus[i] / atr) * 100 : 0;
    const mdi = atr ? (minus[i] / atr) * 100 : 0;
    const denom = pdi + mdi;
    dx[i] = denom ? (Math.abs(pdi - mdi) / denom) * 100 : 0;
  }

  const adx: (number | null)[] = [];
  let ema: number | null = null;
  const k = 2 / (period + 1);
  for (let i = 0; i < len; i++) {
    const v = dx[i];
    ema = ema == null ? v : v * k + ema * (1 - k);
    adx.push(ema);
  }
  return adx;
}

/* ----------------- LÓGICA DE SINAIS (EMA9 x EMA21 + ADX14 informativo) ----------------- */
function detectCrossSignals(
  candles: { id: number; time: Date; open: number; high: number; low: number; close: number; volume: number | null }[]
) {
  if (!candles.length) return [] as { candleId: number; side: Side; score: number; reason: string }[];

  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  const e9 = EMA(closes, 9);
  const e21 = EMA(closes, 21);
  const adx = ADX(highs, lows, closes, 14);

  const out: { candleId: number; side: Side; score: number; reason: string }[] = [];
  for (let i = 1; i < candles.length; i++) {
    const prevDiff = (e9[i - 1] ?? closes[i - 1]) - (e21[i - 1] ?? closes[i - 1]);
    const diff = (e9[i] ?? closes[i]) - (e21[i] ?? closes[i]);
    let side: Side | null = null;
    if (prevDiff <= 0 && diff > 0) side = "BUY";
    if (prevDiff >= 0 && diff < 0) side = "SELL";
    if (!side) continue;

    const score = Math.abs(diff) / Math.max(1e-6, Math.abs(e21[i] ?? closes[i]));
    const reason =
      side === "BUY"
        ? `EMA9 cross above EMA21 • ADX14=${(adx[i] ?? 0).toFixed(1)}`
        : `EMA9 cross below EMA21 • ADX14=${(adx[i] ?? 0).toFixed(1)}`;

    out.push({ candleId: candles[i].id, side, score, reason });
  }
  return out;
}

/* ----------------- BACKFILL ----------------- */
async function main() {
  const { symbol, timeframe, from, to, dry } = parseArgs();
  console.log(`[RebuildSignals] symbol=${symbol} timeframe=${timeframe} from=${from || "-"} to=${to || "-"} dry=${!!dry}`);

  // 1) instrument
  const instrument = await prisma.instrument.findFirst({ where: { symbol } });
  if (!instrument) {
    console.error(`Instrumento não encontrado para symbol=${symbol}. Importe candles primeiro.`);
    process.exit(2);
  }

  // 2) candles do período
  const whereTime: any = {};
  if (from) whereTime.gte = new Date(from.includes("T") ? from : `${from}T00:00:00.000Z`);
  if (to) whereTime.lte = new Date(to.includes("T") ? to : `${to}T23:59:59.999Z`);

  const candleWhere: any = {
    instrumentId: instrument.id,
    ...(from || to ? { time: whereTime } : {}),
    // aceita "M5" OU "5" OU null; se seu schema de timeframe for enum e isso quebrar,
    // remova a linha timeframe abaixo e rode por intervalo de tempo.
    OR: [{ timeframe }, { timeframe: String(timeframe.replace(/^M/i, "")) }, { timeframe: null }],
  };

  const candles = await prisma.candle.findMany({
    where: candleWhere,
    orderBy: { time: "asc" },
    select: { id: true, time: true, open: true, high: true, low: true, close: true, volume: true },
  });

  if (!candles.length) {
    console.error(`Nenhum candle encontrado para ${symbol} ${timeframe} no período informado.`);
    process.exit(0);
  }

  console.log(`[RebuildSignals] Candles carregados: ${candles.length}`);

  // 3) gera sinais por cruzamento
  const signals = detectCrossSignals(candles);
  if (!signals.length) {
    console.log("[RebuildSignals] Nenhum cruzamento detectado.");
    process.exit(0);
  }
  console.log(`[RebuildSignals] Sinais detectados (EMA cross): ${signals.length}`);

  // 4) upsert em Signal (unique aproximado por (candleId, signalType="EMA_CROSS", side))
  let created = 0;
  let updated = 0;

  if (dry) {
    console.log(`[RebuildSignals] (dry-run) Sinais que seriam gravados/atualizados: ${signals.length}`);
    process.exit(0);
  }

  for (const s of signals) {
    const existing = await prisma.signal.findFirst({
      where: { candleId: s.candleId, signalType: "EMA_CROSS", side: s.side },
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
          signalType: "EMA_CROSS",
          side: s.side,
          score: s.score,
          reason: s.reason,
        },
      });
      created++;
    }
  }

  console.log(`[RebuildSignals] Concluído. created=${created} updated=${updated}`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("[RebuildSignals] erro:", e?.message || e);
  await prisma.$disconnect();
  process.exit(1);
});
