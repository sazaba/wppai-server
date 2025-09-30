// server/src/utils/ai/strategies/esteticaModules/estetica.prompts.ts
import type { EsteticaCtx } from './estetica.rag'

/**
 * System prompt: personalidad + guardrails "full-agent" ACOTADO a la BD.
 * - No inventar servicios, precios, duraciones ni contraindicaciones.
 * - Si falta un dato, decirlo y sugerir valoración.
 * - Responder en 2–5 líneas, tono cálido y profesional; máx. 1 emoji.
 */
export function buildSystemPrompt(ctx: EsteticaCtx) {
    // Campos garantizados en tu ctx
    const vertical = ctx.vertical && ctx.vertical !== 'custom' ? ctx.vertical : 'estética'
    const addr = ctx.logistics?.locationAddress?.trim?.() ? ctx.logistics.locationAddress.trim() : ''
    const locName = ctx.logistics?.locationName?.trim?.() ? ctx.logistics.locationName.trim() : ''
    const tz = ctx.timezone || 'America/Bogota'

    // Campos opcionales/no tipados en EsteticaCtx → leerlos con any para evitar errores TS
    const anyCtx = ctx as any
    const negocio = (anyCtx?.business?.name || '').toString().trim()
    const web = (anyCtx?.business?.website || '').toString().trim()
    const scope = (anyCtx?.business?.scope || '').toString().trim()
    const disclaim = (anyCtx?.business?.disclaimers || '').toString().trim()
    const phone = (anyCtx?.logistics?.phone || '').toString().trim()
    const policies = (anyCtx?.policies || '').toString().trim()
    const depositRequired: boolean = !!anyCtx?.rules?.depositRequired
    const depositAmount = anyCtx?.rules?.depositAmount

    const depTxt = depositRequired
        ? `Puede requerirse depósito${Number.isFinite(Number(depositAmount)) ? ` (${fmtMoney(depositAmount)})` : ''}.`
        : ''

    return [
        negocio
            ? `Asistente de orientación en ${vertical} de "${negocio}".`
            : `Asistente de orientación en ${vertical}.`,
        'Habla en primera persona (yo), tono cercano, profesional y claro.',
        'Responde en 2–5 líneas. Usa como máximo 1 emoji cuando ayude al tono.',
        'NUNCA inventes servicios, precios, duraciones ni contraindicaciones.',
        'Para preguntas de catálogo usa EXCLUSIVAMENTE la información recuperada desde la base de datos (RAG).',
        'Si un dato no está disponible, dilo con transparencia y sugiere agendar una valoración gratuita.',
        'Evita párrafos largos; usa viñetas o numeración cuando mejore la claridad.',
        scope ? `Ámbito: ${scope}` : '',
        policies ? `Políticas relevantes: ${policies}` : '',
        disclaim ? `Incluye cuando aplique: ${disclaim}` : '',
        addr ? `Dirección: ${addr}` : '',
        locName || phone ? `Contacto/Logística: ${[locName, phone].filter(Boolean).join(' — ')}` : '',
        web ? `Sitio web: ${web}` : '',
        depTxt,
        `Zona horaria de agenda: ${tz}.`,
        'En agendamiento: propone entre 3 y 6 horarios válidos.'
    ].filter(Boolean).join('\n')
}

/**
 * Ofertas de horarios (BOOK / RESCHEDULE).
 * ✔️ Conserva firma/semántica original.
 */
export function fmtProposeSlots(
    slots: Date[],
    ctx: EsteticaCtx,
    verbo: 'agendar' | 'reagendar' = 'agendar'
) {
    if (!slots?.length) {
        return 'En este momento no veo cupos disponibles en la ventana actual. ¿Busco otras fechas? 🙂'
    }
    const tz = ctx.timezone || 'America/Bogota'
    const f = (d: Date) =>
        new Intl.DateTimeFormat('es-CO', {
            dateStyle: 'full',
            timeStyle: 'short',
            timeZone: tz,
        }).format(d)

    const list = slots.slice(0, 6).map((s, i) => `${i + 1}. ${f(s)}`).join('\n')
    return `Puedo ${verbo} tu cita. Estas opciones están libres:\n${list}\n\nResponde con el número que prefieras o indícame otra fecha/hora.`
}

/**
 * Confirmación de cita.
 * ✔️ Mantiene la firma original (recibe endAt aunque no se use).
 */
export function fmtConfirmBooking(
    appt: { startAt: Date; endAt: Date; serviceName?: string; customerName?: string },
    ctx: EsteticaCtx
) {
    const tz = ctx.timezone || 'America/Bogota'
    const when = new Intl.DateTimeFormat('es-CO', {
        dateStyle: 'full',
        timeStyle: 'short',
        timeZone: tz,
    }).format(appt.startAt)

    const quien = appt.customerName ? ` para ${appt.customerName}` : ''
    const servicio = appt.serviceName ? ` (${appt.serviceName})` : ''
    const place = ctx.logistics?.locationName
        ? `\nLugar: ${ctx.logistics.locationName}${ctx.logistics.locationAddress ? ` — ${ctx.logistics.locationAddress}` : ''}`
        : ''

    return `Cita confirmada${quien}${servicio} ✅
Fecha y hora: ${when}${place}
¿Deseas que te envíe un recordatorio? 😊`
}

/* ===== Utils ===== */
function fmtMoney(v: unknown) {
    try {
        const n = Number(v)
        if (!Number.isFinite(n)) return ''
        return new Intl.NumberFormat('es-CO', {
            style: 'currency',
            currency: 'COP',
            maximumFractionDigits: 0,
        }).format(n)
    } catch {
        return ''
    }
}
