// utils/ai/strategies/esteticaModules/booking/schedule.core.ts
import prisma from "../../../../../lib/prisma";
import type { EsteticaCtx } from "../domain/estetica.rag";
import {
    AppointmentSource,
    AppointmentStatus,
    type Appointment,
} from "@prisma/client";

export const ESTETICA_SCHEDULE_CORE_VERSION = "schedule-core@2025-10-02-a";

/* ========= Tipos locales ========= */
type HourRow = {
    day: "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";
    isOpen: boolean;
    start1: string | null;
    end1: string | null;
    start2: string | null;
    end2: string | null;
};

type ExceptionRow = {
    date: Date;
    isOpen: boolean | null;
    start1: string | null;
    end1: string | null;
    start2: string | null;
    end2: string | null;
};

type FindSlotsArgs = {
    empresaId: number;
    ctx: EsteticaCtx;
    hint?: Date | null;
    durationMin?: number;
    count?: number;
};

/* ========= Utilidades TZ ========= */
const DAY_MAP: Record<number, HourRow["day"]> = {
    0: "sun",
    1: "mon",
    2: "tue",
    3: "wed",
    4: "thu",
    5: "fri",
    6: "sat",
};

function addMinutes(d: Date, m: number) {
    return new Date(d.getTime() + m * 60000);
}
function addDays(d: Date, days: number) {
    return new Date(d.getTime() + days * 86400000);
}
function ymdInTZ(d: Date, tz: string): string {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(d);
}
function weekdayInTZ(d: Date, tz: string): number {
    const p = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        weekday: "short",
    }).formatToParts(d);
    const w = p.find((x) => x.type === "weekday")?.value?.toLowerCase() ?? "";
    return ({ sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 } as Record<
        string,
        number
    >)[w.slice(0, 3)]!;
}
function makeZonedDate(ymd: string, hhmm: string, tz: string): Date {
    const [y, m, d] = ymd.split("-").map(Number);
    const [h, mi] = hhmm.split(":").map(Number);
    const utcGuess = new Date(Date.UTC(y, m - 1, d, h, mi));
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    }).formatToParts(utcGuess);
    const gotH = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
    const gotM = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
    const delta = h * 60 + mi - (gotH * 60 + gotM);
    return new Date(utcGuess.getTime() + delta * 60000);
}
function startOfDayTZ(d: Date, tz: string) {
    return makeZonedDate(ymdInTZ(d, tz), "00:00", tz);
}
function endOfDayTZ(d: Date, tz: string) {
    return makeZonedDate(ymdInTZ(d, tz), "23:59", tz);
}
function isBlackout(ymdKey: string, ctx: EsteticaCtx) {
    const list = ctx.rules?.blackoutDates ?? [];
    return Array.isArray(list) && list.includes(ymdKey);
}

/* ========= Exceptions ========= */
async function safeFetchExceptions(empresaId: number): Promise<ExceptionRow[]> {
    try {
        const rows = await prisma.appointmentException.findMany({
            where: { empresaId },
        });
        return rows.map((r) => ({
            date: r.date,
            isOpen: r?.isOpen ?? null,
            start1: r?.start1 ?? null,
            end1: r?.end1 ?? null,
            start2: r?.start2 ?? null,
            end2: r?.end2 ?? null,
        }));
    } catch {
        return [];
    }
}

/* ========= Windows ========= */
function getOpenWindowsForDay({
    tz,
    ymd,
    hours,
    exceptions,
}: {
    tz: string;
    ymd: string;
    hours: HourRow[];
    exceptions: ExceptionRow[];
}): Array<{ start: string; end: string }> {
    const ex = exceptions.find((e) => ymdInTZ(e.date, tz) === ymd);
    if (ex) {
        if (ex.isOpen === false) return [];
        const pairs: [string | null, string | null][] = [
            [ex.start1, ex.end1],
            [ex.start2, ex.end2],
        ];
        return pairs
            .filter(([s, e]) => !!s && !!e)
            .map(([s, e]) => ({ start: s!, end: e! }));
    }

    const weekday = DAY_MAP[weekdayInTZ(makeZonedDate(ymd, "00:00", tz), tz)];
    const todays = hours.filter((h) => h.day === weekday && h.isOpen);
    const pairs = todays
        .flatMap(
            (h) => [[h.start1, h.end1], [h.start2, h.end2]] as [
                string | null,
                string | null
            ][]
        )
        .filter(([s, e]) => !!s && !!e);
    return pairs.map(([s, e]) => ({ start: s!, end: e! }));
}

