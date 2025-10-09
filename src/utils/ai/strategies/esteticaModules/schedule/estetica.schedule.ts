// utils/ai/strategies/esteticaModules/schedule/estetica.schedule.ts
import prisma from "../../../../../lib/prisma";
import { AppointmentStatus, Weekday } from "@prisma/client";
import { Logger } from "../../../../ai/strategies/esteticaModules/log";
import {
    fromLocalTZToUTC,
    fromUTCtoLocalTZ,
    parseHHMM,
} from "../datetime";

const log = Logger.child("estetica.schedule");

// ★ Offset fijo conocido en APPOINTMENT (no en appointmentHour)
const APPT_DB_OFFSET_MIN = 300; // 5h
function addMinutes(d: Date, min: number) { return new Date(d.getTime() + min * 60000); }
function applyApptOffsetWrite(utc: Date) { return addMinutes(utc, -APPT_DB_OFFSET_MIN); }
function applyApptOffsetRead(dbUtcWithOffset: Date) { return addMinutes(dbUtcWithOffset, APPT_DB_OFFSET_MIN); }

function formatLabel(dateUTC: Date, tz: string) {
    const local = fromUTCtoLocalTZ(dateUTC, tz);
    const dd = local.toLocaleDateString("es-CO", { weekday: "short", day: "2-digit", month: "short" });
    const hh = local.toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit", hour12: false });
    return `${dd} ${hh}`;
}

function weekdayFromDateUTC(dUTC: Date, tz: string): Weekday {
    const local = fromUTCtoLocalTZ(dUTC, tz);
    return (["sun", "mon", "tue", "wed", "thu", "fri", "sat"][local.getDay()] as Weekday);
}

async function getHoursForDay(empresaId: number, weekday: Weekday) {
    return prisma.appointmentHour.findUnique({ where: { empresaId_day: { empresaId, day: weekday } } });
}
async function getExceptionForDate(empresaId: number, dateUTC: Date) {
    // buscamos sólo por la “fecha” en UTC (excepciones guardadas por fecha)
    const start = new Date(Date.UTC(dateUTC.getUTCFullYear(), dateUTC.getUTCMonth(), dateUTC.getUTCDate(), 0, 0, 0));
    const end = new Date(Date.UTC(dateUTC.getUTCFullYear(), dateUTC.getUTCMonth(), dateUTC.getUTCDate() + 1, 0, 0, 0));
    return prisma.appointmentException.findFirst({
        where: { empresaId, date: { gte: start, lt: end } },
        orderBy: { updatedAt: "desc" },
    });
}

function withTimeUTC(refUTC: Date, hhmm: string, tz: string): Date {
    const { h, m } = parseHHMM(hhmm)!;
    const local = new Date(refUTC.getUTCFullYear(), refUTC.getUTCMonth(), refUTC.getUTCDate(), h, m, 0, 0);
    return fromLocalTZToUTC(fromUTCtoLocalTZ(local, tz), tz);
}

function buildSegmentsFromHours(
    tz: string,
    refUTC: Date,
    hours: { start1?: string | null; end1?: string | null; start2?: string | null; end2?: string | null }
) {
    const segs: Array<{ startUTC: Date; endUTC: Date }> = [];
    const pairs: Array<[string | null | undefined, string | null | undefined]> = [[hours.start1, hours.end1], [hours.start2, hours.end2]];
    for (const [s, e] of pairs) {
        if (!s || !e) continue;
        segs.push({ startUTC: withTimeUTC(refUTC, s, tz), endUTC: withTimeUTC(refUTC, e, tz) });
    }
    return segs;
}
function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date) {
    return aStart < bEnd && bStart < aEnd;
}

export type SlotView = { startAt: Date; endAt: Date; label: string };
export type FindSlotsOpts = {
    empresaId: number;
    timezone: string;
    serviceDurationMin: number;
    fromDateUTC: Date; // ancla en UTC (p.ej. “ahora” o mañana 09:00 local convertido a UTC)
    days: number;
    bufferMin?: number;
};

