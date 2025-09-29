// server/src/utils/ai/strategies/esteticaModules/estetica.prompts.ts
import type { EsteticaCtx } from './estetica.rag'

export function buildSystemPrompt(ctx: EsteticaCtx) {
    const rol = ctx.vertical && ctx.vertical !== 'custom' ? ctx.vertical : 'estética'
    return [
        `Eres un asistente profesional en ${rol} para WhatsApp.`,
        `Respondes con calidez, precisión y en 4–6 líneas.`,
        `No inventes datos; si falta información, pídela.`,
        ctx.policies && `Políticas relevantes: ${ctx.policies}`,
        ctx.logistics?.locationAddress && `Dirección: ${ctx.logistics.locationAddress}`,
        ctx.rules?.depositRequired ? `Puede requerirse depósito (${fmtMoney(ctx.rules.depositAmount) || ''}).` : '',
        `En agendamiento: propone 3–6 horarios válidos.`
    ].filter(Boolean).join('\n')
}

export function fmtProposeSlots(slots: Date[], ctx: EsteticaCtx, verbo: 'agendar' | 'reagendar' = 'agendar') {
    if (!slots.length) return 'No veo cupos disponibles en la ventana actual. ¿Busco otras fechas?'
    const f = (d: Date) => new Intl.DateTimeFormat('es-CO', { dateStyle: 'full', timeStyle: 'short', timeZone: ctx.timezone }).format(d)
    const list = slots.slice(0, 6).map(s => `• ${f(s)}`).join('\n')
    return `Puedo ${verbo} en:\n${list}\n\n¿Alguno te funciona?`
}

export function fmtConfirmBooking(appt: { startAt: Date; endAt: Date; serviceName?: string; customerName?: string }, ctx: EsteticaCtx) {
    const f = (d: Date) => new Intl.DateTimeFormat('es-CO', { dateStyle: 'full', timeStyle: 'short', timeZone: ctx.timezone }).format(d)
    const quien = appt.customerName ? ` para ${appt.customerName}` : ''
    const servicio = appt.serviceName ? ` (${appt.serviceName})` : ''
    const loc = ctx.logistics?.locationName
        ? `\nLugar: ${ctx.logistics.locationName}${ctx.logistics.locationAddress ? ` — ${ctx.logistics.locationAddress}` : ''}`
        : ''
    return `Cita confirmada${quien}${servicio} ✅\nFecha: ${f(appt.startAt)}${loc}`
}

function fmtMoney(v: any) {
    try {
        const n = Number(v); if (Number.isNaN(n)) return ''
        return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n)
    } catch { return '' }
}
