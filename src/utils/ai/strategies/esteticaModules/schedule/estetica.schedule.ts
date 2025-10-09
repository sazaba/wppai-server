import prisma from "../../../../../lib/prisma";
import type { AppointmentStatus, AppointmentVertical, Weekday } from "@prisma/client";
import { addMinutes } from "date-fns";
import { zonedTimeToUtc, utcToZonedTime, format as tzFormat } from "date-fns-tz";

export type Slot = { startISO: string; endISO: string };

export type ScheduleContext = {
    empresaId: number;
    vertical: AppointmentVertical | "custom";
    timezone: string;        // ej. "America/Bogota"
    bufferMin?: number;      // margen al inicio (min)
    granularityMin?: number; // paso entre intentos (min) — default 15
};

// ========= Offset de citas en BD (ej. -5h almacenadas) =========
const APPT_DB_OFFSET_MIN = Number(process.env.APPT_DB_OFFSET_MIN ?? 300); // 5h por defecto
const applyApptOffsetRead = (dbDate: Date) => addMinutes(dbDate, APPT_DB_OFFSET_MIN); // -> UTC real
const applyApptOffsetWrite = (utcDate: Date) => addMinutes(utcDate, -APPT_DB_OFFSET_MIN); // <- a BD

// Helper: formatear una Date "d" en la zona tz con patrón "fmt"
function formatInTZ(d: Date, tz: string, fmt: string) {
    const zoned = utcToZonedTime(d, tz);
    return tzFormat(zoned, fmt, { timeZone: tz });
}

/** Mapa: ISO weekday 1..7 → Weekday enum de Prisma */
const isoToWeekdayEnum = (isoDay: number): Weekday => {
    const map: Record<number, Weekday> = { 1: "mon", 2: "tue", 3: "wed", 4: "thu", 5: "fri", 6: "sat", 7: "sun" };
    return map[isoDay];
};

/** 00:00 y 23:59:59 locales (de ese dateISO) convertidos a UTC */
function dayBoundsUtc(dateISO: string, tz: string) {
    const localStart = new Date(`${dateISO}T00:00:00`);
    const localEnd = new Date(`${dateISO}T23:59:59`);
    const dayStartUtc = zonedTimeToUtc(localStart, tz);
    const dayEndUtc = zonedTimeToUtc(localEnd, tz);
    return { dayStartUtc, dayEndUtc };
}

/** Construye (hasta) dos ventanas HH:mm→HH:mm aplicando override de excepción si la hay */
function buildRangesFromExceptionOrHours(args: {
    start1?: string | null; end1?: string | null;
    start2?: string | null; end2?: string | null;
    exStart1?: string | null; exEnd1?: string | null;
    exStart2?: string | null; exEnd2?: string | null;
}) {
    const pick = (base?: string | null, ex?: string | null) => (ex ?? base) || null;
    const r1 = [pick(args.start1, args.exStart1), pick(args.end1, args.exEnd1)] as const;
    const r2 = [pick(args.start2, args.exStart2), pick(args.end2, args.exEnd2)] as const;
    const out: Array<{ start: string; end: string }> = [];
    if (r1[0] && r1[1]) out.push({ start: r1[0]!, end: r1[1]! });
    if (r2[0] && r2[1]) out.push({ start: r2[0]!, end: r2[1]! });
    return out;
}

/** Genera slots disponibles (sin solape) para la fecha dada (en tz del negocio) */
export async function getAvailableSlotsForDate(
    ctx: ScheduleContext,
    dateISO: string,
    durationMin: number
): Promise<Slot[]> {
    const { empresaId, timezone: tz, bufferMin = 0, granularityMin = 15 } = ctx;

    // Weekday (en tz)
    const middayLocal = new Date(`${dateISO}T12:00:00`);
    const middayUtc = zonedTimeToUtc(middayLocal, tz);
    const isoDay = Number(formatInTZ(middayUtc, tz, "i")); // 1..7
    const weekdayEnum = isoToWeekdayEnum(isoDay);

    // 1) Horario base
    const hours = await prisma.appointmentHour.findUnique({
        where: { empresaId_day: { empresaId, day: weekdayEnum } },
        select: { isOpen: true, start1: true, end1: true, start2: true, end2: true },
    });
    if (!hours || !hours.isOpen) return [];

    // 2) Excepción del día
    const { dayStartUtc, dayEndUtc } = dayBoundsUtc(dateISO, tz);
    const exception = await prisma.appointmentException.findFirst({
        where: { empresaId, date: { gte: dayStartUtc, lte: dayEndUtc } },
        select: { isOpen: true, start1: true, end1: true, start2: true, end2: true },
    });
    if (exception && exception.isOpen === false) return [];

    // 3) Ventanas definitivas
    const ranges = buildRangesFromExceptionOrHours({
        start1: hours.start1, end1: hours.end1,
        start2: hours.start2, end2: hours.end2,
        exStart1: exception?.start1, exEnd1: exception?.end1,
        exStart2: exception?.start2, exEnd2: exception?.end2,
    });
    if (!ranges.length) return [];

    // 4) Citas que solapan con el día (aplicando OFFSET de la BD → UTC real)
    const overlappingRaw = await prisma.appointment.findMany({
        where: {
            empresaId,
            status: { in: ["pending", "confirmed", "rescheduled"] as AppointmentStatus[] },
            startAt: { lt: applyApptOffsetWrite(dayEndUtc) }, // en BD está con offset
            endAt: { gt: applyApptOffsetWrite(dayStartUtc) },
        },
        select: { startAt: true, endAt: true },
        orderBy: { startAt: "asc" },
    });
    // Normalizamos a UTC real para comparar
    const overlapping = overlappingRaw.map(a => ({
        startAt: applyApptOffsetRead(a.startAt),
        endAt: applyApptOffsetRead(a.endAt),
    }));

    const slots: Slot[] = [];

    for (const r of ranges) {
        // Ventana local → UTC real
        const windowStartUtc = zonedTimeToUtc(new Date(`${dateISO}T${r.start}:00`), tz);
        const windowEndUtc = zonedTimeToUtc(new Date(`${dateISO}T${r.end}:00`), tz);

        // Cursor en local
        let cursorLocal = new Date(`${dateISO}T${r.start}:00`);
        cursorLocal = addMinutes(cursorLocal, bufferMin);

        while (true) {
            const slotEndLocal = addMinutes(cursorLocal, durationMin);
            const slotStartUtc = zonedTimeToUtc(cursorLocal, tz);
            const slotEndUtc = zonedTimeToUtc(slotEndLocal, tz);

            if (slotEndUtc > windowEndUtc) break;

            // ¿choca con alguna cita?
            const collide = overlapping.some((a) => slotStartUtc < a.endAt && slotEndUtc > a.startAt);
            if (!collide) {
                // ISO con offset de la zona
                const startISO = tzFormat(utcToZonedTime(slotStartUtc, tz), "yyyy-MM-dd'T'HH:mm:ssXXX", { timeZone: tz });
                const endISO = tzFormat(utcToZonedTime(slotEndUtc, tz), "yyyy-MM-dd'T'HH:mm:ssXXX", { timeZone: tz });
                slots.push({ startISO, endISO });
            }

            cursorLocal = addMinutes(cursorLocal, granularityMin);
            if (zonedTimeToUtc(cursorLocal, tz) >= windowEndUtc) break;
        }
    }

    return slots;
}

