import type { EsteticaCtx } from './estetica.rag'
import { matchProcedureFromText } from './estetica.rag'

export enum EsteticaIntent {
    BOOK = 'BOOK',
    RESCHEDULE = 'RESCHEDULE',
    CANCEL = 'CANCEL',
    ASK_SERVICES = 'ASK_SERVICES',
    CONFIRM = 'CONFIRM',
    LIST = 'LIST',
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
    cancelAll?: boolean
    numberList?: number[]
}

function norm(t: string) {
    return (t || '')
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[“”"]/g, '"')
        .trim()
}

// “1 y 2”, “1,2”, “#1 y #2”, etc.
function extractNumberList(t: string): number[] {
    const s = norm(t).replace(/\b(opcion|opciones|numero|nro|num|no|#)\b/g, '')
    const raw = s.match(/(\d{1,2})(?=(?:\D|$))/g)
    if (!raw) return []
    return raw.map(n => Number(n)).filter(n => Number.isFinite(n))
}

/**
 * Política: JAMÁS auto-confirmar por decir "agendar" o "lo más pronto posible".
 * La confirmación solo ocurre con expresiones claras de confirmación.
 */
export async function detectIntent(text: string, ctx: EsteticaCtx): Promise<IntentResult> {
    const t = norm(text)

    // Confirmación explícita
    if (/\b(s[ií] confirmo|confirmo|ok confirmo|confirmar|dale confirmo|listo confirmo)\b/.test(t)) {
        return { type: EsteticaIntent.CONFIRM, confirm: true }
    }

    // Listar citas
    if (/\b(que|qué)?\s*citas?\s*(tengo|pendientes|agendadas|programadas)\b/.test(t)) {
        return { type: EsteticaIntent.LIST }
    }

    // Reagendar
    if (/(reagenda(r|rme)|cambiar cita|mover cita|otra hora|otro horario)/.test(t)) {
        const confirm = /\b(confirmo|confirmar|listo|dale|ok)\b/.test(t)
        return { type: EsteticaIntent.RESCHEDULE, when: null, confirm }
    }

    // Cancelar (acepta “cota” typo)
    if (/(cancel(ar|acion|ación)|anular)\s*(cita|cota)?/.test(t)) {
        const list = extractNumberList(t)
        const cancelAll = /\b(todas|ambas|las dos|las 2|las tres|las 3|todas las citas)\b/.test(t)
        return { type: EsteticaIntent.CANCEL, numberList: list, cancelAll }
    }

    // Catálogo / info
    if (/(precio|costo|servicios|tratamiento|procedimiento|hacen|ofrecen)/.test(t)) {
        return { type: EsteticaIntent.ASK_SERVICES, query: text }
    }

    // Booking (nunca confirmamos aquí)
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
        } catch { }

        return { type: EsteticaIntent.BOOK, when: null, confirm: false, serviceName, procedureId, durationMin }
    }

    return { type: EsteticaIntent.GENERAL_QA, query: text }
}
