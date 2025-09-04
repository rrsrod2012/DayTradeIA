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
    if (!isFinite(v)) {
      out.push(ema);
      continue;
    }
    ema = ema == null ? v : v * k + ema * (1 - k);
    out.push(ema);
  }
  return out;
}

export function MACD(closes: number[], fast = 12, slow = 26, signal = 9) {
  const emaFast = EMA(closes, fast);
  const emaSlow = EMA(closes, slow);
  const macd: (number | null)[] = closes.map((_, i) => {
    const f = emaFast[i];
    const s = emaSlow[i];
    return f !== null && s !== null ? f - s : null;
  });
  const macdVals = macd.map((v) => v ?? 0);
  const signalArr = EMA(macdVals, signal);
  const hist = macd.map((v, i) =>
    v !== null && signalArr[i] !== null ? v - (signalArr[i] as number) : null
  );
  return { macd, signal: signalArr, hist };
}

export function ATR(
  highs: number[],
  lows: number[],
  closes: number[],
  period = 14
) {
  const trs: number[] = [];
  for (let i = 0; i < highs.length; i++) {
    if (i === 0) {
      trs.push(highs[i] - lows[i]);
      continue;
    }
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trs.push(tr);
  }
  return EMA(trs, period);
}

/** Wilder's RMA (a.k.a. Smoothed Moving Average) */
function RMA(values: number[], period: number): (number | null)[] {
  if (period <= 1) return values.map((v) => (Number.isFinite(v) ? v : null));
  const out: (number | null)[] = new Array(values.length).fill(null);
  let prev: number | null = null;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    const v = Number(values[i]) || 0;
    if (i < period) {
      sum += v;
      if (i === period - 1) {
        prev = sum / period;
        out[i] = prev;
      }
    } else {
      prev = ((prev as number) * (period - 1) + v) / period;
      out[i] = prev;
    }
  }
  return out;
}

/** ADX (Average Directional Index) — período padrão 14
 * Retorna array com ADX (0..100). */
export function ADX(
  highs: number[],
  lows: number[],
  closes: number[],
  period = 14
): (number | null)[] {
  const n = Math.min(highs.length, lows.length, closes.length);
  if (n === 0) return [];
  const TR: number[] = new Array(n).fill(0);
  const DMp: number[] = new Array(n).fill(0);
  const DMm: number[] = new Array(n).fill(0);

  for (let i = 0; i < n; i++) {
    const high = highs[i];
    const low = lows[i];
    const closePrev = i > 0 ? closes[i - 1] : closes[i];
    const tr = Math.max(
      high - low,
      Math.abs(high - closePrev),
      Math.abs(low - closePrev)
    );
    TR[i] = tr;

    if (i === 0) continue;
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    DMp[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    DMm[i] = downMove > upMove && downMove > 0 ? downMove : 0;
  }

  const TRn = RMA(TR, period).map((v) => (v == null ? 0 : v));
  const DMpn = RMA(DMp, period).map((v) => (v == null ? 0 : v));
  const DMmn = RMA(DMm, period).map((v) => (v == null ? 0 : v));

  const DIp: (number | null)[] = new Array(n).fill(null);
  const DIm: (number | null)[] = new Array(n).fill(null);
  const DX: (number | null)[] = new Array(n).fill(null);

  for (let i = 0; i < n; i++) {
    if (TRn[i] <= 0) {
      DIp[i] = null;
      DIm[i] = null;
      DX[i] = null;
      continue;
    }
    const dip = 100 * (DMpn[i] / TRn[i]);
    const dim = 100 * (DMmn[i] / TRn[i]);
    DIp[i] = dip;
    DIm[i] = dim;
    const denom = dip + dim;
    DX[i] = denom > 0 ? (100 * Math.abs(dip - dim)) / denom : null;
  }

  const ADXarr = RMA(
    DX.map((v) => v ?? 0),
    period
  );
  for (let i = 0; i < n; i++) {
    if (i < period * 2 - 1) ADXarr[i] = null;
    else
      ADXarr[i] =
        ADXarr[i] != null ? Math.max(0, Math.min(100, ADXarr[i]!)) : null;
  }
  return ADXarr;
}
