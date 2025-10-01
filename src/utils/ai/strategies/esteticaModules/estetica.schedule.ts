// server/src/utils/ai/strategies/esteticaModules/estetica.schedule.ts
import prisma from "../../../../lib/prisma";
import type { EsteticaCtx } from "./estetica.rag";
import { AppointmentSource, AppointmentStatus } from "@prisma/client";

export const ESTETICA_SCHEDULE_VERSION = "estetica-schedule@2025-10-01-a";

/* ==================== Constantes / Tipos ==================== */
const DAY_MAP: Record<number, "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat"> = {
    0: "sun",
    1: "mon",
    2: "tue",
    3: "wed",
    4: "thu",
    5: "fri",
    6: "sat",
};

type FindSlotsArgs = {
    empresaId: number;
    ctx: EsteticaCtx;
    hint?: Date | null;
    durationMin?: number;
    count?: number;
};

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

/* ==================== API principal ==================== */
export async function findSlots({
    empresaId,
    ctx,
    hint,
    durationMin = 60,
    count = 8,
}: FindSlotsArgs): Promise<Date[]> {
    const now = new Date();

    const bookingWindowDays = ctx.rules?.bookingWindowDays ?? ctx.rules?.maxAdvanceDays ?? 30;
    const from = hint ? new Date(hint) : now;
    const to = addDays(from, bookingWindowDays);

    const minNoticeH = ctx.rules?.minNoticeHours ?? 0;
    const earliest = addMinutes(now, minNoticeH * 60 + (ctx.bufferMin ?? 0));

    const [hours, rawExceptions] = await Promise.all([
        prisma.appointmentHour.findMany({
            where: { empresaId, isOpen: true },
            select: { day: true, isOpen: true, start1: true, end1: true, start2: true, end2: true },
        }),
        safeFetchExceptions(empresaId),
    ]);

    console.debug("[schedule.findSlots] in", {
        v: ESTETICA_SCHEDULE_VERSION,
        empresaId,
        tz: ctx.timezone,
        hint,
        durationMin,
        count,
        rules: ctx.rules,
        hours: hours.length,
        exceptions: rawExceptions.length,
    });

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

        const windows = getOpenWindowsForDay({ tz: ctx.timezone, ymd, hours, exceptions: rawExceptions });

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

    console.debug("[schedule.findSlots] out", { v: ESTETICA_SCHEDULE_VERSION, found: out.length });
    return out;
}

/* ==================== Mutaciones ==================== */
export async function book(
    args: {
        empresaId: number;
        conversationId: number;
        customerPhone: string;
        customerName?: string;
        serviceName: string;
        startAt: Date;
        durationMin: number;
        timezone: string;
        procedureId?: number;
        notes?: string;
    },
    ctx: EsteticaCtx
) {
    const endAt = addMinutes(args.startAt, args.durationMin);

    return prisma.$transaction(async (tx) => {
        const free = await isSlotFree(args.empresaId, args.startAt, args.durationMin, ctx);
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

        const proc = args.procedureId
            ? await tx.esteticaProcedure.findUnique({
                where: { id: args.procedureId },
                select: { depositRequired: true },
            })
            : null;

        const needClientConfirm = !!ctx.rules?.requireConfirmation;
        const needDeposit = !!proc?.depositRequired;
        const status: AppointmentStatus =
            needClientConfirm || needDeposit ? AppointmentStatus.pending : AppointmentStatus.confirmed;

        const appt = await tx.appointment.create({
            data: {
                empresaId: args.empresaId,
                conversationId: args.conversationId,
                source: AppointmentSource.ai,
                status,
                customerName: args.customerName ?? "",
                customerPhone: args.customerPhone,
                serviceName: args.serviceName,
                notas: args.notes ?? null,
                customerDisplayName: args.customerName ?? null,
                serviceDurationMin: args.durationMin,
                locationNameCache: ctx.logistics?.locationName ?? null,
                startAt: args.startAt,
                endAt,
                timezone: args.timezone,
                procedureId: args.procedureId ?? null,
                deletedAt: null,
            },
        });

        return appt;
    });
}

