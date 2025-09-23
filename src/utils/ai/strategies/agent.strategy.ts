import axios from 'axios'
import prisma from '../../../lib/prisma'
import type { Prisma } from '@prisma/client'
import { openai } from '../../../lib/openai'
import {
    ConversationEstado,
    MediaType,
    MessageFrom,
    AgentSpecialty,
} from '@prisma/client'
import * as Wam from '../../../services/whatsapp.service'
import { transcribeAudioBuffer } from '../../../services/transcription.service'
import type { IAReplyResult } from '../../handleIAReply.ecommerce'

/** Config imagen/texto */
const IMAGE_WAIT_MS = Number(process.env.IA_IMAGE_WAIT_MS ?? 1000)                 // 1s re-chequeo (no respondemos desde imagen sola)
const IMAGE_LOOKBACK_MS = Number(process.env.IA_IMAGE_LOOKBACK_MS ?? 5 * 60 * 1000) // 5min adjuntar imagen reciente
const REPLY_DEDUP_WINDOW_MS = Number(process.env.REPLY_DEDUP_WINDOW_MS ?? 120_000)  // 120s ventana idempotencia in-memory

/** ===== Respuesta breve (soft clamp) =====
 *  - Limitamos por líneas (no por caracteres) para evitar cortes a media frase.
 *  - El modelo ya viene breve por IA_MAX_TOKENS.
 */
const IA_MAX_LINES = Number(process.env.IA_MAX_LINES ?? 5)     // líneas duras
const IA_MAX_CHARS = Number(process.env.IA_MAX_CHARS ?? 1000)   // tope blando, no cortamos por chars
const IA_MAX_TOKENS = Number(process.env.IA_MAX_TOKENS ?? 100)  // tokens del LLM (ligeramente más aire para cerrar frases)
const IA_ALLOW_EMOJI = (process.env.IA_ALLOW_EMOJI ?? '0') === '1'

// ===== Idempotencia por inbound (sin DB) =====
const processedInbound = new Map<number, number>() // messageId -> timestamp ms
function seenInboundRecently(messageId: number, windowMs = REPLY_DEDUP_WINDOW_MS): boolean {
    const now = Date.now()
    const prev = processedInbound.get(messageId)
    if (prev && (now - prev) <= windowMs) return true
    processedInbound.set(messageId, now)
    return false
}

export type AgentConfig = {
    specialty: AgentSpecialty
    prompt: string
    scope: string
    disclaimers: string
}

