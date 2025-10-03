import type { EsteticaCtx } from "./estetica.rag";
import { matchProcedureFromText } from "./estetica.rag";

export enum EsteticaIntent {
    BOOK = "BOOK",
    RESCHEDULE = "RESCHEDULE",
    CANCEL = "CANCEL",
    ASK_SERVICES = "ASK_SERVICES",
    CONFIRM = "CONFIRM",
    LIST = "LIST",
    GENERAL_QA = "GENERAL_QA",
}

export type IntentResult = {
    type: EsteticaIntent;
    query?: string;
    when?: Date | null;
    confirm?: boolean;
    appointmentId?: number;
    serviceName?: string;
    procedureId?: number;
    durationMin?: number;
    customerName?: string;
    notes?: string;
    cancelAll?: boolean;
    numberList?: number[];
};

function norm(t: string) {
    return String(t || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[“”]/g, '"')
        .trim();
}

/** Exportado por si quieres reusar desde otros módulos */
export const SERVICE_SYNONYMS: Record<string, string> = {
    "botox": "toxina botulínica",
    "bótox": "toxina botulínica",
    "botulinica": "toxina botulínica",
    "botulínica": "toxina botulínica",
    "toxina": "toxina botulínica",
    "toxinabotulinica": "toxina botulínica",
    "relleno": "rellenos dérmicos",
    "acido hialuronico": "rellenos dérmicos",
    "ácido hialurónico": "rellenos dérmicos",
    "peeling": "peeling químico",
    "limpieza": "limpieza facial",
};
export function normalizeServiceName(raw: string) {
    const key = norm(raw);
    return SERVICE_SYNONYMS[key] ?? raw;
}

/* ===========================================================
 * Utilidades: selección numérica y fechas “naturales”
 * =========================================================== */

// “1 y 2”, “1,2”, “2-4”, “#1 y #2”, etc.
function extractNumberList(t: string): number[] {
    const s = norm(t).replace(/\b(opcion|opciones|numero|nro|num|no|#)\b/g, "");
    // Rango: 2-5
    const ranges = Array.from(s.matchAll(/\b(\d{1,2})\s*-\s*(\d{1,2})\b/g)).flatMap((m) => {
        const a = Number(m[1]), b = Number(m[2]);
        if (!Number.isFinite(a) || !Number.isFinite(b)) return [];
        const from = Math.min(a, b), to = Math.max(a, b);
        return Array.from({ length: to - from + 1 }, (_, i) => from + i);
    });

    // Números sueltos
    const singles = Array.from(s.matchAll(/\b(\d{1,2})\b/g)).map((m) => Number(m[1]));

    // Unir y deduplicar
    const all = [...ranges, ...singles].filter((n) => Number.isFinite(n));
    return Array.from(new Set(all));
}

// ID de cita “cita 123”, “id 45”, “código APT-0045”
function extractAppointmentId(t: string): number | undefined {
    const m1 = t.match(/\b(cita|id)\s*(\d{1,7})\b/i);
    if (m1) return Number(m1[2]);
    const m2 = t.match(/\bapt-(\d{1,7})\b/i);
    if (m2) return Number(m2[1]);
    return undefined;
}

/* ===== fechas (TZ) ===== */
function addMinutes(d: Date, min: number) { return new Date(d.getTime() + min * 60000); }
function addDays(d: Date, days: number) { return new Date(d.getTime() + days * 86400000); }

function ymdInTZ(d: Date, tz: string): string {
    const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    return f.format(d);
}
function weekdayInTZ(d: Date, tz: string): number {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).formatToParts(d);
    const w = p.find((x) => x.type === "weekday")?.value?.toLowerCase();
    return ({ sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 } as any)[String(w).slice(0, 3)] ?? 0;
}
/** Convierte (YYYY-MM-DD + HH:mm) en instante UTC de esa TZ */
function makeZonedDate(ymd: string, hhmm: string, tz: string): Date {
    const [y, m, d] = ymd.split("-").map(Number);
    const [h, mi] = hhmm.split(":").map(Number);
    const guess = new Date(Date.UTC(y, m - 1, d, h, mi));
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit",
    }).formatToParts(guess);
    const gotH = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
    const gotM = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
    const deltaMin = (h * 60 + mi) - (gotH * 60 + gotM);
    return new Date(guess.getTime() + deltaMin * 60000);
}

function startOfDayTZ(d: Date, tz: string): Date { return makeZonedDate(ymdInTZ(d, tz), "00:00", tz); }

const WEEKDAYS: Record<string, number> = {
    domingo: 0, dom: 0,
    lunes: 1, lun: 1,
    martes: 2, mar: 2,
    miercoles: 3, miércoles: 3, mie: 3, mié: 3,
    jueves: 4, jue: 4,
    viernes: 5, vie: 5,
    sabado: 6, sábado: 6, sab: 6, sáb: 6,
};

function nextWeekdayInTZ(from: Date, tz: string, targetDow: number): Date {
    const start = startOfDayTZ(from, tz);
    let d = new Date(start);
    for (let i = 0; i < 14; i++) {
        if (weekdayInTZ(d, tz) === targetDow) return d;
        d = addDays(d, 1);
    }
    return d;
}