export async function reschedule(
    args: { empresaId: number; appointmentId: number; newStartAt: Date },
    ctx: EsteticaCtx
) {
    return prisma.$transaction(async (tx) => {
        const appt = await tx.appointment.findUnique({ where: { id: args.appointmentId } });
        if (!appt || appt.deletedAt || appt.empresaId !== args.empresaId) throw new Error("Cita no existe");

        const duration =
            appt.serviceDurationMin ??
            Math.max(15, Math.round((appt.endAt.getTime() - appt.startAt.getTime()) / 60000));

        if (+appt.startAt === +args.newStartAt) return appt;

        const free = await isSlotFree(args.empresaId, args.newStartAt, duration, ctx);
        if (!free) throw new Error("Nuevo horario ocupado");

        const updated = await tx.appointment.update({
            where: { id: appt.id },
            data: {
                startAt: args.newStartAt,
                endAt: addMinutes(args.newStartAt, duration),
                status: AppointmentStatus.rescheduled,
            },
        });

        return updated;
    });
}

export async function cancel(args: { empresaId: number; appointmentId: number }) {
    const appt = await prisma.appointment.findUnique({ where: { id: args.appointmentId } });
    if (!appt || appt.empresaId !== args.empresaId || appt.deletedAt) throw new Error("Cita no existe");

    const deleted = await prisma.appointment.update({
        where: { id: args.appointmentId },
        data: { status: AppointmentStatus.cancelled, deletedAt: new Date() },
    });
    return deleted;
}

export async function cancelMany(args: { empresaId: number; appointmentIds: number[] }) {
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

/** Próxima / listado por teléfono */
export async function findNextUpcomingApptForPhone(empresaId: number, phoneE164: string) {
    return prisma.appointment.findFirst({
        where: {
            empresaId,
            customerPhone: phoneE164,
            deletedAt: null,
            status: { in: [AppointmentStatus.pending, AppointmentStatus.confirmed, AppointmentStatus.rescheduled] },
            startAt: { gt: new Date() },
        },
        orderBy: { startAt: "asc" },
        select: { id: true, startAt: true, serviceName: true },
    });
}

export async function listUpcomingApptsForPhone(empresaId: number, phoneE164: string) {
    return prisma.appointment.findMany({
        where: {
            empresaId,
            customerPhone: phoneE164,
            deletedAt: null,
            status: { in: [AppointmentStatus.pending, AppointmentStatus.confirmed, AppointmentStatus.rescheduled] },
            startAt: { gt: new Date() },
        },
        orderBy: { startAt: "asc" },
        select: { id: true, startAt: true, serviceName: true },
    });
}

/* ==================== Helpers ==================== */
function isBlackout(ymdKey: string, ctx: EsteticaCtx) {
    const list = ctx.rules?.blackoutDates ?? [];
    return Array.isArray(list) && list.some((d) => d === ymdKey);
}
function addMinutes(d: Date, min: number) {
    return new Date(d.getTime() + min * 60000);
}
function addDays(d: Date, days: number) {
    return new Date(d.getTime() + days * 86400000);
}

function ymdInTZ(d: Date, tz: string): string {
    const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    return f.format(d);
}
function weekdayInTZ(d: Date, tz: string): number {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).formatToParts(d);
    const w = p.find((x) => x.type === "weekday")?.value?.toLowerCase();
    return ({ sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 } as any)[String(w).slice(0, 3)] ?? 0;
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
    const deltaMin = h * 60 + mi - (gotH * 60 + gotM);
    return new Date(utcGuess.getTime() + deltaMin * 60000);
}

/** ✅ Sin SELECT de campos inexistentes: mapea de forma segura */
async function safeFetchExceptions(empresaId: number): Promise<ExceptionRow[]> {
    try {
        const rows = (await prisma.appointmentException.findMany({ where: { empresaId } } as any)) as any[];
        return rows.map((r: any) => ({
            date: r.date,
            isOpen: r?.isOpen ?? null,
            start1: r?.start1 ?? null,
            end1: r?.end1 ?? null,
            start2: r?.start2 ?? null,
            end2: r?.end2 ?? null,
        }));
    } catch {
        const rows = (await prisma.appointmentException.findMany({
            where: { empresaId },
            select: { date: true },
        } as any)) as any[];
        return rows.map((r: any) => ({ date: r.date, isOpen: null, start1: null, end1: null, start2: null, end2: null }));
    }
}

