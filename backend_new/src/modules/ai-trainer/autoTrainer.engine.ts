// ===============================
// FILE: backend_new/src/modules/ai-trainer/autoTrainer.engine.ts
// ===============================
import { logger } from '../../core/logger';

let isRunning = false;
let status = 'stopped';
let lastRun: Date | null = null;
let intervalId: NodeJS.Timeout | null = null;

const runTrainingCycle = async () => {
    if (!isRunning) return;
    status = 'running';
    logger.info('🤖 [AutoTrainer] Iniciando novo ciclo de treinamento...');

    // Aqui entraria a lógica real de treinamento:
    // 1. Obter dados recentes do banco.
    // 2. Preparar os dados (features, labels).
    // 3. Chamar o serviço de IA para treinar o modelo.
    // 4. Salvar o modelo ou atualizar parâmetros.
    await new Promise(resolve => setTimeout(resolve, 15000)); // Simula um ciclo de treino de 15s

    lastRun = new Date();
    status = 'idle';
    logger.info(`✅ [AutoTrainer] Ciclo de treinamento concluído. Próximo em 1 hora.`);
};

export const startAutoTrainer = () => {
    if (isRunning) {
        logger.warn('[AutoTrainer] O treinamento automático já está em execução.');
        return { ok: false, message: 'Already running' };
    }
    isRunning = true;
    status = 'idle';
    // Executa imediatamente e depois a cada hora
    runTrainingCycle();
    intervalId = setInterval(runTrainingCycle, 3600 * 1000); // 1 hora
    logger.info('▶️ [AutoTrainer] Serviço de treinamento automático INICIADO.');
    return { ok: true };
};

export const stopAutoTrainer = () => {
    if (!isRunning) {
        logger.warn('[AutoTrainer] O treinamento automático não estava em execução.');
        return { ok: false, message: 'Not running' };
    }
    isRunning = false;
    if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
    }
    status = 'stopped';
    logger.info('⏹️ [AutoTrainer] Serviço de treinamento automático PARADO.');
    return { ok: true };
};

export const getAutoTrainerStatus = () => {
    return {
        running: isRunning,
        status,
        lastRun: lastRun?.toISOString() || null,
    };
};