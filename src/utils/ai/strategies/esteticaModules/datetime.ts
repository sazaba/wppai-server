// utils/ai/strategies/esteticaModules/util/datetime.ts
import { Logger } from "../esteticaModules/log";

const log = Logger.child("util.datetime");

// === Conversión TZ local <-> UTC, estable con offsets variables (DST-ready) ===
function getTZOffsetMin(timeZone: string, date: Date): number {
    const dtf = new Intl.DateTimeFormat("en-US", {
        timeZone, hour12: false,
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const parts = dtf.formatToParts(date);
    const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
    const asUTC = Date.UTC(+map.year, +map.month - 1, +map.day, +map.hour, +map.minute, +map.second);
    return (asUTC - date.getTime()) / 60000;
}
export function fromLocalTZToUTC(localDate: Date, timeZone: string): Date {
    const off = getTZOffsetMin(timeZone, localDate);
    return new Date(localDate.getTime() - off * 60000);
}
export function fromUTCtoLocalTZ(utcDate: Date, timeZone: string): Date {
    const off = getTZOffsetMin(timeZone, utcDate);
    return new Date(utcDate.getTime() + off * 60000);
}

// === “Hoy / Mañana / Pasado mañana / fecha explícita” ===
export type ParsedRelativeDate = { ok: true; localStart: Date } | { ok: false; reason: string };

export function parseRelativeDateText(
    text: string,
    timeZone: string,
    referenceLocal?: Date
): ParsedRelativeDate {
    try {
        const t = text.toLowerCase();
        const ref = referenceLocal ?? new Date(); // local “ahora” (no UTC)
        const base = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), 0, 0, 0, 0);

        if (/\bhoy\b/.test(t)) return { ok: true, localStart: base };
        if (/\bmañana\b/.test(t)) return { ok: true, localStart: new Date(base.getTime() + 24 * 60 * 60000) };
        if (/pasad[oa]\s+mañana/.test(t)) return { ok: true, localStart: new Date(base.getTime() + 48 * 60 * 60000) };

        // dd/mm/yyyy o dd-mm-yyyy
        const m1 = /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/.exec(t);
        if (m1) {
            const d = new Date(Number(m1[3]), Number(m1[2]) - 1, Number(m1[1]), 0, 0, 0, 0);
            return { ok: true, localStart: d };
        }
        // yyyy-mm-dd
        const m2 = /(\d{4})-(\d{2})-(\d{2})/.exec(t);
        if (m2) {
            const d = new Date(Number(m2[1]), Number(m2[2]) - 1, Number(m2[3]), 0, 0, 0, 0);
            return { ok: true, localStart: d };
        }

        return { ok: false, reason: "no_match" };
    } catch (e) {
        log.warn("parseRelativeDateText error", e);
        return { ok: false, reason: "exception" };
    }
}

// HH:MM de 24 h
export function parseHHMM(s?: string | null): { h: number; m: number } | null {
    if (!s) return null;
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(s.trim());
    if (!m) return null;
    return { h: +m[1], m: +m[2] };
}
export function combineLocalDateTime(localDay: Date, hhmm: string, tz: string): Date {
    const { h, m } = parseHHMM(hhmm)!;
    const local = new Date(localDay.getFullYear(), localDay.getMonth(), localDay.getDate(), h, m, 0, 0);
    return fromLocalTZToUTC(local, tz);
}
