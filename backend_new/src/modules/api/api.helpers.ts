// ===============================
// FILE: backend_new/src/modules/api/api.helpers.ts
// ===============================
import { DateTime } from 'luxon';

const ZONE = "America/Sao_Paulo";

/**
 * Converte um intervalo de datas (strings 'from' e 'to') para um objeto de data UTC.
 * Suporta formatos ISO e BR (dd/MM/yyyy).
 */
export function toUtcRange(from?: string, to?: string) {
  const parse = (s: string, endOfDay = false) => {
    if (!s) return null;
    let dt: DateTime;
    // ISO?
    if (/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(s))
      dt = DateTime.fromISO(s, { zone: "utc" });
    // BR (dd/MM/yyyy [HH:mm[:ss]])
    else if (/^\d{2}\/\d{2}\/\d{4}(\s+\d{2}:\d{2}(:\d{2})?)?$/.test(s)) {
      const parts = s.split(/[\s/:]/).map(p => parseInt(p, 10));
      const isoStr = `${parts[2]}-${String(parts[1]).padStart(2, '0')}-${String(parts[0]).padStart(2, '0')}T${String(parts[3] || 0).padStart(2, '0')}:${String(parts[4] || 0).padStart(2, '0')}:${String(parts[5] || 0).padStart(2, '0')}Z`;
      dt = DateTime.fromISO(isoStr, { zone: "utc" });
    } else {
      // Tenta como ISO flexível
      dt = DateTime.fromISO(s, { zone: "utc" });
    }
    if (!dt.isValid) {
      const d = new Date(s);
      if (isNaN(d.getTime())) return null;
      dt = DateTime.fromJSDate(d).toUTC();
    }
    if (endOfDay) {
      dt = dt.endOf('day');
    }
    return dt.toJSDate();
  };
  if (!from && !to) return undefined;
  const out: { gte?: Date; lte?: Date } = {};
  if (from) out.gte = parse(from);
  if (to) out.lte = parse(to, true);
  return out;
}

/**
 * Converte um objeto Date para uma string de data local no formato 'yyyy-LL-dd HH:mm:ss'.
 */
export const toLocalDateStr = (d: Date) =>
  DateTime.fromJSDate(d).setZone(ZONE).toFormat("yyyy-LL-dd HH:mm:ss");

/**
 * Converte um timeframe (ex: 'M5', 'H1') para o equivalente em minutos.
 */
export function tfToMinutes(tf: string) {
  const s = String(tf || "").trim().toUpperCase();
  if (s === "H1") return 60;
  const m = s.match(/^M(\d+)$/);
  return m ? Number(m[1]) : 5;
}