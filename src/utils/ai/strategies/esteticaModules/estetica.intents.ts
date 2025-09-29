// server/src/utils/ai/strategies/esteticaModules/estetica.intents.ts
import type { EsteticaCtx } from './estetica.rag'
import { matchProcedureFromText } from './estetica.rag'

export enum EsteticaIntent {
    BOOK = 'BOOK',
    RESCHEDULE = 'RESCHEDULE',
    CANCEL = 'CANCEL',
    ASK_SERVICES = 'ASK_SERVICES',
    CONFIRM = 'CONFIRM',
    GENERAL_QA = 'GENERAL_QA',
}

export type IntentResult = {
    type: EsteticaIntent
    query?: string
    when?: Date | null
    confirm?: boolean
    appointmentId?: number
    serviceName?: string
    procedureId?: number
    durationMin?: number
    customerName?: string
    notes?: string
}

export async function detectIntent(text: string, ctx: EsteticaCtx): Promise<IntentResult> {
    const t = (text || '').toLowerCase().trim()

    // Confirmación explícita
    if (/\b(confirmo|sí confirmo|si confirmo|ok confirmo|confirmar cita|confirmar)\b/.test(t)) {
        return { type: EsteticaIntent.CONFIRM, confirm: true }
    }

    if (/(reagenda(r|rme)|cambiar cita|mover cita|otra hora)/i.test(t)) {
        const confirm = /(confirm|sí|si|listo|dale)/i.test(t)
        return { type: EsteticaIntent.RESCHEDULE, when: null, confirm }
    }

    if (/(cancel(ar|ación) cita|anular cita|cancelar)/i.test(t)) {
        return { type: EsteticaIntent.CANCEL }
    }

    if (/(precio|costo|servicios|tratamiento|procedimiento|hacen|ofrecen)/i.test(t)) {
        return { type: EsteticaIntent.ASK_SERVICES, query: text }
    }

    // BOOK
    if (/\b(cita|agendar|agenda|reservar|reserva|separar)\b/.test(t)) {
        let serviceName: string | undefined
        let procedureId: number | undefined
        let durationMin: number | undefined

        try {
            const match = await matchProcedureFromText(ctx.empresaId, text)
            if (match) {
                serviceName = match.name
                procedureId = match.id
                durationMin = match.durationMin ?? ctx.rules?.defaultServiceDurationMin ?? 60
            } else {
                durationMin = ctx.rules?.defaultServiceDurationMin ?? 60
            }
        } catch { /* noop */ }

        const confirm = /(confirm|sí|si|listo|dale|hágale)/i.test(t)
        return { type: EsteticaIntent.BOOK, when: null, confirm, serviceName, procedureId, durationMin }
    }

    return { type: EsteticaIntent.GENERAL_QA, query: text }
}
