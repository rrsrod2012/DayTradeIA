// backend/src/services/backtest.ts
export type Side = "BUY" | "SELL" | "FLAT";

export type BacktestParams = {
  qty?: number;
  slPoints?: number; // stop-loss (pts)
  tpPoints?: number; // take-profit (pts)
  contractMultiplier?: number; // R$ por ponto por contrato
};

/**
 * Backtest minimalista:
 * - Entra quando e9 cruza e21 (fora deste arquivo, você pode gerar um vetor "signals" com { idx, side }).
 * - Stop e alvo fixos em pontos.
 * - Fecha e reverte na próxima entrada contrária.
 */
export function runBacktest(
  ohlc: { o: number[]; h: number[]; l: number[]; c: number[] },
  signals: { idx: number; side: Side }[],
  params: BacktestParams = {}
) {
  const qty = params.qty ?? 1;
  const mult = params.contractMultiplier ?? 0.2;
  const sl = params.slPoints ?? 200;
  const tp = params.tpPoints ?? 300;

  let position: Side = "FLAT";
  let entryPrice = 0;
  let pnlMoney = 0;
  let pnlPoints = 0;

  const trades: {
    entryIdx: number;
    exitIdx: number;
    side: Side;
    entry: number;
    exit: number;
    points: number;
    money: number;
  }[] = [];

  for (const s of signals) {
    const i = s.idx;
    // Fecha posição atual antes de abrir outra
    if (position !== "FLAT") {
      // Stop/TP intrabar (simplificado): usa H/L da barra de entrada
      if (position === "BUY") {
        const tpHit = ohlc.h[i] >= entryPrice + tp;
        const slHit = ohlc.l[i] <= entryPrice - sl;
        if (tpHit || slHit) {
          const exit = tpHit ? entryPrice + tp : entryPrice - sl;
          const pts = tpHit ? tp : -sl;
          const money = pts * mult * qty;
          pnlPoints += pts;
          pnlMoney += money;
          trades.push({
            entryIdx: i,
            exitIdx: i,
            side: position,
            entry: entryPrice,
            exit,
            points: pts,
            money,
          });
          position = "FLAT";
        }
      } else if (position === "SELL") {
        const tpHit = ohlc.l[i] <= entryPrice - tp;
        const slHit = ohlc.h[i] >= entryPrice + sl;
        if (tpHit || slHit) {
          const exit = tpHit ? entryPrice - tp : entryPrice + sl;
          const pts = tpHit ? tp : -sl;
          const money = pts * mult * qty;
          pnlPoints += pts;
          pnlMoney += money;
          trades.push({
            entryIdx: i,
            exitIdx: i,
            side: position,
            entry: entryPrice,
            exit,
            points: pts,
            money,
          });
          position = "FLAT";
        }
      }
    }

    // Abre nova posição (se estiver FLAT)
    if (position === "FLAT" && (s.side === "BUY" || s.side === "SELL")) {
      position = s.side;
      entryPrice = ohlc.c[i];
    }
  }

  return { trades, pnlPoints, pnlMoney };
}
