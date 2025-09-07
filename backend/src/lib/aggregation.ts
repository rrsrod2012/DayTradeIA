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

/**
 * Range de consulta. Agora aceita opcionalmente `limit`
 * para controlar a quantidade de registros retornados.
 */
export type Range = {
  gte?: Date;
  lte?: Date;
  limit?: number; // <=== NOVO
};

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
 *
 * Suporta `range.limit` como "take" para o Prisma.
 */
export async function loadCandlesAnyTF(
  symbol: string,
  timeframe: string,
  range?: Range
): Promise<CandleLike[]> {
  const tf = String(timeframe).toUpperCase();
  const sym = String(symbol).toUpperCase();

  // 1) Tenta buscar no TF nativo
  const whereNative: any = {
    instrument: { is: { symbol: sym } },
    timeframe: tf,
    ...(range?.gte || range?.lte
      ? {
          time: {
            ...(range?.gte instanceof Date && isFinite(range.gte.getTime())
              ? { gte: range.gte }
              : {}),
            ...(range?.lte instanceof Date && isFinite(range.lte.getTime())
              ? { lte: range.lte }
              : {}),
          },
        }
      : {}),
  };

  const native = await prisma.candle.findMany({
    where: whereNative,
    orderBy: { time: "asc" },
    ...(range?.limit && range.limit > 0 ? { take: range.limit } : {}),
  });

  if (native.length > 0 || tf === "M1") {
    return native.map((r: any) => ({
      time: r.time,
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: r.volume != null ? Number(r.volume) : null,
    }));
  }

  // 2) Não há no TF; agrega a partir de M1
  //    Para evitar corte no primeiro bucket, expande um pouco o início.
  let expanded: Range | undefined = range;
  const mins = tfToMinutes(tf);
  if (range?.gte) {
    const g = DateTime.fromJSDate(range.gte)
      .minus({ minutes: Math.max(0, mins - 1) })
      .toJSDate();
    expanded = { ...range, gte: g };
  }

  const whereM1: any = {
    instrument: { is: { symbol: sym } },
    timeframe: "M1",
    ...(expanded?.gte || expanded?.lte
      ? {
          time: {
            ...(expanded?.gte instanceof Date &&
            isFinite(expanded.gte.getTime())
              ? { gte: expanded.gte }
              : {}),
            ...(expanded?.lte instanceof Date &&
            isFinite(expanded.lte.getTime())
              ? { lte: expanded.lte }
              : {}),
          },
        }
      : {}),
  };

  // Heurística: se pediram limit N no TF alvo, pegue ~N * mins * 1.5 de M1 (com teto)
  const takeM1 =
    expanded?.limit && expanded.limit > 0
      ? Math.min(
          100_000,
          Math.max(200, Math.round(expanded.limit * mins * 1.5))
        )
      : undefined;

  const m1 = await prisma.candle.findMany({
    where: whereM1,
    orderBy: { time: "asc" },
    ...(takeM1 ? { take: takeM1 } : {}),
  });

  if (!m1?.length) return [];

  const m1Norm: CandleLike[] = m1.map((r: any) => ({
    time: r.time,
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: r.volume != null ? Number(r.volume) : null,
  }));

  const agg = aggregateCandles(m1Norm, tf);

  // Se pediram limit, devolva os últimos N (lista já está ascendente)
  let out = agg;
  if (range?.limit && range.limit > 0 && agg.length > range.limit) {
    out = agg.slice(agg.length - range.limit);
  }

  // Filtra o range final com base no horário do bucket (se forneceram gte/lte)
  if (range?.gte || range?.lte) {
    out = out.filter((c) => {
      if (range?.gte && c.time < range.gte) return false;
      if (range?.lte && c.time > range.lte) return false;
      return true;
    });
  }

  return out;
}
