// server/src/utils/ai/strategies/appointments.strategy.ts
import axios from 'axios'
import prisma from '../../../lib/prisma'
import type { Prisma } from '@prisma/client'
import { AppointmentVertical } from '@prisma/client'
import { openai } from '../../../lib/openai'
import {
    ConversationEstado,
    MediaType,
    MessageFrom,
} from '@prisma/client'
import * as Wam from '../../../services/whatsapp.service'
import { transcribeAudioBuffer } from '../../../services/transcription.service'
import type { IAReplyResult } from '../../handleIAReply.ecommerce'

/* ================= Config imagen/texto ================= */
const IMAGE_WAIT_MS = Number(process.env.IA_IMAGE_WAIT_MS ?? 1000)
const IMAGE_LOOKBACK_MS = Number(process.env.IA_IMAGE_LOOKBACK_MS ?? 5 * 60 * 1000)
const REPLY_DEDUP_WINDOW_MS = Number(process.env.REPLY_DEDUP_WINDOW_MS ?? 120_000)

/* ================= Respuesta breve ================= */
const IA_MAX_LINES = Number(process.env.IA_MAX_LINES ?? 5)
const IA_MAX_CHARS = Number(process.env.IA_MAX_CHARS ?? 1000)
const IA_MAX_TOKENS = Number(process.env.IA_MAX_TOKENS ?? 100)
const IA_ALLOW_EMOJI = (process.env.IA_ALLOW_EMOJI ?? '0') === '1'

/* ===== Idempotencia por inbound (sin DB) ===== */
const processedInbound = new Map<number, number>()
function seenInboundRecently(messageId: number, windowMs = REPLY_DEDUP_WINDOW_MS) {
    const now = Date.now()
    const prev = processedInbound.get(messageId)
    if (prev && (now - prev) <= windowMs) return true
    processedInbound.set(messageId, now)
    return false
}

/* ================= Tipos locales ================= */
type BcaConfig = {
    appointmentEnabled?: boolean
    appointmentVertical?: AppointmentVertical | null
    appointmentVerticalCustom?: string | null
    appointmentPolicies?: string | null
    appointmentTimezone?: string | null
    appointmentBufferMin?: number | null
    appointmentReminders?: boolean | null
    services?: unknown
    servicesText?: string | null
} | null

type BcCompat = {
    nombre?: string | null
    appointmentVertical?: unknown
    appointmentPolicies?: string | null
    appointmentTimezone?: string | null
    servicios?: string | null
} | null

// Para permitir que el orquestador pase apptConfig (opcional)
export type ApptConfigFromOrchestrator = {
    timezone: string
    bufferMin: number
    vertical: AppointmentVertical
    verticalCustom: string | null
    enabled: boolean
    policies: string | null
    reminders: boolean
    services?: unknown
    servicesText?: string
    logistics?: Record<string, unknown>
    rules?: Record<string, unknown>
    remindersConfig?: Record<string, unknown>
    kb?: Record<string, unknown>
}

