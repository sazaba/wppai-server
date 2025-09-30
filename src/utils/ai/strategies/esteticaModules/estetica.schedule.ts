// server/src/utils/ai/strategies/esteticaModules/estetica.schedule.ts
import prisma from '../../../../lib/prisma'
import type { EsteticaCtx } from './estetica.rag'
import { AppointmentStatus } from '@prisma/client'

const DAY_MAP: Record<number, 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat'> = {
    0: 'sun',
    1: 'mon',
    2: 'tue',
    3: 'wed',
    4: 'thu',
    5: 'fri',
    6: 'sat',
}

type FindSlotsArgs = {
    empresaId: number
    ctx: EsteticaCtx
    hint?: Date | null
    durationMin?: number
    count?: number
}

/**
 * Genera próximos slots válidos respetando:
 * - AppointmentHour (isOpen, tramos 1/2)
 * - AppointmentException / blackoutDates
 * - Cap diario y solape con citas existentes
 * - Zona horaria del negocio (¡sin 4:00 a. m.!)
 */
export async function findSlots({
    empresaId,
    ctx,
    hint,
    durationMin = 60,
    count = 8,
}: FindSlotsArgs): Promise<Date[]> {
    const now = new Date()
    const from = hint ? new Date(hint) : now
    const maxDays = ctx.rules?.bookingWindowDays ?? 30
    const out: Date[] = []

    const [hours, exceptions] = await Promise.all([
        prisma.appointmentHour.findMany({ where: { empresaId, isOpen: true } }),
        prisma.appointmentException.findMany({ where: { empresaId } }),
    ])

    for (let dayOffset = 0; dayOffset < maxDays && out.length < count; dayOffset++) {
        const dateTz = addDays(from, dayOffset)
        const ymdKey = ymdInTZ(dateTz, ctx.timezone)

        // minNotice / mismo día
        const minNoticeH = ctx.rules?.minNoticeHours ?? 0
        const sameDay = ymdKey === ymdInTZ(now, ctx.timezone)
        if (!ctx.rules?.allowSameDay && sameDay && minNoticeH > 0) {
            const nowPlus = addMinutes(now, minNoticeH * 60)
            if (nowPlus > endOfDayTZ(dateTz, ctx.timezone)) continue
        }

        if (isBlackout(ymdKey, ctx) || isExceptionDay(ymdKey, exceptions, ctx.timezone)) continue

        const weekday = DAY_MAP[weekdayInTZ(dateTz, ctx.timezone)]
        const todays = hours.filter((h) => h.day === weekday && h.isOpen)
        if (!todays.length) continue

        for (const h of todays) {
            if (h.start1 && h.end1) {
                await collectSlotsInRangeTZ(
                    ymdKey,
                    ctx.timezone,
                    h.start1,
                    h.end1,
                    durationMin,
                    out,
                    count,
                    empresaId,
                    ctx
                )
                if (out.length >= count) break
            }
            if (h.start2 && h.end2) {
                await collectSlotsInRangeTZ(
                    ymdKey,
                    ctx.timezone,
                    h.start2,
                    h.end2,
                    durationMin,
                    out,
                    count,
                    empresaId,
                    ctx
                )
                if (out.length >= count) break
            }
        }
    }
    return out
}

async function collectSlotsInRangeTZ(
    ymdKey: string,
    tz: string,
    startHHmm: string,
    endHHmm: string,
    durationMin: number,
    acc: Date[],
    limit: number,
    empresaId: number,
    ctx: EsteticaCtx
) {
    let cursor = makeZonedDate(ymdKey, startHHmm, tz)
    const end = makeZonedDate(ymdKey, endHHmm, tz)
    const step = (ctx.bufferMin ?? 10) + durationMin

    while (cursor.getTime() + durationMin * 60000 <= end.getTime()) {
        if (await isSlotFree(empresaId, cursor, durationMin)) {
            if (await isUnderDailyCap(empresaId, cursor, ctx)) {
                acc.push(new Date(cursor))
                if (acc.length >= limit) break
            }
        }
        cursor = addMinutes(cursor, step)
    }
}

function isBlackout(ymdKey: string, ctx: EsteticaCtx) {
    const list = ctx.rules?.blackoutDates ?? []
    return Array.isArray(list) && list.some((d) => d === ymdKey)
}
function isExceptionDay(ymdKey: string, exceptions: { date: Date }[], tz: string) {
    return exceptions.some((e) => ymdInTZ(e.date, tz) === ymdKey)
}

async function isSlotFree(empresaId: number, start: Date, durationMin: number) {
    const end = addMinutes(start, durationMin)
    const overlap = await prisma.appointment.count({
        where: {
            empresaId,
            status: { notIn: ['cancelled', 'no_show'] },
            AND: [{ startAt: { lt: end } }, { endAt: { gt: start } }],
        },
    })
    return overlap === 0
}

