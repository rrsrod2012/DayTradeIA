export function fibonacciLevels(swingHigh: number, swingLow: number) {
  const diff = swingHigh - swingLow;
  return {
    0: swingLow,
    0.236: swingHigh - diff * 0.236,
    0.382: swingHigh - diff * 0.382,
    0.5: swingHigh - diff * 0.5,
    0.618: swingHigh - diff * 0.618,
    0.786: swingHigh - diff * 0.786,
    1: swingHigh
  } as Record<number, number>;
}

export function recentSwing(highs: number[], lows: number[], lookback = 50) {
  const h = highs.slice(-lookback);
  const l = lows.slice(-lookback);
  return { swingHigh: Math.max(...h), swingLow: Math.min(...l) };
}
