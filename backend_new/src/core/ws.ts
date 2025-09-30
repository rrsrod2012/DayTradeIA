import { Server } from 'http';
import WebSocket from 'ws';
import { logger } from './logger';
import { eventBus, EVENTS } from './eventBus';

export const initWebSocket = (server: Server) => {
  const wss = new WebSocket.Server({ server });

  wss.on('connection', (ws) => {
    logger.info('Cliente WebSocket conectado.');

    ws.on('close', () => {
      logger.info('Cliente WebSocket desconectado.');
    });
  });

  const broadcast = (data: object) => {
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(data));
      }
    });
  };

  // Repassa eventos do sistema para o frontend via WebSocket
  eventBus.on(EVENTS.SIGNAL_GENERATED, (payload) => broadcast({ type: 'NEW_SIGNAL', payload }));
  eventBus.on(EVENTS.TRADE_EXECUTED, (payload) => broadcast({ type: 'TRADE_UPDATE', payload }));
  eventBus.on(EVENTS.DATA_INVALIDATED, (payload) => broadcast({ type: 'DATA_INVALIDATED', payload }));


  logger.info('✅ Servidor WebSocket inicializado.');
};