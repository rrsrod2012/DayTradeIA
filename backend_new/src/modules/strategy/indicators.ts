<<<<<<< HEAD
// ===============================
// FILE: backend_new/src/modules/strategy/indicators.ts
// ===============================
import { DateTime } from 'luxon';

/**
 * Calcula a Média Móvel Exponencial (EMA) para uma série de valores.
 */
export function ema(values: number[], period: number): (number | null)[] {
    const out: (number | null)[] = [];
    const k = 2 / (period + 1);
    let e: number | null = null;
    for (let i = 0; i < values.length; i++) {
        const v = Number(values[i]) || 0;
        e = e == null ? v : v * k + e * (1 - k);
        out.push(e);
    }
    return out;
}

/**
 * Calcula o Average True Range (ATR) para uma série de candles.
 */
export function ATR(
  candles: { high: number; low: number; close: number }[],
  period = 14
): (number | null)[] {
  const tr: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    const prev = i > 0 ? candles[i - 1].close : candles[i].close;
    const high = candles[i].high;
    const low = candles[i].low;
    const v = Math.max(
      high - low,
      Math.abs(high - prev),
      Math.abs(low - prev)
    );
    tr.push(v);
  }
  // RMA simples p/ aproximar ATR
  const out: (number | null)[] = [];
  const k = 1 / Math.max(1, period);
  let rma: number | null = null;
  for (let i = 0; i < tr.length; i++) {
    const v = tr[i];
    rma = rma == null ? v : (rma as number) * (1 - k) + v * k;
    out.push(rma);
=======
import fetch from 'node-fetch';
import { prisma } from '../../core/prisma';
import { loadCandlesAnyTF } from '../data-import/lib/aggregation';
import { logger } from '../../core/logger';
import { ema, ADX } from '../strategy/indicators';

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
>>>>>>> 366c209d194f3a00ff5fc64ff7310018020f914f
  }
}

<<<<<<< HEAD

/**
 * Calcula o Average Directional Index (ADX) para uma série de candles.
 */
export function ADX(
    candles: { high: number, low: number, close: number }[],
    period = 14
): (number | null)[] {
    const len = candles.length;
    const plusDM: number[] = [];
    const minusDM: number[] = [];
    const tr: number[] = [];

    for (let i = 0; i < len; i++) {
        if (i === 0) {
            plusDM.push(0);
            minusDM.push(0);
            tr.push(candles[0].high - candles[0].low);
            continue;
        }
        const upMove = candles[i].high - candles[i - 1].high;
        const downMove = candles[i - 1].low - candles[i].low;
        plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
        minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);

        const _tr = Math.max(
            candles[i].high - candles[i].low,
            Math.abs(candles[i].high - candles[i - 1].close),
            Math.abs(candles[i].low - candles[i - 1].close)
        );
        tr.push(_tr);
    }

    const rma = (arr: number[]): number[] => {
        const out: number[] = [];
        const k = 1 / period;
        let v: number | null = null;
        for (let i = 0; i < arr.length; i++) {
            v = v == null ? arr[i] : (v as number) * (1 - k) + arr[i] * k;
            out.push(v as number);
        }
        return out;
    };

    const trRMA = rma(tr);
    const plusDMRMA = rma(plusDM);
    const minusDMRMA = rma(minusDM);

    const dx: (number | null)[] = [];
    for (let i = 0; i < len; i++) {
        const trv = trRMA[i] || 0;
        const pdi = trv > 0 ? (plusDMRMA[i] / trv) * 100 : 0;
        const mdi = trv > 0 ? (minusDMRMA[i] / trv) * 100 : 0;
        const denom = pdi + mdi;
        dx.push(denom > 0 ? (Math.abs(pdi - mdi) / denom) * 100 : null);
    }

    const adx: (number | null)[] = [];
    const k = 1 / period;
    let val: number | null = null;
    for (let i = 0; i < len; i++) {
        const dxi = dx[i];
        if (dxi == null) {
            adx.push(val);
            continue;
        }
        val = val == null ? dxi : (val as number) * (1 - k) + dxi * k;
        adx.push(val);
    }
    return adx;
}

/**
 * Calcula o Volume Weighted Average Price (VWAP) para uma série de candles, reiniciando por sessão (dia).
 */
export function VWAP(candles: { time: Date; high: number; low: number; close: number; volume?: number | null }[]): (number | null)[] {
    const ZONE_BR = "America/Sao_Paulo";
    const vwap: (number | null)[] = [];
    if (!candles.length) return vwap;
    
    let accPV = 0, accVol = 0;
    let dLocal = DateTime.fromJSDate(candles[0].time).setZone(ZONE_BR).toFormat("yyyy-LL-dd");

    for (let i = 0; i < candles.length; i++) {
        const c = candles[i];
        const dl = DateTime.fromJSDate(c.time).setZone(ZONE_BR).toFormat("yyyy-LL-dd");
        if (dl !== dLocal) {
            accPV = 0;
            accVol = 0;
            dLocal = dl;
        }
        const typical = (c.high + c.low + c.close) / 3;
        const vol = Number(c.volume ?? 1);
        accPV += typical * vol;
        accVol += vol;
        vwap.push(accVol > 0 ? accPV / accVol : null);
    }
    return vwap;
}
=======
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
>>>>>>> 366c209d194f3a00ff5fc64ff7310018020f914f
