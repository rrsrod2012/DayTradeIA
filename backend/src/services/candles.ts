

export function detectPatterns(open: number, high: number, low: number, close: number) {
  const patterns: { type: string; strength: number }[] = [];
  const body = Math.abs(close - open);
  const range = high - low || 1e-9;
  const upperShadow = high - Math.max(open, close);
  const lowerShadow = Math.min(open, close) - low;
  const bodyPct = body / range;

  if (bodyPct < 0.1) patterns.push({ type: string.DOJI, strength: 1 - bodyPct });

  const isHammerLike = lowerShadow > body * 2 && upperShadow < body;
  if (isHammerLike) {
    if (close > open) patterns.push({ type: string.HAMMER, strength: Math.min(1, lowerShadow / range) });
    else patterns.push({ type: string.HANGING_MAN, strength: Math.min(1, lowerShadow / range) });
  }

  return patterns;
}