/* ================= API principal ================= */
export async function handleEsteticaReply(args: {
    chatId: number
    empresaId: number
    mensajeArg?: string
    toPhone?: string
    phoneNumberId?: string
    apptConfig?: ApptConfigFromOrchestrator
}): Promise<IAReplyResult | null> {
    const { chatId, empresaId, mensajeArg = '', toPhone, phoneNumberId } = args

    // 1) Conversación base
    const conversacion = await prisma.conversation.findUnique({
        where: { id: chatId },
        select: { id: true, estado: true, phone: true },
    })
    if (!conversacion) return null

    // 2) Último mensaje del cliente
    const last = await prisma.message.findFirst({
        where: { conversationId: chatId, from: MessageFrom.client },
        orderBy: { timestamp: 'desc' },
        select: {
            id: true,
            mediaType: true,
            mediaUrl: true,
            caption: true,
            isVoiceNote: true,
            transcription: true,
            contenido: true,
            mimeType: true,
            timestamp: true,
        },
    })

    if (process.env.DEBUG_AI === '1') {
        console.log('[APPOINTMENT] enter', {
            chatId, empresaId,
            lastId: last?.id, lastTs: last?.timestamp, lastType: last?.mediaType,
            hasCaption: !!(last?.caption && String(last.caption).trim()),
            hasContenido: !!(last?.contenido && String(last.contenido).trim()),
            mensajeArgLen: (args.mensajeArg || '').length,
        })
    }

    // Evitar doble respuesta por el mismo inbound
    if (last?.id && seenInboundRecently(last.id)) {
        if (process.env.DEBUG_AI === '1') console.log('[APPOINTMENT] Skip: inbound already processed', { lastId: last.id })
        return null
    }

    // 3) Config del negocio (prioriza BCA, luego BC)
    const [bca, bc, empresa] = await Promise.all([
        prisma.businessConfigAppt.findUnique({
            where: { empresaId },
            select: {
                appointmentEnabled: true,
                appointmentVertical: true,
                appointmentVerticalCustom: true,
                appointmentPolicies: true,
                appointmentTimezone: true,
                appointmentBufferMin: true,
                appointmentReminders: true,
                services: true,
                servicesText: true,
            },
        }) as Promise<BcaConfig>,
        prisma.businessConfig.findUnique({
            where: { empresaId },
            select: {
                nombre: true,
                appointmentVertical: true,
                appointmentPolicies: true,
                appointmentTimezone: true,
                servicios: true,
            },
        }) as Promise<BcCompat>,
        prisma.empresa.findUnique({ where: { id: empresaId }, select: { nombre: true } }),
    ])

    // 4) Preparar texto priorizando transcripción (nota de voz)
    let userText = (mensajeArg || '').trim()
    if (!userText && last?.isVoiceNote) {
        let transcript = (last.transcription || '').trim()
        if (!transcript) {
            try {
                let audioBuf: Buffer | null = null
                if (last.mediaUrl && /^https?:\/\//i.test(String(last.mediaUrl))) {
                    const { data } = await axios.get(String(last.mediaUrl), { responseType: 'arraybuffer', timeout: 30000 })
                    audioBuf = Buffer.from(data)
                }
                if (audioBuf) {
                    const name =
                        last.mimeType?.includes('mpeg') ? 'audio.mp3'
                            : last.mimeType?.includes('wav') ? 'audio.wav'
                                : last.mimeType?.includes('m4a') ? 'audio.m4a'
                                    : last.mimeType?.includes('webm') ? 'audio.webm'
                                        : 'audio.ogg'
                    transcript = await transcribeAudioBuffer(audioBuf, name)
                    if (transcript) {
                        await prisma.message.update({ where: { id: last.id }, data: { transcription: transcript } })
                    }
                }
            } catch (e) {
                if (process.env.DEBUG_AI === '1') console.error('[APPOINTMENT] Transcription error:', (e as any)?.message || e)
            }
        }
        if (transcript) userText = transcript
    }

    const isImage = last?.mediaType === MediaType.image && !!last?.mediaUrl
    const imageUrl = isImage ? String(last?.mediaUrl) : null
    const caption = String(last?.caption || '').trim()

    // ====== Debounce por conversación ======
    if (isImage) {
        if (caption || userText) {
            if (last?.timestamp && shouldSkipDoubleReply(chatId, last.timestamp, REPLY_DEDUP_WINDOW_MS)) {
                if (process.env.DEBUG_AI === '1') console.log('[APPOINTMENT] Skip (debounce): image+caption same webhook')
                return null
            }
            const comboText = (userText || caption || '').trim() || 'Hola'
            const resp = await answerWithLLM_Appointment({
                chatId,
                empresaId,
                negocio: empresa,
                bc,   // back-compat (nombre/catálogo largo)
                bca,  // config especializada
                userText: comboText,
                effectiveImageUrl: imageUrl,
                lastIdToExcludeFromHistory: last?.id,
                toPhone,
                phoneNumberId,
            })
            if (last?.timestamp) markActuallyReplied(chatId, last.timestamp)
            return resp
        } else {
            if (process.env.DEBUG_AI === '1') console.log('[APPOINTMENT] Image-only: defer to upcoming text')
            await sleep(IMAGE_WAIT_MS)
            return null
        }
    } else {
        if (last?.timestamp && shouldSkipDoubleReply(chatId, last.timestamp, REPLY_DEDUP_WINDOW_MS)) {
            if (process.env.DEBUG_AI === '1') console.log('[APPOINTMENT] Skip (debounce): normal text flow')
            return null
        }
    }

    // 5) System prompt (prioriza BCA, luego BC)
    const negocioName = (bc?.nombre || empresa?.nombre || '').trim()
    const verticalVal =
        (bca?.appointmentVertical ?? toApptVerticalOrNull(bc?.appointmentVertical)) ?? AppointmentVertical.custom
    const vertical = humanVertical(verticalVal, bca?.appointmentVerticalCustom)

    const nameLine = negocioName
        ? `Asistente de ${vertical} de "${negocioName}".`
        : `Asistente de ${vertical}.`

    const servicios = getServiciosFromConfigs(bca, bc)
    const serviciosLine = servicios.length
        ? `Servicios autorizados: ${servicios.map(s => `• ${s}`).join('\n')}`
        : `El negocio aún no publicó su catálogo completo de servicios. Si preguntan por algo no listado, ofrece ayuda para entender necesidades y comparte las opciones disponibles.`

    const policies = (bca?.appointmentPolicies ?? bc?.appointmentPolicies ?? '').trim()
    const tz = (bca?.appointmentTimezone ?? bc?.appointmentTimezone ?? '').trim()

    const system = [
        nameLine,
        `Habla en primera persona (yo), tono profesional, cercano y claro. Responde en 2–5 líneas.`,
        `Actúa dentro del ámbito de ${vertical}. No inventes información. Si preguntan fuera de alcance, indícalo y reconduce.`,
        serviciosLine,
        policies ? `Políticas relevantes: ${policies}` : '',
        tz ? `Zona horaria del negocio: ${tz} (úsala solo como referencia de horarios; por ahora no confirmes reservas).` : '',
        `AÚN NO agendas. Si piden reservar, ofrece orientar sobre disponibilidad y próximos pasos; evita confirmar citas por tu cuenta.`,
    ].filter(Boolean).join('\n')

    // 6) Historial
    const history = await getRecentHistory(chatId, last?.id, 10)

    // 7) Construcción de mensajes (adjunta imagen reciente si solo hay texto)
    let effectiveImageUrl = imageUrl
    if (!effectiveImageUrl && (userText || caption)) {
        const recentImage = await prisma.message.findFirst({
            where: {
                conversationId: chatId,
                from: MessageFrom.client,
                mediaType: MediaType.image,
                timestamp: { gte: new Date(Date.now() - IMAGE_LOOKBACK_MS) },
            },
            orderBy: { timestamp: 'desc' },
            select: { mediaUrl: true, caption: true },
        })
        if (recentImage?.mediaUrl) {
            effectiveImageUrl = String(recentImage.mediaUrl)
            if (!caption && recentImage.caption) {
                userText = `${userText}\n\nNota de la imagen: ${recentImage.caption}`
            }
        }
    }

    const messages: Array<any> = [{ role: 'system', content: system }, ...history]
    if (effectiveImageUrl) {
        messages.push({
            role: 'user',
            content: [
                { type: 'text', text: userText || caption || 'Hola' },
                { type: 'image_url', image_url: { url: effectiveImageUrl } },
            ],
        })
    } else {
        messages.push({ role: 'user', content: userText || caption || 'Hola' })
    }

    budgetMessages(messages, Number(process.env.IA_PROMPT_BUDGET ?? 110))

    // 8) LLM
    const model = process.env.IA_TEXT_MODEL || process.env.IA_MODEL || 'gpt-4o-mini'
    const temperature = Number(process.env.IA_TEMPERATURE ?? 0.35)
    let texto = ''
    try {
        texto = await runChatWithBudget({ model, messages, temperature, maxTokens: IA_MAX_TOKENS })
    } catch (err: any) {
        console.error('[APPOINTMENT] OpenAI error:', err?.response?.data || err?.message || err)
        texto = 'Gracias por escribirnos. Puedo ayudarte con información sobre nuestros servicios y horarios.'
    }

    texto = closeNicely(texto)
    texto = clampConcise(texto, IA_MAX_LINES, IA_MAX_CHARS)
    texto = formatConcise(texto, IA_MAX_LINES, IA_MAX_CHARS, IA_ALLOW_EMOJI)

    // 9) Persistir + enviar
    const saved = await persistBotReply({
        conversationId: chatId,
        empresaId,
        texto,
        nuevoEstado: ConversationEstado.respondido,
        to: toPhone ?? conversacion.phone,
        phoneNumberId,
    })

    if (!isImage && last?.timestamp) markActuallyReplied(chatId, last.timestamp)

    return {
        estado: ConversationEstado.respondido,
        mensaje: saved.texto,
        messageId: saved.messageId,
        wamid: saved.wamid,
        media: [],
    }
}

