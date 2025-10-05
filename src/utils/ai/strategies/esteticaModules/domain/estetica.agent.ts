// utils/ai/strategies/esteticaModules/domain/estetica.agent.ts
// Full-agent (agenda natural + tools + KB) CON staff-awareness, estilo humano y sin delays

import prisma from "../../../../../lib/prisma"
import { openai } from "../../../../../lib/openai"
import { AppointmentStatus, AppointmentSource } from "@prisma/client"
import type { EsteticaCtx } from "./estetica.rag"

/* ======================= LLM CFG ======================= */
const MODEL = process.env.ESTETICA_MODEL || "gpt-4o-mini"
const TEMPERATURE = Number(process.env.IA_TEMPERATURE ?? 0.35)

/* ======================= Tipos chat ======================= */
export type ChatTurn = { role: "user" | "assistant"; content: string }
type AssistantMsg = {
    role: "assistant"
    content?: string | null
    tool_calls?: Array<{
        id: string
        type: "function"
        function: { name: string; arguments: string }
    }>
}
type ToolMsg = { role: "tool"; tool_call_id: string; content: string }

/* ======================= Utils ======================= */
function safeParseArgs(raw?: string) {
    if (!raw) return {}
    try { return JSON.parse(raw) } catch { return {} }
}
const ENDINGS = ["¿Te parece?", "¿Confirmamos?", "¿Te va bien?"]

function postProcessReply(reply: string, history: ChatTurn[]): string {
    const clean = reply.trim().replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n")
    if (!clean) return clean
    const ending = ENDINGS[(history.length) % ENDINGS.length]
    const withEnding = /[.?!…]$/.test(clean) ? `${clean} ${ending}` : `${clean}. ${ending}`
    const hasEmoji = /\p{Extended_Pictographic}/u.test(withEnding)
    return hasEmoji ? withEnding : `${withEnding} 🙂`
}

/* ======================= Fecha/TZ helpers ======================= */
function addMinutes(d: Date, m: number) { return new Date(d.getTime() + m * 60000) }
function addDays(d: Date, days: number) { return new Date(d.getTime() + days * 86400000) }
function ymdInTZ(d: Date, tz: string): string {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d)
}
function makeZonedDate(ymd: string, hhmm: string, tz: string): Date {
    const [y, m, d] = ymd.split("-").map(Number)
    const [h, mi] = hhmm.split(":").map(Number)
    const guess = new Date(Date.UTC(y, m - 1, d, h, mi))
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit",
    }).formatToParts(guess)
    const gotH = Number(parts.find((p) => p.type === "hour")?.value ?? "0")
    const gotM = Number(parts.find((p) => p.type === "minute")?.value ?? "0")
    const delta = h * 60 + mi - (gotH * 60 + gotM)
    return new Date(guess.getTime() + delta * 60000)
}
function startOfDayTZ(d: Date, tz: string) { return makeZonedDate(ymdInTZ(d, tz), "00:00", tz) }
function endOfDayTZ(d: Date, tz: string) { return makeZonedDate(ymdInTZ(d, tz), "23:59", tz) }

/* ====== Corrección opcional de timezone en appointmentHours ====== */
// Si tus hours están en UTC y el negocio opera en America/Bogota (-300 min):
// APPT_HOURS_TZ_OFFSET_MIN=-300
const HOURS_TZ_OFFSET_MIN = Number(process.env.APPT_HOURS_TZ_OFFSET_MIN ?? 0)
function hhmmWithOffset(hhmm: string): string {
    if (!HOURS_TZ_OFFSET_MIN) return hhmm
    const [h, m] = hhmm.split(":").map(Number)
    let total = h * 60 + m + HOURS_TZ_OFFSET_MIN
    total = ((total % 1440) + 1440) % 1440
    const H = Math.floor(total / 60).toString().padStart(2, "0")
    const M = (total % 60).toString().padStart(2, "0")
    return `${H}:${M}`
}