export async function handleAgentReply(args: {
    chatId: number
    empresaId: number
    mensajeArg?: string
    toPhone?: string
    phoneNumberId?: string
    agent: AgentConfig
}): Promise<IAReplyResult | null> {
    const { chatId, empresaId, mensajeArg = '', toPhone, phoneNumberId, agent } = args

    // 1) Conversación y último mensaje del cliente
    const conversacion = await prisma.conversation.findUnique({
        where: { id: chatId },
        select: { id: true, estado: true, phone: true },
    })
    if (!conversacion) return null

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
        console.log('[AGENT] handleAgentReply enter', {
            chatId, empresaId,
            lastId: last?.id, lastTs: last?.timestamp, lastType: last?.mediaType,
            hasCaption: !!(last?.caption && String(last.caption).trim()),
            hasContenido: !!(last?.contenido && String(last.contenido).trim()),
            mensajeArgLen: (args.mensajeArg || '').length,
        })
    }

    // 🔒 Guard: si ya procesamos este inbound (last.id) recientemente, salir
    if (last?.id && seenInboundRecently(last.id)) {
        if (process.env.DEBUG_AI === '1') console.log('[AGENT] Skip: inbound already processed', { lastId: last.id })
        return null
    }

    // 2) Config del negocio
    const [bc, empresa] = await Promise.all([
        prisma.businessConfig.findUnique({
            where: { empresaId },
            select: {
                agentSpecialty: true,
                agentPrompt: true,
                agentScope: true,
                agentDisclaimers: true,
                nombre: true,
            },
        }),
        prisma.empresa.findUnique({ where: { id: empresaId }, select: { nombre: true } }),
    ])

    // 3) Preparar texto (prioriza transcripción si es nota de voz)
    let userText = (mensajeArg || '').trim()
    if (!userText && last?.isVoiceNote) {
        let transcript = (last.transcription || '').trim()
        if (!transcript) {
            try {
                let audioBuf: Buffer | null = null
                if (last.mediaUrl && /^https?:\/\//i.test(String(last.mediaUrl))) {
                    const { data } = await axios.get(String(last.mediaUrl), {
                        responseType: 'arraybuffer',
                        timeout: 30000,
                    })
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
                if (process.env.DEBUG_AI === '1') console.error('[AGENT] Transcription error:', (e as any)?.message || e)
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
                if (process.env.DEBUG_AI === '1') console.log('[AGENT] Skip (debounce): image+caption same webhook')
                return null
            }

            const comboText = (userText || caption || '').trim() || 'Hola'
            const resp = await answerWithLLM({
                chatId,
                empresaId,
                agent,
                negocio: empresa,
                bc,
                userText: comboText,
                effectiveImageUrl: imageUrl,
                attachRecentIfTextOnly: false,
                lastIdToExcludeFromHistory: last?.id,
                toPhone,
                phoneNumberId,
            })

            if (last?.timestamp) markActuallyReplied(chatId, last.timestamp)
            return resp
        } else {
            if (process.env.DEBUG_AI === '1') console.log('[AGENT] Image-only: defer to upcoming text')
            await sleep(IMAGE_WAIT_MS)
            return null
        }
    } else {
        if (last?.timestamp && shouldSkipDoubleReply(chatId, last.timestamp, REPLY_DEDUP_WINDOW_MS)) {
            if (process.env.DEBUG_AI === '1') console.log('[AGENT] Skip (debounce): normal text flow')
            return null
        }
    }

    // 5) System + presupuesto
    const negocioName = (bc?.nombre || empresa?.nombre || '').trim()
    const especialidad = (agent.specialty || bc?.agentSpecialty || 'generico') as AgentSpecialty
    const persona = personaLabel(especialidad)
    const nameLine = negocioName
        ? `Asistente de orientación de ${humanSpecialty(especialidad)} de "${negocioName}".`
        : `Asistente de orientación de ${humanSpecialty(especialidad)}.`

    const lineScope = softTrim(agent.scope || bc?.agentScope, 160)
    const lineDisc = softTrim(agent.disclaimers || bc?.agentDisclaimers, 160)
    const extraInst = softTrim(agent.prompt || bc?.agentPrompt, 220)

    const system = [
        nameLine,
        `Actúa como ${persona}. Habla en primera persona (yo), tono profesional y cercano.`,
        'Responde en 2–5 líneas, claro y empático. Sé específico y evita párrafos largos.',
        'Puedes usar 1 emoji ocasionalmente (no siempre).',
        'Si corresponde, puedes mencionar productos del negocio y su web.',
        `Mantente solo en ${humanSpecialty(especialidad)}; si preguntan fuera, indícalo y reconduce.`,
        lineScope ? `Ámbito: ${lineScope}` : '',
        lineDisc ? `Incluye cuando aplique: ${lineDisc}` : '',
        extraInst ? `Sigue estas instrucciones del negocio: ${extraInst}` : '',
    ].filter(Boolean).join('\n')

    // 6) Historial reciente
    const history = await getRecentHistory(chatId, last?.id, 10)

    // 7) Construcción de mensajes (adjunta imagen reciente si solo hay texto)
    let effectiveImageUrl = imageUrl
    if (!effectiveImageUrl && userText) {
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
                { type: 'text', text: userText || caption || 'Analiza la imagen con prudencia clínica y brinda orientación general.' },
                { type: 'image_url', image_url: { url: effectiveImageUrl } },
            ],
        })
    } else {
        messages.push({ role: 'user', content: userText || caption || 'Hola' })
    }

    // Presupuestar prompt total (incluye historial)
    budgetMessages(messages, Number(process.env.IA_PROMPT_BUDGET ?? 110))

    // 8) LLM con retry y salida corta (tokens)
    const model = process.env.IA_TEXT_MODEL || process.env.IA_MODEL || 'gpt-4o-mini'
    const temperature = Number(process.env.IA_TEMPERATURE ?? 0.35)
    const defaultMax = IA_MAX_TOKENS

    let texto = ''
    try {
        texto = await runChatWithBudget({ model, messages, temperature, maxTokens: defaultMax })
    } catch (err: any) {
        console.error('[AGENT] OpenAI error (final):', err?.response?.data || err?.message || err)
        texto = 'Gracias por escribirnos. Podemos ayudarte con orientación general sobre tu consulta.'
    }

    // NUEVO: cerrar bonito si quedó cortado
    texto = closeNicely(texto)

    // 9) Post-formateo (solo líneas, sin branding)
    texto = clampConcise(texto, IA_MAX_LINES, IA_MAX_CHARS)
    texto = formatConcise(texto, IA_MAX_LINES, IA_MAX_CHARS, IA_ALLOW_EMOJI)

    // 10) Persistir y responder
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