/* ================= Variante para imagen con caption ================= */
async function answerWithLLM_Appointment(opts: {
    chatId: number
    empresaId: number
    negocio: { nombre?: string } | null
    bc: BcCompat
    bca?: BcaConfig
    userText: string
    effectiveImageUrl?: string | null
    lastIdToExcludeFromHistory?: number
    toPhone?: string
    phoneNumberId?: string
}): Promise<IAReplyResult | null> {
    const {
        chatId, empresaId, negocio, bc, bca, userText,
        effectiveImageUrl, lastIdToExcludeFromHistory, toPhone, phoneNumberId
    } = opts

    const negocioName = (bc?.nombre || negocio?.nombre || '').trim()

    const verticalVal =
        (bca?.appointmentVertical ?? toApptVerticalOrNull(bc?.appointmentVertical)) ?? AppointmentVertical.custom
    const vertical = humanVertical(verticalVal, bca?.appointmentVerticalCustom)

    const nameLine = negocioName
        ? `Asistente de ${vertical} de "${negocioName}".`
        : `Asistente de ${vertical}.`

    const servicios = getServiciosFromConfigs(bca, bc)
    const serviciosLine = servicios.length
        ? `Servicios autorizados: ${servicios.map(s => `• ${s}`).join('\n')}`
        : `El negocio aún no publicó su catálogo completo de servicios. Si preguntan por algo no listado, ofrece ayuda para entender necesidades y comparte las opciones disponibles.`

    const policies = (bca?.appointmentPolicies ?? bc?.appointmentPolicies ?? '').trim()
    const tz = (bca?.appointmentTimezone ?? bc?.appointmentTimezone ?? '').trim()

    const system = [
        nameLine,
        `Habla en primera persona (yo), tono profesional, cercano y claro. Responde en 2–5 líneas.`,
        `Actúa dentro del ámbito de ${vertical}. No inventes información. Si preguntan fuera de alcance, indícalo y reconduce.`,
        serviciosLine,
        policies ? `Políticas relevantes: ${policies}` : '',
        tz ? `Zona horaria del negocio: ${tz} (referencia; aún no agendas).` : '',
        `AÚN NO agendas. Si piden reservar, ofrece orientar sobre disponibilidad y próximos pasos; evita confirmar citas por tu cuenta.`,
    ].filter(Boolean).join('\n')

    const history = await getRecentHistory(chatId, lastIdToExcludeFromHistory, 10)

    const messages: Array<any> = [{ role: 'system', content: system }, ...history]
    if (effectiveImageUrl) {
        messages.push({
            role: 'user',
            content: [
                { type: 'text', text: userText || 'Hola' },
                { type: 'image_url', image_url: { url: effectiveImageUrl } },
            ],
        })
    } else {
        messages.push({ role: 'user', content: userText || 'Hola' })
    }

    budgetMessages(messages, Number(process.env.IA_PROMPT_BUDGET ?? 110))

    const model = process.env.IA_TEXT_MODEL || process.env.IA_MODEL || 'gpt-4o-mini'
    const temperature = Number(process.env.IA_TEMPERATURE ?? 0.35)
    let texto = ''
    try {
        texto = await runChatWithBudget({ model, messages, temperature, maxTokens: IA_MAX_TOKENS })
    } catch (err: any) {
        console.error('[APPOINTMENT] OpenAI error:', err?.response?.data || err?.message || err)
        texto = 'Gracias por escribirnos. Puedo ayudarte con información sobre nuestros servicios y horarios.'
    }

    texto = closeNicely(texto)
    texto = clampConcise(texto, IA_MAX_LINES, IA_MAX_CHARS)
    texto = formatConcise(texto, IA_MAX_LINES, IA_MAX_CHARS, IA_ALLOW_EMOJI)

    const saved = await persistBotReply({
        conversationId: chatId,
        empresaId,
        texto,
        nuevoEstado: ConversationEstado.respondido,
        to: toPhone,
        phoneNumberId,
    })

    try {
        if (lastIdToExcludeFromHistory) {
            const ref = await prisma.message.findUnique({
                where: { id: lastIdToExcludeFromHistory },
                select: { timestamp: true },
            })
            if (ref?.timestamp) markActuallyReplied(chatId, ref.timestamp)
        }
    } catch { /* noop */ }

    return {
        estado: ConversationEstado.respondido,
        mensaje: saved.texto,
        messageId: saved.messageId,
        wamid: saved.wamid,
        media: [],
    }
}