async function listExisting(empresaId: number, dayUTC: Date) {
    const start = new Date(Date.UTC(dayUTC.getUTCFullYear(), dayUTC.getUTCMonth(), dayUTC.getUTCDate(), 0, 0, 0));
    const end = new Date(Date.UTC(dayUTC.getUTCFullYear(), dayUTC.getUTCMonth(), dayUTC.getUTCDate() + 1, 0, 0, 0));
    // ★ Las citas en DB están “-5h”; al LEER debemos reversar para comparar en UTC real:
    const found = await prisma.appointment.findMany({
        where: {
            empresaId,
            status: { in: ["pending", "confirmed", "rescheduled"] },
            startAt: { gte: applyApptOffsetWrite(start), lt: applyApptOffsetWrite(end) }, // mover rango al espacio “DB”
            deletedAt: null,
        },
        select: { startAt: true, endAt: true },
    });
    return found.map(a => ({ startAt: applyApptOffsetRead(a.startAt), endAt: applyApptOffsetRead(a.endAt) }));
}

export async function findNextSlots(opts: FindSlotsOpts): Promise<SlotView[]> {
    const { empresaId, timezone, serviceDurationMin, fromDateUTC, days, bufferMin = 10 } = opts;
    const out: SlotView[] = [];
    let cursor = new Date(Date.UTC(fromDateUTC.getUTCFullYear(), fromDateUTC.getUTCMonth(), fromDateUTC.getUTCDate(), 0, 0, 0));

    for (let i = 0; i < days; i++) {
        const weekday = weekdayFromDateUTC(cursor, timezone);
        const baseHours = await getHoursForDay(empresaId, weekday);
        if (!baseHours || !baseHours.isOpen) { cursor = addMinutes(cursor, 1440); continue; }

        // excepción
        const ex = await getExceptionForDate(empresaId, cursor);
        let segs = buildSegmentsFromHours(timezone, cursor, baseHours);
        if (ex) {
            if (ex.isOpen === false) { cursor = addMinutes(cursor, 1440); continue; }
            const exSegs = buildSegmentsFromHours(timezone, cursor, ex);
            if (exSegs.length) segs = exSegs;
        }

        const existing = await listExisting(empresaId, cursor);

        for (const seg of segs) {
            let slotStart = new Date(seg.startUTC);
            while (addMinutes(slotStart, serviceDurationMin) <= seg.endUTC) {
                const slotEnd = addMinutes(slotStart, serviceDurationMin);

                // respeta buffer
                const slotStartBuf = addMinutes(slotStart, -bufferMin);
                const slotEndBuf = addMinutes(slotEnd, bufferMin);
                const hasOverlap = existing.some(e => overlaps(slotStartBuf, slotEndBuf, e.startAt, e.endAt));

                if (!hasOverlap) out.push({ startAt: slotStart, endAt: slotEnd, label: formatLabel(slotStart, timezone) });

                // paso “seguro”, evita grilla demasiado densa
                slotStart = addMinutes(slotStart, Math.max(5, Math.min(serviceDurationMin, 30)));
            }
        }
        cursor = addMinutes(cursor, 1440);
        if (out.length >= 30) break;
    }

    log.debug("findNextSlots result", { count: out.length, empresaId, serviceDurationMin });
    return out.slice(0, 30);
}

export type BookArgs = {
    empresaId: number;
    conversationId?: number | null;
    customerName: string;
    customerPhone: string;
    serviceName: string;
    serviceDurationMin: number;
    timezone: string;
    startAtUTC: Date; // validado contra slots (UTC real)
    notes?: string;
    procedureId?: number;
    staffId?: number;
    source?: "ai" | "agent" | "client";
};

