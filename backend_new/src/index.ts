import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { logger } from './core/logger';
import { initApi } from './modules/api/api';
import { initBrokerageBridge } from './modules/execution/BrokerageBridge';
import { initCsvWatcher } from './modules/data-import/csvWatcher';
import { initStrategyEngine } from './modules/strategy/StrategyEngine';
import { initExecutionEngine } from './modules/execution/ExecutionEngine';
import { initNotificationService } from './modules/notifications/NotificationService';
import { initWebSocket } from './core/ws';
import { initAiTrainer } from './modules/ai-trainer'; // Importa o inicializador

// Carrega variáveis de ambiente do .env
dotenv.config();

const main = async () => {
  const PORT = process.env.PORT || 3002;

  const app = express();
  app.use(cors());
  app.use(express.json());

  const server = createServer(app);

  // 1. Inicializa os módulos principais
  initApi(app);
  initBrokerageBridge(app);
  initCsvWatcher();
  initStrategyEngine();
  initExecutionEngine();
  initNotificationService();
  initWebSocket(server);
  initAiTrainer(); // Inicializa o módulo de IA

  // Rota de Health Check
  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  server.listen(PORT, () => {
    logger.info(`🚀 Servidor principal rodando na porta ${PORT}`);
    logger.info('✅ Módulos inicializados: API, Broker, CSVWatcher, Strategy, Execution, Notifications, WebSocket, AiTrainer');
  });
};

main().catch((error) => {
  logger.error('❌ Falha ao iniciar o servidor principal', error);
  process.exit(1);
});