/* ================= Helpers compartidos ================= */

// Resuelve el vertical usando enum/string con fallback
function humanVertical(v?: string | AppointmentVertical | null, custom?: string | null) {
    if (!v) return (custom && custom.trim()) || 'servicios'
    const s = String(v).toLowerCase().trim()
    switch (s) {
        case 'odontologica':
        case 'odontológica':
        case 'odontologia':
        case 'odontología':
            return 'odontología'
        case 'estetica':
        case 'estética':
        case 'clinica estetica':
        case 'clínica estética':
            return 'clínica estética'
        case 'veterinaria':
            return 'veterinaria'
        case 'salud':
            return 'salud'
        case 'fitness':
            return 'fitness'
        case 'bienestar':
            return 'bienestar'
        case 'automotriz':
            return 'servicios automotrices'
        case 'spa':
            return 'spa'
        case 'custom':
            return (custom && custom.trim()) || 'servicios'
        default:
            return s || (custom && custom.trim()) || 'servicios'
    }
}

// Convierte valores heredados de BC a enum si aplica (o null si no mapea)
function toApptVerticalOrNull(v?: unknown): AppointmentVertical | null {
    const s = String(v ?? '').toLowerCase().trim()
    if (!s) return null
    const map: Record<string, AppointmentVertical> = {
        'none': AppointmentVertical.none,
        'salud': AppointmentVertical.salud,
        'bienestar': AppointmentVertical.bienestar,
        'automotriz': AppointmentVertical.automotriz,
        'veterinaria': AppointmentVertical.veterinaria,
        'fitness': AppointmentVertical.fitness,
        'otros': AppointmentVertical.otros,
        'odontologica': AppointmentVertical.odontologica,
        'estetica': AppointmentVertical.estetica,
        'spa': AppointmentVertical.spa,
        'custom': AppointmentVertical.custom,
        // compat
        'servicios': AppointmentVertical.custom,
    }
    return map[s] ?? null
}