/* ========= Public API (core) ========= */
export async function findSlotsCore({
    empresaId,
    ctx,
    hint,
    durationMin = 60,
    count = 8,
}: FindSlotsArgs): Promise<Date[]> {
    const now = new Date();
    const bookingWindowDays =
        ctx.rules?.bookingWindowDays ?? ctx.rules?.maxAdvanceDays ?? 30;

    const from = hint ? new Date(hint) : now;
    const to = addDays(from, bookingWindowDays);

    const minNoticeH = ctx.rules?.minNoticeHours ?? 0;
    const earliest = new Date(
        now.getTime() + (minNoticeH * 60 + (ctx.bufferMin ?? 0)) * 60000
    );

    const [hours, rawExceptions] = await Promise.all([
        prisma.appointmentHour.findMany({
            where: { empresaId, isOpen: true },
            select: {
                day: true,
                isOpen: true,
                start1: true,
                end1: true,
                start2: true,
                end2: true,
            },
        }),
        safeFetchExceptions(empresaId),
    ]);

    const out: Date[] = [];
    let cursor = new Date(from);

    while (cursor < to && out.length < count) {
        const ymd = ymdInTZ(cursor, ctx.timezone);

        const isSameDay = ymd === ymdInTZ(now, ctx.timezone);
        if (isSameDay && !(ctx.rules?.allowSameDay ?? false)) {
            cursor = addDays(cursor, 1);
            continue;
        }
        if (isBlackout(ymd, ctx)) {
            cursor = addDays(cursor, 1);
            continue;
        }

        const windows = getOpenWindowsForDay({
            tz: ctx.timezone,
            ymd,
            hours: (hours as unknown) as HourRow[],
            exceptions: rawExceptions,
        });
        for (const w of windows) {
            await collectSlotsInRangeTZ(
                ymd,
                ctx.timezone,
                w.start,
                w.end,
                durationMin,
                earliest,
                out,
                count,
                empresaId,
                ctx
            );
            if (out.length >= count) break;
        }
        cursor = addDays(cursor, 1);
    }
    return out;
}

async function collectSlotsInRangeTZ(
    ymdKey: string,
    tz: string,
    startHHmm: string,
    endHHmm: string,
    durationMin: number,
    earliest: Date,
    acc: Date[],
    limit: number,
    empresaId: number,
    ctx: EsteticaCtx
) {
    let cursor = makeZonedDate(ymdKey, startHHmm, tz);
    const end = makeZonedDate(ymdKey, endHHmm, tz);
    const step = 15;

    while (cursor.getTime() + durationMin * 60000 <= end.getTime()) {
        const slotEnd = addMinutes(cursor, durationMin);
        if (slotEnd < earliest) {
            cursor = addMinutes(cursor, step);
            continue;
        }

        const free = await isSlotFree(empresaId, cursor, durationMin, ctx);
        const cap = await isUnderDailyCap(empresaId, cursor, ctx);
        if (free && cap) acc.push(new Date(cursor));

        if (acc.length >= limit) break;
        cursor = addMinutes(cursor, step);
    }
}

async function isSlotFree(
    empresaId: number,
    start: Date,
    durationMin: number,
    ctx?: EsteticaCtx
) {
    const buffer = ctx?.bufferMin ?? 0;
    const startWithBuffer = new Date(start.getTime() - buffer * 60000);
    const endWithBuffer = new Date(start.getTime() + (durationMin + buffer) * 60000);

    const overlap = await prisma.appointment.count({
        where: {
            empresaId,
            deletedAt: null,
            status: { notIn: [AppointmentStatus.cancelled, AppointmentStatus.no_show] },
            AND: [{ startAt: { lt: endWithBuffer } }, { endAt: { gt: startWithBuffer } }],
        },
    });
    return overlap === 0;
}

async function isUnderDailyCap(
    empresaId: number,
    start: Date,
    ctx: EsteticaCtx
) {
    const cap = ctx.rules?.maxDailyAppointments;
    if (!cap) return true;
    const s = startOfDayTZ(start, ctx.timezone);
    const e = endOfDayTZ(start, ctx.timezone);
    const count = await prisma.appointment.count({
        where: {
            empresaId,
            deletedAt: null,
            status: { notIn: [AppointmentStatus.cancelled, AppointmentStatus.no_show] },
            startAt: { gte: s, lte: e },
        },
    });
    return count < cap;
}

/* ========= Book / Update / Cancel ========= */
export async function bookCore(
    args: {
        empresaId: number;
        conversationId: number;
        customerPhone: string;
        customerName: string;
        serviceName: string;
        startAt: Date;
        durationMin: number;
        timezone: string;
        procedureId?: number;
        notes?: string;
    },
    ctx: EsteticaCtx
): Promise<Appointment> {
    const endAt = new Date(args.startAt.getTime() + args.durationMin * 60000);

    return prisma.$transaction(async (tx) => {
        const free = await isSlotFree(
            args.empresaId,
            args.startAt,
            args.durationMin,
            ctx
        );
        if (!free) throw new Error("CONFLICT_SLOT");

        const dup = await tx.appointment.findFirst({
            where: {
                empresaId: args.empresaId,
                customerPhone: args.customerPhone,
                startAt: args.startAt,
                deletedAt: null,
                status: { notIn: [AppointmentStatus.cancelled, AppointmentStatus.no_show] },
            },
            select: { id: true },
        });
        if (dup) throw new Error("DUPLICATE_APPOINTMENT");

        const needClientConfirm = !!ctx.rules?.requireConfirmation;
        const status: AppointmentStatus = needClientConfirm
            ? AppointmentStatus.pending
            : AppointmentStatus.confirmed;

        return tx.appointment.create({
            data: {
                empresaId: args.empresaId,
                conversationId: args.conversationId,
                source: AppointmentSource.ai,
                status,
                customerName: args.customerName ?? "",
                customerPhone: args.customerPhone,
                serviceName: args.serviceName,
                customerDisplayName: args.customerName ?? null,
                notas: args.notes ?? null,
                serviceDurationMin: args.durationMin,
                locationNameCache: ctx.logistics?.locationName ?? null,
                startAt: args.startAt,
                endAt,
                timezone: args.timezone,
                procedureId: args.procedureId ?? null,
                deletedAt: null,
            },
        });
    });
}

