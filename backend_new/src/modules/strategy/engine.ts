import { prisma } from '../../core/prisma';
import { loadCandlesAnyTF } from '../data-import/lib/aggregation';
import { ema } from './lib/indicators';

type Candle = {
  time: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
};

type ProjectedSignal = {
  time: string; // ISO
  side: "BUY" | "SELL";
  score: number;
  reason: string;
  symbol: string;
  timeframe: string;
};

// Heurística de sinais baseada em cruzamento de médias e breakout
function buildHeuristicSignals(
  symbol: string,
  timeframe: string,
  candles: Candle[]
): ProjectedSignal[] {
  if (candles.length < 22) return [];

  const closes = candles.map((c) => c.close);
  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);

  const out: ProjectedSignal[] = [];
  const N = 10; // Janela para breakout

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prevDiff = (e9[i - 1] ?? closes[i - 1]) - (e21[i - 1] ?? closes[i - 1]);
    const diff = (e9[i] ?? closes[i]) - (e21[i] ?? closes[i]);

    const window = candles.slice(Math.max(0, i - N), i);
    const winHigh = Math.max(...window.map((x) => x.high));
    const winLow = Math.min(...window.map((x) => x.low));

    // Sinal de COMPRA: cruzou para cima e rompeu a máxima recente
    if (prevDiff <= 0 && diff > 0 && c.close > winHigh) {
      out.push({
        time: c.time.toISOString(),
        side: "BUY",
        score: Math.max(0.1, Math.min(1, Math.abs(diff))),
        reason: `EMA9 > EMA21 + Breakout (${N})`,
        symbol,
        timeframe,
      });
    }

    // Sinal de VENDA: cruzou para baixo e rompeu a mínima recente
    if (prevDiff >= 0 && diff < 0 && c.close < winLow) {
      out.push({
        time: c.time.toISOString(),
        side: "SELL",
        score: Math.max(0.1, Math.min(1, Math.abs(diff))),
        reason: `EMA9 < EMA21 + Breakdown (${N})`,
        symbol,
        timeframe,
      });
    }
  }
  return out;
}

export async function generateProjectedSignals(params: {
  symbol: string;
  timeframe: string;
  from?: string;
  to?: string;
  limit?: number;
}): Promise<ProjectedSignal[]> {
  try {
    const { symbol, timeframe, from, to, limit = 500 } = params;

    const range = from || to ? { 
        gte: from ? new Date(from) : undefined, 
        lte: to ? new Date(to) : undefined 
    } : undefined;

    const candles = await loadCandlesAnyTF(symbol, timeframe, range);
    if (!candles.length) return [];

    const tail = range ? candles : candles.slice(-Math.min(limit, 600));

    let items = buildHeuristicSignals(symbol, timeframe, tail);
    
    // Futuramente, a chamada para o `ai-node` pode ser adicionada aqui para re-pontuar os sinais
    // items = await rescoreWithML(items, tail);

    return items.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
  } catch (e: any) {
    console.error("[Engine] Erro ao gerar sinais projetados:", e?.message || String(e));
    return [];
  }
}