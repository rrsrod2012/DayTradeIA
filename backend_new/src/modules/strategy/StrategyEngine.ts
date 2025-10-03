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
const STRATEGY_TIMEFRAME = (process.env.STRATEGY_TIMEFRAME || 'M1').toUpperCase();

const TF_MINUTES: Record<string, number> = {
  M1: 1, M5: 5, M15: 15, M30: 30, H1: 60,
};

type TFKey = keyof typeof TF_MINUTES;

type Cursor = { id: number; lastProcessedTime: Date } | null;

// ========= CURSOR: usar o nome do índice composto conforme schema: cursor_instrument_tf_unique =========
async function getProcessingCursor(instrumentId: number, timeframe: TFKey): Promise<Cursor> {
  return await prisma.processingCursor.findUnique({
    where: {
      cursor_instrument_tf_unique: {
        instrumentId,
        timeframe,
      },
    },
    select: { id: true, lastProcessedTime: true },
  });
}

async function upsertProcessingCursor(instrumentId: number, timeframe: TFKey, lastProcessedTime: Date): Promise<void> {
  await prisma.processingCursor.upsert({
    where: {
      cursor_instrument_tf_unique: {
        instrumentId,
        timeframe,
      },
    },
    create: { instrumentId, timeframe, lastProcessedTime },
    update: { lastProcessedTime },
  });
}

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
      data: { open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume ?? null },
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
      volume: row.volume ?? null,
    },
    select: { id: true },
  });
  return created?.id ?? null;
}