/* ======================= Disponibilidad base ======================= */
type HourRow = {
    day: "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun"
    isOpen: boolean
    start1: string | null; end1: string | null
    start2: string | null; end2: string | null
}
type ExceptionRow = {
    date: Date
    isOpen: boolean | null
    start1: string | null; end1: string | null
    start2: string | null; end2: string | null
}
type StaffRow = {
    id: number
    name: string
    enabled: boolean | null
    specialties?: any | null // array/JSON con ids de procedimientos
}

async function fetchHours(empresaId: number): Promise<HourRow[]> {
    const rows = await prisma.appointmentHour.findMany({
        where: { empresaId, isOpen: true },
        select: { day: true, isOpen: true, start1: true, end1: true, start2: true, end2: true },
    })
    return rows as unknown as HourRow[]
}
async function fetchExceptions(empresaId: number): Promise<ExceptionRow[]> {
    const rows = await prisma.appointmentException.findMany({
        where: { empresaId },
        select: { date: true, isOpen: true, start1: true, end1: true, start2: true, end2: true },
    })
    return rows.map(r => ({
        date: r.date, isOpen: r.isOpen ?? null,
        start1: r.start1 ?? null, end1: r.end1 ?? null, start2: r.start2 ?? null, end2: r.end2 ?? null,
    }))
}
async function fetchStaffSafe(empresaId: number): Promise<StaffRow[]> {
    try {
        const rows = await prisma.staff.findMany({
            where: { empresaId, OR: [{ enabled: true }, { enabled: null }] },
            select: { id: true, name: true, enabled: true, specialties: true },
            orderBy: { id: "asc" },
        } as any)
        return rows as unknown as StaffRow[]
    } catch { return [] }
}

function weekdayCode(d: Date, tz: string): HourRow["day"] {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).formatToParts(d)
    const w = (p.find(x => x.type === "weekday")?.value ?? "sun").toLowerCase().slice(0, 3)
    return (w as HourRow["day"])
}
function windowsForYMD(ymd: string, tz: string, hours: HourRow[], exceptions: ExceptionRow[]) {
    const ex = exceptions.find(e => ymdInTZ(e.date, tz) === ymd)
    if (ex) {
        if (ex.isOpen === false) return []
        const pairs: [string | null, string | null][] = [[ex.start1, ex.end1], [ex.start2, ex.end2]]
        return pairs
            .filter(([s, e]) => s && e)
            .map(([s, e]) => ({ start: hhmmWithOffset(s!), end: hhmmWithOffset(e!) }))
    }
    const wd = weekdayCode(makeZonedDate(ymd, "00:00", tz), tz)
    const todays = hours.filter(h => h.day === wd && h.isOpen)
    const pairs = todays.flatMap(h => [[h.start1, h.end1], [h.start2, h.end2]] as [string | null, string | null][])
        .filter(([s, e]) => s && e)
    return pairs.map(([s, e]) => ({ start: hhmmWithOffset(s!), end: hhmmWithOffset(e!) }))
}

/* ====== staff availability ====== */
function tryParseIdList(v: any): number[] {
    if (!v) return []
    if (Array.isArray(v)) return v.map(Number).filter(n => Number.isFinite(n))
    if (typeof v === "string") {
        try { const j = JSON.parse(v); return Array.isArray(j) ? j.map(Number).filter(Number.isFinite) : [] }
        catch { return [] }
    }
    return []
}

