// ===============================
// FILE: backend_new/src/index.ts
// ===============================
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { logger } from './core/logger';
import { initApi } from './modules/api/api';
// <<< ALTERAÇÃO: Importa o router e a função de init correta >>>
import { initBrokerageBridge, brokerageRoutes } from './modules/execution/BrokerageBridge';
import { initCsvWatcher } from './modules/data-import/csvWatcher';
import { initStrategyEngine } from './modules/strategy/StrategyEngine';
import { initExecutionEngine } from './modules/execution/ExecutionEngine';
import { initNotificationService } from './modules/notifications/NotificationService';
import { initWebSocket } from './core/ws';
// <<< CORREÇÃO: Importa a função correta >>>
import { startAutoTrainer } from './modules/ai-trainer';
import { prisma } from './core/prisma';

dotenv.config();

const runDbDiagnostics = async () => {
  try {
    await new Promise(resolve => setTimeout(resolve, 3000));
    const candleCount = await prisma.candle.count();
    logger.info(`[DIAGNÓSTICO] Verificação da base de dados...`);
    logger.info(`[DIAGNÓSTICO] Total de candles na base de dados: ${candleCount}`);
    if (candleCount > 0) {
      const firstCandle = await prisma.candle.findFirst({ orderBy: { time: 'asc' } });
      const lastCandle = await prisma.candle.findFirst({ orderBy: { time: 'desc' } });
      logger.info(`[DIAGNÓSTICO] Primeiro candle em: ${firstCandle?.time.toISOString()}`);
      logger.info(`[DIAGNÓSTICO] Último candle em:   ${lastCandle?.time.toISOString()}`);
    } else {
      logger.warn(`[DIAGNÓSTICO] A base de dados de candles está vazia.`);
    }
  } catch (e: any) {
    logger.error(`[DIAGNÓSTICO] Erro ao verificar a base de dados:`, e.message);
  }
};

const main = async () => {
  const PORT = process.env.PORT || 3002;
  const app = express();
  app.use(cors());
  app.use(express.json());
  const server = createServer(app);

  // 1. Inicializa os módulos
  initApi(app);
  initBrokerageBridge(); // Apenas para logar
  initCsvWatcher();
  initStrategyEngine();
  initExecutionEngine();
  initNotificationService();
  initWebSocket(server);
  startAutoTrainer(); // <<< CORREÇÃO: Usa a função correta

  // 2. Regista as rotas dos módulos
  app.use('/', brokerageRoutes); // <<< ALTERAÇÃO: Usa o router

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  server.listen(PORT, () => {
    logger.info(`🚀 Servidor principal a rodar na porta ${PORT}`);
    logger.info('✅ Módulos inicializados: API, Broker, CSVWatcher, Strategy, Execution, Notifications, WebSocket, AiTrainer');
    runDbDiagnostics();
  });
};

main().catch((error) => {
  logger.error('❌ Falha ao iniciar o servidor principal', { error });
  process.exit(1);
});