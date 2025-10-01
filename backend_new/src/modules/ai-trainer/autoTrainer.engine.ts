import fetch from 'node-fetch';
import { prisma } from '../../core/prisma';
import { loadCandlesAnyTF } from '../data-import/lib/aggregation';
import { logger } from '../../core/logger';
import { ema, ADX } from '../strategy/lib/indicators';

// Variáveis de estado para controlar o worker
let isRunning = false;
let lastRun: Date | null = null;
let currentStatus: string = "stopped";
let intervalId: NodeJS.Timeout | null = null;

const toNum = (v: any, def = 0): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
};

// Função para fazer a requisição ao serviço de IA
async function httpPostJSON<T = any>(url: string, body: any, timeoutMs = 5000): Promise<T> {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const resp = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            // @ts-ignore
            signal: ctrl.signal,
        });
        const txt = await resp.text();
        const data = txt ? JSON.parse(txt) : null;
        if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
        return data as T;
    } finally {
        clearTimeout(to);
    }
}

// Lógica principal do treinamento
async function runTrainingCycle() {
    if (!isRunning) return;
    currentStatus = "running";
    logger.info('[AutoTrainer] Iniciando ciclo de treinamento...');
    
    const MICRO_MODEL_URL = process.env.MICRO_MODEL_URL || "";
    if (!MICRO_MODEL_URL) {
        logger.warn('[AutoTrainer] MICRO_MODEL_URL não configurada. Ciclo de treinamento pulado.');
        currentStatus = "idle";
        return;
    }

    try {
        const symbol = process.env.STRATEGY_SYMBOL || 'WIN';
        const timeframe = process.env.STRATEGY_TIMEFRAME || 'M5';

        // Coleta de dados e preparação de features (simplificado, pode ser expandido)
        const candles = await loadCandlesAnyTF(symbol, timeframe);
        if (candles.length < 100) {
            logger.warn('[AutoTrainer] Dados de candles insuficientes.');
            currentStatus = "idle";
            return;
        }

        const closes = candles.map(c => c.close);
        const features = closes.map((c, i) => ({
            close: c,
            ema9: ema(closes.slice(0, i + 1), 9).pop(),
            ema21: ema(closes.slice(0, i + 1), 21).pop(),
        }));
        
        const run = await prisma.trainingRun.create({
            data: { status: 'STARTED', symbol, timeframe }
        });

        // Chamada para a API de treinamento do ai-node
        const trainingResult = await httpPostJSON(`${MICRO_MODEL_URL}/train`, { features });

        await prisma.trainingRun.update({
            where: { id: run.id },
            data: {
                status: 'COMPLETED',
                finishedAt: new Date(),
                loss: toNum(trainingResult?.loss),
                accuracy: toNum(trainingResult?.accuracy),
                notes: `Treinamento concluído com ${features.length} exemplos.`,
            }
        });

        logger.info('[AutoTrainer] Ciclo de treinamento concluído com sucesso.', trainingResult);

    } catch (error: any) {
        logger.error('[AutoTrainer] Erro durante o ciclo de treinamento', { error: error?.message });
        currentStatus = "error";
    } finally {
        lastRun = new Date();
        if (isRunning) currentStatus = "idle";
    }
}


// Funções de controle do worker
export const startAutoTrainer = () => {
    if (isRunning) return { ok: false, message: 'AutoTrainer já está em execução.' };
    
    isRunning = true;
    currentStatus = "starting";
    logger.info('[AutoTrainer] Serviço de Auto-Treinamento iniciado.');

    // Roda a cada 1 hora, por exemplo. Ajuste conforme necessário.
    const intervalMinutes = 60;
    runTrainingCycle(); // Roda imediatamente ao iniciar
    intervalId = setInterval(runTrainingCycle, intervalMinutes * 60 * 1000);
    
    return { ok: true, message: 'AutoTrainer iniciado.' };
};

export const stopAutoTrainer = () => {
    if (!isRunning) return { ok: false, message: 'AutoTrainer não está em execução.' };

    isRunning = false;
    currentStatus = "stopped";
    if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
    }
    logger.info('[AutoTrainer] Serviço de Auto-Treinamento parado.');
    return { ok: true, message: 'AutoTrainer parado.' };
};

export const statusAutoTrainer = () => {
    return {
        running: isRunning,
        status: currentStatus,
        lastRun: lastRun?.toISOString() ?? null,
    };
};