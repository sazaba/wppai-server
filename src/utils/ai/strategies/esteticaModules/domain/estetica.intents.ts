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

/** Sinónimos rápidos */
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

/* ---------- utilidades fecha relativa para señal de BOOK ---------- */
const WD = /(lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo)\b/;
const REL = /\b(hoy|manana|mañana|pasado\s+manana|pasado\s+mañana|proxima\s+semana|pr[oó]xima\s+semana|siguiente\s+semana)\b/;

/* números seleccionables 1-12, “1 y 2”, “2-4”, etc. */
function extractNumberList(t: string): number[] {
    const s = norm(t).replace(/\b(opcion|opciones|numero|nro|num|no|#)\b/g, "");
    const ranges = Array.from(s.matchAll(/\b(\d{1,2})\s*-\s*(\d{1,2})\b/g))
        .flatMap(m => {
            const a = +m[1], b = +m[2];
            if (!Number.isFinite(a) || !Number.isFinite(b)) return [];
            const from = Math.min(a, b), to = Math.max(a, b);
            return Array.from({ length: to - from + 1 }, (_, i) => from + i);
        });
    const singles = Array.from(s.matchAll(/\b(\d{1,2})\b/g)).map(m => +m[1]);
    return Array.from(new Set([...ranges, ...singles].filter(n => Number.isFinite(n))));
}
function extractAppointmentId(t: string): number | undefined {
    const m1 = t.match(/\b(cita|id)\s*(\d{1,7})\b/i);
    if (m1) return Number(m1[2]);
    const m2 = t.match(/\bapt-(\d{1,7})\b/i);
    if (m2) return Number(m2[1]);
    return undefined;
}

/* ============================= DETECTOR ============================= */
export async function detectIntent(text: string, ctx: EsteticaCtx): Promise<IntentResult> {
    const t = norm(text);

    // Confirmación clara
    if (/\b(confirmo|si confirmo|sí confirmo|ok confirmo|es correcto|listo|dale|ok)\b/.test(t)) {
        return { type: EsteticaIntent.CONFIRM, confirm: true };
    }

    // LIST próximas (“¿qué citas tengo?”, “mis reservas”)
    if (/\b(que|qué)?\s*citas?\s*(tengo|pendientes|agendadas|programadas|pr[oó]ximas|reservadas)\b/.test(t)
        || /\b(mis\s+citas|mis\s+reservas)\b/.test(t)) {
        return { type: EsteticaIntent.LIST };
    }

    // RESCHEDULE
    if (/(reagenda(r|rme)|cambiar\s+cita|mover\s+cita|otra\s+hora|otro\s+horario|cambiar\s+hora)/.test(t)) {
        return {
            type: EsteticaIntent.RESCHEDULE,
            when: null,
            confirm: /\b(confirmo|es correcto|listo|dale|ok)\b/.test(t),
            appointmentId: extractAppointmentId(text),
            numberList: extractNumberList(text),
        };
    }

    // CANCEL
    if (/(cancel(ar|acion|ación)|anular)\s*(cita|citas|cota)?/.test(t)) {
        return {
            type: EsteticaIntent.CANCEL,
            numberList: extractNumberList(t),
            appointmentId: extractAppointmentId(text),
            cancelAll: /\b(todas|ambas|las\s+dos|las\s+tres|todas\s+las\s+citas)\b/.test(t),
        };
    }

    // ASK_SERVICES / catálogo
    if (/(precio|precios|costo|costos|servicios|tratamiento|procedimiento|cat[aá]logo|ofrecen|hacen|peeling|botox|limpieza)/.test(t)
        && !/\b(cita|citas|agendar|reservar|reserva|agenda)\b/.test(t)) {
        return { type: EsteticaIntent.ASK_SERVICES, query: text };
    }

    // BOOK — incluye plural “citas” y señales temporales (“lunes”, “mañana”)
    if (/\b(cita(s)?|agendar|agenda|reservar|reserva|separar|apart(ar)?)\b/.test(t) || WD.test(t) || REL.test(t)) {
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

        return {
            type: EsteticaIntent.BOOK,
            when: null,
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
