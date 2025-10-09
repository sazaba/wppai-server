// // utils/ai/strategies/esteticaModules/schedule/estetica.schedule.ts
// import prisma from "../../../../../lib/prisma";
// import { AppointmentStatus, Weekday } from "@prisma/client";
// import { Logger } from "../../../../ai/strategies/esteticaModules/log";
// import {
//     fromLocalTZToUTC,
//     fromUTCtoLocalTZ,
//     parseHHMM,
// } from "../datetime";

// const log = Logger.child("estetica.schedule");

// // ★ Offset fijo conocido en APPOINTMENT (no en appointmentHour)
// const APPT_DB_OFFSET_MIN = 300; // 5h
// function addMinutes(d: Date, min: number) { return new Date(d.getTime() + min * 60000); }
// function applyApptOffsetWrite(utc: Date) { return addMinutes(utc, -APPT_DB_OFFSET_MIN); }
// function applyApptOffsetRead(dbUtcWithOffset: Date) { return addMinutes(dbUtcWithOffset, APPT_DB_OFFSET_MIN); }

// function formatLabel(dateUTC: Date, tz: string) {
//     const local = fromUTCtoLocalTZ(dateUTC, tz);
//     const dd = local.toLocaleDateString("es-CO", { weekday: "short", day: "2-digit", month: "short" });
//     const hh = local.toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit", hour12: false });
//     return `${dd} ${hh}`;
// }

// function weekdayFromDateUTC(dUTC: Date, tz: string): Weekday {
//     const local = fromUTCtoLocalTZ(dUTC, tz);
//     return (["sun", "mon", "tue", "wed", "thu", "fri", "sat"][local.getDay()] as Weekday);
// }

// async function getHoursForDay(empresaId: number, weekday: Weekday) {
//     return prisma.appointmentHour.findUnique({ where: { empresaId_day: { empresaId, day: weekday } } });
// }
// async function getExceptionForDate(empresaId: number, dateUTC: Date) {
//     // buscamos sólo por la “fecha” en UTC (excepciones guardadas por fecha)
//     const start = new Date(Date.UTC(dateUTC.getUTCFullYear(), dateUTC.getUTCMonth(), dateUTC.getUTCDate(), 0, 0, 0));
//     const end = new Date(Date.UTC(dateUTC.getUTCFullYear(), dateUTC.getUTCMonth(), dateUTC.getUTCDate() + 1, 0, 0, 0));
//     return prisma.appointmentException.findFirst({
//         where: { empresaId, date: { gte: start, lt: end } },
//         orderBy: { updatedAt: "desc" },
//     });
// }

// function withTimeUTC(refUTC: Date, hhmm: string, tz: string): Date {
//     const { h, m } = parseHHMM(hhmm)!;
//     const local = new Date(refUTC.getUTCFullYear(), refUTC.getUTCMonth(), refUTC.getUTCDate(), h, m, 0, 0);
//     return fromLocalTZToUTC(fromUTCtoLocalTZ(local, tz), tz);
// }

// function buildSegmentsFromHours(
//     tz: string,
//     refUTC: Date,
//     hours: { start1?: string | null; end1?: string | null; start2?: string | null; end2?: string | null }
// ) {
//     const segs: Array<{ startUTC: Date; endUTC: Date }> = [];
//     const pairs: Array<[string | null | undefined, string | null | undefined]> = [[hours.start1, hours.end1], [hours.start2, hours.end2]];
//     for (const [s, e] of pairs) {
//         if (!s || !e) continue;
//         segs.push({ startUTC: withTimeUTC(refUTC, s, tz), endUTC: withTimeUTC(refUTC, e, tz) });
//     }
//     return segs;
// }
// function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date) {
//     return aStart < bEnd && bStart < aEnd;
// }

// export type SlotView = { startAt: Date; endAt: Date; label: string };
// export type FindSlotsOpts = {
//     empresaId: number;
//     timezone: string;
//     serviceDurationMin: number;
//     fromDateUTC: Date; // ancla en UTC (p.ej. “ahora” o mañana 09:00 local convertido a UTC)
//     days: number;
//     bufferMin?: number;
// };

// async function listExisting(empresaId: number, dayUTC: Date) {
//     const start = new Date(Date.UTC(dayUTC.getUTCFullYear(), dayUTC.getUTCMonth(), dayUTC.getUTCDate(), 0, 0, 0));
//     const end = new Date(Date.UTC(dayUTC.getUTCFullYear(), dayUTC.getUTCMonth(), dayUTC.getUTCDate() + 1, 0, 0, 0));
//     // ★ Las citas en DB están “-5h”; al LEER debemos reversar para comparar en UTC real:
//     const found = await prisma.appointment.findMany({
//         where: {
//             empresaId,
//             status: { in: ["pending", "confirmed", "rescheduled"] },
//             startAt: { gte: applyApptOffsetWrite(start), lt: applyApptOffsetWrite(end) }, // mover rango al espacio “DB”
//             deletedAt: null,
//         },
//         select: { startAt: true, endAt: true },
//     });
//     return found.map(a => ({ startAt: applyApptOffsetRead(a.startAt), endAt: applyApptOffsetRead(a.endAt) }));
// }

