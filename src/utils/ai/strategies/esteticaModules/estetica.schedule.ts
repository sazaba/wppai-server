// server/src/utils/ai/strategies/esteticaModules/estetica.schedule.ts
import prisma from '../../../../lib/prisma'
import type { EsteticaCtx } from './estetica.rag'
import { AppointmentStatus } from '@prisma/client'

const DAY_MAP: Record<number, 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat'> = {
    0: 'sun', 1: 'mon', 2: 'tue', 3: 'wed', 4: 'thu', 5: 'fri', 6: 'sat'
}

type FindSlotsArgs = {
    empresaId: number
    ctx: EsteticaCtx
    hint?: Date | null
    durationMin?: number
    count?: number
}

/**
 * Busca próximos slots válidos respetando:
 * - AppointmentHour (isOpen, tramos 1/2)
 * - AppointmentException (días bloqueados)
 * - blackoutDates (config)
 * - maxDailyAppointments
 * - solapes con appointment existentes
 */
export async function findSlots({ empresaId, ctx, hint, durationMin = 60, count = 8 }: FindSlotsArgs): Promise<Date[]> {
    const from = hint ? new Date(hint) : new Date()
    const maxDays = ctx.rules?.bookingWindowDays ?? 30
    const out: Date[] = []

    const [hours, exceptions] = await Promise.all([
        prisma.appointmentHour.findMany({ where: { empresaId, isOpen: true } }),
        prisma.appointmentException.findMany({ where: { empresaId } })
    ])

    for (let dayOffset = 0; dayOffset < maxDays && out.length < count; dayOffset++) {
        const date = addDays(clearTime(from), dayOffset)

        // aviso mínimo / mismo día
        const minNoticeH = ctx.rules?.minNoticeHours ?? 0
        const sameDay = isSameYMD(date, new Date())
        if (!ctx.rules?.allowSameDay && sameDay && minNoticeH > 0) {
            const nowPlus = addMinutes(new Date(), minNoticeH * 60)
            if (nowPlus > endOfDay(date)) continue
        }

        if (isBlackout(date, ctx) || isExceptionDay(date, exceptions)) continue

        const weekday = DAY_MAP[date.getDay()]
        const todays = hours.filter(h => h.day === weekday && h.isOpen)
        if (!todays.length) continue

        for (const h of todays) {
            if (h.start1 && h.end1) {
                await collectSlotsInRange(date, h.start1, h.end1, durationMin, out, count, empresaId, ctx)
                if (out.length >= count) break
            }
            if (h.start2 && h.end2) {
                await collectSlotsInRange(date, h.start2, h.end2, durationMin, out, count, empresaId, ctx)
                if (out.length >= count) break
            }
        }
    }
    return out
}

async function collectSlotsInRange(
    day: Date,
    startHHmm: string,
    endHHmm: string,
    durationMin: number,
    acc: Date[],
    limit: number,
    empresaId: number,
    ctx: EsteticaCtx
) {
    let cursor = setTime(day, startHHmm)
    const end = setTime(day, endHHmm)
    const step = (ctx.bufferMin ?? 10) + durationMin

    while (cursor.getTime() + durationMin * 60000 <= end.getTime()) {
        if (await isSlotFree(empresaId, cursor, durationMin, ctx)) {
            if (await isUnderDailyCap(empresaId, cursor, ctx)) {
                acc.push(new Date(cursor))
                if (acc.length >= limit) break
            }
        }
        cursor = addMinutes(cursor, step)
    }
}

function isBlackout(day: Date, ctx: EsteticaCtx) {
    const list = ctx.rules?.blackoutDates ?? []
    const key = ymd(day)
    return Array.isArray(list) && list.some(d => d === key)
}
function isExceptionDay(day: Date, exceptions: { date: Date }[]) {
    const key = ymd(day)
    return exceptions.some(e => ymd(e.date) === key)
}

async function isSlotFree(empresaId: number, start: Date, durationMin: number, _ctx: EsteticaCtx) {
    const end = addMinutes(start, durationMin)
    const overlap = await prisma.appointment.count({
        where: {
            empresaId,
            status: { notIn: ['cancelled', 'no_show'] },
            AND: [{ startAt: { lt: end } }, { endAt: { gt: start } }]
        }
    })
    return overlap === 0
}

async function isUnderDailyCap(empresaId: number, start: Date, ctx: EsteticaCtx) {
    const cap = ctx.rules?.maxDailyAppointments
    if (!cap) return true
    const dayStart = startOfDay(start)
    const dayEnd = endOfDay(start)
    const count = await prisma.appointment.count({
        where: {
            empresaId,
            status: { notIn: ['cancelled', 'no_show'] },
            startAt: { gte: dayStart, lte: dayEnd }
        }
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
    const free = await isSlotFree(args.empresaId, args.startAt, args.durationMin, ctx)
    if (!free) throw new Error('Slot ocupado')

    // estado inicial: pending si requiere confirmación o depósito
    const proc = args.procedureId
        ? await prisma.esteticaProcedure.findUnique({ where: { id: args.procedureId }, select: { depositRequired: true } })
        : null
    const needClientConfirm = !!ctx.rules?.requireConfirmation
    const needDeposit = !!proc?.depositRequired
    const status: AppointmentStatus = (needClientConfirm || needDeposit) ? 'pending' : 'confirmed'

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
            procedureId: args.procedureId ?? null
        }
    })
    return appt
}

export async function reschedule(
    args: { empresaId: number; appointmentId: number; newStartAt: Date },
    ctx: EsteticaCtx
) {
    const appt = await prisma.appointment.findUnique({ where: { id: args.appointmentId } })
    if (!appt) throw new Error('Cita no existe')
    const duration = Math.max(15, appt.serviceDurationMin ?? Math.round((appt.endAt.getTime() - appt.startAt.getTime()) / 60000))
    const free = await isSlotFree(args.empresaId, args.newStartAt, duration, ctx)
    if (!free) throw new Error('Nuevo horario ocupado')
    const updated = await prisma.appointment.update({
        where: { id: appt.id },
        data: { startAt: args.newStartAt, endAt: addMinutes(args.newStartAt, duration), status: 'rescheduled' }
    })
    return updated
}

/** Firma simple: un solo argumento */
export async function cancel(args: { empresaId: number; appointmentId: number }) {
    const appt = await prisma.appointment.update({
        where: { id: args.appointmentId },
        data: { status: 'cancelled' }
    })
    return appt
}

/* ===== utilidades de fecha (sin libs externas) ===== */
function ymd(d: Date) {
    const y = d.getFullYear()
    const m = `${d.getMonth() + 1}`.padStart(2, '0')
    const day = `${d.getDate()}`.padStart(2, '0')
    return `${y}-${m}-${day}`
}
function clearTime(d: Date) {
    const x = new Date(d)
    x.setHours(0, 0, 0, 0)
    return x
}
function startOfDay(d: Date) { return clearTime(d) }
function endOfDay(d: Date) {
    const x = clearTime(d)
    x.setHours(23, 59, 59, 999)
    return x
}
function setTime(day: Date, hhmm: string) {
    const [h, m] = hhmm.split(':').map(Number)
    const d = new Date(day)
    d.setHours(h, (m || 0), 0, 0)
    return d
}
function addMinutes(d: Date, min: number) {
    return new Date(d.getTime() + min * 60000)
}
function addDays(d: Date, days: number) {
    return new Date(d.getTime() + days * 86400000)
}
function isSameYMD(a: Date, b: Date) { return ymd(a) === ymd(b) }
