// ===============================
// FILE: backend_new/src/core/dateUtils.ts
// ===============================
import { DateTime } from 'luxon';

// Define o fuso horário de origem dos dados do CSV (horário do pregão no Brasil)
const CSV_TIMEZONE = 'America/Sao_Paulo';

/**
 * Converte a string de data/hora do arquivo CSV do MetaTrader para um objeto Date em UTC.
 * A função assume que a string de origem (ex: "2024.12.18 10:00") está no fuso horário de São Paulo.
 * @param csvTimestamp String de data e hora do CSV (formato "YYYY.MM.DD HH:MM").
 * @returns Um objeto Date em UTC.
 */
export function parseCsvDate(csvTimestamp: string): Date | null {
    if (!csvTimestamp) return null;

    // Luxon é uma biblioteca robusta para lidar com datas e fusos horários.
    // 'c' representa o formato "YYYY-MM-DD HH:MM:SS"
    const dt = DateTime.fromFormat(csvTimestamp, 'yyyy.LL.dd HH:mm', { zone: CSV_TIMEZONE });

    if (!dt.isValid) {
        logger.warn(`[DateUtils] Timestamp do CSV inválido encontrado: ${csvTimestamp}`);
        return null;
    }

    // Retorna o objeto Date nativo, que internamente é sempre UTC.
    return dt.toJSDate();
}

/**
 * Formata um objeto Date para uma string legível no fuso horário de São Paulo.
 * Útil para logs e depuração.
 * @param date Objeto Date.
 * @returns String formatada (ex: "2024-12-18 10:00:00").
 */
export function formatToSaoPaulo(date: Date): string {
    return DateTime.fromJSDate(date).setZone(CSV_TIMEZONE).toFormat('yyyy-LL-dd HH:mm:ss');
}