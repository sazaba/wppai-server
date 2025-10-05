// utils/ai/strategies/esteticaModules/domain/estetica.rag.ts
import prisma from "../../../../../lib/prisma"
import type { AppointmentVertical } from "@prisma/client"

const ESTETICA_DEBUG = String(process.env.ESTETICA_DEBUG ?? "0") !== "0"
type Lvl = "debug" | "info" | "warn" | "error"
function log(level: Lvl, msg: string, meta?: any) {
    if (!ESTETICA_DEBUG && level === "debug") return
    const tag = `[RAG:${level.toUpperCase()}]`
    if (meta !== undefined) (console as any)[level]?.(tag, msg, meta) ?? console.log(tag, msg, meta)
    else (console as any)[level]?.(tag, msg) ?? console.log(tag, msg)
}

/* ======================== Types ======================== */
export type EsteticaCtx = {
    empresaId: number
    vertical: AppointmentVertical | "custom"
    timezone: string
    bufferMin: number
    policies?: string | null
    logistics?: {
        locationName?: string
        locationAddress?: string
        locationMapsUrl?: string
        instructionsArrival?: string
        parkingInfo?: string
    }
    rules?: {
        cancellationWindowHours?: number | null
        noShowPolicy?: string | null
        depositRequired?: boolean | null
        depositAmount?: unknown
        maxDailyAppointments?: number | null
        bookingWindowDays?: number | null
        blackoutDates?: string[] | null
        overlapStrategy?: string | null
        minNoticeHours?: number | null
        maxAdvanceDays?: number | null
        allowSameDay?: boolean | null
        requireConfirmation?: boolean | null
        defaultServiceDurationMin?: number | null
        paymentNotes?: string | null
    }
    buildKbContext: () => Promise<string>
}

/* ======================== Parsers ======================== */
function asStrArr(v: unknown): string[] | null {
    if (v == null) return null
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string")
    if (typeof v === "string") {
        try {
            const j = JSON.parse(v)
            return Array.isArray(j) ? j.filter((x): x is string => typeof x === "string") : null
        } catch { return null }
    }
    return null
}
function asNum(v: unknown, dflt?: number | null): number | null {
    const n = Number(v)
    return Number.isFinite(n) ? n : (dflt ?? null)
}
function asBool(v: unknown, dflt = false): boolean {
    if (typeof v === "boolean") return v
    if (typeof v === "string") return ["true", "1", "yes", "si", "sí"].includes(v.toLowerCase())
    if (typeof v === "number") return v !== 0
    return dflt
}

/* ======================== Context Loader ======================== */
type OrchestratorOverrides = {
    vertical?: AppointmentVertical | "custom"
    timezone?: string
    bufferMin?: number
    policies?: string | null
    logistics?: Record<string, unknown>
    appointmentMinNoticeHours?: number | null
    appointmentMaxAdvanceDays?: number | null
    allowSameDayBooking?: boolean | null
    requireClientConfirmation?: boolean | null
    defaultServiceDurationMin?: number | null
    bookingWindowDays?: number | null
    maxDailyAppointments?: number | null
    blackoutDates?: string[] | string | null
    overlapStrategy?: string | null
    kb?: {
        businessOverview?: string
        faqs?: Array<{ q: string; a: string }>
        serviceNotes?: Record<string, unknown>
        disclaimers?: string
        freeText?: string
    }
}