export async function bookAppointment(args: BookArgs) {
    const endAtUTC = addMinutes(args.startAtUTC, args.serviceDurationMin);

    // Anti solape en DB (recordando offset al ESCRIBIR/CONSULTAR):
    const startDB = applyApptOffsetWrite(args.startAtUTC);
    const endDB = applyApptOffsetWrite(endAtUTC);

    const dup = await prisma.appointment.findFirst({
        where: {
            empresaId: args.empresaId,
            status: { in: ["pending", "confirmed", "rescheduled"] },
            deletedAt: null,
            AND: [{ startAt: { lt: endDB } }, { endAt: { gt: startDB } }],
        },
    });
    if (dup) { log.warn("book dup", { id: dup.id }); throw new Error("Ese horario acaba de ocuparse. Probemos otro."); }

    const appt = await prisma.appointment.create({
        data: {
            empresaId: args.empresaId,
            conversationId: args.conversationId ?? null,
            source: args.source === "ai" ? "ai" : "client",
            status: "pending",
            customerName: args.customerName,
            customerPhone: args.customerPhone,
            customerDisplayName: args.customerName,
            serviceName: args.serviceName,
            serviceDurationMin: args.serviceDurationMin,
            notas: args.notes ?? null,
            procedureId: args.procedureId ?? null,
            staffId: args.staffId ?? null,
            timezone: args.timezone,
            startAt: startDB, // ★ guardar con offset
            endAt: endDB,     // ★ guardar con offset
        },
    });

    log.info("booked", { apptId: appt.id, empresaId: args.empresaId, service: args.serviceName });
    return appt;
}

// ================= Reagendar y Cancelar =================

export type RescheduleArgs = {
    empresaId: number;
    appointmentId: number;
    // nueva hora en UTC real (sin offset de la tabla):
    newStartAtUTC: Date;
    // si no se pasa, usa la duración ya guardada en la cita
    serviceDurationMin?: number;
};

export async function rescheduleAppointment(args: RescheduleArgs) {
    const { empresaId, appointmentId, newStartAtUTC } = args;

    const appt = await prisma.appointment.findFirst({
        where: {
            id: appointmentId,
            empresaId,
            status: { in: ["pending", "confirmed", "rescheduled"] },
            deletedAt: null,
        },
        select: {
            id: true, serviceName: true, serviceDurationMin: true, timezone: true,
            startAt: true, endAt: true, customerName: true, customerPhone: true,
        },
    });
    if (!appt) throw new Error("No encontré la cita a reagendar.");

    const duration = Number.isFinite(args.serviceDurationMin)
        ? Number(args.serviceDurationMin)
        : (appt.serviceDurationMin ?? 60);

    // Calcular nuevo rango en UTC real
    const newEndAtUTC = new Date(newStartAtUTC.getTime() + duration * 60000);

    // Mapeo al “espacio DB” (con offset -5h)
    const startDB = applyApptOffsetWrite(newStartAtUTC);
    const endDB = applyApptOffsetWrite(newEndAtUTC);

    // Validar solape con otras citas
    const dup = await prisma.appointment.findFirst({
        where: {
            empresaId,
            id: { not: appointmentId },
            status: { in: ["pending", "confirmed", "rescheduled"] },
            deletedAt: null,
            AND: [{ startAt: { lt: endDB } }, { endAt: { gt: startDB } }],
        },
        select: { id: true },
    });
    if (dup) throw new Error("Ese horario ya está ocupado. Probemos otro.");

    const updated = await prisma.appointment.update({
        where: { id: appointmentId },
        data: {
            startAt: startDB,
            endAt: endDB,
            status: "rescheduled",
            serviceDurationMin: duration,
        },
        select: {
            id: true, serviceName: true, startAt: true, endAt: true, timezone: true,
            customerName: true, customerPhone: true, serviceDurationMin: true, status: true,
        },
    });

    // Devolvemos tiempos corregidos a UTC real
    return {
        ...updated,
        startAt: applyApptOffsetRead(updated.startAt),
        endAt: applyApptOffsetRead(updated.endAt),
    };
}

export async function cancelAppointment(
    empresaId: number,
    appointmentId: number,
    reason?: string
) {
    const appt = await prisma.appointment.findFirst({
        where: {
            id: appointmentId,
            empresaId,
            status: { in: ["pending", "confirmed", "rescheduled"] },
            deletedAt: null,
        },
        select: { id: true, notas: true },
    });
    if (!appt) throw new Error("No encontré una cita activa para cancelar.");

    const notas = (appt.notas ? appt.notas + "\n" : "") + (reason ? `Cancelación: ${reason}` : "Cancelación solicitada.");

    const updated = await prisma.appointment.update({
        where: { id: appointmentId },
        data: { status: "cancelled", notas },
        select: { id: true, status: true },
    });

    return updated;
}