async function hasFreeStaffForSlot(empresaId: number, start: Date, durationMin: number, bufferMin: number, procedureId?: number | null) {
    const staff = await fetchStaffSafe(empresaId)
    if (!staff.length) return true
    const end = addMinutes(start, durationMin)
    for (const s of staff) {
        if (s.enabled === false) continue
        if (procedureId != null) {
            const spec = tryParseIdList(s.specialties)
            if (spec.length && !spec.includes(Number(procedureId))) continue
        }
        const overlap = await prisma.appointment.count({
            where: {
                empresaId,
                deletedAt: null,
                staffId: s.id,
                status: { notIn: [AppointmentStatus.cancelled, AppointmentStatus.no_show] },
                AND: [{ startAt: { lt: addMinutes(end, bufferMin) } }, { endAt: { gt: addMinutes(start, -bufferMin) } }],
            },
        } as any)
        if (overlap === 0) return { ok: true, staffId: s.id }
    }
    return { ok: false }
}

async function isSlotFree(empresaId: number, start: Date, durationMin: number, bufferMin = 0, procedureId?: number | null) {
    const startWithBuffer = new Date(start.getTime() - bufferMin * 60000)
    const endWithBuffer = new Date(start.getTime() + (durationMin + bufferMin) * 60000)
    const overlap = await prisma.appointment.count({
        where: {
            empresaId,
            deletedAt: null,
            status: { notIn: [AppointmentStatus.cancelled, AppointmentStatus.no_show] },
            AND: [{ startAt: { lt: endWithBuffer } }, { endAt: { gt: startWithBuffer } }],
        },
    })
    if (overlap > 0) return { ok: false }

    const staffOk = await hasFreeStaffForSlot(empresaId, start, durationMin, bufferMin, procedureId ?? null)
    if (staffOk === true) return { ok: true, staffId: undefined }
    if ((staffOk as any)?.ok) return staffOk as any
    return { ok: false }
}

async function underDailyCap(empresaId: number, d: Date, tz: string, cap?: number | null) {
    if (!cap) return true
    const s = startOfDayTZ(d, tz); const e = endOfDayTZ(d, tz)
    const count = await prisma.appointment.count({
        where: {
            empresaId, deletedAt: null,
            status: { notIn: [AppointmentStatus.cancelled, AppointmentStatus.no_show] },
            startAt: { gte: s, lte: e },
        },
    })
    return count < cap
}

async function resolveService(ctx: EsteticaCtx, q: { serviceId?: number; name?: string }) {
    if (q.serviceId) {
        const r = await prisma.esteticaProcedure.findFirst({
            where: { id: q.serviceId, empresaId: ctx.empresaId, enabled: true },
            select: { id: true, name: true, durationMin: true },
        })
        if (r) return r
    }
    if (q.name && q.name.trim()) {
        const r = await prisma.esteticaProcedure.findFirst({
            where: { empresaId: ctx.empresaId, enabled: true, name: { contains: q.name.trim() } as any },
            select: { id: true, name: true, durationMin: true },
        })
        if (r) return r
    }
    return null
}

/* ======================= Núcleo de búsqueda de slots ======================= */
async function findSlotsCore(opts: {
    empresaId: number
    ctx: EsteticaCtx
    hint?: Date | null
    durationMin: number
    count: number
    procedureId?: number | null
}): Promise<Array<{ start: Date; staffId?: number }>> {
    const { empresaId, ctx } = opts
    const now = new Date()
    const tz = ctx.timezone
    const allowSameDay = !!ctx.rules?.allowSameDay
    const minNoticeH = ctx.rules?.minNoticeHours ?? 0
    const earliest = new Date(now.getTime() + (minNoticeH * 60 + (ctx.bufferMin ?? 0)) * 60000)
    const bookingWindowDays = ctx.rules?.bookingWindowDays ?? ctx.rules?.maxAdvanceDays ?? 30

    const from = opts.hint ? new Date(opts.hint) : now
    const to = addDays(from, Math.max(1, bookingWindowDays))
    const [hours, exceptions] = await Promise.all([fetchHours(empresaId), fetchExceptions(empresaId)])

    const out: Array<{ start: Date; staffId?: number }> = []
    let cursor = new Date(from)
    while (cursor < to && out.length < opts.count) {
        const ymd = ymdInTZ(cursor, tz)
        if (!allowSameDay && ymd === ymdInTZ(now, tz)) { cursor = addDays(cursor, 1); continue }
        if (Array.isArray(ctx.rules?.blackoutDates) && ctx.rules!.blackoutDates!.includes(ymd)) {
            cursor = addDays(cursor, 1); continue
        }

        const wins = windowsForYMD(ymd, tz, hours, exceptions)
        for (const w of wins) {
            let s = makeZonedDate(ymd, w.start, tz)
            const e = makeZonedDate(ymd, w.end, tz)
            while (s.getTime() + opts.durationMin * 60000 <= e.getTime()) {
                const slotEnd = addMinutes(s, opts.durationMin)
                if (slotEnd >= earliest) {
                    const free = await isSlotFree(empresaId, s, opts.durationMin, ctx.bufferMin, opts.procedureId)
                    const okCap = await underDailyCap(empresaId, s, tz, ctx.rules?.maxDailyAppointments ?? null)
                    if ((free as any)?.ok && okCap) {
                        out.push({ start: new Date(s), staffId: (free as any).staffId })
                        if (out.length >= opts.count) break
                    }
                }
                s = addMinutes(s, 15)
            }
            if (out.length >= opts.count) break
        }
        cursor = addDays(cursor, 1)
    }
    return out
}

