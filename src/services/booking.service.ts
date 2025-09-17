// src/services/booking.service.ts
import prisma from "../lib/prisma";
import { hasOverlap } from "../controllers/_availability";
import { DateTime, Interval } from "luxon";

/* ============================================
   Tipos
============================================ */
export type BookParams = {
    empresaId: number;
    conversationId?: number;
    customerName: string;
    customerPhone: string;
    serviceName: string;
    startsAt: Date; // UTC o JS Date estándar
    endsAt: Date;   // UTC o JS Date estándar
    notas?: string | null;
    enforceWorkingHours?: boolean; // valida contra appointmentHours (default: true)
};

export type RescheduleParams = {
    empresaId: number;
    appointmentId: number;
    startsAt: Date;
    endsAt: Date;
    enforceWorkingHours?: boolean;
};

/* ============================================
   Utils internos
============================================ */
function getWeekdayKey(dt: DateTime): "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat" {
    // Luxon: Monday=1..Sunday=7
    const map = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
    return map[dt.weekday % 7];
}

/** Verifica si el rango [start,end] cae dentro de los bloques abiertos del día (en TZ de negocio). */
async function isWithinWorkingHours(empresaId: number, tz: string, startAt: Date, endAt: Date): Promise<boolean> {
    const startLocal = DateTime.fromJSDate(startAt).setZone(tz);
    const endLocal = DateTime.fromJSDate(endAt).setZone(tz);
    if (!startLocal.isValid || !endLocal.isValid || endLocal <= startLocal) return false;

    const dayKey = getWeekdayKey(startLocal);
    // Si cruza de día, lo rechazamos (para MVP). Puedes ampliar si requieres.
    if (getWeekdayKey(endLocal) !== dayKey) return false;

    const row = await prisma.appointmentHour.findUnique({
        where: { empresaId_day: { empresaId, day: dayKey } },
        select: { isOpen: true, start1: true, end1: true, start2: true, end2: true },
    });

    if (!row || !row.isOpen) return false;

    const mkIv = (s?: string | null, e?: string | null) => {
        if (!s || !e) return null;
        const [sh, sm] = s.split(":").map(Number);
        const [eh, em] = e.split(":").map(Number);
        const sdt = startLocal.startOf("day").set({ hour: sh, minute: sm });
        const edt = startLocal.startOf("day").set({ hour: eh, minute: em });
        if (!sdt.isValid || !edt.isValid || edt <= sdt) return null;
        return Interval.fromDateTimes(sdt, edt);
    };

    const b1 = mkIv(row.start1, row.end1);
    const b2 = mkIv(row.start2, row.end2);
    const slot = Interval.fromDateTimes(startLocal, endLocal);

    return !!((b1 && b1.contains(slot.start) && b1.contains(slot.end)) ||
        (b2 && b2.contains(slot.start) && b2.contains(slot.end)));
}

