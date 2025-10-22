// utils/ai/strategies/esteticaModules/schedule/estetica.facade.ts
import prisma from "../../../../../lib/prisma";
import {
    getNextAvailableSlots as _getNextAvailableSlots,
    createAppointmentSafe as _createAppointmentSafe,
} from "../schedule/estetica.schedule";
import type {
    AppointmentStatus,
    AppointmentVertical,
} from "@prisma/client";
import type { SlotsByDay, Slot } from "../schedule/estetica.schedule";;

export type DayPeriod = "morning" | "afternoon" | "evening";
export type LabeledSlot = { startISO: string; endISO: string; label: string };

export type FindSlotsArgs = {
    empresaId: number;
    timezone: string;
    vertical: AppointmentVertical | "custom";
    bufferMin?: number | null;
    granularityMin: number;
    pivotLocalDateISO: string; // YYYY-MM-DD en TZ del negocio
    durationMin: number;
    daysHorizon: number;
    maxSlots: number;
    period?: DayPeriod | null;
};

export async function FIND_SLOTS(args: FindSlotsArgs): Promise<LabeledSlot[]> {
    const byDay = await _getNextAvailableSlots(
        {
            empresaId: args.empresaId,
            timezone: args.timezone,
            vertical: args.vertical,
            bufferMin: args.bufferMin,
            granularityMin: args.granularityMin,
        },
        args.pivotLocalDateISO,
        args.durationMin,
        args.daysHorizon,
        args.maxSlots,
        args.period ?? undefined
    );

    // Flatea con tipos explícitos
    const flat: Slot[] = byDay.flatMap((d: SlotsByDay) => d.slots);

    // Formateador de label en la TZ del negocio
    const fmt = new Intl.DateTimeFormat("es-CO", {
        timeZone: args.timezone,
        weekday: "long",
        day: "2-digit",
        month: "short",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
    });

    const labeled: LabeledSlot[] = flat.map((s) => ({
        startISO: s.startISO,
        endISO: s.endISO,
        label: fmt.format(new Date(s.startISO)),
    }));

    return labeled;
}

export type BookArgs = {
    empresaId: number;
    timezone: string;
    vertical: AppointmentVertical | "custom";
    bufferMin?: number | null;
    procedureId?: number | null;
    serviceName: string;
    customerName: string;
    customerPhone: string;
    startISO: string; // UTC
    durationMin: number;
    notes?: string;
};

export async function BOOK_APPOINTMENT(args: BookArgs) {
    const endISO = new Date(
        new Date(args.startISO).getTime() + args.durationMin * 60_000
    ).toISOString();

    return _createAppointmentSafe({
        empresaId: args.empresaId,
        vertical: args.vertical,
        timezone: args.timezone,
        procedureId: args.procedureId ?? null,
        serviceName: args.serviceName,
        customerName: args.customerName,
        customerPhone: args.customerPhone,
        startISO: args.startISO,
        endISO,
        notes: args.notes ?? "Agendado por IA",
        bufferMin: args.bufferMin ?? 0,
        source: "ai",
    });
}

export type CancelArgs =
    | { empresaId: number; appointmentId: number }
    | { empresaId: number; phone: string };

export async function CANCEL_APPOINTMENT(args: CancelArgs) {
    if ("appointmentId" in args) {
        await prisma.appointment.update({
            where: { id: args.appointmentId },
            data: { status: "cancelled", deletedAt: new Date() },
        });
        return { ok: true };
    }

    const blocking: AppointmentStatus[] = [
        "pending",
        "confirmed",
        "rescheduled",
    ];
    const appt = await prisma.appointment.findFirst({
        where: {
            empresaId: args.empresaId,
            customerPhone: { contains: args.phone },
            status: { in: blocking },
            startAt: { gte: new Date() },
        },
        orderBy: { startAt: "asc" },
    });

    if (!appt) return { ok: false, reason: "NOT_FOUND" };

    await prisma.appointment.update({
        where: { id: appt.id },
        data: { status: "cancelled", deletedAt: new Date() },
    });
    return { ok: true, id: appt.id };
}

export type RescheduleArgs = {
    empresaId: number;
    appointmentId: number;
    timezone: string;
    newStartISO: string; // UTC
    durationMin: number;
};

export async function RESCHEDULE_APPOINTMENT(args: RescheduleArgs) {
    const startAt = new Date(args.newStartISO);
    const endAt = new Date(startAt.getTime() + args.durationMin * 60_000);

    await prisma.$transaction(async (tx) => {
        const appt = await tx.appointment.findUnique({
            where: { id: args.appointmentId },
        });
        if (!appt) throw new Error("APPT_NOT_FOUND");

        await tx.appointment.update({
            where: { id: args.appointmentId },
            data: {
                startAt,
                endAt,
                status: "confirmed",
                serviceDurationMin: args.durationMin,
                timezone: args.timezone,
            },
        });
    });

    return { ok: true };
}