/** Primeros N slots a partir de una fecha (inclusive) */
export async function getNextAvailableSlots(
    ctx: ScheduleContext,
    fromDateISO: string,
    durationMin: number,
    daysHorizon = 14,
    take = 8
): Promise<Array<{ date: string; slots: Slot[] }>> {
    const out: Array<{ date: string; slots: Slot[] }> = [];
    let currentISO = fromDateISO;

    for (let i = 0; i < daysHorizon && out.flatMap(d => d.slots).length < take; i++) {
        const slots = await getAvailableSlotsForDate(ctx, currentISO, durationMin);
        if (slots.length) out.push({ date: currentISO, slots });
        // +1 día
        const d = new Date(`${currentISO}T00:00:00`);
        const next = new Date(d.getTime() + 24 * 60 * 60 * 1000);
        const y = next.getFullYear();
        const m = String(next.getMonth() + 1).padStart(2, "0");
        const dd = String(next.getDate()).padStart(2, "0");
        currentISO = `${y}-${m}-${dd}`;
    }

    // recortar global a `take`
    let total = 0;
    return out
        .map(({ date, slots }) => {
            const remaining = Math.max(0, take - total);
            const pick = slots.slice(0, remaining);
            total += pick.length;
            return { date, slots: pick };
        })
        .filter(e => e.slots.length > 0);
}

/** Crear cita validando solapes (recibe ISO con offset de zona) */
export async function createAppointmentSafe(params: {
    empresaId: number;
    vertical: AppointmentVertical | "custom";
    timezone: string;
    procedureId: number | null;
    serviceName: string;
    customerName: string;
    customerPhone: string;
    notes?: string | null;
    startISO: string; // ej. "2025-10-10T10:00:00-05:00"
    endISO: string;
    source?: "ai" | "agent" | "client";
}) {
    const {
        empresaId, vertical, timezone: tz, procedureId, serviceName,
        customerName, customerPhone, notes, startISO, endISO, source = "ai",
    } = params;

    const startUtc = zonedTimeToUtc(new Date(startISO), tz);
    const endUtc = zonedTimeToUtc(new Date(endISO), tz);
    if (!(startUtc instanceof Date) || isNaN(startUtc.valueOf()) || !(endUtc instanceof Date) || isNaN(endUtc.valueOf()) || endUtc <= startUtc) {
        throw new Error("Rango de tiempo inválido");
    }

    // Solape (comparando en UTC real)
    const overlap = await prisma.appointment.findFirst({
        where: {
            empresaId,
            status: { in: ["pending", "confirmed", "rescheduled"] as AppointmentStatus[] },
            startAt: { lt: applyApptOffsetWrite(endUtc) },
            endAt: { gt: applyApptOffsetWrite(startUtc) },
        },
        select: { id: true },
    });
    if (overlap) throw new Error("El horario seleccionado ya no está disponible.");

    const durationMin = Math.round((endUtc.getTime() - startUtc.getTime()) / 60000);

    // Escribimos con offset si aplica
    const appt = await prisma.appointment.create({
        data: {
            empresaId,
            source,
            status: "confirmed",
            customerName,
            customerPhone,
            serviceName,
            serviceDurationMin: durationMin,
            locationNameCache: "",
            startAt: applyApptOffsetWrite(startUtc),
            endAt: applyApptOffsetWrite(endUtc),
            timezone: tz,
            procedureId: procedureId ?? undefined,
            notas: notes ?? undefined,
        },
    });

    return appt;
}
