// ===============================
// FILE: backend_new/src/modules/api/api.helpers.ts
// ===============================
import { DateTime } from 'luxon';

const ZONE_BR = "America/Sao_Paulo";

/**
 * Converte um intervalo de datas (strings 'from' e 'to') para um objeto de data UTC.
 * Esta versão é mais simples e foi substituída pela função mais robusta abaixo.
 */
export function toUtcRange(from?: string, to?: string) {
  // ... (código anterior mantido por compatibilidade, mas não será mais usado pelas rotas principais)
  const parse = (s: string, endOfDay = false) => {
    if (!s) return null;
    let dt = DateTime.fromISO(s, { zone: ZONE_BR });
    if (!dt.isValid) dt = DateTime.fromSQL(s, { zone: ZONE_BR });
    if (!dt.isValid) return null;

    return endOfDay ? dt.endOf('day').toUTC().toJSDate() : dt.startOf('day').toUTC().toJSDate();
  };
  if (!from && !to) return undefined;
  const out: { gte?: Date; lte?: Date } = {};
  if (from) out.gte = parse(from);
  if (to) out.lte = parse(to, true);
  return out;
}

/**
 * <<< NOVA FUNÇÃO ROBUSTA >>>
 * Normaliza um intervalo de datas vindo da API, interpretando as datas no fuso horário de São Paulo
 * e garantindo que o intervalo cubra os dias completos.
 * @param fromRaw A data de início (string).
 * @param toRaw A data de fim (string).
 * @returns Um objeto com datas { gte, lte } em UTC, ou undefined se nenhuma data for fornecida.
 */
export function normalizeApiDateRange(fromRaw: any, toRaw: any): { gte?: Date; lte?: Date } | undefined {
  const parseDate = (raw: any) => {
    if (!raw) return null;
    // Tenta interpretar a data como ISO (YYYY-MM-DD), que é o que o input[type=date] envia
    const dt = DateTime.fromISO(String(raw), { zone: ZONE_BR });
    return dt.isValid ? dt : null;
  };

  const fromDate = parseDate(fromRaw);
  const toDate = parseDate(toRaw);

  if (!fromDate && !toDate) {
    return undefined;
  }

  // Se apenas uma data for fornecida, usamos a mesma para início e fim
  const start = fromDate || toDate;
  const end = toDate || fromDate;

  if (!start || !end) return undefined;

  // Garante que o intervalo cubra desde o início do primeiro dia até o fim do último dia
  const gte = start.startOf('day').toUTC().toJSDate();
  const lte = end.endOf('day').toUTC().toJSDate();

  return { gte, lte };
}


/**
 * Converte um objeto Date para uma string de data local no formato 'yyyy-LL-dd HH:mm:ss'.
 */
export const toLocalDateStr = (d: Date) =>
  DateTime.fromJSDate(d).setZone(ZONE_BR).toFormat("yyyy-LL-dd HH:mm:ss");

/**
 * Converte um timeframe (ex: 'M5', 'H1') para o equivalente em minutos.
 */
export function tfToMinutes(tf: string) {
  const s = String(tf || "").trim().toUpperCase();
  if (s === "H1") return 60;
  const m = s.match(/^M(\d+)$/);
  return m ? Number(m[1]) : 5;
}