export async function rescheduleCore(
    args: { empresaId: number; appointmentId: number; newStartAt: Date },
    ctx: EsteticaCtx
): Promise<Appointment> {
    return prisma.$transaction(async (tx) => {
        const appt = await tx.appointment.findUnique({
            where: { id: args.appointmentId },
        });
        if (!appt || appt.deletedAt || appt.empresaId !== args.empresaId)
            throw new Error("Cita no existe");

        const duration =
            appt.serviceDurationMin ??
            Math.max(15, Math.round((appt.endAt.getTime() - appt.startAt.getTime()) / 60000));
        if (+appt.startAt === +args.newStartAt) return appt;

        const free = await isSlotFree(args.empresaId, args.newStartAt, duration, ctx);
        if (!free) throw new Error("Nuevo horario ocupado");

        return tx.appointment.update({
            where: { id: appt.id },
            data: {
                startAt: args.newStartAt,
                endAt: new Date(args.newStartAt.getTime() + duration * 60000),
                status: AppointmentStatus.rescheduled,
            },
        });
    });
}

export async function cancelCore(args: {
    empresaId: number;
    appointmentId: number;
}): Promise<Appointment> {
    const appt = await prisma.appointment.findUnique({
        where: { id: args.appointmentId },
    });
    if (!appt || appt.empresaId !== args.empresaId || appt.deletedAt)
        throw new Error("Cita no existe");

    return prisma.appointment.update({
        where: { id: args.appointmentId },
        data: { status: AppointmentStatus.cancelled, deletedAt: new Date() },
    });
}

export async function cancelManyCore(args: {
    empresaId: number;
    appointmentIds: number[];
}): Promise<
    Array<Pick<Appointment, "id" | "startAt" | "serviceName" | "timezone">>
> {
    const items = await prisma.appointment.findMany({
        where: { id: { in: args.appointmentIds }, empresaId: args.empresaId, deletedAt: null },
        select: { id: true, startAt: true, serviceName: true, timezone: true },
    });
    if (!items.length) return [];
    await prisma.appointment.updateMany({
        where: { id: { in: items.map((i) => i.id) }, empresaId: args.empresaId, deletedAt: null },
        data: { status: AppointmentStatus.cancelled, deletedAt: new Date() },
    });
    return items;
}

export async function listUpcomingApptsForPhone(
    empresaId: number,
    phoneE164: string
): Promise<Array<Pick<Appointment, "id" | "startAt" | "serviceName" | "timezone">>> {
    return prisma.appointment.findMany({
        where: {
            empresaId,
            customerPhone: phoneE164,
            deletedAt: null,
            status: {
                in: [
                    AppointmentStatus.pending,
                    AppointmentStatus.confirmed,
                    AppointmentStatus.rescheduled,
                ],
            },
            startAt: { gt: new Date() },
        },
        orderBy: { startAt: "asc" },
        select: { id: true, startAt: true, serviceName: true, timezone: true },
    });
}

// === NUEVO: buscador robusto con ventanas escalonadas ===
export async function findNextSlotsRobust(params: {
    empresaId: number;
    ctx: EsteticaCtx;
    hint?: Date | null;           // p.ej. "lunes" ya normalizado; opcional
    durationMin?: number;         // default 60 si no llega
    count?: number;               // cuántos slots devolver (máx 6 recomendado)
}): Promise<Date[]> {
    const { empresaId, ctx } = params;
    const durationMin = params.durationMin ?? (ctx.rules?.defaultServiceDurationMin ?? 60);
    const count = Math.max(1, Math.min(params.count ?? 6, 12));

    // 1) Si hay hint (lunes), intenta primero esa semana (7 días)
    const windows: Array<{ from: Date; days: number }> = [];
    const now = new Date();
    const base = params.hint ?? now;

    // Semana del hint
    windows.push({ from: base, days: 7 });

    // Mes desde mañana
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    windows.push({ from: tomorrow, days: 30 });

    // Mes siguiente (ampliar si aún no hay cupos)
    const in15 = new Date(now.getTime() + 15 * 24 * 60 * 60 * 1000);
    windows.push({ from: in15, days: 30 });

    const out: Date[] = [];
    for (const w of windows) {
        const partial = await findSlotsCore({
            empresaId,
            ctx,
            hint: w.from,
            durationMin,
            count: count - out.length,
        });
        for (const d of partial) {
            // dedupe por timestamp
            if (!out.some((x) => +x === +d)) out.push(d);
            if (out.length >= count) break;
        }
        if (out.length >= count) break;
    }

    return out.slice(0, count);
}