/* ========= Ventanas del día (con logs de diagnóstico) ========= */
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
        if (ex.isOpen === false) {
            console.debug("[schedule.windows] exception CLOSE", { ymd, tz });
            return [];
        }
        const exPairs: [string | null, string | null][] = [
            [ex.start1, ex.end1],
            [ex.start2, ex.end2],
        ];
        const exWindows = exPairs
            .filter(([s, e]) => !!s && !!e)
            .map(([s, e]) => ({ start: s as string, end: e as string }));

        console.debug("[schedule.windows] exception OVERRIDE", { ymd, tz, count: exWindows.length, ex });
        if (exWindows.length) return exWindows;
    }

    const weekday = DAY_MAP[weekdayInTZ(makeZonedDate(ymd, "00:00", tz), tz)];
    const todays = hours.filter((h) => h.day === weekday && h.isOpen);

    const pairs = todays
        .flatMap((h) => [[h.start1, h.end1], [h.start2, h.end2]] as [string | null, string | null][])
        .filter(([s, e]) => !!s && !!e);

    const win = pairs.map(([s, e]) => ({ start: s as string, end: e as string }));
    console.debug("[schedule.windows] hours", { ymd, tz, weekday, windows: win });
    return win;
}

/* ==== Recolección de slots por ventana (con logs de descartes) ==== */
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

    let foundBefore = acc.length;
    let dropFriendly = 0;
    let dropEarliest = 0;
    let dropBusy = 0;
    let dropCap = 0;

    while (cursor.getTime() + durationMin * 60000 <= end.getTime()) {
        const localHour = parseInt(
            new Intl.DateTimeFormat("es-CO", { hour: "2-digit", hour12: false, timeZone: tz }).format(cursor),
            10
        );
        const inFriendlyRange = localHour >= 6 && localHour <= 22;

        const slotEnd = addMinutes(cursor, durationMin);
        const afterEarliest = slotEnd >= earliest;

        if (!inFriendlyRange) {
            dropFriendly++;
            cursor = addMinutes(cursor, step);
            continue;
        }
        if (!afterEarliest) {
            dropEarliest++;
            cursor = addMinutes(cursor, step);
            continue;
        }

        if (!(await isSlotFree(empresaId, cursor, durationMin, ctx))) {
            dropBusy++;
            cursor = addMinutes(cursor, step);
            continue;
        }
        if (!(await isUnderDailyCap(empresaId, cursor, ctx))) {
            dropCap++;
            cursor = addMinutes(cursor, step);
            continue;
        }

        acc.push(new Date(cursor));
        if (acc.length >= limit) break;
        cursor = addMinutes(cursor, step);
    }

    const foundNow = acc.length - foundBefore;
    console.debug("[schedule.collect]", {
        ymd: ymdKey,
        tz,
        win: `${startHHmm}-${endHHmm}`,
        foundInWindow: foundNow,
        drops: { friendly: dropFriendly, earliest: dropEarliest, busy: dropBusy, cap: dropCap },
    });
}

/* ==================== Chequeos de ocupación / límites ==================== */
async function isSlotFree(empresaId: number, start: Date, durationMin: number, ctx?: EsteticaCtx) {
    const buffer = ctx?.bufferMin ?? 0;
    const startWithBuffer = addMinutes(start, -buffer);
    const endWithBuffer = addMinutes(start, durationMin + buffer);

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

async function isUnderDailyCap(empresaId: number, start: Date, ctx: EsteticaCtx) {
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

function startOfDayTZ(d: Date, tz: string): Date {
    return makeZonedDate(ymdInTZ(d, tz), "00:00", tz);
}
function endOfDayTZ(d: Date, tz: string): Date {
    return makeZonedDate(ymdInTZ(d, tz), "23:59", tz);
}
