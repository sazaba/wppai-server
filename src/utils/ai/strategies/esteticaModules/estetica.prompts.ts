import type { EsteticaCtx } from './estetica.rag'

/**
 * Prompt “full-agent” para estética:
 * - Tono humano, cálido y profesional; 3–5 líneas; máx 1 emoji.
 * - SOLO usa lo que esté en el catálogo/contexto (BD/orquestador). Si falta info, dilo y ofrece opciones.
 * - Nunca inventes precios ni duraciones.
 * - En agendamiento, propone 3–6 horarios y pide confirmar con el número.
 */
export function buildSystemPrompt(ctx: EsteticaCtx): string {
    const vertical =
        ctx.vertical && ctx.vertical !== 'custom' ? String(ctx.vertical) : 'estética'

    const addr = (ctx.logistics?.locationAddress ?? '').trim()
    const locName = (ctx.logistics?.locationName ?? '').trim()
    const phone = (ctx.logistics?.locationMapsUrl ?? '').trim()
    const arrival = (ctx.logistics?.instructionsArrival ?? '').trim()
    const parking = (ctx.logistics?.parkingInfo ?? '').trim()

    const depTxt = ctx.rules?.depositRequired
        ? `Puede requerirse un depósito${ctx.rules?.depositAmount ? ` (${fmtMoney(ctx.rules.depositAmount)})` : ''
        }.`
        : ''

    return [
        `Eres un asistente humano virtual especializado en ${vertical} para WhatsApp.`,
        `Tu estilo es cercano, cálido y profesional. Responde en 3–5 líneas y usa a lo sumo 1 emoji.`,
        `Usa únicamente información presente en el catálogo/contexto. Si no hay datos suficientes, comunícalo y ofrece alternativas (pedir más detalles o agendar una valoración gratuita si aplica).`,
        `Nunca inventes precios ni duraciones: usa exactamente los valores del catálogo que te pase el sistema.`,
        ctx.policies ? `Políticas: ${ctx.policies}` : '',
        locName ? `Sede: ${locName}` : '',
        addr ? `Dirección: ${addr}` : '',
        phone ? `Mapa: ${phone}` : '',
        arrival ? `Indicaciones de llegada: ${arrival}` : '',
        parking ? `Parqueadero: ${parking}` : '',
        depTxt,
        `En agendamiento, propone entre 3 y 6 horarios válidos (zona horaria ${ctx.timezone}) y pide confirmar con el número de la opción.`,
    ]
        .filter(Boolean)
        .join('\n')
}

/** Propuesta de horarios de agenda/reagenda */
export function fmtProposeSlots(
    slots: Date[],
    ctx: EsteticaCtx,
    verbo: 'agendar' | 'reagendar' = 'agendar'
): string {
    if (!slots || slots.length === 0) {
        return 'No veo cupos libres en esa franja. ¿Busco otras fechas u horarios?'
    }
    const f = (d: Date) =>
        new Intl.DateTimeFormat('es-CO', {
            dateStyle: 'full',
            timeStyle: 'short',
            timeZone: ctx.timezone,
        }).format(d)

    const list = slots
        .slice(0, 6)
        .map((s, i) => `${i + 1}. ${f(s)}`)
        .join('\n')

    return `Puedo ${verbo} tu cita en:\n${list}\n\nResponde con el número de la opción o indícame otra fecha/hora.`
}

/** Confirmación de cita (incluye código corto) */
export function fmtConfirmBooking(
    appt: {
        id?: number
        startAt: Date
        endAt: Date
        serviceName?: string
        customerName?: string
    },
    ctx: EsteticaCtx
): string {
    const f = (d: Date) =>
        new Intl.DateTimeFormat('es-CO', {
            dateStyle: 'full',
            timeStyle: 'short',
            timeZone: ctx.timezone,
        }).format(d)

    const quien = appt.customerName ? ` para ${appt.customerName}` : ''
    const servicio = appt.serviceName ? ` (${appt.serviceName})` : ''
    const loc =
        ctx.logistics?.locationName || ctx.logistics?.locationAddress
            ? `\n📍 Lugar: ${[
                ctx.logistics?.locationName ?? '',
                ctx.logistics?.locationAddress ?? '',
            ]
                .filter(Boolean)
                .join(' — ')}`
            : ''

    const code = appt?.id ? `\n🆔 Código: APT-${String(appt.id).padStart(4, '0')}` : ''

    return `✅ Cita confirmada${quien}${servicio}\n🗓️ ${f(
        appt.startAt
    )}${loc}${code}\nPor favor llega 10 minutos antes.`
}

/** Utilidad: formato de dinero COP sin decimales */
function fmtMoney(v: unknown): string {
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
