// ===============================
// FILE: backend_new/src/index.ts
// ===============================
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
import { initAiTrainer } from './modules/ai-trainer';
import { prisma } from './core/prisma'; // <<< NOVA IMPORTAÇÃO

// Carrega variáveis de ambiente do .env
dotenv.config();

// <<< NOVO BLOCO DE DIAGNÓSTICO >>>
const runDbDiagnostics = async () => {
  try {
    await new Promise(resolve => setTimeout(resolve, 3000)); // Espera 3s para dar tempo à importação inicial

    const candleCount = await prisma.candle.count();
    logger.info(`[DIAGNÓSTICO] Verificação da base de dados...`);
    logger.info(`[DIAGNÓSTICO] Total de candles na base de dados: ${candleCount}`);

    if (candleCount > 0) {
      const firstCandle = await prisma.candle.findFirst({ orderBy: { time: 'asc' } });
      const lastCandle = await prisma.candle.findFirst({ orderBy: { time: 'desc' } });
      logger.info(`[DIAGNÓSTICO] Primeiro candle em: ${firstCandle?.time.toISOString()}`);
      logger.info(`[DIAGNÓSTICO] Último candle em:   ${lastCandle?.time.toISOString()}`);
    } else {
      logger.warn(`[DIAGNÓSTICO] A base de dados de candles está vazia. Verifique se o ficheiro CSV está a ser importado corretamente.`);
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

  // 1. Inicializa os módulos principais
  initApi(app);
  initBrokerageBridge(app);
  initCsvWatcher();
  initStrategyEngine();
  initExecutionEngine();
  initNotificationService();
  initWebSocket(server);
  initAiTrainer();

  // Rota de Health Check
  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  server.listen(PORT, () => {
    logger.info(`🚀 Servidor principal a rodar na porta ${PORT}`);
    logger.info('✅ Módulos inicializados: API, Broker, CSVWatcher, Strategy, Execution, Notifications, WebSocket, AiTrainer');

    // Executa o diagnóstico após o arranque
    runDbDiagnostics();
  });
};

main().catch((error) => {
  logger.error('❌ Falha ao iniciar o servidor principal', error);
  process.exit(1);
});