// Fusiona servicios priorizando BCA (array/texto) y luego BC (texto)
function getServiciosFromConfigs(bca?: BcaConfig, bc?: BcCompat): string[] {
    if (bca && Array.isArray(bca?.services)) {
        const arr = (bca.services as any[]).map(x => String(x ?? '').trim()).filter(Boolean)
        if (arr.length) return arr.slice(0, 24)
    }
    const tBca = String(bca?.servicesText || '').trim()
    if (tBca) {
        const parsed = parseServicios(tBca)
        if (parsed.length) return parsed
    }
    const tBc = String(bc?.servicios || '').trim()
    if (tBc) return parseServicios(tBc)
    return []
}

function parseServicios(raw?: string | null): string[] {
    const t = String(raw || '').trim()
    if (!t) return []
    return t
        .split(/[\n;,]/g)
        .map(s => s.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .slice(0, 24)
}

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

// Historial compacto
async function getRecentHistory(conversationId: number, excludeMessageId?: number, take = 10) {
    const where: Prisma.MessageWhereInput = { conversationId }
    if (excludeMessageId) where.id = { not: excludeMessageId }

    const rows = await prisma.message.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        take,
        select: { from: true, contenido: true },
    })

    return rows.reverse().map(r => {
        const role = r.from === MessageFrom.client ? 'user' : 'assistant'
        const content = softTrim(r.contenido || '', 220)
        return { role, content }
    })
}

