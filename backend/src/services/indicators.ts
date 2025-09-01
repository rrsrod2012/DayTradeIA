export function SMA(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    out.push(i >= period - 1 ? sum / period : null);
  }
  return out;
}

export function EMA(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  const k = 2 / (period + 1);
  let ema: number | null = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    ema = ema === null ? v : v * k + ema * (1 - k);
    out.push(i >= period - 1 ? ema : null);
  }
  return out;
}

export function RSI(closes: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = [];
  let gain = 0, loss = 0;
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const g = ch > 0 ? ch : 0;
    const l = ch < 0 ? -ch : 0;
    if (i <= period) {
      gain += g; loss += l;
      out.push(null);
      continue;
    }
    if (i === period + 1) {
      gain /= period; loss /= period;
    } else {
      gain = (gain * (period - 1) + g) / period;
      loss = (loss * (period - 1) + l) / period;
    }
    const rs = loss === 0 ? 100 : 100 * (gain / loss);
    const rsi = 100 - 100 / (1 + rs);
    out.push(rsi);
  }
  out.unshift(null);
  return out;
}

export function MACD(closes: number[], fast = 12, slow = 26, signal = 9) {
  const emaFast = EMA(closes, fast);
  const emaSlow = EMA(closes, slow);
  const macd: (number | null)[] = closes.map((_, i) => {
    const f = emaFast[i]; const s = emaSlow[i];
    return f !== null && s !== null ? f - s : null;
  });
  const macdVals = macd.map(v => v ?? 0);
  const signalArr = EMA(macdVals, signal);
  const hist = macd.map((v, i) => (v !== null && signalArr[i] !== null) ? v - (signalArr[i] as number) : null);
  return { macd, signal: signalArr, hist };
}

export function ATR(highs: number[], lows: number[], closes: number[], period = 14) {
  const trs: number[] = [];
  for (let i = 0; i < highs.length; i++) {
    if (i === 0) { trs.push(highs[i] - lows[i]); continue; }
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trs.push(tr);
  }
  return EMA(trs, period);
}
