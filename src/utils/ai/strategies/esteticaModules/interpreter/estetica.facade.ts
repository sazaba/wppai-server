// utils/ai/strategies/esteticaModules/schedule/estetica.facade.ts
import prisma from "../../../../../lib/prisma";
import {
    getNextAvailableSlots as _getNextAvailableSlots,
    createAppointmentSafe as _createAppointmentSafe,
    handleSchedulingTurn, // 🔥 agente principal
} from "../schedule/estetica.schedule";

import type {
    AppointmentStatus,
    AppointmentVertical,
} from "@prisma/client";

import type {
    Slot,
    SlotsByDay,
    KBMinimal,
    StateShape,
    SchedulingCtx,
    SchedulingResult,
    InterpreterNLU,
} from "../schedule/estetica.schedule";

/* ============================================================
   📅 FUNCIONES AUXILIARES
============================================================ */
export type DayPeriod = "morning" | "afternoon" | "evening";
export type LabeledSlot = { startISO: string; endISO: string; label: string };

export type FindSlotsArgs = {
    empresaId: number;
    timezone: string;
    vertical: AppointmentVertical | "custom";
    bufferMin?: number | null;
    granularityMin: number;
    pivotLocalDateISO: string;
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

    const flat: Slot[] = byDay.flatMap((d: SlotsByDay) => d.slots);

    const fmt = new Intl.DateTimeFormat("es-CO", {
        timeZone: args.timezone,
        weekday: "long",
        day: "2-digit",
        month: "short",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
    });

    return flat.map((s) => ({
        startISO: s.startISO,
        endISO: s.endISO,
        label: fmt.format(new Date(s.startISO)),
    }));
}

/* ============================================================
   ✳️ BOOK / CANCEL / RESCHEDULE
============================================================ */
export type BookArgs = {
    empresaId: number;
    timezone: string;
    vertical: AppointmentVertical | "custom";
    bufferMin?: number | null;
    procedureId?: number | null;
    serviceName: string;
    customerName: string;
    customerPhone: string;
    startISO: string;
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

    const blocking: AppointmentStatus[] = ["pending", "confirmed", "rescheduled"];
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
    newStartISO: string;
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

/* ============================================================
   🤖 RUN_AGENT_TURN — modo ChatGPT total
============================================================ */
export type RunAgentTurnArgs = {
    text: string;
    empresaId: number;
    kb: KBMinimal;
    state: StateShape;
    intent: "price" | "schedule" | "reschedule" | "cancel" | "info" | "other";
    granularityMin: number;
    daysHorizon: number;
    maxSlots: number;
    serviceInContext?: { id: number; name: string; durationMin?: number | null } | null;
    nlu?: InterpreterNLU | null;
    now?: Date;
};

export async function RUN_AGENT_TURN(args: RunAgentTurnArgs): Promise<SchedulingResult> {
    const ctx: SchedulingCtx = {
        empresaId: args.empresaId,
        kb: args.kb,
        granularityMin: args.granularityMin,
        daysHorizon: args.daysHorizon,
        maxSlots: args.maxSlots,
        now: args.now,
    };

    return handleSchedulingTurn({
        text: args.text,
        state: args.state,
        ctx,
        serviceInContext: args.serviceInContext ?? null,
        intent: args.intent,
        nlu: args.nlu ?? undefined,
    });
}
