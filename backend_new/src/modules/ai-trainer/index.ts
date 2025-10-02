// ===============================
// FILE: backend_new/src/modules/ai-trainer/index.ts
// ===============================
import { logger } from '../../core/logger';
import { startAutoTrainer as start, stopAutoTrainer as stop, getAutoTrainerStatus as status } from './autoTrainer.engine';

export const initAiTrainer = () => {
  const autoStart = process.env.AUTO_TRAINER_START_ON_BOOT === 'true';
  if (autoStart) {
    logger.info('🚀 [AiTrainer] Iniciando o serviço de auto-treinamento no boot...');
    start();
  } else {
    logger.info('ℹ️ [AiTrainer] Auto-treinamento no boot desabilitado. Inicie manualmente via API, se necessário.');
  }
};

// Exporta as funções para serem usadas pelas rotas da API
export const startAutoTrainer = start;
export const stopAutoTrainer = stop;
export const statusAutoTrainer = status;