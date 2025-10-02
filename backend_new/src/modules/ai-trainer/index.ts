// ===============================
// FILE: backend_new/src/modules/ai-trainer/index.ts
// ===============================
import { startAutoTrainer, stopAutoTrainer, getAutoTrainerStatus, runTrainingCycle } from './autoTrainer.engine';

// Para uso na API, renomeando para evitar conflito de nomes
export const statusAutoTrainer = getAutoTrainerStatus;

// Exporta as funções para serem usadas nas rotas da API
export { startAutoTrainer, stopAutoTrainer, runTrainingCycle };