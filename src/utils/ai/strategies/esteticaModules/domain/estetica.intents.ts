// utils/ai/strategies/esteticaModules/domain/estetica.intents.ts
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
function addDays(d: Date, days: number) { return new Date(d.getTime() + days * 86400000); }
function startOfDayTZ(d: Date, tz: string): Date {
    const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
    const [y, m, dd] = ymd.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, dd, 0, 0));
}

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
        const wd = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(d).slice(0, 3).toLowerCase();
        const map: any = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
        if (map[wd] === targetDow) return d;
        d = addDays(d, 1);
    }
    return d;
}

/** Devuelve un “hint” de fecha/hora según el texto. */
function parseWhenHint(text: string, tz: string): Date | null {
    const t = norm(text);

    const now = new Date();
    const today = startOfDayTZ(now, tz);

    if (/\b(hoy)\b/.test(t)) return today;
    if (/\b(ma[nñ]ana)\b/.test(t)) return addDays(today, 1);
    if (/\b(pasado\s+ma[nñ]ana)\b/.test(t)) return addDays(today, 2);

    if (/\b(otra|proxima|pr[oó]xima|siguiente)\s+semana\b/.test(t)) {
        const wdToday = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(today).slice(0, 3).toLowerCase();
        const map: any = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
        const cur = map[wdToday] ?? 0;
        const daysToNextMonday = ((1 - cur + 7) % 7) || 7;
        return addDays(today, daysToNextMonday);
    }

    const wdKey = Object.keys(WEEKDAYS).find((w) => new RegExp(`\\b${w}\\b`).test(t));
    if (wdKey) {
        const dow = WEEKDAYS[wdKey];
        return nextWeekdayInTZ(addDays(today, 1), tz, dow);
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

    // Confirmación explícita
    if (/\b(confirmo|si confirmo|sí confirmo|es correcto|listo|ok)\b/.test(t)) {
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

    // Cancelar
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