async function isUnderDailyCap(empresaId: number, start: Date, ctx: EsteticaCtx) {
    const cap = ctx.rules?.maxDailyAppointments
    if (!cap) return true
    const s = startOfDayTZ(start, ctx.timezone)
    const e = endOfDayTZ(start, ctx.timezone)
    const count = await prisma.appointment.count({
        where: {
            empresaId,
            status: { notIn: ['cancelled', 'no_show'] },
            startAt: { gte: s, lte: e },
        },
    })
    return count < cap
}

export async function book(
    args: {
        empresaId: number
        conversationId: number
        customerPhone: string
        customerName?: string
        serviceName: string
        startAt: Date
        durationMin: number
        timezone: string
        procedureId?: number
        notes?: string
    },
    ctx: EsteticaCtx
) {
    const endAt = addMinutes(args.startAt, args.durationMin)
    const free = await isSlotFree(args.empresaId, args.startAt, args.durationMin)
    if (!free) throw new Error('Slot ocupado')

    const proc = args.procedureId
        ? await prisma.esteticaProcedure.findUnique({ where: { id: args.procedureId }, select: { depositRequired: true } })
        : null
    const needClientConfirm = !!ctx.rules?.requireConfirmation
    const needDeposit = !!proc?.depositRequired
    const status: AppointmentStatus = needClientConfirm || needDeposit ? 'pending' : 'confirmed'

    const appt = await prisma.appointment.create({
        data: {
            empresaId: args.empresaId,
            conversationId: args.conversationId,
            source: 'ai',
            status,
            customerName: args.customerName ?? '',
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
        },
    })
    return appt
}

export async function reschedule(
    args: { empresaId: number; appointmentId: number; newStartAt: Date },
    _ctx: EsteticaCtx
) {
    const appt = await prisma.appointment.findUnique({ where: { id: args.appointmentId } })
    if (!appt) throw new Error('Cita no existe')
    const duration =
        appt.serviceDurationMin ?? Math.max(15, Math.round((appt.endAt.getTime() - appt.startAt.getTime()) / 60000))
    const free = await isSlotFree(args.empresaId, args.newStartAt, duration)
    if (!free) throw new Error('Nuevo horario ocupado')
    const updated = await prisma.appointment.update({
        where: { id: appt.id },
        data: { startAt: args.newStartAt, endAt: addMinutes(args.newStartAt, duration), status: 'rescheduled' },
    })
    return updated
}

export async function cancel(args: { empresaId: number; appointmentId: number }) {
    const appt = await prisma.appointment.update({ where: { id: args.appointmentId }, data: { status: 'cancelled' } })
    return appt
}

/* ===== utilidades de fecha con zona horaria (sin libs externas) ===== */

function addMinutes(d: Date, min: number) {
    return new Date(d.getTime() + min * 60000)
}
function addDays(d: Date, days: number) {
    return new Date(d.getTime() + days * 86400000)
}

/** yyyy-mm-dd calculado en la TZ dada */
function ymdInTZ(d: Date, tz: string): string {
    const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    return f.format(d) // "YYYY-MM-DD"
}
function weekdayInTZ(d: Date, tz: string): number {
    // 0..6 (Sun..Sat) en tz
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).formatToParts(d)
    const w = p.find((x) => x.type === 'weekday')?.value?.toLowerCase()
    return { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }[String(w).slice(0, 3) as 'sun'] ?? 0
}

/** Crea un Date que representa el *instante UTC* correspondiente a ese HH:mm de la TZ dada */
function makeZonedDate(ymd: string, hhmm: string, tz: string): Date {
    const [y, m, d] = ymd.split('-').map(Number)
    const [h, mi] = hhmm.split(':').map(Number)
    const guess = Date.UTC(y, (m || 1) - 1, d || 1, h || 0, mi || 0, 0)
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    }).formatToParts(new Date(guess))
    const gotH = Number(parts.find((p) => p.type === 'hour')?.value || 0)
    const gotM = Number(parts.find((p) => p.type === 'minute')?.value || 0)
    const deltaMin = (h * 60 + (mi || 0)) - (gotH * 60 + gotM)
    return new Date(guess - deltaMin * 60000)
}

function startOfDayTZ(d: Date, tz: string): Date {
    const ymd = ymdInTZ(d, tz)
    return makeZonedDate(ymd, '00:00', tz)
}
function endOfDayTZ(d: Date, tz: string): Date {
    const ymd = ymdInTZ(d, tz)
    return makeZonedDate(ymd, '23:59', tz)
}