/* ================= helpers ================= */

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

async function answerWithLLM(opts: {
    chatId: number
    empresaId: number
    agent: AgentConfig
    negocio: { nombre?: string } | null
    bc: any
    userText: string
    effectiveImageUrl?: string | null
    attachRecentIfTextOnly?: boolean
    lastIdToExcludeFromHistory?: number
    toPhone?: string
    phoneNumberId?: string
}): Promise<IAReplyResult | null> {
    const {
        chatId, empresaId, agent, negocio, bc,
        userText, effectiveImageUrl,
        lastIdToExcludeFromHistory, toPhone, phoneNumberId
    } = opts

    const negocioName = (bc?.nombre || negocio?.nombre || '').trim()
    const especialidad = (agent.specialty || bc?.agentSpecialty || 'generico') as AgentSpecialty
    const persona = personaLabel(especialidad)
    const nameLine = negocioName
        ? `Asistente de orientación de ${humanSpecialty(especialidad)} de "${negocioName}".`
        : `Asistente de orientación de ${humanSpecialty(especialidad)}.`

    const lineScope = softTrim(agent.scope || bc?.agentScope, 160)
    const lineDisc = softTrim(agent.disclaimers || bc?.agentDisclaimers, 160)
    const extraInst = softTrim(agent.prompt || bc?.agentPrompt, 220)

    const system = [
        nameLine,
        `Actúa como ${persona}. Habla en primera persona (yo), tono profesional y cercano.`,
        'Responde en 2–4 líneas, claro y empático. Sé específico y evita párrafos largos.',
        'Puedes usar 1 emoji ocasionalmente (no siempre).',
        'Si corresponde, puedes mencionar productos del negocio y su web.',
        `Mantente solo en ${humanSpecialty(especialidad)}; si preguntan fuera, indícalo y reconduce.`,
        lineScope ? `Ámbito: ${lineScope}` : '',
        lineDisc ? `Incluye cuando aplique: ${lineDisc}` : '',
        extraInst ? `Sigue estas instrucciones del negocio: ${extraInst}` : '',
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
    const defaultMax = IA_MAX_TOKENS

    let texto = ''
    try {
        texto = await runChatWithBudget({ model, messages, temperature, maxTokens: defaultMax })
    } catch (err: any) {
        console.error('[AGENT] OpenAI error (final):', err?.response?.data || err?.message || err)
        texto = 'Gracias por escribirnos. Podemos ayudarte con orientación general sobre tu consulta.'
    }

    // NUEVO: cerrar bonito si quedó cortado
    texto = closeNicely(texto)

    // Sin branding al final
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

// Historial: últimos N mensajes en formato compacto
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
        console.log('[AGENT] model =', model)
        console.log('[AGENT] OPENAI_API_KEY set =', !!process.env.OPENAI_API_KEY)
        console.log('[AGENT] max_tokens try #1 =', firstMax)
    }

    try {
        const resp1 = await openai.chat.completions.create({
            model, messages, temperature, max_tokens: firstMax,
        } as any)
        return resp1?.choices?.[0]?.message?.content?.trim() || ''
    } catch (err: any) {
        const msg = String(err?.response?.data || err?.message || '')
        if (process.env.DEBUG_AI === '1') console.error('[AGENT] first call error:', msg)

        const affordable = parseAffordableTokens(msg)
        const retryTokens =
            (typeof affordable === 'number' && Number.isFinite(affordable))
                ? Math.max(12, Math.min(affordable - 1, 48))
                : 32

        if (process.env.DEBUG_AI === '1') console.log('[AGENT] retry with max_tokens =', retryTokens)

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
        if (/Asistente de orientación|Responde en|Puedes usar|No diagnostiques|Mantente solo|Ámbito:|Incluye cuando|Sigue estas/i.test(l)) {
            keep.push(l)
        }
        if (keep.length >= 5) break
    }
    ; (sys as any).content = keep.join('\n') || lines.slice(0, 5).join('\n')

    if (typeof user?.content === 'string') {
        const ut = String(user.content)
        user.content = ut.length > 200 ? ut.slice(0, 200) : ut
    } else if (Array.isArray(user?.content)) {
        const ut = String(user.content?.[0]?.text || '')
        user.content[0].text = softTrim(ut, 200)
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

// ===== formatting / misc =====

// Soft clamp: SOLO líneas, no recortamos por caracteres para evitar “Te recom…”
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

function formatConcise(text: string, maxLines = IA_MAX_LINES, maxChars = IA_MAX_CHARS, allowEmoji = IA_ALLOW_EMOJI): string {
    let t = String(text || '').trim()
    if (!t) return 'Gracias por escribirnos. ¿Cómo puedo ayudarte?'

    // Limpieza ligera
    t = t.replace(/^[•\-]\s*/gm, '').replace(/\s+\n/g, '\n').replace(/\n{2,}/g, '\n').trim()

    // Recorte final SOLO por líneas
    t = clampConcise(t, maxLines, maxChars)

    // 1 emoji opcional si el texto es “limpio”
    if (allowEmoji && !/[^\w\s.,;:()¿?¡!…]/.test(t)) {
        const EMOJIS = ['🙂', '💡', '👌', '✅', '✨', '🧴', '💬', '🫶']
        t = `${t} ${EMOJIS[Math.floor(Math.random() * EMOJIS.length)]}`
        t = clampConcise(t, maxLines, maxChars)
    }
    return t
}

// === NUEVO: helpers para cerrar bonito ===
function endsWithPunctuation(t: string) {
    return /[.!?…]\s*$/.test((t || '').trim())
}

function closeNicely(raw: string): string {
    let t = (raw || '').trim()
    if (!t) return t
    if (endsWithPunctuation(t)) return t
    // Quitar última palabra "a medias" y cerrar con puntos suspensivos
    t = t.replace(/\s+[^\s]*$/, '').trim()
    if (!t) return raw.trim()
    return `${t}…`
}

function humanSpecialty(s: AgentSpecialty) {
    switch (s) {
        case 'medico': return 'medicina general'
        case 'dermatologia': return 'dermatología'
        case 'nutricion': return 'nutrición'
        case 'psicologia': return 'psicología'
        case 'odontologia': return 'odontología'
        default: return 'salud'
    }
}
function personaLabel(s: AgentSpecialty) {
    switch (s) {
        case 'dermatologia': return 'un asistente virtual de dermatología'
        case 'medico': return 'un asistente virtual de medicina general'
        case 'nutricion': return 'un asistente virtual de nutrición'
        case 'psicologia': return 'un asistente virtual de psicología'
        case 'odontologia': return 'un asistente virtual de odontología'
        default: return 'un asistente virtual de salud'
    }
}

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

/** ===== Idempotencia in-memory (sin DB) ===== */
const recentReplies = new Map<number, { afterMs: number; repliedAtMs: number }>()
function shouldSkipDoubleReply(conversationId: number, clientTs: Date, windowMs = REPLY_DEDUP_WINDOW_MS) {
    const now = Date.now()
    const prev = recentReplies.get(conversationId)
    const clientMs = clientTs.getTime()

    if (prev && prev.afterMs >= clientMs && (now - prev.repliedAtMs) <= windowMs) {
        return true
    }
    recentReplies.set(conversationId, { afterMs: clientMs, repliedAtMs: now })
    return false
}
function markActuallyReplied(conversationId: number, clientTs: Date) {
    const now = Date.now()
    recentReplies.set(conversationId, { afterMs: clientTs.getTime(), repliedAtMs: now })
}

/** ===== (Opcional) Guard DB ===== */
async function alreadyRepliedAfter(
    conversationId: number,
    afterTs: Date,
    windowMs = 90_000
) {
    const bot = await prisma.message.findFirst({
        where: {
            conversationId,
            from: MessageFrom.bot,
            timestamp: { gt: afterTs },
        },
        orderBy: { timestamp: 'desc' },
        select: { timestamp: true },
    })
    if (!bot) return false
    const now = Date.now()
    return now - bot.timestamp.getTime() <= windowMs
}
