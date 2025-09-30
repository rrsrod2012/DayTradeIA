import { eventBus, EVENTS } from '../../core/eventBus';
import { logger } from '../../core/logger';
import { prisma } from '../../core/prisma';
import { ema } from './indicators';

const STRATEGY_SYMBOL = process.env.STRATEGY_SYMBOL || 'WIN';
const STRATEGY_TIMEFRAME = process.env.STRATEGY_TIMEFRAME || 'M5';

const runStrategy = async () => {
  logger.info(`Executando estratégia para ${STRATEGY_SYMBOL} ${STRATEGY_TIMEFRAME}...`);

  const instrument = await prisma.instrument.findUnique({ where: { symbol: STRATEGY_SYMBOL }});
  if (!instrument) {
    logger.warn(`Instrumento ${STRATEGY_SYMBOL} não encontrado no banco.`);
    return;
  }
  
  // Busca os últimos 100 candles para análise
  const candles = await prisma.candle.findMany({
    where: {
      instrumentId: instrument.id,
      timeframe: STRATEGY_TIMEFRAME,
    },
    orderBy: { time: 'desc' },
    take: 100,
  });

  if (candles.length < 22) {
    logger.warn('Dados insuficientes para rodar a estratégia (necessário no mínimo 22 candles).');
    return;
  }

  // A ordem é descendente (do mais novo para o mais antigo), então revertemos para calcular os indicadores
  const sortedCandles = candles.slice().reverse();
  const closes = sortedCandles.map(c => c.close);
  
  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);

  const lastIndex = sortedCandles.length - 1;
  const prevIndex = lastIndex - 1;

  const lastCandle = sortedCandles[lastIndex];
  
  // Verifica o cruzamento no penúltimo candle fechado
  const prevDiff = ema9[prevIndex] - ema21[prevIndex];
  const lastDiff = ema9[lastIndex] - ema21[lastIndex];

  let side: 'BUY' | 'SELL' | null = null;
  if (prevDiff <= 0 && lastDiff > 0) {
    side = 'BUY';
  } else if (prevDiff >= 0 && lastDiff < 0) {
    side = 'SELL';
  }

  if (side) {
    // Verificamos se já existe um sinal para este candle para evitar duplicatas
    const existingSignal = await prisma.signal.findFirst({
        where: {
            candleId: lastCandle.id,
            signalType: 'EMA_CROSS',
            side: side,
        }
    });

    if (existingSignal) {
        logger.info(`Sinal ${side} já existe para o candle ${lastCandle.time.toISOString()}, ignorando.`);
        return;
    }
    
    logger.info(`🔥 SINAL GERADO: ${side} para ${STRATEGY_SYMBOL} em ${lastCandle.time.toISOString()}`);
    
    const newSignal = await prisma.signal.create({
        data: {
            candleId: lastCandle.id,
            signalType: 'EMA_CROSS',
            side,
            reason: 'Cruzamento de médias EMA9/EMA21',
            score: 0.5 // Score base, pode ser enriquecido pela IA
        }
    });

    // Dispara o evento para que outros módulos (como o de execução) possam agir
    eventBus.emit(EVENTS.SIGNAL_GENERATED, {
      signal: newSignal,
      candle: lastCandle,
      instrument,
    });
  }
};

export const initStrategyEngine = () => {
  // O motor de estratégia escuta por novos dados de candles
  eventBus.on(EVENTS.NEW_CANDLE_DATA, (data: { symbol: string, timeframe: string}) => {
    // Apenas executa se os novos dados forem do ativo/timeframe que estamos operando
    if (data.symbol === STRATEGY_SYMBOL && data.timeframe === STRATEGY_TIMEFRAME) {
      runStrategy();
    }
  });
  logger.info('✅ Motor de Estratégia inicializado e aguardando novos candles.');
};