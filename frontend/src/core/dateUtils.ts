// ===============================
// FILE: frontend/src/core/dateUtils.ts
// ===============================
import { DateTime } from 'luxon';

/**
 * Formata uma data/hora ISO (que vem do backend em UTC) para uma string legível 
 * no fuso horário local do utilizador.
 * * Exemplo: "2025-10-02T13:30:00.000Z" => "02/10/2025 10:30:00" (se o utilizador estiver no Brasil)
 * * @param isoString A data em formato ISO 8601.
 * @returns A data e hora formatadas ou uma string vazia se a entrada for inválida.
 */
export function formatToLocal(isoString: string | null | undefined): string {
    if (!isoString) {
        return '';
    }
    const dt = DateTime.fromISO(isoString);
    if (!dt.isValid) {
        return '';
    }
    return dt.toFormat('dd/LL/yyyy HH:mm:ss');
}

/**
 * Formata uma data/hora ISO apenas para a hora local.
 * * Exemplo: "2025-10-02T13:30:00.000Z" => "10:30:00"
 * * @param isoString A data em formato ISO 8601.
 * @returns A hora formatada ou uma string vazia.
 */
export function formatToLocalTime(isoString: string | null | undefined): string {
    if (!isoString) {
        return '';
    }
    const dt = DateTime.fromISO(isoString);
    if (!dt.isValid) {
        return '';
    }
    return dt.toFormat('HH:mm:ss');
}

/**
 * Converte um objeto Date para uma string no formato YYYY-MM-DD.
 * Usado para os campos de input de data.
 * * @param date O objeto Date.
 * @returns A data formatada.
 */
export function toDateOnly(date: Date): string {
    return DateTime.fromJSDate(date).toFormat('yyyy-LL-dd');
}