export function calcEMA(values: number[], period: number) {
    const out: number[] = [];
    const k = 2 / (period + 1);
    let prev: number | undefined;
    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        prev = prev == null ? v : prev + k * (v - prev);
        out.push(prev);
    }
    return out;
}

export function calcATR(high: number[], low: number[], close: number[], period = 14) {
    const tr: number[] = [];
    for (let i = 0; i < close.length; i++) {
        if (i === 0) { tr.push(high[i] - low[i]); continue; }
        const prevClose = close[i - 1];
        tr.push(Math.max(high[i] - low[i], Math.abs(high[i] - prevClose), Math.abs(low[i] - prevClose)));
    }
    // EMA do TR
    return calcEMA(tr, period);
}

export function calcADX(high: number[], low: number[], close: number[], period = 14) {
    // Implementação compacta (Wilder) — suficiente p/ filtro
    const len = close.length;
    const plusDM: number[] = [0], minusDM: number[] = [0], tr: number[] = [0];
    for (let i = 1; i < len; i++) {
        const upMove = high[i] - high[i - 1];
        const downMove = low[i - 1] - low[i];
        plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0;
        minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;
        tr[i] = Math.max(
            high[i] - low[i],
            Math.abs(high[i] - close[i - 1]),
            Math.abs(low[i] - close[i - 1])
        );
    }
    // Suavizações
    const smooth = (arr: number[]) => calcEMA(arr, period);
    const trN = smooth(tr);
    const pDMN = smooth(plusDM);
    const mDMN = smooth(minusDM);

    const pDI: number[] = [], mDI: number[] = [], dx: number[] = [];
    for (let i = 0; i < len; i++) {
        const trv = trN[i] || 1e-9;
        const p = 100 * (pDMN[i] || 0) / trv;
        const m = 100 * (mDMN[i] || 0) / trv;
        pDI.push(p);
        mDI.push(m);
        dx.push(100 * Math.abs(p - m) / Math.max(p + m, 1e-9));
    }
    return calcEMA(dx, period); // ADX
}

export function calcVWAP(rows: { high: number; low: number; close: number; volume: number }[]) {
    let cumPV = 0;
    let cumV = 0;
    return rows.map((r) => {
        const tp = (r.high + r.low + r.close) / 3;
        cumPV += tp * (r.volume || 0);
        cumV += (r.volume || 0);
        return cumV > 0 ? cumPV / cumV : tp;
    });
}

export function slope(arr: number[], lookback = 5) {
    const n = Math.min(lookback, arr.length);
    if (n < 2) return 0;
    const a = arr.slice(-n);
    const xBar = (n - 1) / 2;
    const yBar = a.reduce((p, v) => p + v, 0) / n;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
        num += (i - xBar) * (a[i] - yBar);
        den += (i - xBar) * (i - xBar);
    }
    return den === 0 ? 0 : num / den;
}
