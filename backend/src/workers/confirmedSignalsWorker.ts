/**
 * Worker responsável por gerar "sinais confirmados" a partir de candles já persistidos.
 * - Estratégia: cruzamento de EMA curta vs. EMA longa (confirmado no fechamento da vela).
 * - Varredura periódica, com janela configurável.
 * - Evita duplicidade verificando se já existe um sinal para aquele candle/side/signalType.
 * - Agora persiste também o campo obrigatório `score` (Float).
 */

import { DateTime } from "luxon";
import { prisma } from "../prisma";
import logger from "../logger";

// ====================== Config ======================
const ZONE = "America/Sao_Paulo";
const SCAN_INTERVAL_MS = Number(process.env.SIGNALS_SCAN_INTERVAL_MS || 10_000);
const EMA_FAST = Number(process.env.SIGNALS_EMA_FAST || 9);
const EMA_SLOW = Number(process.env.SIGNALS_EMA_SLOW || 21);
const SCAN_LOOKBACK = Number(process.env.SIGNALS_LOOKBACK || 300); // nº de candles por timeframe/símbolo
const MAX_BATCH_CREATE = Number(process.env.SIGNALS_MAX_BATCH_CREATE || 200); // proteção

// Se vierem listas por env, limitam o escopo do scan
type Instrument = { id: string | number; symbol: string };

const SYMBOLS: string[] = (process.env.SIGNALS_SYMBOLS || "")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

const TIMEFRAMES: string[] = (process.env.SIGNALS_TIMEFRAMES || "")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

let timer: NodeJS.Timeout | null = null;
let booted = false;

// ====================== Tipos simples ======================
type Side = "BUY" | "SELL";

interface CandleLite {
  id: string | number;
  time: Date;
  close: number;
}

