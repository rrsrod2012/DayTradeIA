import { logger } from '../../core/logger';
import { startAutoTrainer } from './autoTrainer.engine';

export const initAiTrainer = () => {
    const AUTO_START = process.env.AUTO_TRAINER_ENABLED === 'true' || process.env.AUTO_TRAINER_ENABLED === '1';

    if (AUTO_START) {
        logger.info('[AiTrainer] Auto-treinamento habilitado. Iniciando automaticamente...');
        startAutoTrainer();
    } else {
        logger.info('[AiTrainer] Auto-treinamento desabilitado. Nenhum worker iniciado.');
    }
};