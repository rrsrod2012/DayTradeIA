// ===============================
// FILE: backend_new/src/modules/ai-trainer/autoTrainer.engine.ts
// ===============================
import { logger } from '../../core/logger';
<<<<<<< HEAD
=======
import { ema, ADX } from '../strategy/indicators';
>>>>>>> 366c209d194f3a00ff5fc64ff7310018020f914f

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

<<<<<<< HEAD
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
=======
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
>>>>>>> 366c209d194f3a00ff5fc64ff7310018020f914f
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