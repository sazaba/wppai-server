// server/src/utils/ai/strategies/esteticaModules/estetica.rag.ts
import prisma from '../../../../lib/prisma'
import type { AppointmentVertical } from '@prisma/client'

export type EsteticaCtx = {
    empresaId: number
    vertical: AppointmentVertical | 'custom'
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
        depositAmount?: any
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

/**
 * Carga el contexto de agenda desde el orquestador (preferente) o DB (fallback).
 * Mantiene shape estable para el strategy.
 */
export async function loadApptContext(empresaId: number, fromOrchestrator?: any): Promise<EsteticaCtx> {
    if (fromOrchestrator) {
        return {
            empresaId,
            vertical: fromOrchestrator.vertical ?? 'custom',
            timezone: fromOrchestrator.timezone ?? 'America/Bogota',
            bufferMin: fromOrchestrator.bufferMin ?? 10,
            policies: fromOrchestrator.policies ?? null,
            logistics: fromOrchestrator.logistics ?? {},
            rules: {
                cancellationWindowHours: fromOrchestrator.rules?.cancellationWindowHours ?? null,
                noShowPolicy: fromOrchestrator.rules?.noShowPolicy ?? null,
                depositRequired: fromOrchestrator.rules?.depositRequired ?? null,
                depositAmount: fromOrchestrator.rules?.depositAmount ?? null,
                maxDailyAppointments: fromOrchestrator.rules?.maxDailyAppointments ?? null,
                bookingWindowDays: fromOrchestrator.rules?.bookingWindowDays ?? 30,
                blackoutDates: fromOrchestrator.rules?.blackoutDates ?? null,
                overlapStrategy: fromOrchestrator.rules?.overlapStrategy ?? 'strict',
                minNoticeHours: fromOrchestrator.appointmentMinNoticeHours ?? fromOrchestrator.rules?.minNoticeHours ?? null,
                maxAdvanceDays: fromOrchestrator.appointmentMaxAdvanceDays ?? fromOrchestrator.rules?.maxAdvanceDays ?? null,
                allowSameDay: fromOrchestrator.allowSameDayBooking ?? fromOrchestrator.rules?.allowSameDay ?? false,
                requireConfirmation: fromOrchestrator.requireClientConfirmation ?? fromOrchestrator.rules?.requireClientConfirmation ?? true,
                defaultServiceDurationMin: fromOrchestrator.defaultServiceDurationMin ?? 60,
                paymentNotes: fromOrchestrator.paymentNotes ?? null
            },
            buildKbContext: async () => {
                const kb = fromOrchestrator.kb ?? {}
                return [
                    kb.businessOverview && `Sobre la empresa:\n${kb.businessOverview}`,
                    Array.isArray(kb.faqs) && kb.faqs.length
                        ? `FAQs:\n${kb.faqs.map((f: any) => `- ${f.q}\n  ${f.a}`).join('\n')}`
                        : '',
                    kb.serviceNotes && `Notas de servicios:\n${JSON.stringify(kb.serviceNotes, null, 2)}`,
                    kb.disclaimers && `Avisos/Disclaimers:\n${kb.disclaimers}`,
                    kb.freeText && `Notas libres:\n${kb.freeText}`
                ]
                    .filter(Boolean)
                    .join('\n\n')
            }
        }
    }

    // Fallback a DB
    const bca = await prisma.businessConfigAppt.findUnique({ where: { empresaId } })
    return {
        empresaId,
        vertical: bca?.appointmentVertical ?? 'custom',
        timezone: bca?.appointmentTimezone ?? 'America/Bogota',
        bufferMin: bca?.appointmentBufferMin ?? 10,
        policies: bca?.appointmentPolicies ?? null,
        logistics: {
            locationName: bca?.locationName ?? undefined,
            locationAddress: bca?.locationAddress ?? undefined,
            locationMapsUrl: bca?.locationMapsUrl ?? undefined,
            instructionsArrival: bca?.instructionsArrival ?? undefined,
            parkingInfo: bca?.parkingInfo ?? undefined
        },
        rules: {
            cancellationWindowHours: bca?.cancellationWindowHours ?? null,
            noShowPolicy: bca?.noShowPolicy ?? null,
            depositRequired: bca?.depositRequired ?? null,
            depositAmount: bca?.depositAmount ?? null,
            maxDailyAppointments: bca?.maxDailyAppointments ?? null,
            bookingWindowDays: bca?.bookingWindowDays ?? 30,
            blackoutDates: (bca?.blackoutDates as any) ?? null,
            overlapStrategy: bca?.overlapStrategy ?? 'strict',
            minNoticeHours: bca?.appointmentMinNoticeHours ?? null,
            maxAdvanceDays: bca?.appointmentMaxAdvanceDays ?? null,
            allowSameDay: bca?.allowSameDayBooking ?? false,
            requireConfirmation: bca?.requireClientConfirmation ?? true,
            defaultServiceDurationMin: bca?.defaultServiceDurationMin ?? 60,
            paymentNotes: null
        },
        buildKbContext: async () =>
            [
                bca?.kbBusinessOverview && `Sobre la empresa:\n${bca.kbBusinessOverview}`,
                Array.isArray(bca?.kbFAQs) && (bca?.kbFAQs as any[]).length
                    ? `FAQs:\n${(bca!.kbFAQs as any[]).map((f: any) => `- ${f.q}\n  ${f.a}`).join('\n')}`
                    : '',
                bca?.kbServiceNotes && `Notas de servicios:\n${JSON.stringify(bca.kbServiceNotes, null, 2)}`,
                bca?.kbDisclaimers && `Avisos/Disclaimers:\n${bca.kbDisclaimers}`,
                bca?.kbFreeText && `Notas libres:\n${bca.kbFreeText}`
            ]
                .filter(Boolean)
                .join('\n\n')
    }
}

/** Consulta de procedimientos (para RAG simple de servicios) */


export async function retrieveProcedures(empresaId: number, rawQuery?: string) {
    const q = (rawQuery || '').trim()

    // 1) Sin query → top 10 activos
    if (!q) {
        return prisma.esteticaProcedure.findMany({
            where: { empresaId, enabled: true },
            orderBy: [{ updatedAt: 'desc' }, { name: 'asc' }],
            take: 10,
            select: {
                id: true,
                name: true,
                durationMin: true,
                priceMin: true,
                priceMax: true,
                requiresAssessment: true,
                prepInstructions: true,
                contraindications: true,
                postCare: true,
                notes: true,
            },
        })
    }

    // 2) Búsqueda compatible (sin "mode", sin "aliases" en el where)
    const rows = await prisma.esteticaProcedure.findMany({
        where: {
            empresaId,
            enabled: true,
            OR: [
                { name: { contains: q } },
                { notes: { contains: q } },
                { contraindications: { contains: q } },
                { prepInstructions: { contains: q } },
                { postCare: { contains: q } },
            ],
        },
        orderBy: [{ updatedAt: 'desc' }, { name: 'asc' }],
        take: 10,
        select: {
            id: true,
            name: true,
            durationMin: true,
            priceMin: true,
            priceMax: true,
            requiresAssessment: true,
            prepInstructions: true,
            contraindications: true,
            postCare: true,
            notes: true,
        },
    })

    if (rows.length) return rows

    // 3) Fallback: filtrar en memoria usando "aliases" si existe (cualquier tipo)
    const all = await prisma.esteticaProcedure.findMany({
        where: { empresaId, enabled: true },
        take: 30,
        orderBy: [{ updatedAt: 'desc' }, { name: 'asc' }],
        select: {
            id: true,
            name: true,
            durationMin: true,
            priceMin: true,
            priceMax: true,
            requiresAssessment: true,
            prepInstructions: true,
            contraindications: true,
            postCare: true,
            notes: true,
            // no lo ponemos en el where para evitar error de tipado
            // pero sí lo traemos como any si existe
            // @ts-ignore - schema puede no tenerlo
            aliases: true as any,
        } as any,
    })

    const needle = q.toLowerCase()
    return all.filter((p: any) => {
        const aliases = Array.isArray(p.aliases)
            ? p.aliases.join(', ')
            : (typeof p.aliases === 'string' ? p.aliases : '')
        const haystack = [
            p.name, p.notes, p.contraindications, p.prepInstructions, p.postCare, aliases,
        ].filter(Boolean).join(' • ').toLowerCase()
        return haystack.includes(needle)
    })
}


const nrm = (s: string) =>
    String(s || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()

/** Mapeo texto → procedimiento (id, nombre, duración, depósito) */
export async function matchProcedureFromText(
    empresaId: number,
    text: string
): Promise<{ id: number; name: string; durationMin?: number | null; depositRequired?: boolean; depositAmount?: any } | null> {
    const q = nrm(text)
    if (!q) return null

    const rows = await prisma.esteticaProcedure.findMany({
        where: { empresaId, enabled: true },
        select: { id: true, name: true, durationMin: true, aliases: true, depositRequired: true, depositAmount: true }
    })

    let best: any = null
    let bestScore = 0

    for (const r of rows) {
        const nameScore = q.includes(nrm(r.name)) ? 1 : 0
        let aliasScore = 0
        const aliases = Array.isArray(r.aliases) ? r.aliases : []
        for (const a of aliases) {
            if (typeof a === 'string' && q.includes(nrm(a))) aliasScore = Math.max(aliasScore, 0.8)
        }
        const score = Math.max(nameScore, aliasScore)
        if (score > bestScore) { best = r; bestScore = score }
    }

    return bestScore >= 0.6
        ? { id: best.id, name: best.name, durationMin: best.durationMin, depositRequired: best.depositRequired, depositAmount: best.depositAmount }
        : null
}

/** Confirmar la última cita 'pending' por teléfono (útil para intent CONFIRM) */
export async function confirmLatestPendingForPhone(empresaId: number, phoneE164: string) {
    const appt = await prisma.appointment.findFirst({
        where: { empresaId, customerPhone: phoneE164, status: 'pending' },
        orderBy: { startAt: 'desc' },
        select: { id: true }
    })
    if (!appt) return null
    return prisma.appointment.update({
        where: { id: appt.id },
        data: { status: 'confirmed' }
    })
}
