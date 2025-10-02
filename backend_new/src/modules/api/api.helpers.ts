// ===============================
// FILE: backend_new/src/modules/api/api.helpers.ts
// ===============================
import { DateTime } from 'luxon';
import { logger } from '../../core/logger';

const APP_TIMEZONE = "America/Sao_Paulo";

/**
 * Normaliza um intervalo de datas vindo da API (strings 'from' e 'to'), 
 * interpretando-as no fuso horário de São Paulo para garantir que o filtro
 * corresponda corretamente ao dia de pregão.
 * @param fromRaw A data de início (string no formato 'YYYY-MM-DD').
 * @param toRaw A data de fim (string no formato 'YYYY-MM-DD').
 * @returns Um objeto com datas { gte, lte } prontas para a consulta no Prisma, ou undefined se nenhuma data for fornecida.
 */
export function normalizeApiDateRange(fromRaw: any, toRaw: any): { gte?: Date; lte?: Date } | undefined {
  if (!fromRaw && !toRaw) {
    return undefined;
  }

  // Usa a data 'from' ou 'to' se uma delas estiver faltando.
  const effectiveFrom = String(fromRaw || toRaw);
  const effectiveTo = String(toRaw || fromRaw);

  try {
    // Constrói a data de início como o primeiro momento do dia em São Paulo.
    const gte = DateTime.fromISO(effectiveFrom, { zone: APP_TIMEZONE })
      .startOf('day')
      .toJSDate();

    // Constrói a data de fim como o último momento do dia em São Paulo.
    const lte = DateTime.fromISO(effectiveTo, { zone: APP_TIMEZONE })
      .endOf('day')
      .toJSDate();

    logger.info('[API_HELPER] Intervalo de datas para a consulta', {
      from: effectiveFrom,
      to: effectiveTo,
      gte_utc: gte.toISOString(),
      lte_utc: lte.toISOString()
    });

    return { gte, lte };

  } catch (error) {
    logger.error('[API_HELPER] Falha ao analisar as datas', { fromRaw, toRaw, error });
    return undefined;
  }
}

/**
 * Converte um objeto Date para uma string de data local no formato 'yyyy-LL-dd HH:mm:ss'.
 */
export const toLocalDateStr = (d: Date) =>
  DateTime.fromJSDate(d).setZone(APP_TIMEZONE).toFormat("yyyy-LL-dd HH:mm:ss");

/**
 * Converte um timeframe (ex: 'M5', 'H1') para o equivalente em minutos.
 */
export function tfToMinutes(tf: string) {
  const s = String(tf || "").trim().toUpperCase();
  if (s === "H1") return 60;
  const m = s.match(/^M(\d+)$/);
  return m ? Number(m[1]) : 5;
}