/* ======================= Tools ======================= */
async function toolListProcedures(ctx: EsteticaCtx, _args: any) {
    const rows = await prisma.esteticaProcedure.findMany({
        where: { empresaId: ctx.empresaId, enabled: true },
        select: { id: true, name: true, durationMin: true, priceMin: true, priceMax: true },
        orderBy: [{ updatedAt: "desc" }, { name: "asc" }],
        take: 6,
    })
    return { ok: true, items: rows }
}

async function toolFindSlots(ctx: EsteticaCtx, args: { serviceId?: number; serviceName?: string; fromISO?: string; max?: number }) {
    const svc = await resolveService(ctx, { serviceId: args.serviceId, name: args.serviceName })
    const durationMin = svc?.durationMin ?? ctx.rules?.defaultServiceDurationMin ?? 60

    const hint = args.fromISO ? new Date(args.fromISO) : undefined
    const raw = await findSlotsCore({
        empresaId: ctx.empresaId,
        ctx,
        hint: hint ?? null,
        durationMin,
        count: Math.min(12, Math.max(6, Number(args.max ?? 8))),
        procedureId: svc?.id ?? null,
    })

    const now = new Date()
    let labels = raw
        .filter(d => d.start.getTime() > now.getTime())
        .slice(0, 12)
        .map((d, i) => ({
            idx: i + 1,
            startISO: d.start.toISOString(),
            startLabel: new Intl.DateTimeFormat("es-CO", { dateStyle: "full", timeStyle: "short", timeZone: ctx.timezone }).format(d.start),
            staffId: d.staffId ?? null,
        }))

    if (!labels.length) {
        const hint2 = (hint ? new Date(hint) : new Date()); hint2.setDate(hint2.getDate() + 1)
        const raw2 = await findSlotsCore({
            empresaId: ctx.empresaId, ctx, hint: hint2, durationMin, count: 12, procedureId: svc?.id ?? null,
        })
        labels = raw2.filter(d => d.start > new Date()).slice(0, 12).map((d, i) => ({
            idx: i + 1,
            startISO: d.start.toISOString(),
            startLabel: new Intl.DateTimeFormat("es-CO", { dateStyle: "full", timeStyle: "short", timeZone: ctx.timezone }).format(d.start),
            staffId: d.staffId ?? null,
        }))
    }

    return { ok: true, durationMin, serviceName: svc?.name ?? args.serviceName ?? null, slots: labels.slice(0, 6) }
}