// export async function findNextSlots(opts: FindSlotsOpts): Promise<SlotView[]> {
//     const { empresaId, timezone, serviceDurationMin, fromDateUTC, days, bufferMin = 10 } = opts;
//     const out: SlotView[] = [];
//     let cursor = new Date(Date.UTC(fromDateUTC.getUTCFullYear(), fromDateUTC.getUTCMonth(), fromDateUTC.getUTCDate(), 0, 0, 0));

//     for (let i = 0; i < days; i++) {
//         const weekday = weekdayFromDateUTC(cursor, timezone);
//         const baseHours = await getHoursForDay(empresaId, weekday);
//         if (!baseHours || !baseHours.isOpen) { cursor = addMinutes(cursor, 1440); continue; }

//         // excepción
//         const ex = await getExceptionForDate(empresaId, cursor);
//         let segs = buildSegmentsFromHours(timezone, cursor, baseHours);
//         if (ex) {
//             if (ex.isOpen === false) { cursor = addMinutes(cursor, 1440); continue; }
//             const exSegs = buildSegmentsFromHours(timezone, cursor, ex);
//             if (exSegs.length) segs = exSegs;
//         }

//         const existing = await listExisting(empresaId, cursor);

//         for (const seg of segs) {
//             let slotStart = new Date(seg.startUTC);
//             while (addMinutes(slotStart, serviceDurationMin) <= seg.endUTC) {
//                 const slotEnd = addMinutes(slotStart, serviceDurationMin);

//                 // respeta buffer
//                 const slotStartBuf = addMinutes(slotStart, -bufferMin);
//                 const slotEndBuf = addMinutes(slotEnd, bufferMin);
//                 const hasOverlap = existing.some(e => overlaps(slotStartBuf, slotEndBuf, e.startAt, e.endAt));

//                 if (!hasOverlap) out.push({ startAt: slotStart, endAt: slotEnd, label: formatLabel(slotStart, timezone) });

//                 // paso “seguro”, evita grilla demasiado densa
//                 slotStart = addMinutes(slotStart, Math.max(5, Math.min(serviceDurationMin, 30)));
//             }
//         }
//         cursor = addMinutes(cursor, 1440);
//         if (out.length >= 30) break;
//     }

//     log.debug("findNextSlots result", { count: out.length, empresaId, serviceDurationMin });
//     return out.slice(0, 30);
// }

// export type BookArgs = {
//     empresaId: number;
//     conversationId?: number | null;
//     customerName: string;
//     customerPhone: string;
//     serviceName: string;
//     serviceDurationMin: number;
//     timezone: string;
//     startAtUTC: Date; // validado contra slots (UTC real)
//     notes?: string;
//     procedureId?: number;
//     staffId?: number;
//     source?: "ai" | "agent" | "client";
// };

// export async function bookAppointment(args: BookArgs) {
//     const endAtUTC = addMinutes(args.startAtUTC, args.serviceDurationMin);

//     // Anti solape en DB (recordando offset al ESCRIBIR/CONSULTAR):
//     const startDB = applyApptOffsetWrite(args.startAtUTC);
//     const endDB = applyApptOffsetWrite(endAtUTC);

//     const dup = await prisma.appointment.findFirst({
//         where: {
//             empresaId: args.empresaId,
//             status: { in: ["pending", "confirmed", "rescheduled"] },
//             deletedAt: null,
//             AND: [{ startAt: { lt: endDB } }, { endAt: { gt: startDB } }],
//         },
//     });
//     if (dup) { log.warn("book dup", { id: dup.id }); throw new Error("Ese horario acaba de ocuparse. Probemos otro."); }

//     const appt = await prisma.appointment.create({
//         data: {
//             empresaId: args.empresaId,
//             conversationId: args.conversationId ?? null,
//             source: args.source === "ai" ? "ai" : "client",
//             status: "pending",
//             customerName: args.customerName,
//             customerPhone: args.customerPhone,
//             customerDisplayName: args.customerName,
//             serviceName: args.serviceName,
//             serviceDurationMin: args.serviceDurationMin,
//             notas: args.notes ?? null,
//             procedureId: args.procedureId ?? null,
//             staffId: args.staffId ?? null,
//             timezone: args.timezone,
//             startAt: startDB, // ★ guardar con offset
//             endAt: endDB,     // ★ guardar con offset
//         },
//     });

//     log.info("booked", { apptId: appt.id, empresaId: args.empresaId, service: args.serviceName });
//     return appt;
// }