export async function loadApptContext(
    empresaId: number,
    fromOrchestrator?: OrchestratorOverrides
): Promise<EsteticaCtx> {
    const t0 = Date.now()

    if (fromOrchestrator) {
        const o = fromOrchestrator
        const ctx: EsteticaCtx = {
            empresaId,
            vertical: (o.vertical as AppointmentVertical) ?? "custom",
            timezone: o.timezone ?? "America/Bogota",
            bufferMin: asNum(o.bufferMin, 10) ?? 10,
            policies: o.policies ?? null,
            logistics: {
                locationName: o?.logistics?.["locationName"] as string | undefined,
                locationAddress: o?.logistics?.["locationAddress"] as string | undefined,
                locationMapsUrl: o?.logistics?.["locationMapsUrl"] as string | undefined,
                instructionsArrival: o?.logistics?.["instructionsArrival"] as string | undefined,
                parkingInfo: o?.logistics?.["parkingInfo"] as string | undefined,
            },
            rules: {
                cancellationWindowHours: null,
                noShowPolicy: null,
                depositRequired: null,
                depositAmount: null,
                maxDailyAppointments: asNum(o.maxDailyAppointments),
                bookingWindowDays: asNum(o.bookingWindowDays, asNum(o.appointmentMaxAdvanceDays, 30)) ?? 30,
                blackoutDates: asStrArr(o.blackoutDates) ?? null,
                overlapStrategy: (o.overlapStrategy as string) ?? "strict",
                minNoticeHours: asNum(o.appointmentMinNoticeHours),
                maxAdvanceDays: asNum(o.appointmentMaxAdvanceDays),
                allowSameDay: asBool(o.allowSameDayBooking, false),
                requireConfirmation: asBool(o.requireClientConfirmation, true),
                defaultServiceDurationMin: asNum(o.defaultServiceDurationMin, 60) ?? 60,
                paymentNotes: null,
            },
            buildKbContext: async () => {
                const kb = o.kb ?? {}
                const out = [
                    kb.businessOverview && `Sobre la clínica:\n${kb.businessOverview}`,
                    Array.isArray(kb.faqs) && kb.faqs.length
                        ? `FAQs:\n${kb.faqs.map((f) => `- ${f.q}\n  ${f.a}`).join("\n")}`
                        : "",
                    kb.serviceNotes && `Servicios (notas):\n${JSON.stringify(kb.serviceNotes, null, 2)}`,
                    kb.disclaimers && `Avisos:\n${kb.disclaimers}`,
                    kb.freeText && `Notas libres:\n${kb.freeText}`,
                ].filter(Boolean).join("\n\n")
                log("debug", "kb.orchestrator.len", { len: out.length })
                return out
            },
        }

        log("info", "ctx.loaded.fromOrchestrator", {
            empresaId,
            timezone: ctx.timezone,
            bufferMin: ctx.bufferMin,
            rules: {
                allowSameDay: ctx.rules?.allowSameDay,
                minNoticeHours: ctx.rules?.minNoticeHours,
                bookingWindowDays: ctx.rules?.bookingWindowDays,
                maxDailyAppointments: ctx.rules?.maxDailyAppointments,
                requireConfirmation: ctx.rules?.requireConfirmation,
                defaultServiceDurationMin: ctx.rules?.defaultServiceDurationMin,
                blackoutDatesCount: ctx.rules?.blackoutDates?.length ?? 0,
            },
            ms: Date.now() - t0,
        })
        return ctx
    }

    // ——— Carga desde DB ———
    const bca = await prisma.businessConfigAppt.findUnique({ where: { empresaId } })

    const ctx: EsteticaCtx = {
        empresaId,
        vertical: (bca?.appointmentVertical as AppointmentVertical) ?? "custom",
        timezone: bca?.appointmentTimezone ?? "America/Bogota",
        bufferMin: asNum(bca?.appointmentBufferMin, 10) ?? 10,
        policies: bca?.appointmentPolicies ?? null,
        logistics: {
            locationName: bca?.locationName ?? undefined,
            locationAddress: bca?.locationAddress ?? undefined,
            locationMapsUrl: bca?.locationMapsUrl ?? undefined,
            instructionsArrival: bca?.instructionsArrival ?? undefined,
            parkingInfo: bca?.parkingInfo ?? undefined,
        },
        rules: {
            cancellationWindowHours: asNum(bca?.cancellationWindowHours),
            noShowPolicy: bca?.noShowPolicy ?? null,
            depositRequired: typeof bca?.depositRequired === "boolean" ? bca.depositRequired : null,
            depositAmount: bca?.depositAmount ?? null,
            maxDailyAppointments: asNum(bca?.maxDailyAppointments),
            bookingWindowDays: asNum(bca?.bookingWindowDays, asNum(bca?.appointmentMaxAdvanceDays, 30)) ?? 30,
            blackoutDates: asStrArr(bca?.blackoutDates) ?? null,
            overlapStrategy: bca?.overlapStrategy ?? "strict",
            minNoticeHours: asNum(bca?.appointmentMinNoticeHours),
            maxAdvanceDays: asNum(bca?.appointmentMaxAdvanceDays),
            allowSameDay: asBool(bca?.allowSameDayBooking, false),
            requireConfirmation: asBool(bca?.requireClientConfirmation, true),
            defaultServiceDurationMin: asNum(bca?.defaultServiceDurationMin, 60) ?? 60,
            paymentNotes: null,
        },
        buildKbContext: async () => {
            const out = [
                bca?.kbBusinessOverview && `Sobre la clínica:\n${bca.kbBusinessOverview}`,
                Array.isArray(bca?.kbFAQs) && (bca.kbFAQs as any[])?.length
                    ? `FAQs:\n${(bca.kbFAQs as any[]).map((f: any) => `- ${f.q}\n  ${f.a}`).join("\n")}`
                    : "",
                bca?.kbServiceNotes && `Servicios (notas):\n${JSON.stringify(bca.kbServiceNotes as any, null, 2)}`,
                bca?.kbDisclaimers && `Avisos:\n${bca.kbDisclaimers}`,
                bca?.kbFreeText && `Notas libres:\n${bca.kbFreeText}`,
            ].filter(Boolean).join("\n\n")
            log("debug", "kb.db.len", { len: out.length })
            return out
        },
    }

    log("info", "ctx.loaded.fromDB", {
        empresaId,
        timezone: ctx.timezone,
        bufferMin: ctx.bufferMin,
        rules: {
            allowSameDay: ctx.rules?.allowSameDay,
            minNoticeHours: ctx.rules?.minNoticeHours,
            bookingWindowDays: ctx.rules?.bookingWindowDays,
            maxDailyAppointments: ctx.rules?.maxDailyAppointments,
            requireConfirmation: ctx.rules?.requireConfirmation,
            defaultServiceDurationMin: ctx.rules?.defaultServiceDurationMin,
            blackoutDatesCount: ctx.rules?.blackoutDates?.length ?? 0,
        },
        ms: Date.now() - t0,
    })

    return ctx
}

/* ======================= Procedimientos: matching ======================= */
const nrm = (s: string) =>
    String(s || "")
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .toLowerCase().replace(/[^\w\s]/g, " ")
        .replace(/\s+/g, " ").trim()

export async function matchProcedureFromText(empresaId: number, text: string) {
    const q = nrm(text)
    if (!q) return null

    const rows = await prisma.esteticaProcedure.findMany({
        where: { empresaId, enabled: true },
        select: { id: true, name: true, durationMin: true, aliases: true },
    })

    type Row = (typeof rows)[number]
    let best: Row | null = null
    let bestScore = 0

    for (const r of rows) {
        const nameKey = nrm(r.name)
        const byName = q.includes(nameKey) ? 1 : 0

        let byAlias = 0
        const aliases = Array.isArray(r.aliases) ? (r.aliases as unknown as string[]) : []
        for (const a of aliases) if (typeof a === "string" && q.includes(nrm(a))) byAlias = Math.max(byAlias, 0.8)

        const score = Math.max(byName, byAlias)
        if (score > bestScore) { best = r; bestScore = score }
    }

    return best && bestScore >= 0.6
        ? { id: best.id, name: best.name, durationMin: best.durationMin ?? undefined }
        : null
}