interface CrossEvent {
  candleId: string | number;
  time: Date;
  side: Side;
  score: number; // intensidade relativa do cruzamento
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ====================== Utilitários ======================
function toLocalDateStr(d: Date) {
  return DateTime.fromJSDate(d).setZone(ZONE).toFormat("yyyy-LL-dd");
}

function calcEMA(values: number[], period: number): number[] {
  if (period <= 1) return values.slice();
  const k = 2 / (period + 1);
  const out: number[] = [];
  let emaPrev = values[0] ?? 0;
  out.push(emaPrev);
  for (let i = 1; i < values.length; i++) {
    const ema = values[i] * k + emaPrev * (1 - k);
    out.push(ema);
    emaPrev = ema;
  }
  return out;
}

async function discoverInstruments(): Promise<Instrument[]> {
  if (SYMBOLS.length > 0) {
    const rows = await prisma.instrument.findMany({
      where: { symbol: { in: SYMBOLS } },
      select: { id: true, symbol: true },
    });
    return rows as any;
  }
  const rows = await prisma.instrument.findMany({
    select: { id: true, symbol: true },
  });
  return rows as any;
}

async function discoverTimeframes(): Promise<string[]> {
  if (TIMEFRAMES.length > 0) return TIMEFRAMES;
  const rows = await prisma.candle.groupBy({
    by: ["timeframe"],
  });
  return rows.map((r) => r.timeframe);
}

async function loadCandlesForInstrument(
  instrumentId: string | number,
  timeframe: string,
  lookback = SCAN_LOOKBACK
): Promise<CandleLite[]> {
  const rows = await prisma.candle.findMany({
    where: { instrumentId: instrumentId as any, timeframe },
    // >>> FIX: buscar os mais recentes (desc) e depois reordenar para asc
    orderBy: { time: "desc" },
    take: lookback > 0 ? lookback : undefined,
    select: {
      id: true,
      time: true,
      close: true,
    },
  });
  // processar em ordem cronológica
  return (rows as any).reverse();
}

function generateSignalsFor(candles: CandleLite[]): CrossEvent[] {
  if (candles.length === 0) return [];
  const closes = candles.map((c) => c.close);
  const emaF = calcEMA(closes, EMA_FAST);
  const emaS = calcEMA(closes, EMA_SLOW);

  const out: CrossEvent[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prevDiff = (emaF[i - 1] ?? 0) - (emaS[i - 1] ?? 0);
    const currDiff = (emaF[i] ?? 0) - (emaS[i] ?? 0);

    // variação de inclinação no cruzamento
    const delta = currDiff - prevDiff;
    const close = closes[i] || 1;
    // normaliza pelo preço para evitar distorções de escala
    let score = Math.abs(delta) / Math.max(Math.abs(close), 1e-9);
    // escala básica para números pequenos (opcional)
    score = Number((score * 100).toFixed(6));
    if (!isFinite(score) || isNaN(score)) score = 0.000001;

    // Cruzou de baixo para cima => BUY
    if (prevDiff <= 0 && currDiff > 0) {
      out.push({
        candleId: candles[i].id,
        time: candles[i].time,
        side: "BUY",
        score,
      });
    }
    // Cruzou de cima para baixo => SELL
    if (prevDiff >= 0 && currDiff < 0) {
      out.push({
        candleId: candles[i].id,
        time: candles[i].time,
        side: "SELL",
        score,
      });
    }
  }
  return out;
}

async function persistSignals(
  instrumentId: string | number,
  timeframe: string,
  events: CrossEvent[]
): Promise<number> {
  if (events.length === 0) return 0;

  // upserts simples por (candleId, side, signalType)
  // Evita duplicatas caso o worker reescaneie janelas sobrepostas
  let created = 0;
  for (const batch of chunk(
    events,
    Math.max(1, Math.min(MAX_BATCH_CREATE, 200))
  )) {
    // Prisma <= 5 pode não suportar createMany+skipDuplicates com compostos,
    // então fazemos upsert item a item para garantir unicidade.
    for (const ev of batch) {
      try {
        await prisma.signal.upsert({
          where: {
            // precisa existir uma unique composta no schema:
            // @@unique([candleId, signalType, side])
            candleId_signalType_side: {
              candleId: ev.candleId as any,
              signalType: "EMA_CROSS",
              side: ev.side,
            },
          },
          update: {
            time: ev.time,
            score: ev.score,
          },
          create: {
            candleId: ev.candleId as any,
            time: ev.time,
            signalType: "EMA_CROSS",
            side: ev.side,
            score: ev.score,
          },
        });
        created++;
      } catch (err: any) {
        logger.warn(
          `[SignalsWorker] upsert falhou em candle=${ev.candleId} side=${
            ev.side
          } tf=${timeframe} ${toLocalDateStr(ev.time)} - erro=${
            err?.code || err?.message || err
          }`
        );
      }
    }
  }
  return created;
}

async function runOnce(): Promise<void> {
  const instruments = await discoverInstruments();
  const tfs = await discoverTimeframes();

  if (instruments.length === 0 || tfs.length === 0) {
    logger.warn(
      "[SignalsWorker] Sem instrumentos ou timeframes para processar; aguardando dados…"
    );
    return;
  }

  for (const inst of instruments) {
    for (const tf of tfs) {
      try {
        const candles = await loadCandlesForInstrument(
          inst.id,
          tf,
          SCAN_LOOKBACK
        );
        const events = generateSignalsFor(candles);
        const created = await persistSignals(inst.id, tf, events);
        if (created > 0) {
          const first = events[0]?.time;
          const last = events[events.length - 1]?.time;
          logger.info(
            `[SignalsWorker] ${inst.symbol}/${tf}: criados ${created} sinais (${
              first ? toLocalDateStr(first) : "?"
            } → ${last ? toLocalDateStr(last) : "?"})`
          );
        }
      } catch (err: any) {
        logger.error(
          `[SignalsWorker] Falha em ${inst.symbol}/${tf}: ${
            err?.message || err
          }`
        );
      }
    }
  }
}

export function bootConfirmedSignalsWorker() {
  if (booted) return;
  booted = true;

  // primeira passada logo ao subir
  runOnce().catch((e) =>
    logger.error("[SignalsWorker] runOnce inicial falhou", e)
  );

  // agenda recorrência
  timer = setInterval(() => {
    runOnce().catch((e) => logger.error("[SignalsWorker] runOnce falhou", e));
  }, SCAN_INTERVAL_MS);

  logger.info(
    `[SignalsWorker] Iniciado (intervalo=${SCAN_INTERVAL_MS}ms, EMA=${EMA_FAST}/${EMA_SLOW}, lookback=${SCAN_LOOKBACK})`
  );
}

export function stopConfirmedSignalsWorker() {
  if (timer) {
    clearInterval(timer);
    timer = null;
    booted = false;
    logger.info("[SignalsWorker] Parado.");
  }
}
