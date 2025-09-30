export function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let currentEma: number | null = null;
  for (const value of values) {
    if (currentEma === null) {
      currentEma = value;
    } else {
      currentEma = value * k + currentEma * (1 - k);
    }
    out.push(currentEma);
  }
  return out;
}

export function atr(candles: { high: number, low: number, close: number }[], period: number): number[] {
  if (candles.length < 2) return [];

  const trueRanges: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trueRanges.push(tr);
  }

  // Simple Moving Average for the first ATR value
  let atrValues: number[] = [trueRanges.slice(0, period - 1).reduce((sum, val) => sum + val, 0) / (period - 1)];

  for (let i = period - 1; i < trueRanges.length; i++) {
    const prevAtr = atrValues[atrValues.length - 1];
    const currentAtr = (prevAtr * (period - 1) + trueRanges[i]) / period;
    atrValues.push(currentAtr);
  }

  // Pad the start with nulls to match candle array length
  const padding = Array(candles.length - atrValues.length).fill(atrValues[0]);
  return [...padding, ...atrValues];
}