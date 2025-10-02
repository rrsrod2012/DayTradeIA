// ===============================
// FILE: backend_new/src/modules/strategy/maintenance.tasks.ts
// ===============================
import { prisma } from '../../core/prisma';
import { loadCandlesAnyTF } from '../data-import/lib/aggregation';
import { ema, ADX } from './indicators';
import { logger } from '../../core/logger';
import { Instrument } from '@prisma/client';

type TFKey = "M1" | "M5" | "M15" | "M30" | "H1";

// Função para garantir que um candle exista para um determinado TF
async function upsertTfCandle(
  instrumentId: number,
  tf: TFKey,
  row: { time: Date; open: number; high: number; low: number; close: number; volume: number | null; }
): Promise<number | null> {
  const found = await prisma.candle.findFirst({
    where: { instrumentId, time: row.time, timeframe: tf },
    select: { id: true },
  });

  if (found) {
    await prisma.candle.update({
      where: { id: found.id },
      data: { open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume },
    });
    return found.id;
  }

  const created = await prisma.candle.create({
    data: {
      instrumentId, timeframe: tf, time: row.time,
      open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume,
    },
    select: { id: true },
  });
  return created?.id ?? null;
}

/**
 * Recria sinais e trades para um instrumento e timeframe, similar ao `confirmedSignalsWorker` original.
 */
export async function backfillSignalsAndTrades(instrument: Instrument, timeframe: TFKey) {
  const candles = await loadCandlesAnyTF(instrument.symbol, timeframe);
  if (candles.length < 22) {
    logger.warn(`[Maintenance] Dados insuficientes para backfill de ${instrument.symbol} ${timeframe}.`);
    return { createdSignals: 0, createdTrades: 0 };
  }

  const closes = candles.map((c) => c.close);
  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  const adx = ADX(candles.map(c => ({ high: c.high, low: c.low, close: c.close })), 14);

  let createdSignals = 0;
  let createdTrades = 0;
  let openTrade: any = null;

  for (let i = 1; i < candles.length; i++) {
    const prevDiff = (e9[i - 1] ?? 0) - (e21[i - 1] ?? 0);
    const diff = (e9[i] ?? 0) - (e21[i] ?? 0);

    let side: "BUY" | "SELL" | null = null;
    if (prevDiff <= 0 && diff > 0) side = "BUY";
    else if (prevDiff >= 0 && diff < 0) side = "SELL";
    else continue;

    const candleData = candles[i];
    const candleId = await upsertTfCandle(instrument.id, timeframe, candleData);
    if (!candleId) continue;

    const reason = side === "BUY"
        ? `EMA9 cross above EMA21 • ADX14=${(adx[i] ?? 0).toFixed(1)}`
        : `EMA9 cross below EMA21 • ADX14=${(adx[i] ?? 0).toFixed(1)}`;

    const signal = await prisma.signal.upsert({
      where: { candleId_signalType_side: { candleId, signalType: "EMA_CROSS", side } },
      update: { score: Math.abs(diff), reason },
      create: { candleId, signalType: "EMA_CROSS", side, score: Math.abs(diff), reason },
    });
    createdSignals++;

    if (!openTrade) {
      openTrade = { entrySignal: signal, entryPrice: candleData.close };
    } else if (openTrade.entrySignal.side !== side) {
      const pnlPoints = side === "SELL" // Sinal de fechamento de uma compra
          ? candleData.close - openTrade.entryPrice
          : openTrade.entryPrice - candleData.close;
      
      await prisma.trade.create({
        data: {
          instrumentId: instrument.id,
          timeframe: timeframe,
          entrySignalId: openTrade.entrySignal.id,
          exitSignalId: signal.id,
          qty: 1,
          entryPrice: openTrade.entryPrice,
          exitPrice: candleData.close,
          pnlPoints,
        },
      });
      createdTrades++;
      openTrade = null; // Fecha o trade e prepara para um novo
    }
  }
  return { createdSignals, createdTrades };
}

/**
 * Processa um intervalo de tempo para gerar trades a partir de sinais existentes.
 */
export async function processImportedRange(params: { symbol?: string, timeframe?: string, from?: Date, to?: Date }) {
    const { symbol, timeframe, from, to } = params;
    // Lógica simplificada: para este escopo, a função acima (backfill) é mais completa.
    // Manteremos este stub para compatibilidade com a rota, mas a lógica principal está no backfill.
    if (!symbol || !timeframe) {
        throw new Error("Símbolo e timeframe são necessários para processar o intervalo.");
    }
    const instrument = await prisma.instrument.findUnique({ where: { symbol } });
    if (!instrument) throw new Error(`Instrumento ${symbol} não encontrado.`);
    
    // Limpa trades antigos no intervalo para evitar duplicatas
    await prisma.trade.deleteMany({
        where: {
            instrumentId: instrument.id,
            timeframe: timeframe as TFKey,
            entrySignal: {
                candle: {
                    time: {
                        gte: from,
                        lte: to,
                    }
                }
            }
        }
    });

    const result = await backfillSignalsAndTrades(instrument, timeframe as TFKey);
    return {
        message: "Intervalo reprocessado com sucesso usando a lógica de backfill.",
        ...result,
    };
}