// // ================= Reagendar y Cancelar =================

// export type RescheduleArgs = {
//     empresaId: number;
//     appointmentId: number;
//     // nueva hora en UTC real (sin offset de la tabla):
//     newStartAtUTC: Date;
//     // si no se pasa, usa la duración ya guardada en la cita
//     serviceDurationMin?: number;
// };

// export async function rescheduleAppointment(args: RescheduleArgs) {
//     const { empresaId, appointmentId, newStartAtUTC } = args;

//     const appt = await prisma.appointment.findFirst({
//         where: {
//             id: appointmentId,
//             empresaId,
//             status: { in: ["pending", "confirmed", "rescheduled"] },
//             deletedAt: null,
//         },
//         select: {
//             id: true, serviceName: true, serviceDurationMin: true, timezone: true,
//             startAt: true, endAt: true, customerName: true, customerPhone: true,
//         },
//     });
//     if (!appt) throw new Error("No encontré la cita a reagendar.");

//     const duration = Number.isFinite(args.serviceDurationMin)
//         ? Number(args.serviceDurationMin)
//         : (appt.serviceDurationMin ?? 60);

//     // Calcular nuevo rango en UTC real
//     const newEndAtUTC = new Date(newStartAtUTC.getTime() + duration * 60000);

//     // Mapeo al “espacio DB” (con offset -5h)
//     const startDB = applyApptOffsetWrite(newStartAtUTC);
//     const endDB = applyApptOffsetWrite(newEndAtUTC);

//     // Validar solape con otras citas
//     const dup = await prisma.appointment.findFirst({
//         where: {
//             empresaId,
//             id: { not: appointmentId },
//             status: { in: ["pending", "confirmed", "rescheduled"] },
//             deletedAt: null,
//             AND: [{ startAt: { lt: endDB } }, { endAt: { gt: startDB } }],
//         },
//         select: { id: true },
//     });
//     if (dup) throw new Error("Ese horario ya está ocupado. Probemos otro.");

//     const updated = await prisma.appointment.update({
//         where: { id: appointmentId },
//         data: {
//             startAt: startDB,
//             endAt: endDB,
//             status: "rescheduled",
//             serviceDurationMin: duration,
//         },
//         select: {
//             id: true, serviceName: true, startAt: true, endAt: true, timezone: true,
//             customerName: true, customerPhone: true, serviceDurationMin: true, status: true,
//         },
//     });

//     // Devolvemos tiempos corregidos a UTC real
//     return {
//         ...updated,
//         startAt: applyApptOffsetRead(updated.startAt),
//         endAt: applyApptOffsetRead(updated.endAt),
//     };
// }

// export async function cancelAppointment(
//     empresaId: number,
//     appointmentId: number,
//     reason?: string
// ) {
//     const appt = await prisma.appointment.findFirst({
//         where: {
//             id: appointmentId,
//             empresaId,
//             status: { in: ["pending", "confirmed", "rescheduled"] },
//             deletedAt: null,
//         },
//         select: { id: true, notas: true },
//     });
//     if (!appt) throw new Error("No encontré una cita activa para cancelar.");

//     const notas = (appt.notas ? appt.notas + "\n" : "") + (reason ? `Cancelación: ${reason}` : "Cancelación solicitada.");

//     const updated = await prisma.appointment.update({
//         where: { id: appointmentId },
//         data: { status: "cancelled", notas },
//         select: { id: true, status: true },
//     });

//     return updated;
// }


// utils/ai/strategies/esteticaModules/schedule/estetica.schedule.ts
// Reescrito sin Luxon: usa date-fns y date-fns-tz con zona horaria.
// - Lee AppointmentHour (+ 2 franjas) y AppointmentException (cierra/recorta).
// - Evita solapes contra Appointment (pending|confirmed|rescheduled).
// - Retorna slots con ISO incluyendo offset (ej. 2025-10-10T10:00:00-05:00).

// utils/ai/strategies/esteticaModules/schedule/estetica.schedule.ts
// Versión CommonJS-friendly: date-fns v2 + date-fns-tz v1 (CJS)
// - Lee AppointmentHour (+ 2 franjas) y AppointmentException (cierre/recorte)
// - Valida solapes contra Appointment (pending|confirmed|rescheduled)
// - Devuelve ISOs con offset del timezone (ej. 2025-10-10T10:00:00-05:00)

import prisma from "../../../../../lib/prisma";
import type { AppointmentStatus, AppointmentVertical, Weekday } from "@prisma/client";
import { addMinutes } from "date-fns";
import { zonedTimeToUtc, utcToZonedTime, format as tzFormat } from "date-fns-tz";

export type Slot = { startISO: string; endISO: string };

