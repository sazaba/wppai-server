// utils/ai/strategies/esteticaModules/booking/booking.validators.ts
import type { EsteticaCtx } from "../domain/estetica.rag";
import { resolveService } from "./booking.tools";

export type DayPart = "am" | "pm" | "any";
export type DatePref = { fromISO?: string; dayPart: DayPart };

const AM_WORDS = [/mañana\b/i, /\b(temprano|am|a\.m\.)\b/i];
const PM_WORDS = [/tarde\b/i, /despu[eé]s de/i, /\b(pm|p\.m\.)\b/i];

function guessDayPart(text: string): DayPart {
    if (AM_WORDS.some((r) => r.test(text))) return "am";
    if (PM_WORDS.some((r) => r.test(text))) return "pm";
    return "any";
}

function ymdInTZ(d: Date, tz: string): string {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(d);
}

function startOfDayTZ(ymd: string, tz: string): Date {
    const [y, m, dd] = ymd.split("-").map(Number);
    // 00:00 local -> calculado estable
    const base = new Date(Date.UTC(y, m - 1, dd, 0, 0));
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    }).formatToParts(base);
    const gotH = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
    const gotM = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
    const deltaMin = 0 - (gotH * 60 + gotM);
    return new Date(base.getTime() + deltaMin * 60000);
}

/** Interpreta "mañana", "próxima semana", "lunes", "el 9" → ISO día base (sin hora) + franja */
export function parseDatePref(text: string, tz: string): DatePref {
    const t = text.toLowerCase();

    // día relativo corto
    if (/\b(hoy)\b/.test(t)) {
        const ymd = ymdInTZ(new Date(), tz);
        return { fromISO: startOfDayTZ(ymd, tz).toISOString(), dayPart: guessDayPart(text) };
    }
    if (/\b(ma[ñn]ana)\b/.test(t)) {
        const now = new Date();
        const ymd = ymdInTZ(now, tz);
        const tomorrow = new Date(startOfDayTZ(ymd, tz).getTime() + 86400000);
        return { fromISO: tomorrow.toISOString(), dayPart: guessDayPart(text) };
    }
    if (/\b(pr[oó]xima semana|la otra semana)\b/.test(t)) {
        // normalizar al lunes próximo (server también normaliza, esto es solo pista)
        const now = new Date();
        const w = now.getUTCDay(); // 0..6
        const daysToMon = (8 - (w || 7)) % 7; // hasta próximo lunes
        const base = new Date(now.getTime() + (daysToMon || 7) * 86400000);
        const ymd = ymdInTZ(base, tz);
        return { fromISO: startOfDayTZ(ymd, tz).toISOString(), dayPart: guessDayPart(text) };
    }

    // día de la semana explícito (lun..dom)
    const map: Record<string, number> = {
        lunes: 1, martes: 2, miercoles: 3, miércoles: 3,
        jueves: 4, viernes: 5, sabado: 6, sábado: 6, domingo: 0,
    };
    for (const k of Object.keys(map)) {
        if (t.includes(k)) {
            const targetDow = map[k];
            const now = new Date();
            // mover al próximo k (incluye hoy->la próxima ocurrencia)
            let d = new Date(now);
            for (let i = 0; i < 8; i++) {
                if (d.getDay() === targetDow) break;
                d = new Date(d.getTime() + 86400000);
            }
            const ymd = ymdInTZ(d, tz);
            return { fromISO: startOfDayTZ(ymd, tz).toISOString(), dayPart: guessDayPart(text) };
        }
    }

    // sin pista → que el backend normalice (findSlots lo sabe hacer)
    return { fromISO: undefined, dayPart: guessDayPart(text) };
}

export async function validateService(
    ctx: EsteticaCtx,
    q: { serviceId?: number; name?: string | null }
) {
    const s = await resolveService(ctx.empresaId, { serviceId: q.serviceId, name: q.name ?? undefined });
    return s ? { id: s.id, name: s.name, durationMin: s.durationMin ?? ctx.rules?.defaultServiceDurationMin ?? 60 } : null;
}

export function normalizePhone(raw?: string): string | null {
    const n = String(raw || "").replace(/[^\d]/g, "");
    return n.length >= 6 ? n : null;
}
