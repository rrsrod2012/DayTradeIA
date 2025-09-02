import { DateTime } from "luxon";
import { prisma } from "../prisma";

export const ZONE = "America/Sao_Paulo";

export type CandleLike = {
  time: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number | null;
};

export type Range = { gte?: Date; lte?: Date };

export function tfToMinutes(tf: string): number {
  const s = String(tf || "")
    .trim()
    .toUpperCase();
  if (s === "H1") return 60;
  const m = s.match(/^M(\d+)$/);
  return m ? Number(m[1]) : 1;
}

function floorToBucketUTC(d: Date, minutes: number, zone = ZONE): Date {
  const dt = DateTime.fromJSDate(d, { zone }).set({
    second: 0,
    millisecond: 0,
  });
  const floored = dt.set({ minute: dt.minute - (dt.minute % minutes) });
  return floored.toUTC().toJSDate();
}

export function aggregateCandles(
  rowsAsc: CandleLike[],
  timeframe: string,
  zone = ZONE
): CandleLike[] {
  const mins = tfToMinutes(timeframe);
  if (mins <= 1) return rowsAsc;

  const buckets = new Map<number, CandleLike>();

  for (const c of rowsAsc) {
    const keyDate = floorToBucketUTC(c.time, mins, zone);
    const key = keyDate.getTime();
    const existing = buckets.get(key);
    if (!existing) {
      buckets.set(key, {
        time: keyDate,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: (c.volume ?? 0) as number,
      });
    } else {
      existing.high = Math.max(existing.high, c.high);
      existing.low = Math.min(existing.low, c.low);
      // close sempre o último do bucket
      existing.close = c.close;
      (existing as any).volume =
        Number(existing.volume ?? 0) + Number(c.volume ?? 0) || null;
    }
  }

  return Array.from(buckets.values()).sort(
    (a, b) => a.time.getTime() - b.time.getTime()
  );
}

/**
 * Carrega candles do TF solicitado. Se não houver no banco e TF != M1,
 * agrega a partir de M1 (no mesmo range).
 */
export async function loadCandlesAnyTF(
  symbol: string,
  timeframe: string,
  range?: Range
): Promise<CandleLike[]> {
  const tf = String(timeframe).toUpperCase();
  const sym = String(symbol).toUpperCase();

  // 1) Tenta buscar no TF nativo
  const native = await prisma.candle.findMany({
    where: {
      instrument: { is: { symbol: sym } },
      timeframe: tf,
      ...(range ? { time: range } : {}),
    },
    orderBy: { time: "asc" },
  });

  if (native.length > 0 || tf === "M1") {
    return native.map((r) => ({
      time: r.time,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: (r as any).volume ?? null,
    }));
  }

  // 2) Não há no TF; agrega a partir de M1
  //    Para evitar corte no primeiro bucket, expande um pouco o início.
  let expanded: Range | undefined = range;
  const mins = tfToMinutes(tf);
  if (range?.gte) {
    const g = DateTime.fromJSDate(range.gte)
      .minus({ minutes: mins - 1 })
      .toJSDate();
    expanded = { ...range, gte: g };
  }

  const m1 = await prisma.candle.findMany({
    where: {
      instrument: { is: { symbol: sym } },
      timeframe: "M1",
      ...(expanded ? { time: expanded } : {}),
    },
    orderBy: { time: "asc" },
  });

  const agg = aggregateCandles(
    m1.map((r) => ({
      time: r.time,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: (r as any).volume ?? null,
    })),
    tf
  );

  // Filtra o range final com base no horário do bucket
  if (range?.gte || range?.lte) {
    return agg.filter((c) => {
      if (range?.gte && c.time < range.gte) return false;
      if (range?.lte && c.time > range.lte) return false;
      return true;
    });
  }
  return agg;
}
