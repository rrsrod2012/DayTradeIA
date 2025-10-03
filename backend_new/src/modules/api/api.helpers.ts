// ===============================
// FILE: backend_new/src/modules/api/api.helpers.ts
// ===============================
import { DateTime } from 'luxon';
import { logger } from '../../core/logger';

const APP_TIMEZONE = "America/Sao_Paulo";

/**
 * Converte várias formas de data para 'yyyy-LL-dd' (date-only).
 * Aceita:
 *  - 'YYYY-MM-DD'
 *  - 'DD/MM/YYYY'
 *  - ISO completo (pega apenas a parte de data, no fuso de SP)
 */
function parseToYMD(input?: any): string | undefined {
  if (input == null) return undefined;
  const s = String(input).trim();
  if (!s) return undefined;

  // Já no formato yyyy-LL-dd?
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // DD/MM/YYYY
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) {
    const dd = parseInt(m[1], 10);
    const MM = parseInt(m[2], 10);
    const yyyy = parseInt(m[3], 10);
    if (dd >= 1 && dd <= 31 && MM >= 1 && MM <= 12) {
      return `${yyyy}-${String(MM).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
    }
  }

  // ISO ou outra coisa parsável: extrai data no fuso de SP
  const dt = DateTime.fromISO(s, { zone: APP_TIMEZONE });
  if (dt.isValid) {
    return dt.toFormat("yyyy-LL-dd");
  }

  return undefined;
}

/**
 * Normaliza um intervalo de datas vindo da API (strings 'from' e 'to'),
 * interpretando-as no fuso de São Paulo e convertendo para UTC.
 * Se só 'from' vier, usa o mesmo dia em 'to'. Se só 'to' vier, usa o mesmo dia em 'from'.
 * Retorna undefined se nenhum limite for fornecido.
 */
export function normalizeApiDateRange(
  fromRaw?: any,
  toRaw?: any
): { gte?: Date; lte?: Date } | undefined {
  try {
    const fromYMD = parseToYMD(fromRaw);
    const toYMD = parseToYMD(toRaw);

    if (!fromYMD && !toYMD) return undefined;

    const startYMD = fromYMD ?? toYMD!;
    const endYMD = toYMD ?? fromYMD!;

    const start = DateTime.fromISO(startYMD, { zone: APP_TIMEZONE }).startOf('day');
    const end = DateTime.fromISO(endYMD, { zone: APP_TIMEZONE }).endOf('day');

    if (!start.isValid || !end.isValid) {
      logger.warn("[API_HELPER] Datas inválidas", { fromRaw, toRaw, start: start.invalidReason, end: end.invalidReason });
      return undefined;
    }

    return {
      gte: start.toUTC().toJSDate(),
      lte: end.toUTC().toJSDate(),
    };
  } catch (error) {
    logger.error('[API_HELPER] Falha ao analisar as datas', { fromRaw, toRaw, error });
    return undefined;
  }
}

/**
 * Converte um objeto Date para uma string de data local (SP) no formato 'yyyy-LL-dd HH:mm:ss'.
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
