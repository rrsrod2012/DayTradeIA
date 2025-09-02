// backend/src/services/candles.ts
export type CandlePatternType = "DOJI" | "HAMMER" | "HANGING_MAN";
export type CandlePattern = { type: CandlePatternType; strength: number };

/**
 * Heurísticas simples só para enriquecer UI / marcações:
 * - DOJI: corpo muito pequeno em relação ao range total.
 * - HAMMER: sombra inferior longa, corpo pequeno, fechamento acima da abertura.
 * - HANGING_MAN: semelhante ao hammer, mas em candle de baixa (fechamento abaixo da abertura).
 */
export function detectPatterns(
  open: number,
  high: number,
  low: number,
  close: number
): CandlePattern[] {
  const patterns: CandlePattern[] = [];

  const body = Math.abs(close - open);
  const range = Math.max(1e-9, high - low);
  const upperShadow = high - Math.max(open, close);
  const lowerShadow = Math.min(open, close) - low;
  const bodyPct = body / range;

  // DOJI: corpo menor que 10% do range
  if (bodyPct < 0.1) {
    patterns.push({ type: "DOJI", strength: +(1 - bodyPct).toFixed(3) });
  }

  // HAMMER-like: sombra inferior pelo menos 2x o corpo e sombra superior curta
  const isHammerLike = lowerShadow > body * 2 && upperShadow < body;
  if (isHammerLike) {
    const strength = Math.min(1, lowerShadow / range);
    if (close > open) {
      patterns.push({ type: "HAMMER", strength: +strength.toFixed(3) });
    } else {
      patterns.push({ type: "HANGING_MAN", strength: +strength.toFixed(3) });
    }
  }

  return patterns;
}
