// ===============================
// FILE: backend_new/src/modules/ai-trainer/autoTrainer.engine.ts
// ===============================
import { logger } from '../../core/logger';
import { prisma } from '../../core/prisma';
import fetch from 'node-fetch';

let isRunning = false;
let status = 'stopped';
let lastRun: Date | null = null;
let intervalId: NodeJS.Timeout | null = null;

// URL do serviço de IA, onde o treinamento será executado.
const AI_NODE_URL = process.env.AI_NODE_URL || 'http://127.0.0.1:5001';

/**
 * <<< LÓGICA DE TREINAMENTO REAL IMPLEMENTADA >>>
 * Executa o ciclo completo de treinamento da IA.
 */
export const runTrainingCycle = async () => {
    // Previne execuções simultâneas
    if (status === 'running') {
        logger.warn('[AutoTrainer] Tentativa de iniciar um novo ciclo de treinamento enquanto um já está em execução.');
        return { ok: false, message: 'Training already in progress.' };
    }

    status = 'running';
    logger.info('🤖 [AutoTrainer] Iniciando novo ciclo de treinamento...');

    try {
        // 1. Obter dados recentes do banco de dados.
        // Buscamos um número significativo de candles para garantir um bom volume de dados para o treino.
        logger.info('[AutoTrainer] Buscando os últimos 5000 candles para o treinamento...');
        const candles = await prisma.candle.findMany({
            orderBy: { time: 'desc' },
            take: 5000,
            include: { instrument: true },
        });

        if (candles.length < 100) {
            throw new Error(`Dados insuficientes para o treinamento (apenas ${candles.length} candles encontrados).`);
        }

        // Garante a ordem cronológica para o treinamento
        const trainingData = candles.reverse().map(c => ({
            time: c.time.toISOString(),
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.tickVolume,
        }));

        logger.info(`[AutoTrainer] Enviando ${trainingData.length} candles para o AI-Node em ${AI_NODE_URL}/train`);

        // 2. Chamar o serviço de IA para treinar o modelo.
        const response = await fetch(`${AI_NODE_URL}/train`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ candles: trainingData }),
            timeout: 300000 // Timeout de 5 minutos para o treinamento
        });

        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`AI-Node respondeu com status ${response.status}: ${errorBody}`);
        }

        const result = await response.json() as any;
        logger.info('[AutoTrainer] Resposta do AI-Node recebida.', result);

        lastRun = new Date();
        status = 'idle';
        logger.info(`✅ [AutoTrainer] Ciclo de treinamento concluído com sucesso. Próximo em 1 hora.`);
        return { ok: true, details: result };

    } catch (error: any) {
        status = 'error';
        logger.error('[AutoTrainer] Falha durante o ciclo de treinamento.', { error: error.message, stack: error.stack });
        // Retorna o erro para que a rota da API possa capturá-lo
        throw error;
    }
};

export const startAutoTrainer = () => {
    if (isRunning) {
        logger.warn('[AutoTrainer] O treinamento automático já está em execução.');
        return { ok: false, message: 'Already running' };
    }
    isRunning = true;
    status = 'idle';

    // Executa imediatamente no início e depois a cada hora
    runTrainingCycle().catch(() => {
        // O erro já é logado dentro da função, aqui apenas evitamos uma quebra de promessa não tratada.
    });

    intervalId = setInterval(() => {
        runTrainingCycle().catch(() => { });
    }, 3600 * 1000); // 1 hora

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