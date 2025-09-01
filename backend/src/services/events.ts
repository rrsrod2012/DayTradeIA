import { EventEmitter } from "events";

// Barramento de eventos único da aplicação
export const bus = new EventEmitter();
bus.setMaxListeners(50);

// Eventos emitidos atualmente:
// - 'candle:upsert' -> payloads:
//   a) { symbol, timeframe, candle: { time, o, h, l, c, v } }  // granular por candle
//   b) { symbol, timeframe, count, reason }                    // resumo por import/change
