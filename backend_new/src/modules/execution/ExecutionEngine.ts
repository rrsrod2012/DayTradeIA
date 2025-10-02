// ===============================
// FILE: backend_new/src/modules/execution/ExecutionEngine.ts
// ===============================
import { eventBus, EVENTS } from '../../core/eventBus';
import { logger } from '../../core/logger';
import { enqueueOrder } from './BrokerageBridge';
import { Candle, Instrument, Signal } from '@prisma/client';
import { ATR } from '../strategy/indicators'; // <<< CORRIGIDO
import { prisma } from '../../core/prisma';

let isPositionOpen = false;

const handleSignal = async (data: { signal: Signal, candle: Candle, instrument: Instrument }) => {
  const { signal, candle, instrument } = data;

  if (isPositionOpen && signal.side !== 'CLOSE') {
    // Se o sinal for na direção oposta, tratamos como um fechamento e reabrimos.
    if ((signal.side === 'BUY' && isPositionOpen) || (signal.side === 'SELL' && isPositionOpen)) {
      logger.info(`Sinal oposto (${signal.side}) recebido com posição aberta. Fechando e reabrindo.`);
    } else {
      logger.warn(`Sinal de ${signal.side} recebido, mas já existe uma posição aberta na mesma direção. Ignorando.`);
      return;
    }
  }

  if (!isPositionOpen && signal.side === 'CLOSE') {
    logger.warn('Sinal de fechamento recebido, mas nenhuma posição aberta. Ignorando.');
    return;
  }

  isPositionOpen = signal.side !== 'CLOSE';

  const candles = await prisma.candle.findMany({
    where: { instrumentId: instrument.id, timeframe: candle.timeframe },
    orderBy: { time: 'desc' },
    take: 100
  });

  if (candles.length < 15) {
    logger.warn(`[ExecutionEngine] Não foi possível calcular o ATR para SL/TP, poucos candles (${candles.length}).`);
    return;
  }

  const sortedCandles = candles.slice().reverse();
  const atrValues = ATR(sortedCandles, 14); // <<< CORRIGIDO
  const lastAtrValue = atrValues[atrValues.length - 1];
  const atrValue = typeof lastAtrValue === 'number' && isFinite(lastAtrValue) ? lastAtrValue : 100;

  const slMultiplier = parseFloat(process.env.SL_ATR_MULTIPLIER || "1.5");
  const tpRatio = parseFloat(process.env.TP_RR_RATIO || "2.0");

  const slPoints = Math.round(atrValue * slMultiplier);
  const tpPoints = Math.round(slPoints * tpRatio);

  const order = {
    id: `signal-${signal.id}-${Date.now()}`,
    symbol: instrument.symbol,
    side: signal.side as 'BUY' | 'SELL',
    timeframe: candle.timeframe,
    volume: 1,
    slPoints,
    tpPoints,
    comment: `SignalID: ${signal.id}`
  };

  logger.info(`Decidido executar ordem para o sinal ${signal.id}. Enviando para a fila.`);
  enqueueOrder(order);
};

export const initExecutionEngine = () => {
  eventBus.on(EVENTS.SIGNAL_GENERATED, handleSignal);

  eventBus.on(EVENTS.TRADE_EXECUTED, (data: { event: string }) => {
    if (data.event === 'closed') {
      isPositionOpen = false;
      logger.info('Posição foi fechada. Motor de execução está livre para novas entradas.');
    }
  });

  logger.info('✅ Motor de Execução inicializado e aguardando sinais.');
};