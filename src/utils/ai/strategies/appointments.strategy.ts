// server/src/utils/ai/strategies/appointments.strategy.ts
import prisma from '../../../lib/prisma'
import { openai } from '../../../lib/openai'
import type { IAReplyResult } from '../../handleIAReply.ecommerce'
import { ConversationEstado, MessageFrom } from '@prisma/client'
import * as Wam from '../../../services/whatsapp.service'


/* ========== util: branding & formato breve (copias mínimas) ========== */
const IA_MAX_LINES = Number(process.env.IA_MAX_LINES ?? 5)
const IA_MAX_CHARS = Number(process.env.IA_MAX_CHARS ?? 1000)
const IA_MAX_TOKENS = Number(process.env.IA_MAX_TOKENS ?? 100)
const IA_ALLOW_EMOJI = (process.env.IA_ALLOW_EMOJI ?? '0') === '1'

function softTrim(s: string | null | undefined, max = 160) {
    const t = (s || '').trim()
    if (!t) return ''
    return t.length <= max ? t : t.slice(0, max).replace(/\s+[^\s]*$/, '') + '…'
}
function clampConcise(text: string, maxLines = IA_MAX_LINES, _maxChars = IA_MAX_CHARS): string {
    let t = String(text || '').replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
    if (!t) return t
    const lines = t.split('\n').filter(Boolean)
    if (lines.length > maxLines) {
        t = lines.slice(0, maxLines).join('\n').trim()
        if (!/[.!?…]$/.test(t)) t += '…'
    }
    return t
}
function formatConcise(text: string, maxLines = IA_MAX_LINES, maxChars = IA_MAX_CHARS, allowEmoji = IA_ALLOW_EMOJI) {
    let t = String(text || '').trim()
    if (!t) return 'Gracias por escribirnos. ¿Cómo puedo ayudarte?'
    t = t.replace(/^[•\-]\s*/gm, '').replace(/\s+\n/g, '\n').replace(/\n{2,}/g, '\n').trim()
    t = clampConcise(t, maxLines, maxChars)
    if (allowEmoji && !/[^\w\s.,;:()¿?¡!…]/.test(t)) {
        const EMOJIS = ['🙂', '💡', '👌', '✅', '✨', '📆']
        t = `${t} ${EMOJIS[Math.floor(Math.random() * EMOJIS.length)]}`
        t = clampConcise(t, maxLines, maxChars)
    }
    return t
}
function endsWithPunctuation(t: string) { return /[.!?…]\s*$/.test((t || '').trim()) }
function closeNicely(raw: string) {
    let t = (raw || '').trim()
    if (!t) return t
    if (endsWithPunctuation(t)) return t
    t = t.replace(/\s+[^\s]*$/, '').trim()
    if (!t) return raw.trim()
    return `${t}…`
}
function maybeInjectBrand(text: string, businessPrompt?: string): string {
    const p = String(businessPrompt || '')
    const urlMatch = p.match(/(https?:\/\/[^\s]+|www\.[^\s]+)/i)
    const url = urlMatch ? urlMatch[0] : ''
    if (!url) return text
    if (!endsWithPunctuation(text)) return text
    const candidate = `${text}\nMás info: ${url}`.trim()
    return clampConcise(candidate, IA_MAX_LINES, IA_MAX_CHARS)
}

/* ========== util: parse de servicios (desde BusinessConfig.servicios) ========== */
function parseServiciosList(raw?: string | null): string[] {
    const t = String(raw ?? '').trim()
    if (!t) return []
    // intenta JSON ["Corte","Color"] o string con comas/saltos de línea
    try {
        const j = JSON.parse(t)
        if (Array.isArray(j)) return j.map(x => String(x || '').trim()).filter(Boolean)
    } catch { /* noop */ }
    return t
        .split(/\r?\n|,/g)
        .map(s => s.trim())
        .filter(Boolean)
}

/* ========== util: historial & persistencia (copias mínimas) ========== */
async function getRecentHistory(conversationId: number, take = 10) {
    const rows = await prisma.message.findMany({
        where: { conversationId },
        orderBy: { timestamp: 'desc' },
        take,
        select: { from: true, contenido: true },
    })
    return rows.reverse().map(r => ({
        role: r.from === MessageFrom.client ? 'user' : 'assistant',
        content: softTrim(r.contenido || '', 220)
    }))
}
function normalizeToE164(n: string) { return String(n || '').replace(/[^\d]/g, '') }
async function persistBotReply(opts: {
    conversationId: number
    empresaId: number
    texto: string
    nuevoEstado: ConversationEstado
    to?: string
    phoneNumberId?: string
}) {
    const { conversationId, empresaId, texto, nuevoEstado, to, phoneNumberId } = opts
    const msg = await prisma.message.create({
        data: { conversationId, from: MessageFrom.bot, contenido: texto, empresaId },
    })
    await prisma.conversation.update({ where: { id: conversationId }, data: { estado: nuevoEstado } })

    let wamid: string | undefined
    if (to && String(to).trim()) {
        try {
            const resp = await Wam.sendWhatsappMessage({
                empresaId, to: normalizeToE164(to), body: texto, phoneNumberIdHint: phoneNumberId,
            })
            wamid = (resp as any)?.data?.messages?.[0]?.id || (resp as any)?.messages?.[0]?.id
            if (wamid) await prisma.message.update({ where: { id: msg.id }, data: { externalId: wamid } })
        } catch { /* noop */ }
    }
    return { messageId: msg.id, texto, wamid }
}