async function toolBook(
    ctx: EsteticaCtx,
    args: { serviceId?: number; serviceName?: string; startISO: string; phone: string; fullName: string; notes?: string; durationMin?: number; staffId?: number },
    conversationId?: number
) {
    const phone = String(args.phone || "").replace(/[^\d]/g, "")
    if (!phone) return { ok: false, reason: "INVALID_PHONE" }

    const svc = await resolveService(ctx, { serviceId: args.serviceId, name: args.serviceName })
    if (!svc) return { ok: false, reason: "SERVICE_NOT_FOUND" }

    const durationMin = args.durationMin ?? svc.durationMin ?? ctx.rules?.defaultServiceDurationMin ?? 60
    const startAt = new Date(args.startISO)
    const endAt = addMinutes(startAt, durationMin)

    let finalStaffId: number | undefined = args.staffId
    const free = await isSlotFree(ctx.empresaId, startAt, durationMin, ctx.bufferMin, svc.id)
    if (!(free as any)?.ok) return { ok: false, reason: "CONFLICT_SLOT" }
    if (finalStaffId == null) finalStaffId = (free as any)?.staffId

    const status: AppointmentStatus = (ctx.rules?.requireConfirmation ?? true)
        ? AppointmentStatus.pending
        : AppointmentStatus.confirmed

    const appt = await prisma.appointment.create({
        data: {
            empresaId: ctx.empresaId,
            conversationId: conversationId ?? null,
            source: AppointmentSource.ai,
            status,
            customerName: String(args.fullName || "").trim(),
            customerPhone: phone,
            customerDisplayName: String(args.fullName || "").trim(),
            serviceName: svc.name,
            serviceDurationMin: durationMin,
            startAt, endAt, timezone: ctx.timezone,
            procedureId: svc.id,
            notas: args.notes ?? null,
            locationNameCache: ctx.logistics?.locationName ?? null,
            staffId: finalStaffId ?? null,
        },
    } as any)

    return {
        ok: true,
        data: {
            id: appt.id,
            startISO: appt.startAt.toISOString(),
            startLabel: new Intl.DateTimeFormat("es-CO", { dateStyle: "full", timeStyle: "short", timeZone: ctx.timezone }).format(appt.startAt),
            status: appt.status,
            serviceName: appt.serviceName,
            staffId: appt.staffId ?? null,
        },
    }
}

async function toolReschedule(ctx: EsteticaCtx, args: { appointmentId: number; newStartISO: string; staffId?: number }) {
    const appt = await prisma.appointment.findUnique({ where: { id: Number(args.appointmentId) } } as any)
    if (!appt || appt.deletedAt || appt.empresaId !== ctx.empresaId) return { ok: false, reason: "NOT_FOUND" }

    const duration = appt.serviceDurationMin ?? Math.max(15, Math.round((+appt.endAt - +appt.startAt) / 60000))
    const newStart = new Date(args.newStartISO)

    const free = await isSlotFree(ctx.empresaId, newStart, duration, ctx.bufferMin, appt.procedureId ?? null)
    if (!(free as any)?.ok) return { ok: false, reason: "CONFLICT_SLOT" }

    const updated = await prisma.appointment.update({
        where: { id: appt.id },
        data: {
            startAt: newStart,
            endAt: addMinutes(newStart, duration),
            status: AppointmentStatus.rescheduled,
            staffId: args.staffId ?? (free as any)?.staffId ?? appt.staffId ?? null,
        },
    } as any)

    return {
        ok: true,
        data: {
            id: updated.id,
            startISO: updated.startAt.toISOString(),
            startLabel: new Intl.DateTimeFormat("es-CO", { dateStyle: "full", timeStyle: "short", timeZone: ctx.timezone }).format(updated.startAt),
            status: updated.status,
            staffId: updated.staffId ?? null,
        },
    }
}