const runStrategy = async (symbol: string, timeframe: string) => {
  logger.info(`[StrategyEngine] Executando estratégia para ${symbol} ${timeframe}...`);
  const tf = timeframe.toUpperCase() as TFKey;
  const tfMin = TF_MINUTES[tf];
  if (!tfMin) {
    logger.warn(`[StrategyEngine] Timeframe não suportado: ${timeframe}`);
    return;
  }

  const instrument = await prisma.instrument.findUnique({ where: { symbol } });
  if (!instrument) {
    logger.warn(`[StrategyEngine] Instrumento ${symbol} não encontrado no banco.`);
    return;
  }

  const candlesAll = await loadCandlesAnyTF(instrument.symbol, tf);
  if (candlesAll.length < 22) {
    logger.warn(`[StrategyEngine] Dados insuficientes para ${symbol} ${tf} (encontrados: ${candlesAll.length}, necessário: 22).`);
    return;
  }

  // Incremental: lê cursor e seleciona janela com aquecimento de 50 candles
  let candles = candlesAll;
  const cursor = await getProcessingCursor(instrument.id, tf);
  if (cursor && cursor.lastProcessedTime) {
    const idxStart = candlesAll.findIndex(c => c.time > cursor.lastProcessedTime);
    if (idxStart === -1) {
      logger.info(`[StrategyEngine] Sem novos candles após ${cursor.lastProcessedTime.toISOString()} para ${symbol} ${tf}.`);
      return;
    }
    const warmup = 50;
    const start = Math.max(0, idxStart - warmup);
    candles = candlesAll.slice(start);
  }

  // Indicadores
  const closes = candles.map(c => c.close);
  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  const adx = ADX(candles, 14);

  let lastSignalSide: 'BUY' | 'SELL' | null = null;
  let openTrade = await prisma.trade.findFirst({
    where: { instrumentId: instrument.id, timeframe: tf, exitSignalId: null },
    orderBy: { id: 'desc' },
  });

  let createdOrUpdated = 0;

  for (let i = 1; i < candles.length; i++) {
    const prevDiff = (e9[i - 1] ?? 0) - (e21[i - 1] ?? 0);
    const diff = (e9[i] ?? 0) - (e21[i] ?? 0);

    let side: 'BUY' | 'SELL' | null = null;
    if (prevDiff <= 0 && diff > 0) side = 'BUY';
    else if (prevDiff >= 0 && diff < 0) side = 'SELL';
    else continue;

    if (side === lastSignalSide) continue;

    const bucketTime = floorToBucket(candles[i].time, tfMin);

    // Evita abrir/fechar na mesma barra retroativa
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

    const reason = `EMA9xEMA21 ${side} (ADX=${(adx[i] ?? 0).toFixed(2)})`;

    // SIGNAL: índice composto nomeado conforme schema
    const signal = await prisma.signal.upsert({
      where: {
        candle_signal_side_unique: {
          candleId,
          signalType: 'EMA_CROSS',
          side,
        },
      },
      create: {
        candleId,
        signalType: 'EMA_CROSS',
        side,
        meta: {
          adx: adx[i] ?? null,
          e9: e9[i] ?? null,
          e21: e21[i] ?? null,
          spread: Math.abs((e9[i] || 0) - (e21[i] || 0)),
          rel: Math.abs((e9[i] || 0) - (e21[i] || 0)) / Math.abs(e21[i] || 1),
          reason,
        } as any,
      },
      update: {
        meta: {
          adx: adx[i] ?? null,
          e9: e9[i] ?? null,
          e21: e21[i] ?? null,
          spread: Math.abs((e9[i] || 0) - (e21[i] || 0)),
          rel: Math.abs((e9[i] || 0) - (e21[i] || 0)) / Math.abs(e21[i] || 1),
          reason,
        } as any,
      },
    });

    eventBus.emit(EVENTS.SIGNAL_GENERATED, { signal, candle: candles[i], instrument });

    if (!openTrade) {
      // TRADE: usa campo único direto (entrySignalId)
      openTrade = await prisma.trade.upsert({
        where: { entrySignalId: signal.id },
        create: {
          instrumentId: instrument.id,
          timeframe: tf,
          entrySignalId: signal.id,
          qty: 1,
          entryPrice: candles[i].close,
        },
        update: {},
      });
      logger.info(`[StrategyEngine] 🔥 NOVO TRADE ABERTO: ${side} para ${symbol} ${tf} @ ${candles[i].close} em ${bucketTime.toISOString()}`);
    } else if (openTrade) {
      // fecha se sinal contrário
      const isOpposite = (side === 'BUY' && lastSignalSide === 'SELL') || (side === 'SELL' && lastSignalSide === 'BUY');
      if (isOpposite) {
        const pnlPoints = candles[i].close - openTrade.entryPrice;
        await prisma.trade.update({
          where: { id: openTrade.id },
          data: {
            exitSignalId: signal.id,
            exitPrice: candles[i].close,
            pnlPoints,
          },
        });
        logger.info(`[StrategyEngine] ✅ TRADE FECHADO: ${side} para ${symbol} ${tf} em ${candles[i].time.toISOString()} com ${pnlPoints.toFixed(2)} pontos.`);
        openTrade = null;
      }
    }

    lastSignalSide = side;
    createdOrUpdated++;
  }

  if (createdOrUpdated > 0) {
    logger.info(`[StrategyEngine] Estratégia finalizada. ${createdOrUpdated} sinais/trades processados para ${symbol} ${tf}.`);
  }

  // Atualiza cursor para o último candle efetivamente processado (fim da janela)
  try {
    const lastTime = candles[candles.length - 1]?.time;
    if (lastTime) await upsertProcessingCursor(instrument.id, tf, lastTime);
  } catch (e) {
    logger.warn(`[StrategyEngine] Falha ao atualizar cursor: ${String(e)}`);
  }
};

export const initStrategyEngine = () => {
  // Ouve o evento de nova importação de dados
  eventBus.on(EVENTS.NEW_CANDLE_DATA, (data: { symbol: string; timeframe: string }) => {
    logger.info(`[StrategyEngine] Evento NEW_CANDLE_DATA recebido para ${data.symbol} ${data.timeframe}. Disparando estratégia.`);
    runStrategy(data.symbol, data.timeframe);
  });

  // Executa uma vez no início para processar dados que já possam existir
  runStrategy(STRATEGY_SYMBOL, STRATEGY_TIMEFRAME);

  // Execução periódica de garantia (idempotente e incremental)
  setInterval(() => {
    logger.info('[StrategyEngine] Execução periódica de garantia disparada.');
    runStrategy(STRATEGY_SYMBOL, STRATEGY_TIMEFRAME);
  }, 5 * 60 * 1000);

  logger.info('✅ Motor de Estratégia inicializado e aguardando eventos de novos candles.');
};
