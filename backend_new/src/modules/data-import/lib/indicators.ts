export function ADX(
  highs: number[],
  lows: number[],
  closes: number[],
  period = 14
): (number | null)[] {
  const len = closes.length;
  const plusDM: number[] = [];
  const minusDM: number[] = [];
  const tr: number[] = [];

  for (let i = 0; i < len; i++) {
    if (i === 0) {
      plusDM.push(0);
      minusDM.push(0);
      tr.push(highs[0] - lows[0]);
      continue;
    }
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);

    const _tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    tr.push(_tr);
  }

  const rma = (arr: number[]): number[] => {
    const out: number[] = [];
    const k = 1 / period;
    let v: number | null = null;
    for (let i = 0; i < arr.length; i++) {
      v = v == null ? arr[i] : (v as number) * (1 - k) + arr[i] * k;
      out.push(v as number);
    }
    return out;
  };

  const trRMA = rma(tr);
  const plusDMRMA = rma(plusDM);
  const minusDMRMA = rma(minusDM);

  const dx: (number | null)[] = [];
  for (let i = 0; i < len; i++) {
    const trv = trRMA[i] || 0;
    const pdi = trv > 0 ? (plusDMRMA[i] / trv) * 100 : 0;
    const mdi = trv > 0 ? (minusDMRMA[i] / trv) * 100 : 0;
    const denom = pdi + mdi;
    dx.push(denom > 0 ? (Math.abs(pdi - mdi) / denom) * 100 : null);
  }

  const adx: (number | null)[] = [];
  const k = 1 / period;
  let val: number | null = null;
  for (let i = 0; i < len; i++) {
    const dxi = dx[i];
    if (dxi == null) {
      adx.push(val);
      continue;
    }
    val = val == null ? dxi : (val as number) * (1 - k) + dxi * k;
    adx.push(val);
  }
  return adx;
}

export function ema(values: number[], period: number): number[] {
    const out: number[] = [];
    const k = 2 / (period + 1);
    let e: number | null = null;
    for (let i = 0; i < values.length; i++) {
        const v = Number(values[i]) || 0;
        e = e == null ? v : v * k + e * (1 - k);
        out.push(e);
    }
    return out;
}