async function toolCancel(ctx: EsteticaCtx, args: { appointmentId: number }) {
    const appt = await prisma.appointment.findUnique({ where: { id: Number(args.appointmentId) } } as any)
    if (!appt || appt.empresaId !== ctx.empresaId || appt.deletedAt) return { ok: false, reason: "NOT_FOUND" }
    const deleted = await prisma.appointment.update({
        where: { id: appt.id }, data: { status: AppointmentStatus.cancelled, deletedAt: new Date() },
    } as any)
    return {
        ok: true,
        data: {
            id: deleted.id,
            startISO: deleted.startAt.toISOString(),
            startLabel: new Intl.DateTimeFormat("es-CO", { dateStyle: "full", timeStyle: "short", timeZone: ctx.timezone }).format(deleted.startAt),
            status: deleted.status,
        },
    }
}

async function toolListUpcoming(ctx: EsteticaCtx, args: { phone: string; limit?: number }) {
    const phone = String(args.phone || "").replace(/[^\d]/g, "")
    if (!phone) return { ok: false, reason: "INVALID_PHONE" }
    const rows = await prisma.appointment.findMany({
        where: {
            empresaId: ctx.empresaId,
            customerPhone: phone,
            deletedAt: null,
            status: { in: [AppointmentStatus.pending, AppointmentStatus.confirmed, AppointmentStatus.rescheduled] },
            startAt: { gt: new Date() },
        },
        orderBy: { startAt: "asc" },
        select: { id: true, startAt: true, serviceName: true, timezone: true },
        take: Math.max(1, Number(args.limit ?? 5)),
    } as any)
    const items = rows.map(r => ({
        id: r.id,
        startISO: r.startAt.toISOString(),
        startLabel: new Intl.DateTimeFormat("es-CO", { dateStyle: "full", timeStyle: "short", timeZone: r.timezone || ctx.timezone }).format(r.startAt),
        serviceName: r.serviceName ?? null,
    }))
    return { ok: true, items }
}

/* === NUEVO: cita actual por conversación (para reagendar rápido) === */
async function toolGetCurrentAppt(
    ctx: EsteticaCtx,
    _args: { limit?: number },
    conversationId?: number
) {
    if (!conversationId) return { ok: false, reason: "NO_CONVERSATION_ID" }
    const rows = await prisma.appointment.findMany({
        where: {
            empresaId: ctx.empresaId,
            conversationId,
            deletedAt: null,
            status: { notIn: [AppointmentStatus.cancelled, AppointmentStatus.no_show] },
        },
        orderBy: { startAt: "desc" },
        take: Math.max(1, Number(_args?.limit ?? 1)),
        select: { id: true, startAt: true, endAt: true, serviceName: true, timezone: true, status: true, staffId: true, serviceDurationMin: true, procedureId: true },
    } as any)
    const items = rows.map(r => ({
        id: r.id,
        startISO: r.startAt.toISOString(),
        endISO: r.endAt.toISOString(),
        startLabel: new Intl.DateTimeFormat("es-CO", { dateStyle: "full", timeStyle: "short", timeZone: r.timezone || ctx.timezone }).format(r.startAt),
        serviceName: r.serviceName,
        status: r.status,
        staffId: r.staffId,
        durationMin: r.serviceDurationMin ?? Math.max(15, Math.round((+r.endAt - +r.startAt) / 60000)),
        procedureId: r.procedureId ?? null,
    }))
    return { ok: true, items }
}

