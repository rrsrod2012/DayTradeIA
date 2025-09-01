// Substitui dependência de enum do Prisma por string literals em tempo de execução.
// Evita ReferenceError em runtime (CommonJS + ts-node-dev).

export type TrendBias = "UP" | "DOWN" | "SIDEWAYS";

/**
 * Calcula o viés (tendência) a partir de EMAs rápida/lenta e suas inclinações.
 * Heurística simples:
 *  - UP:   EMA rápida > EMA lenta e ambas com inclinação positiva
 *  - DOWN: EMA rápida < EMA lenta e ambas com inclinação negativa
 *  - SIDEWAYS: caso contrário
 */
export function trendBias(
  closes: number[],
  fastPeriod = 9,
  slowPeriod = 21
): TrendBias {
  if (closes.length < Math.max(fastPeriod, slowPeriod) + 2) return "SIDEWAYS";

  const emaFast = emaSeries(closes, fastPeriod);
  const emaSlow = emaSeries(closes, slowPeriod);

  const f1 = last(emaFast);
  const f0 = prev(emaFast);
  const s1 = last(emaSlow);
  const s0 = prev(emaSlow);

  if (f1 == null || f0 == null || s1 == null || s0 == null) return "SIDEWAYS";

  const fastSlope = f1 - f0;
  const slowSlope = s1 - s0;

  const fastAbove = f1 > s1;
  const fastBelow = f1 < s1;

  if (fastAbove && fastSlope > 0 && slowSlope > 0) return "UP";
  if (fastBelow && fastSlope < 0 && slowSlope < 0) return "DOWN";
  return "SIDEWAYS";
}

/** EMA completa (série) */
function emaSeries(values: number[], period: number): Array<number | null> {
  const k = 2 / (period + 1);
  let e: number | undefined;
  return values.map((v, i) => {
    e = e === undefined ? v : v * k + e * (1 - k);
    return i >= period - 1 ? e : null;
  });
}

function last<T>(arr: Array<T | null>): T | null {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] != null) return arr[i] as T;
  }
  return null;
}

function prev<T>(arr: Array<T | null>): T | null {
  let seen = 0;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] != null) {
      seen++;
      if (seen === 2) return arr[i] as T;
    }
  }
  return null;
}
