import { eventBus, EVENTS } from '../../core/eventBus';
import { logger } from '../../core/logger';
import { enqueueOrder } from './BrokerageBridge';
import { Candle, Instrument, Signal } from '@prisma/client';
import { atr } from '../strategy/indicators';
import { prisma } from '../../core/prisma';

let isPositionOpen = false; // Controle de estado simples para evitar múltiplas posições

const handleSignal = async (data: { signal: Signal, candle: Candle, instrument: Instrument }) => {
  const { signal, candle, instrument } = data;

  if (isPositionOpen && signal.side !== 'CLOSE') {
    logger.warn(`Sinal de ${signal.side} recebido, mas já existe uma posição aberta. Ignorando.`);
    return;
  }
  
  if (!isPositionOpen && signal.side === 'CLOSE') {
      logger.warn('Sinal de fechamento recebido, mas nenhuma posição aberta. Ignorando.');
      return;
  }

  isPositionOpen = signal.side !== 'CLOSE';

  // Lógica para definir SL/TP
  const candles = await prisma.candle.findMany({
      where: { instrumentId: instrument.id, timeframe: candle.timeframe },
      orderBy: { time: 'desc' },
      take: 100
  });
  const sortedCandles = candles.slice().reverse();
  const atrValue = atr(sortedCandles, 14).pop() || 100;

  const slMultiplier = parseFloat(process.env.SL_ATR_MULTIPLIER || "1.5");
  const tpRatio = parseFloat(process.env.TP_RR_RATIO || "2.0");

  const slPoints = Math.round(atrValue * slMultiplier);
  const tpPoints = Math.round(slPoints * tpRatio);

  const order = {
    id: `signal-${signal.id}-${Date.now()}`,
    symbol: instrument.symbol,
    side: signal.side as 'BUY' | 'SELL',
    timeframe: candle.timeframe,
    volume: 1, // Pode ser configurável
    slPoints,
    tpPoints,
    comment: `SignalID: ${signal.id}`
  };
  
  logger.info(`Decidido executar ordem para o sinal ${signal.id}. Enviando para a fila.`);
  enqueueOrder(order);
};

export const initExecutionEngine = () => {
  eventBus.on(EVENTS.SIGNAL_GENERATED, handleSignal);

  // Lógica para resetar o estado da posição (ex: quando o MT5 confirma um fechamento)
  eventBus.on(EVENTS.TRADE_EXECUTED, (data: { event: string }) => {
      if (data.event === 'closed') {
          isPositionOpen = false;
          logger.info('Posição foi fechada. Motor de execução está livre para novas entradas.');
      }
  });

  logger.info('✅ Motor de Execução inicializado e aguardando sinais.');
};