/* ============================================
   API de servicio
============================================ */
export async function bookAppointment(params: BookParams) {
    const {
        empresaId,
        conversationId,
        customerName,
        customerPhone,
        serviceName,
        startsAt,
        endsAt,
        notas = null,
        enforceWorkingHours = true,
    } = params;

    // 1) Config del negocio
    const cfg = await prisma.businessConfig.findUnique({ where: { empresaId } });
    if (!cfg) return { ok: false as const, error: "Config de negocio no encontrada." };
    if (!cfg.appointmentEnabled)
        return { ok: false as const, error: "La agenda no está habilitada para este negocio." };

    const tz = cfg.appointmentTimezone || "America/Bogota";
    const bufferMin = cfg.appointmentBufferMin ?? 10;

    // 2) Normalizar tiempo y validar
    const start = DateTime.fromJSDate(startsAt);
    const end = DateTime.fromJSDate(endsAt);
    if (!start.isValid || !end.isValid) return { ok: false as const, error: "Fecha/hora inválida." };
    if (end <= start) return { ok: false as const, error: "El fin debe ser mayor al inicio." };

    // 3) Validar que el slot cae dentro de los horarios abiertos (opcional)
    if (enforceWorkingHours) {
        const inside = await isWithinWorkingHours(empresaId, tz, start.toJSDate(), end.toJSDate());
        if (!inside) return { ok: false as const, error: "La hora seleccionada está fuera del horario de atención." };
    }

    // 4) Chequeo de solapes con buffer
    const checkStart = start.minus({ minutes: bufferMin }).toJSDate();
    const checkEnd = end.plus({ minutes: bufferMin }).toJSDate();
    const conflict = await hasOverlap({ empresaId, startAt: checkStart, endAt: checkEnd });
    if (conflict) return { ok: false as const, error: "Ese horario ya está ocupado." };

    // 5) Transacción con re-chequeo (evita carrera)
    try {
        const created = await prisma.$transaction(async (tx) => {
            const again = await tx.appointment.findFirst({
                where: {
                    empresaId,
                    AND: [{ startAt: { lt: checkEnd } }, { endAt: { gt: checkStart } }],
                },
                select: { id: true },
            });
            if (again) throw new Error("Horario ocupado (race).");

            return tx.appointment.create({
                data: {
                    empresaId,
                    conversationId: conversationId ?? null,
                    source: "client",    // ajusta si tu flujo define otra fuente
                    status: "pending",   // o "confirmed" si confirmas en un paso
                    customerName,
                    customerPhone,
                    serviceName,
                    notas,
                    startAt: start.toJSDate(), // guarda UTC
                    endAt: end.toJSDate(),
                    timezone: tz,
                },
            });
        });

        return { ok: true as const, id: created.id, when: created.startAt, tz };
    } catch (e: any) {
        return { ok: false as const, error: e?.message || "No se pudo crear la cita." };
    }
}

export async function rescheduleAppointment(params: RescheduleParams) {
    const { empresaId, appointmentId, startsAt, endsAt, enforceWorkingHours = true } = params;

    const cfg = await prisma.businessConfig.findUnique({ where: { empresaId } });
    if (!cfg) return { ok: false as const, error: "Config de negocio no encontrada." };

    const tz = cfg.appointmentTimezone || "America/Bogota";
    const bufferMin = cfg.appointmentBufferMin ?? 10;

    const start = DateTime.fromJSDate(startsAt);
    const end = DateTime.fromJSDate(endsAt);
    if (!start.isValid || !end.isValid || end <= start)
        return { ok: false as const, error: "Rango de fechas inválido." };

    if (enforceWorkingHours) {
        const inside = await isWithinWorkingHours(empresaId, tz, start.toJSDate(), end.toJSDate());
        if (!inside) return { ok: false as const, error: "La hora seleccionada está fuera del horario de atención." };
    }

    const checkStart = start.minus({ minutes: bufferMin }).toJSDate();
    const checkEnd = end.plus({ minutes: bufferMin }).toJSDate();

    // Evitar solape con otras citas (excluyendo la misma)
    const conflict = await prisma.appointment.findFirst({
        where: {
            empresaId,
            NOT: { id: appointmentId },
            AND: [{ startAt: { lt: checkEnd } }, { endAt: { gt: checkStart } }],
        },
        select: { id: true },
    });
    if (conflict) return { ok: false as const, error: "Horario ocupado." };

    await prisma.appointment.update({
        where: { id: appointmentId },
        data: { startAt: start.toJSDate(), endAt: end.toJSDate() },
    });

    return { ok: true as const };
}

export async function cancelAppointment(empresaId: number, appointmentId: number) {
    const row = await prisma.appointment.findUnique({ where: { id: appointmentId } });
    if (!row || row.empresaId !== empresaId) return { ok: false as const, error: "Cita no encontrada." };

    await prisma.appointment.update({
        where: { id: appointmentId },
        data: { status: "cancelled" },
    });

    return { ok: true as const };
}
