/* eslint-disable no-console */
import { bus } from "./events";
import { generateEmaCrossSignalsRange } from "../workers/confirmedSignalsWorker";
import { trainRangeOnce } from "../workers/autoTrainer";
import logger from "../logger";

/**
 * Pipeline pós-import:
 *  1) Gera/atualiza sinais confirmados no intervalo importado (EMA_CROSS).
 *  2) Treina o modelo com os sinais desse mesmo intervalo.
 */
export function bootPipeline() {
  try {
    bus.on("import:done", async (p: any) => {
      try {
        const { instrumentId, timeframe, firstTime, lastTime } = p || {};
        if (!instrumentId || !timeframe) return;

        logger?.info?.(
          `[pipeline] import done; gerando sinais (instrumentId=${instrumentId}, tf=${timeframe}, ${firstTime}..${lastTime})`
        );
        const r = await generateEmaCrossSignalsRange(
          Number(instrumentId),
          String(timeframe),
          firstTime || null,
          lastTime || null
        );
        logger?.info?.(
          `[pipeline] sinais confirmados: +${r.created} / ~${r.updated} atualizados`
        );

        const t = await trainRangeOnce(
          Number(instrumentId),
          String(timeframe),
          firstTime || null,
          lastTime || null
        );
        logger?.info?.(`[pipeline] treino concluído: ${t.trained} exemplos`);
      } catch (e: any) {
        logger?.error?.(`[pipeline] erro pós-import: ${e?.message || e}`);
      }
    });
  } catch {
    // não derruba o servidor se o bus não estiver disponível
  }
}