/* ======================= Tools spec/handlers ======================= */
export const toolSpecs = [
    { type: "function", function: { name: "listProcedures", description: "Lista breve de servicios/procedimientos disponibles.", parameters: { type: "object", properties: {}, additionalProperties: false } } },
    { type: "function", function: { name: "findSlots", description: "Busca horarios disponibles (máx. 6).", parameters: { type: "object", properties: { serviceId: { type: "number" }, serviceName: { type: "string" }, fromISO: { type: "string" }, max: { type: "number" } }, additionalProperties: false } } },
    { type: "function", function: { name: "book", description: "Crea una reserva confirmada/pending según política.", parameters: { type: "object", properties: { serviceId: { type: "number" }, serviceName: { type: "string" }, startISO: { type: "string" }, phone: { type: "string" }, fullName: { type: "string" }, notes: { type: "string" }, durationMin: { type: "number" }, staffId: { type: "number" } }, required: ["startISO", "phone", "fullName"], additionalProperties: false } } },
    { type: "function", function: { name: "reschedule", description: "Reagenda una cita existente.", parameters: { type: "object", properties: { appointmentId: { type: "number" }, newStartISO: { type: "string" }, staffId: { type: "number" } }, required: ["appointmentId", "newStartISO"], additionalProperties: false } } },
    { type: "function", function: { name: "cancel", description: "Cancela una cita por ID.", parameters: { type: "object", properties: { appointmentId: { type: "number" } }, required: ["appointmentId"], additionalProperties: false } } },
    { type: "function", function: { name: "listUpcomingApptsForPhone", description: "Lista próximas citas filtrando por teléfono.", parameters: { type: "object", properties: { phone: { type: "string" }, limit: { type: "number" } }, required: ["phone"], additionalProperties: false } } },
    { type: "function", function: { name: "getCurrentAppt", description: "Obtiene la cita vigente/reciente de la conversación para reagendar rápido.", parameters: { type: "object", properties: { limit: { type: "number" } }, additionalProperties: false } } },
] as const

export function toolHandlers(ctx: EsteticaCtx, convId?: number) {
    return {
        async listProcedures(_args: {}) { return toolListProcedures(ctx, _args) },
        async findSlots(args: { serviceId?: number; serviceName?: string; fromISO?: string; max?: number }) {
            return toolFindSlots(ctx, args)
        },
        async book(args: { serviceId?: number; serviceName?: string; startISO: string; phone: string; fullName: string; notes?: string; durationMin?: number; staffId?: number }) {
            return toolBook(ctx, args, convId)
        },
        async reschedule(args: { appointmentId: number; newStartISO: string; staffId?: number }) {
            return toolReschedule(ctx, args)
        },
        async cancel(args: { appointmentId: number }) { return toolCancel(ctx, args) },
        async listUpcomingApptsForPhone(args: { phone: string; limit?: number }) { return toolListUpcoming(ctx, args) },
        async getCurrentAppt(args: { limit?: number }) { return toolGetCurrentAppt(ctx, args, convId) },
    }
}

/* ======================= Prompt & fewshots ======================= */
export function systemPrompt(ctx: EsteticaCtx) {
    const tz = ctx.timezone
    const allowSameDay = !!ctx.rules?.allowSameDay
    const minNoticeH = ctx.rules?.minNoticeHours ?? 0

    return [
        `Eres coordinador/a humano/a de una clínica estética premium en Colombia. Respondes como una persona: cálida, breve, natural y con **1 emoji** en cada turno. Nada de “voy a buscar / dame un momento”.`,
        `Usa **TOOLS** para todo lo de agenda: listar cupos, reservar, reagendar, cancelar, próximas.`,
        ``,
        `# Reglas de agenda`,
        `- Zona horaria del negocio: **${tz}**.`,
        `- Citas del mismo día: ${allowSameDay ? "permitidas si hay cupo" : "NO permitidas"}.`,
        `- Antelación mínima: **${minNoticeH}h**.`,
        `- Solo ofrece horarios que devuelven las tools (máx. 6 por respuesta; reparte en mañana/tarde).`,
        ``,
        `# Interpretación de fechas/horas del usuario`,
        `- Convierte “martes/mañana/pasado/3pm del lunes/el 15” a fecha/hora real en ${tz} y pásala como **fromISO** a **findSlots**.`,
        `- Si no hay cupos ese día, ofrece automáticamente los más cercanos (hasta 6).`,
        ``,
        `# Flujo de Reagendar (OBLIGATORIO)`,
        `1) Llama **getCurrentAppt** (por conversación) para obtener la cita vigente.`,
        `2) Confirma con el usuario servicio y duración de esa cita.`,
        `3) Llama **findSlots** usando la intención (p.ej. “jueves en la tarde”) para proponer hasta 6 opciones.`,
        `4) Cuando elija una, llama **reschedule** con {appointmentId, newStartISO, staffId?}.`,
        `5) Resume y pide confirmación final.`,
        ``,
        `# Datos obligatorios antes de reservar`,
        `- Servicio, fecha/hora exacta (de los slots), nombre completo y teléfono.`,
        `- **Doble confirmación**: (1) resume; (2) pregunta “¿Confirmamos?”. Solo ante un “sí/ok/listo/confirmo” llamas **book**/**reschedule**.`,
        ``,
        `# KB`,
        `- Duración/precios/notas salen de la KB; si falta, dilo.`,
        ``,
        `# Estilo`,
        `- 2–5 líneas, directo, cercano, **1 emoji** siempre.`,
    ].join("\n")
}

