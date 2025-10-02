// ===============================
// FILE: backend_new/src/modules/strategy/StrategyEngine.ts
// ===============================
import { eventBus, EVENTS } from '../../core/eventBus';
import { logger } from '../../core/logger';
import { prisma } from '../../core/prisma';
import { ADX, ema } from './indicators';
import { loadCandlesAnyTF } from '../data-import/lib/aggregation';

// Parâmetros padrão para a estratégia
const STRATEGY_SYMBOL = process.env.STRATEGY_SYMBOL || 'WIN';
const STRATEGY_TIMEFRAME = process.env.STRATEGY_TIMEFRAME || 'M5'; // Alterado para M5 para corresponder ao arquivo de dados

const TF_MINUTES: Record<string, number> = {
  M1: 1, M5: 5, M15: 15, M30: 30, H1: 60,
};

type TFKey = keyof typeof TF_MINUTES;

function floorToBucket(d: Date, tfMin: number): Date {
  const y = d.getUTCFullYear(),
    m = d.getUTCMonth(),
    day = d.getUTCDate();
  const H = d.getUTCHours(),
    M = d.getUTCMinutes();
  const bucketMin = Math.floor(M / tfMin) * tfMin;
  return new Date(Date.UTC(y, m, day, H, bucketMin, 0, 0));
}

async function upsertTfCandle(
  instrumentId: number,
  tf: TFKey,
  row: { time: Date; open: number; high: number; low: number; close: number; volume: number | null; }
): Promise<number | null> {
  const found = await prisma.candle.findFirst({
    where: { instrumentId, time: row.time, timeframe: tf },
    select: { id: true },
  });

  if (found) {
    await prisma.candle.update({
      where: { id: found.id },
      data: { open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume },
    });
    return found.id;
  }

  const created = await prisma.candle.create({
    data: {
      instrumentId,
      timeframe: tf,
      time: row.time,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume,
    },
    select: { id: true },
  });
  return created?.id ?? null;
}

const runStrategy = async (symbol: string, timeframe: string) => {
  logger.info(`[StrategyEngine] Executando estratégia para ${symbol} ${timeframe}...`);
  const tf = timeframe.toUpperCase() as TFKey;

  const instrument = await prisma.instrument.findUnique({ where: { symbol } });
  if (!instrument) {
    logger.warn(`[StrategyEngine] Instrumento ${symbol} não encontrado no banco.`);
    return;
  }

  const candles = await loadCandlesAnyTF(instrument.symbol, tf);
  if (candles.length < 22) {
    logger.warn(`[StrategyEngine] Dados insuficientes para ${symbol} ${tf} (encontrados: ${candles.length}, necessário: 22).`);
    return;
  }

  logger.info(`[StrategyEngine] ${candles.length} candles carregados para ${symbol} ${tf}. Calculando indicadores...`);

  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);

  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  const adx = ADX(highs, lows, closes, 14);

  let createdOrUpdated = 0;
  let lastSignalSide: "BUY" | "SELL" | null = null;

  let openTrade = await prisma.trade.findFirst({
    where: { instrumentId: instrument.id, timeframe: tf, exitSignalId: null },
    orderBy: { id: 'desc' }
  });

  if (openTrade) {
    const entrySignal = await prisma.signal.findUnique({ where: { id: openTrade.entrySignalId } });
    if (entrySignal) {
      lastSignalSide = entrySignal.side as "BUY" | "SELL";
    }
  }

  const tfMin = TF_MINUTES[tf];

  for (let i = 1; i < candles.length; i++) {
    const prevDiff = (e9[i - 1] ?? 0) - (e21[i - 1] ?? 0);
    const diff = (e9[i] ?? 0) - (e21[i] ?? 0);

    let side: "BUY" | "SELL" | null = null;
    if (prevDiff <= 0 && diff > 0) side = "BUY";
    else if (prevDiff >= 0 && diff < 0) side = "SELL";
    else continue;

    if (side === lastSignalSide) continue;

    const bucketTime = floorToBucket(candles[i].time, tfMin);

    if (openTrade) {
      const entrySignal = await prisma.signal.findUnique({ where: { id: openTrade.entrySignalId }, include: { candle: true } });
      if (entrySignal && bucketTime <= entrySignal.candle.time) {
        continue;
      }
    }

    const candleId = await upsertTfCandle(instrument.id, tf, {
      time: bucketTime,
      open: candles[i].open,
      high: candles[i].high,
      low: candles[i].low,
      close: candles[i].close,
      volume: candles[i].volume ?? null,
    });

    if (!candleId) continue;

    const reason =
      side === "BUY"
        ? `EMA9 cross above EMA21 • ADX14=${(adx[i] ?? 0).toFixed(1)}`
        : `EMA9 cross below EMA21 • ADX14=${(adx[i] ?? 0).toFixed(1)}`;

    const signal = await prisma.signal.upsert({
      where: { candleId_signalType_side: { candleId, signalType: "EMA_CROSS", side: side! } },
      update: { score: Math.abs(diff) / (Math.abs(e21[i] || 1)), reason },
      create: {
        candleId,
        signalType: "EMA_CROSS",
        side: side!,
        score: Math.abs(diff) / (Math.abs(e21[i] || 1)),
        reason,
      },
    });

    eventBus.emit(EVENTS.SIGNAL_GENERATED, { signal, candle: candles[i], instrument });

    if (!openTrade) {
      openTrade = await prisma.trade.create({
        data: {
          instrumentId: instrument.id,
          timeframe: tf,
          entrySignalId: signal.id,
          qty: 1,
          entryPrice: candles[i].close,
        },
      });
      logger.info(`[StrategyEngine] 🔥 NOVO TRADE ABERTO: ${side} para ${symbol} em ${candles[i].time.toISOString()}`);
    } else {
      const pnlPoints =
        lastSignalSide === "BUY"
          ? candles[i].close - openTrade.entryPrice
          : openTrade.entryPrice - candles[i].close;

      await prisma.trade.update({
        where: { id: openTrade.id },
        data: {
          exitSignalId: signal.id,
          exitPrice: candles[i].close,
          pnlPoints,
        },
      });
      logger.info(`[StrategyEngine] ✅ TRADE FECHADO: ${side} para ${symbol} em ${candles[i].time.toISOString()} com ${pnlPoints.toFixed(2)} pontos.`);
      openTrade = null;
    }

    lastSignalSide = side;
    createdOrUpdated++;
  }

  if (createdOrUpdated > 0) {
    logger.info(`[StrategyEngine] Estratégia finalizada. ${createdOrUpdated} sinais/trades processados para ${symbol} ${tf}.`);
  }
};

export const initStrategyEngine = () => {
  // Ouve o evento de nova importação de dados
  eventBus.on(EVENTS.NEW_CANDLE_DATA, (data: { symbol: string, timeframe: string }) => {
    logger.info(`[StrategyEngine] Evento NEW_CANDLE_DATA recebido para ${data.symbol} ${data.timeframe}. Disparando estratégia.`);
    runStrategy(data.symbol, data.timeframe);
  });

  // Executa uma vez no início para processar dados que já possam existir
  runStrategy(STRATEGY_SYMBOL, STRATEGY_TIMEFRAME);

  // <<< NOVO >>> Adiciona uma execução periódica a cada 5 minutos como garantia
  setInterval(() => {
    logger.info('[StrategyEngine] Execução periódica de garantia disparada.');
    runStrategy(STRATEGY_SYMBOL, STRATEGY_TIMEFRAME);
  }, 5 * 60 * 1000); // 5 minutos

  logger.info('✅ Motor de Estratégia inicializado e aguardando eventos de novos candles.');
};