export type ScheduleContext = {
    empresaId: number;
    vertical: AppointmentVertical | "custom";
    timezone: string;         // ej. "America/Bogota"
    bufferMin?: number;       // margen al inicio (min)
    granularityMin?: number;  // paso entre intentos (min) — default 15
};

// Helper: formatear una Date "d" en la zona tz con patrón "fmt"
function formatInTZ(d: Date, tz: string, fmt: string) {
    // tzFormat acepta { timeZone } y respeta locale si la pasas en opciones
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

    // Weekday (en tz): tomar mediodía local para evitar DST
    const middayLocal = new Date(`${dateISO}T12:00:00`);
    const middayUtc = zonedTimeToUtc(middayLocal, tz);
    const isoDay = Number(formatInTZ(middayUtc, tz, "i")); // 1..7
    const weekdayEnum = isoToWeekdayEnum(isoDay);

    // 1) Horario base del día
    const hours = await prisma.appointmentHour.findUnique({
        where: { empresaId_day: { empresaId, day: weekdayEnum } },
        select: { isOpen: true, start1: true, end1: true, start2: true, end2: true },
    });
    if (!hours || !hours.isOpen) return [];

    // 2) Excepción para ese día (cierre / recorte)
    const { dayStartUtc, dayEndUtc } = dayBoundsUtc(dateISO, tz);
    const exception = await prisma.appointmentException.findFirst({
        where: { empresaId, date: { gte: dayStartUtc, lte: dayEndUtc } },
        select: { isOpen: true, start1: true, end1: true, start2: true, end2: true },
    });
    if (exception && exception.isOpen === false) return []; // cerrado

    // 3) Ventanas definitivas
    const ranges = buildRangesFromExceptionOrHours({
        start1: hours.start1, end1: hours.end1,
        start2: hours.start2, end2: hours.end2,
        exStart1: exception?.start1, exEnd1: exception?.end1,
        exStart2: exception?.start2, exEnd2: exception?.end2,
    });
    if (!ranges.length) return [];

    // 4) Citas que solapan con cualquier momento del día
    const overlapping = await prisma.appointment.findMany({
        where: {
            empresaId,
            status: { in: ["pending", "confirmed", "rescheduled"] as AppointmentStatus[] },
            startAt: { lt: dayEndUtc },
            endAt: { gt: dayStartUtc },
        },
        select: { startAt: true, endAt: true },
        orderBy: { startAt: "asc" },
    });

    const slots: Slot[] = [];

    for (const r of ranges) {
        // Ventana local → UTC
        const windowStartUtc = zonedTimeToUtc(new Date(`${dateISO}T${r.start}:00`), tz);
        const windowEndUtc = zonedTimeToUtc(new Date(`${dateISO}T${r.end}:00`), tz);

        // Cursor en local (para sumar minutos); luego convertimos a UTC
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
                // ISO con offset del tz
                const startISO = tzFormat(utcToZonedTime(slotStartUtc, tz), "yyyy-MM-dd'T'HH:mm:ssXXX", { timeZone: tz });
                const endISO = tzFormat(utcToZonedTime(slotEndUtc, tz), "yyyy-MM-dd'T'HH:mm:ssXXX", { timeZone: tz });
                slots.push({ startISO, endISO });
            }

            cursorLocal = addMinutes(cursorLocal, granularityMin);
            if (zonedTimeToUtc(cursorLocal, tz) >= windowEndUtc) break; // corte de seguridad
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
        // +1 día simple (no dependemos del tz para la etiqueta YYYY-MM-DD)
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

/** Crear cita validando solapes (recibe ISO con offset) */
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
        empresaId,
        vertical,
        timezone: tz,
        procedureId,
        serviceName,
        customerName,
        customerPhone,
        notes,
        startISO,
        endISO,
        source = "ai",
    } = params;

    const startUtc = zonedTimeToUtc(new Date(startISO), tz);
    const endUtc = zonedTimeToUtc(new Date(endISO), tz);
    if (!(startUtc instanceof Date) || isNaN(startUtc.valueOf()) || !(endUtc instanceof Date) || isNaN(endUtc.valueOf()) || endUtc <= startUtc) {
        throw new Error("Rango de tiempo inválido");
    }

    // Solape estricto
    const overlap = await prisma.appointment.findFirst({
        where: {
            empresaId,
            status: { in: ["pending", "confirmed", "rescheduled"] as AppointmentStatus[] },
            startAt: { lt: endUtc },
            endAt: { gt: startUtc },
        },
        select: { id: true },
    });
    if (overlap) throw new Error("El horario seleccionado ya no está disponible.");

    const durationMin = Math.round((endUtc.getTime() - startUtc.getTime()) / 60000);

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
            startAt: startUtc,
            endAt: endUtc,
            timezone: tz,
            procedureId: procedureId ?? undefined,
            notas: notes ?? undefined,
        },
    });

    return appt;
}