async function runChatWithBudget(opts: {
    model: string
    messages: any[]
    temperature: number
    maxTokens: number
}): Promise<string> {
    const { model, messages, temperature } = opts
    const firstMax = opts.maxTokens

    if (process.env.DEBUG_AI === '1') {
        console.log('[APPOINTMENT] model =', model)
        console.log('[APPOINTMENT] OPENAI_API_KEY set =', !!process.env.OPENAI_API_KEY)
        console.log('[APPOINTMENT] max_tokens try #1 =', firstMax)
    }

    try {
        const resp1 = await openai.chat.completions.create({
            model, messages, temperature, max_tokens: firstMax,
        } as any)
        return resp1?.choices?.[0]?.message?.content?.trim() || ''
    } catch (err: any) {
        const msg = String(err?.response?.data || err?.message || '')
        if (process.env.DEBUG_AI === '1') console.error('[APPOINTMENT] first call error:', msg)

        const affordable = parseAffordableTokens(msg)
        const retryTokens =
            (typeof affordable === 'number' && Number.isFinite(affordable))
                ? Math.max(12, Math.min(affordable - 1, 48))
                : 32

        if (process.env.DEBUG_AI === '1') console.log('[APPOINTMENT] retry with max_tokens =', retryTokens)

        const resp2 = await openai.chat.completions.create({
            model, messages, temperature, max_tokens: retryTokens,
        } as any)
        return resp2?.choices?.[0]?.message?.content?.trim() || ''
    }
}

function parseAffordableTokens(message: string): number | null {
    const m =
        message.match(/can\s+only\s+afford\s+(\d+)/i) ||
        message.match(/only\s+(\d+)\s+tokens?/i) ||
        message.match(/exceeded:\s*(\d+)\s*>\s*\d+/i)
    if (m && m[1]) {
        const n = Number(m[1])
        return Number.isFinite(n) ? n : null
    }
    return null
}

// ===== prompt budgeting =====
function softTrim(s: string | null | undefined, max = 140) {
    const t = (s || '').trim()
    if (!t) return ''
    return t.length <= max ? t : t.slice(0, max).replace(/\s+[^\s]*$/, '') + '…'
}
function approxTokens(str: string) { return Math.ceil((str || '').length / 4) }

