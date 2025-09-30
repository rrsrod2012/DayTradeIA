import { EventEmitter } from 'events';

// Um barramento de eventos central para desacoplar os módulos
class EventBus extends EventEmitter {}

export const eventBus = new EventBus();

// Definição dos tipos de eventos para autocomplete e type safety
export const EVENTS = {
  NEW_CANDLE_DATA: 'new_candle_data', // Disparado quando novos candles são importados
  SIGNAL_GENERATED: 'signal_generated', // Disparado pelo motor de estratégia
  EXECUTE_TRADE: 'execute_trade',     // Disparado pelo motor de execução
  TRADE_EXECUTED: 'trade_executed',   // Disparado quando o MT5 confirma a execução
  DATA_INVALIDATED: 'data_invalidated' // Para notificar o frontend
};