export function buildFewshots(_ctx: EsteticaCtx): ChatTurn[] {
    return [
        { role: "user", content: "hola" },
        { role: "assistant", content: "¡Hola! ¿Quieres info de tratamientos o prefieres ver horarios para agendar? 🙂" },

        // Nueva cita
        { role: "user", content: "me sirve el martes en la tarde para botox" },
        { role: "assistant", content: "Perfecto. Buscaré cupos desde el **próximo martes 06:00** (hora local) para *Toxina botulínica*. Te muestro opciones y luego tomamos tus datos. 😉" },

        // Reagendar
        { role: "user", content: "quiero reagendar mi cita" },
        { role: "assistant", content: "Ya reviso tu cita actual y te propongo horarios. Un momento. 🙂" },
        // El modelo debe llamar: getCurrentAppt -> findSlots -> reschedule
    ]
}

/* ======================= Orquestación LLM ======================= */
async function runTools(ctx: EsteticaCtx, calls: AssistantMsg["tool_calls"], convId?: number) {
    const handlers = toolHandlers(ctx, convId)
    const out: ToolMsg[] = []
    for (const c of calls || []) {
        const args = safeParseArgs(c.function?.arguments)
        let res: any
        try {
            // @ts-ignore
            res = await (handlers as any)[c.function.name](args)
        } catch (e: any) {
            res = { ok: false, error: e?.message || "TOOL_ERROR" }
        }
        out.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(res ?? null) })
    }
    return out
}

export async function runEsteticaAgent(
    ctx: EsteticaCtx & { __conversationId?: number },
    turns: ChatTurn[],
): Promise<string> {
    const sys = systemPrompt(ctx)
    const few = buildFewshots(ctx)
    const kb = (await ctx.buildKbContext?.()) ?? ""

    const base: any = [
        { role: "system", content: `${sys}\n\n### Conocimiento de la clínica\n${kb}` },
        ...few,
        ...turns,
    ]

    const r1 = await openai.chat.completions.create({
        model: MODEL, temperature: TEMPERATURE,
        messages: base, tools: toolSpecs as any, tool_choice: "auto",
    } as any)
    const m1 = (r1.choices?.[0]?.message || {}) as AssistantMsg

    if (Array.isArray(m1.tool_calls) && m1.tool_calls.length) {
        const toolMsgs = await runTools(ctx, m1.tool_calls, ctx.__conversationId)
        const r2 = await openai.chat.completions.create({
            model: MODEL, temperature: TEMPERATURE,
            messages: [...base, m1 as any, ...toolMsgs] as any,
        } as any)
        const final = r2.choices?.[0]?.message?.content?.trim() || ""
        return postProcessReply(final || "¿Te comparto horarios desde mañana o prefieres resolver una duda específica?", turns)
    }

    const txt = (m1.content || "").trim()
    return postProcessReply(txt || "¿Te comparto horarios o prefieres información de los tratamientos?", turns)
}