function budgetMessages(messages: any[], budgetPromptTokens = 110) {
    const sys = messages.find((m: any) => m.role === 'system')
    const user = messages.find((m: any) => m.role === 'user')
    if (!sys) return messages

    const sysText = String(sys.content || '')
    const userText = typeof user?.content === 'string'
        ? user?.content
        : Array.isArray(user?.content)
            ? String(user?.content?.[0]?.text || '') : ''

    let total = approxTokens(sysText) + approxTokens(userText)

    for (const m of messages) {
        if (m.role !== 'system' && m !== user) {
            const t = typeof m.content === 'string'
                ? m.content
                : Array.isArray(m.content)
                    ? String(m.content?.[0]?.text || '')
                    : ''
            total += approxTokens(t)
        }
    }

    if (total <= budgetPromptTokens) return messages

    const lines = sysText.split('\n').map(l => l.trim()).filter(Boolean)
    const keep: string[] = []
    for (const l of lines) {
        if (/Asistente|Responde en|Actúa dentro del ámbito|Servicios autorizados|Políticas relevantes|Zona horaria/i.test(l)) {
            keep.push(l)
        }
        if (keep.length >= 6) break
    }
    ; (sys as any).content = keep.join('\n') || lines.slice(0, 6).join('\n')

    if (typeof user?.content === 'string') {
        const ut = String(user.content)
        user.content = ut.length > 200 ? ut.slice(0, 200) : ut
    } else if (Array.isArray(user?.content)) {
        const ut = String(user.content?.[0]?.text || '')
        user.content[0].text = ut.length > 200 ? ut.slice(0, 200) : ut
    }

    let budget = budgetPromptTokens
    const sizeOf = (c: any) => approxTokens(typeof c === 'string'
        ? c
        : Array.isArray(c) ? String(c?.[0]?.text || '') : '')

    const sysTokens = approxTokens((sys as any).content || '')
    budget -= sysTokens

    const toTrim = messages.filter(m => m.role !== 'system' && m !== user)
    for (const m of toTrim) {
        const tks = sizeOf(m.content)
        if (budget - tks <= 0) {
            if (typeof m.content === 'string') {
                m.content = softTrim(m.content, 120)
            } else if (Array.isArray(m.content)) {
                const txt = String(m.content?.[0]?.text || '')
                m.content[0].text = softTrim(txt, 120)
            }
        } else {
            budget -= tks
        }
    }

    return messages
}

// ===== formatting / cierre =====
function clampConcise(text: string, maxLines = IA_MAX_LINES, _maxChars = IA_MAX_CHARS) {
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
        const EMOJIS = ['🙂', '💡', '👌', '✅', '✨', '💬']
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

/* ===== Persistencia & envío ===== */
function normalizeToE164(n: string) { return String(n || '').replace(/[^\d]/g, '') }
async function persistBotReply({
    conversationId, empresaId, texto, nuevoEstado, to, phoneNumberId,
}: {
    conversationId: number
    empresaId: number
    texto: string
    nuevoEstado: ConversationEstado
    to?: string
    phoneNumberId?: string
}) {
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

/* ===== Idempotencia por conversación ===== */
const recentReplies = new Map<number, { afterMs: number; repliedAtMs: number }>()
function shouldSkipDoubleReply(conversationId: number, clientTs: Date, windowMs = REPLY_DEDUP_WINDOW_MS) {
    const now = Date.now()
    const prev = recentReplies.get(conversationId)
    const clientMs = clientTs.getTime()
    if (prev && prev.afterMs >= clientMs && (now - prev.repliedAtMs) <= windowMs) return true
    recentReplies.set(conversationId, { afterMs: clientMs, repliedAtMs: now })
    return false
}
function markActuallyReplied(conversationId: number, clientTs: Date) {
    const now = Date.now()
    recentReplies.set(conversationId, { afterMs: clientTs.getTime(), repliedAtMs: now })
}
