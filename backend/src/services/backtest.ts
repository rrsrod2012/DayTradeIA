type Side = 'BUY'|'SELL'|'FLAT';

export type BacktestParams = {
  qty?: number; slPoints?: number; tpPoints?: number; contractMultiplier?: number;
};

export function runBacktest(ohlc: {o:number;h:number;l:number;c:number;}[], signals: {idx:number; side:Side}[], params: BacktestParams = {}) {
  const qty = params.qty ?? 1;
  const mult = params.contractMultiplier ?? 0.2;
  const sl = params.slPoints ?? 200;
  const tp = params.tpPoints ?? 300;

  let position: Side = Side.FLAT;
  let entryPrice = 0; let pnlMoney = 0; let pnlPoints = 0;
  const trades: { entryIdx:number; exitIdx:number; side:Side; entry:number; exit:number; points:number; money:number }[] = [];

  for (const s of signals) {
    const price = ohlc[s.idx].c;
    if (s.side === Side.BUY && position === Side.FLAT) {
      position = Side.BUY; entryPrice = price;
    } else if (s.side === Side.SELL && position === Side.FLAT) {
      position = Side.SELL; entryPrice = price;
    } else if (s.side === Side.FLAT && position !== Side.FLAT) {
      const points = position === Side.BUY ? price - entryPrice : entryPrice - price;
      const money = points * mult * qty;
      pnlPoints += points; pnlMoney += money;
      trades.push({ entryIdx: s.idx, exitIdx: s.idx, side: position, entry: entryPrice, exit: price, points, money });
      position = Side.FLAT;
    }

    const { h, l } = ohlc[s.idx];
    if (position !== Side.FLAT) {
      if (position === Side.BUY) {
        if (h - entryPrice >= tp) {
          const exit = entryPrice + tp; const money = tp * mult * qty;
          pnlPoints += tp; pnlMoney += money;
          trades.push({ entryIdx: s.idx, exitIdx: s.idx, side: position, entry: entryPrice, exit, points: tp, money });
          position = Side.FLAT;
        } else if (entryPrice - l >= sl) {
          const exit = entryPrice - sl; const money = -sl * mult * qty;
          pnlPoints -= sl; pnlMoney += money;
          trades.push({ entryIdx: s.idx, exitIdx: s.idx, side: position, entry: entryPrice, exit, points: -sl, money });
          position = Side.FLAT;
        }
      } else {
        if (entryPrice - l >= tp) {
          const exit = entryPrice - tp; const money = tp * mult * qty;
          pnlPoints += tp; pnlMoney += money;
          trades.push({ entryIdx: s.idx, exitIdx: s.idx, side: position, entry: entryPrice, exit, points: tp, money });
          position = Side.FLAT;
        } else if (h - entryPrice >= sl) {
          const exit = entryPrice + sl; const money = -sl * mult * qty;
          pnlPoints -= sl; pnlMoney += money;
          trades.push({ entryIdx: s.idx, exitIdx: s.idx, side: position, entry: entryPrice, exit, points: -sl, money });
          position = Side.FLAT;
        }
      }
    }
  }

  return { trades, pnlPoints, pnlMoney };
}