/* ========== Strategy principal ========== */
export async function handleAppointmentsReply(args: {
    chatId: number
    empresaId: number
    mensajeArg?: string
    toPhone?: string
    phoneNumberId?: string
}): Promise<IAReplyResult | null> {
    const { chatId, empresaId, mensajeArg = '', toPhone, phoneNumberId } = args

    // 1) Config del negocio
    const [bc, empresa] = await Promise.all([
        prisma.businessConfig.findUnique({
            where: { empresaId },
            select: {
                nombre: true,
                appointmentVertical: true,   // <- usa este rol/vertical
                servicios: true,             // <- origen de servicios permitidos
                agentPrompt: true,           // para branding web/URL si lo tenías acá
            }
        }),
        prisma.empresa.findUnique({ where: { id: empresaId }, select: { nombre: true } })
    ])

    if (!bc) {
        const texto = 'No encuentro la configuración del negocio para agendar. Por favor intenta más tarde.'
        const saved = await persistBotReply({
            conversationId: chatId,
            empresaId,
            texto,
            nuevoEstado: ConversationEstado.respondido,
            to: toPhone,
            phoneNumberId,
        })
        return {
            estado: ConversationEstado.respondido,
            mensaje: saved.texto,
            messageId: saved.messageId,
            wamid: saved.wamid,
            media: [],
        }
    }


    const negocioName = (bc?.nombre || empresa?.nombre || '').trim()
    const vertical = String(bc?.appointmentVertical ?? 'agenda')
    const serviciosPermitidos = parseServiciosList(bc?.servicios)
    const serviciosLinea = serviciosPermitidos.join(', ')

    // 2) Prompt del sistema (habla de todo, pero SOLO agenda/propone de la lista)
    const nameLine = negocioName
        ? `Asistente de agenda (${vertical}) de "${negocioName}".`
        : `Asistente de agenda (${vertical}).`

    const reglas = [
        nameLine,
        'Responde breve (2–5 líneas), claro y empático.',
        'Puedes hablar de dudas generales, precios, preparación, contraindicaciones, etc.',
        '⚠️ Solo propón o agenda servicios que estén en la lista permitida (no inventes).',
        serviciosPermitidos.length
            ? `Servicios disponibles: ${serviciosLinea}. Si piden algo fuera, sugiere una alternativa de la lista.`
            : 'Aún no hay servicios cargados; indica que pronto actualizaremos la agenda.',
        'Evita párrafos largos y jerga complicada.',
    ].filter(Boolean).join('\n')

    // 3) Historial + mensaje del usuario
    const history = await getRecentHistory(chatId, 10)
    const messages: Array<any> = [
        { role: 'system', content: reglas },
        ...history,
        { role: 'user', content: mensajeArg || 'Hola' },
    ]

    // 4) Llamada al LLM
    const model = process.env.IA_TEXT_MODEL || process.env.IA_MODEL || 'gpt-4o-mini'
    const temperature = Number(process.env.IA_TEMPERATURE ?? 0.35)
    let texto = ''
    try {
        const resp = await openai.chat.completions.create({
            model,
            temperature,
            max_tokens: IA_MAX_TOKENS,
            messages
        } as any)
        texto = resp?.choices?.[0]?.message?.content?.trim() || ''
    } catch (err: any) {
        console.error('[APPOINTMENTS] OpenAI error:', err?.response?.data || err?.message || err)
        texto = 'Gracias por escribirnos. Puedo ayudarte a revisar disponibilidad y opciones del servicio.'
    }

    // 5) Post-procesado conciso + branding web (si hay URL en prompt del negocio)
    texto = closeNicely(texto)
    texto = formatConcise(texto, IA_MAX_LINES, IA_MAX_CHARS, IA_ALLOW_EMOJI)
    texto = maybeInjectBrand(texto, bc?.agentPrompt || '')


    // 6) Guardar + enviar
    const saved = await persistBotReply({
        conversationId: chatId,
        empresaId,
        texto,
        nuevoEstado: ConversationEstado.respondido,
        to: toPhone,
        phoneNumberId,
    })

    return {
        estado: ConversationEstado.respondido,
        mensaje: saved.texto,
        messageId: saved.messageId,
        wamid: saved.wamid,
        media: [],
    }
}