/** Devuelve un “hint” de fecha/hora según el texto. */
function parseWhenHint(text: string, tz: string): Date | null {
    const t = norm(text);

    const now = new Date();
    const today = startOfDayTZ(now, tz);

    // Palabras clave
    if (/\b(hoy)\b/.test(t)) return today; // el core ya maneja same-day policy
    if (/\b(ma[nñ]ana)\b/.test(t)) return addDays(today, 1);
    if (/\b(pasado\s+ma[nñ]ana)\b/.test(t)) return addDays(today, 2);

    // “la otra semana / próxima semana”: usar lunes próximo
    if (/\b(otra|proxima|pr[oó]xima|siguiente)\s+semana\b/.test(t)) {
        const dow = weekdayInTZ(today, tz);
        const daysToNextMonday = ((1 - dow + 7) % 7) || 7;
        return addDays(today, daysToNextMonday);
    }

    // “próximo lunes”, “este viernes”
    const wd = Object.keys(WEEKDAYS).find((w) => new RegExp(`\\b${w}\\b`).test(t));
    if (wd) {
        const dow = WEEKDAYS[wd];
        return nextWeekdayInTZ(addDays(today, 1), tz, dow);
    }

    // Horas “3 pm”, “15:30”, “a las 9”
    let hour: number | null = null;
    let minute = 0;
    const m1 = t.match(/\b(\d{1,2}):(\d{2})\b/); // 15:30
    const m2 = t.match(/\b(?:a\s*las\s*)?(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)\b/); // 3 pm
    const m3 = t.match(/\b(?:a\s*las\s*)?(\d{1,2})\b/); // a las 9

    if (m1) {
        hour = Number(m1[1]); minute = Number(m1[2]);
    } else if (m2) {
        hour = Number(m2[1]); const ap = m2[2].replace(/\./g, "");
        if (ap.startsWith("p") && hour < 12) hour += 12;
        if (ap.startsWith("a") && hour === 12) hour = 0;
    } else if (m3) {
        hour = Number(m3[1]);
    }

    if (hour != null && hour >= 0 && hour <= 23) {
        // Si mencionan hora pero no día, apuntar a mañana a esa hora
        const base = addDays(today, 1);
        return makeZonedDate(ymdInTZ(base, tz), `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`, tz);
    }

    return null;
}

/* ===========================================================
 * Detector de intenciones
 * =========================================================== */

/**
 * Política: JAMÁS auto-confirmar por decir "agendar" o "lo más pronto posible".
 * La confirmación solo ocurre con expresiones claras de confirmación.
 */
export async function detectIntent(text: string, ctx: EsteticaCtx): Promise<IntentResult> {
    const t = norm(text);

    // Confirmación explícita corta/coloquial
    if (
        /\b(s[ií]|ok|dale|listo|perfecto|de una|es correcto|confirmo)\b/.test(t) &&
        /\b(confirmo|confirmar|es correcto|listo|dale|ok)\b/.test(t)
    ) {
        return { type: EsteticaIntent.CONFIRM, confirm: true };
    }
    // “confirmo” directo
    if (/\b(confirmo|si confirmo|sí confirmo|ok confirmo)\b/.test(t)) {
        return { type: EsteticaIntent.CONFIRM, confirm: true };
    }

    // Listar próximas citas
    if (/\b(que|qué)?\s*citas?\s*(tengo|pendientes|agendadas|programadas)\b/.test(t)) {
        return { type: EsteticaIntent.LIST };
    }

    // Reagendar
    if (/(reagenda(r|rme)|cambiar\s+cita|mover\s+cita|otra\s+hora|otro\s+horario|cambiar\s+hora)/.test(t)) {
        const confirm = /\b(confirmo|confirmar|listo|dale|ok|es correcto)\b/.test(t);
        const when = parseWhenHint(text, ctx.timezone);
        const appointmentId = extractAppointmentId(text);
        const numberList = extractNumberList(text);
        return { type: EsteticaIntent.RESCHEDULE, when: when ?? null, confirm, appointmentId, numberList };
    }

    // Cancelar (acepta “cota” typo)
    if (/(cancel(ar|acion|ación)|anular)\s*(cita|cota)?/.test(t)) {
        const numberList = extractNumberList(t);
        const appointmentId = extractAppointmentId(text);
        const cancelAll = /\b(todas|ambas|las dos|las 2|las tres|las 3|todas las citas)\b/.test(t);
        return { type: EsteticaIntent.CANCEL, numberList, appointmentId, cancelAll };
    }

    // Catálogo / info
    if (/(precio|costo|servicios|tratamiento|procedimiento|hacen|ofrecen|lista(n)?|cat[aá]logo)/.test(t)) {
        return { type: EsteticaIntent.ASK_SERVICES, query: text };
    }

    // Booking (nunca confirmamos aquí)
    if (/\b(cita|agendar|agenda|reservar|reserva|separar|apart(ar)?)\b/.test(t)) {
        let serviceName: string | undefined;
        let procedureId: number | undefined;
        let durationMin: number | undefined;

        try {
            const normalizedText = text.replace(/botox/ig, "Toxina botulínica");
            const match = await matchProcedureFromText(ctx.empresaId, normalizedText);
            if (match) {
                serviceName = normalizeServiceName(match.name);
                procedureId = match.id;
                durationMin = match.durationMin ?? ctx.rules?.defaultServiceDurationMin ?? 60;
            } else {
                durationMin = ctx.rules?.defaultServiceDurationMin ?? 60;
            }
        } catch {
            durationMin = ctx.rules?.defaultServiceDurationMin ?? 60;
        }

        // pista temporal para findSlots
        const when = parseWhenHint(text, ctx.timezone);

        return {
            type: EsteticaIntent.BOOK,
            when: when ?? null,
            confirm: false,
            serviceName,
            procedureId,
            durationMin,
            numberList: extractNumberList(text),
        };
    }

    // QA general
    return { type: EsteticaIntent.GENERAL_QA, query: text };
}
