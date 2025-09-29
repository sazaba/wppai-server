import axios from 'axios'
import prisma from '../../../lib/prisma'
import { openai } from '../../../lib/openai'
import * as Wam from '../../../services/whatsapp.service'
import { sendTemplateByName as sendTpl } from '../../../services/whatsapp.service'  // 👈 helper de plantilla
import { transcribeAudioBuffer } from '../../../services/transcription.service'
import {
    ConversationEstado,
    MediaType,
    MessageFrom,
    AgentSpecialty, // solo para reutilizar helpers textuales
} from '@prisma/client'

import { detectIntent, EsteticaIntent } from './esteticaModules/estetica.intents'
import { buildSystemPrompt, fmtConfirmBooking, fmtProposeSlots } from './esteticaModules/estetica.prompts'
import { loadApptContext, retrieveProcedures, type EsteticaCtx } from './esteticaModules/estetica.rag'
import { findSlots, book, reschedule, cancel } from './esteticaModules/estetica.schedule'

/** ===== Resultado (mismo tipo que e-commerce) ===== */
export type IAReplyResult = {
    estado: ConversationEstado
    mensaje?: string
    motivo?: 'confianza_baja' | 'palabra_clave' | 'reintentos'
    messageId?: number
    wamid?: string
    media?: Array<{ productId: number; imageUrl: string; wamid?: string }>
}

/** ===== Config imagen/texto / tiempos ===== */
const IMAGE_WAIT_MS = Number(process.env.IA_IMAGE_WAIT_MS ?? 1000)                 // 1s
const IMAGE_CARRY_MS = Number(process.env.IA_IMAGE_CARRY_MS ?? 60_000)             // 60s: arrastrar imagen reciente
const IMAGE_LOOKBACK_MS = Number(process.env.IA_IMAGE_LOOKBACK_MS ?? 5 * 60 * 1000) // 5m si se menciona explícitamente
const REPLY_DEDUP_WINDOW_MS = Number(process.env.REPLY_DEDUP_WINDOW_MS ?? 120_000)
const REPLY_DELAY_FIRST_MS = Number(process.env.REPLY_DELAY_FIRST_MS ?? 0) // override a 0
const REPLY_DELAY_NEXT_MS = Number(process.env.REPLY_DELAY_NEXT_MS ?? 0)   // override a 0

/** ===== Respuesta concisa ===== */
const IA_MAX_LINES = Number(process.env.IA_MAX_LINES ?? 5)
const IA_MAX_CHARS = Number(process.env.IA_MAX_CHARS ?? 1000)
const IA_MAX_TOKENS = Number(process.env.IA_MAX_TOKENS ?? 100)
const IA_ALLOW_EMOJI = (process.env.IA_ALLOW_EMOJI ?? '0') === '1'

/** ===== Idempotencia por inbound ===== */
const processedInbound = new Map<number, number>() // messageId -> ts
function seenInboundRecently(messageId: number, windowMs = REPLY_DEDUP_WINDOW_MS): boolean {
    const now = Date.now()
    const prev = processedInbound.get(messageId)
    if (prev && (now - prev) <= windowMs) return true
    processedInbound.set(messageId, now)
    return false
}

/** ===== Helpers ===== */
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// ⚡️ Respuesta inmediata para este vertical
async function computeReplyDelayMs(_conversationId: number) {
    return 0
}

function mentionsImageExplicitly(t: string) {
    const s = String(t || '').toLowerCase()
    return /\b(foto|imagen|selfie|captura|screenshot)\b/.test(s)
        || /(mira|revisa|checa|ve|verifica)\s+la\s+(foto|imagen)/.test(s)
        || /(te\s+mand(e|é)|te\s+envi(e|é))\s+(la\s+)?(foto|imagen)/.test(s)
        || /\b(de|en)\s+la\s+(foto|imagen)\b/.test(s)
}

async function pickImageForContext(opts: {
    conversationId: number
    directUrl?: string | null
    userText: string
    caption: string
    referenceTs: Date
}): Promise<{ url: string | null, noteToAppend: string }> {
    const { conversationId, directUrl, userText, caption, referenceTs } = opts

    if (directUrl) {
        return { url: String(directUrl), noteToAppend: caption ? `\n\nNota de la imagen: ${caption}` : '' }
    }
    if (!userText) return { url: null, noteToAppend: '' }

    const veryRecent = await prisma.message.findFirst({
        where: {
            conversationId,
            from: MessageFrom.client,
            mediaType: MediaType.image,
            timestamp: { gte: new Date(referenceTs.getTime() - IMAGE_CARRY_MS), lte: referenceTs },
        },
        orderBy: { timestamp: 'desc' },
        select: { mediaUrl: true, caption: true },
    })
    if (veryRecent?.mediaUrl) {
        return { url: String(veryRecent.mediaUrl), noteToAppend: veryRecent.caption ? `\n\nNota de la imagen: ${veryRecent.caption}` : '' }
    }

    if (mentionsImageExplicitly(userText)) {
        const referenced = await prisma.message.findFirst({
            where: {
                conversationId,
                from: MessageFrom.client,
                mediaType: MediaType.image,
                timestamp: { gte: new Date(referenceTs.getTime() - IMAGE_LOOKBACK_MS), lte: referenceTs },
            },
            orderBy: { timestamp: 'desc' },
            select: { mediaUrl: true, caption: true },
        })
        if (referenced?.mediaUrl) {
            return { url: String(referenced.mediaUrl), noteToAppend: referenced.caption ? `\n\nNota de la imagen: ${referenced.caption}` : '' }
        }
    }
    return { url: null, noteToAppend: '' }
}

/** ===== Debounce por conversación ===== */
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

/** ===== Presupuesto/tokens y formato ===== */
function softTrim(s: string | null | undefined, max = 160) {
    const t = (s || '').trim(); if (!t) return ''
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
        : Array.isArray(user?.content) ? String(user?.content?.[0]?.text || '') : ''

    let total = approxTokens(sysText) + approxTokens(userText)
    for (const m of messages) {
        if (m.role !== 'system' && m !== user) {
            const t = typeof m.content === 'string' ? m.content
                : Array.isArray(m.content) ? String(m.content?.[0]?.text || '') : ''
            total += approxTokens(t)
        }
    }
    if (total <= budgetPromptTokens) return messages

    const lines = sysText.split('\n').map(l => l.trim()).filter(Boolean)
    const keep: string[] = []
    for (const l of lines) {
        if (/Asistente|Responde en|Nunca inventes|Políticas|Dirección|dep[oó]sito|propon(e|er)/i.test(l)) keep.push(l)
        if (keep.length >= 5) break
    }
    ; (sys as any).content = keep.join('\n') || lines.slice(0, 5).join('\n')

    if (typeof user?.content === 'string') {
        user.content = softTrim(user.content, 200)
    } else if (Array.isArray(user?.content)) {
        user.content[0].text = softTrim(String(user.content?.[0]?.text || ''), 200)
    }

    return messages
}

function clampConcise(text: string, maxLines = IA_MAX_LINES): string {
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
    t = t.replace(/^[•\-]\s*/gm, '').replace(/\s+\n/g, '\n').replace(/\n{2,}/g, '\n').trim()
    t = t.length > maxChars ? t.slice(0, maxChars - 1) + '…' : t
    t = clampConcise(t, maxLines)
    if (allowEmoji && !/[^\w\s.,;:()¿?¡!…]/.test(t)) {
        const EMOJIS = ['🙂', '💡', '👌', '✅', '✨', '💬', '🫶']; t = `${t} ${EMOJIS[Math.floor(Math.random() * EMOJIS.length)]}`
        t = clampConcise(t, maxLines)
    }
    return t
}
function endsWithPunctuation(t: string) { return /[.!?…]\s*$/.test((t || '').trim()) }
function closeNicely(raw: string): string {
    let t = (raw || '').trim(); if (!t) return t
    if (endsWithPunctuation(t)) return t
    t = t.replace(/\s+[^\s]*$/, '').trim()
    return t ? `${t}…` : raw.trim()
}

/** ===== Chat con retry en tokens ===== */
async function runChatWithBudget(opts: { model: string; messages: any[]; temperature: number; maxTokens: number }): Promise<string> {
    const { model, messages, temperature, maxTokens } = opts
    try {
        const r1 = await openai.chat.completions.create({ model, messages, temperature, max_tokens: maxTokens } as any)
        return r1?.choices?.[0]?.message?.content?.trim() || ''
    } catch (err: any) {
        const msg = String(err?.response?.data || err?.message || '')
        const m = msg.match(/only\s+(\d+)\s+tokens?/i) || msg.match(/can\s+only\s+afford\s+(\d+)/i)
        const retry = Math.max(12, Math.min(Number(m?.[1] || 32), 48))
        const r2 = await openai.chat.completions.create({ model, messages, temperature, max_tokens: retry } as any)
        return r2?.choices?.[0]?.message?.content?.trim() || ''
    }
}

/** ========================= ENTRY ========================= */
export async function handleEsteticaReply(opts: {
    chatId: number
    empresaId: number
    mensajeArg?: string
    toPhone?: string
    phoneNumberId?: string
    apptConfig?: any
}): Promise<IAReplyResult | null> {
    const { chatId, empresaId, mensajeArg = '', toPhone, phoneNumberId } = opts

    // 0) Conversación y último mensaje del cliente
    const conversacion = await prisma.conversation.findUnique({
        where: { id: chatId },
        select: { id: true, estado: true, phone: true, nombre: true },
    })
    if (!conversacion) return null

    const last = await prisma.message.findFirst({
        where: { conversationId: chatId, from: MessageFrom.client },
        orderBy: { timestamp: 'desc' },
        select: {
            id: true, mediaType: true, mediaUrl: true, caption: true, isVoiceNote: true,
            transcription: true, contenido: true, mimeType: true, timestamp: true
        }
    })

    if (last?.id && seenInboundRecently(last.id)) return null

    // 1) Contexto agenda (DB u orquestador)
    const ctx: EsteticaCtx = await loadApptContext(empresaId, opts.apptConfig)

    // 2) Texto efectivo (voz → transcripción)
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
                        last.mimeType?.includes('mpeg') ? 'audio.mp3' :
                            last.mimeType?.includes('wav') ? 'audio.wav' :
                                last.mimeType?.includes('m4a') ? 'audio.m4a' :
                                    last.mimeType?.includes('webm') ? 'audio.webm' : 'audio.ogg'
                    transcript = await transcribeAudioBuffer(audioBuf, name)
                    if (transcript) await prisma.message.update({ where: { id: last.id }, data: { transcription: transcript } })
                }
            } catch { /* noop */ }
        }
        if (transcript) userText = transcript
    }

    // ⬇️ Fallback: si no hay texto por arg ni por audio, usa el texto del último mensaje del cliente
    if (!userText && last?.contenido) {
        userText = String(last.contenido || '').trim()
    }

    const isImage = last?.mediaType === MediaType.image && !!last?.mediaUrl
    const imageUrl = isImage ? String(last?.mediaUrl) : null
    const caption = String(last?.caption || '').trim()
    const referenceTs = last?.timestamp ?? new Date()

    // Debounce por imagen / general
    if (isImage) {
        if (!(caption || userText)) { await sleep(IMAGE_WAIT_MS); return null }
        if (last?.timestamp && shouldSkipDoubleReply(chatId, last.timestamp, REPLY_DEDUP_WINDOW_MS)) return null
    } else {
        if (last?.timestamp && shouldSkipDoubleReply(chatId, last.timestamp, REPLY_DEDUP_WINDOW_MS)) return null
    }

    // 3) Intent (con el texto final)
    const intent = await detectIntent(userText || caption || '', ctx)

    // 4) Ramas
    switch (intent.type) {
        case EsteticaIntent.ASK_SERVICES: {
            const procs = await retrieveProcedures(empresaId, intent.query)
            const sys = buildSystemPrompt(ctx)

            // Historial compacto (como en agente)
            const history = await getRecentHistory(chatId, last?.id, 10)
            const picked = await pickImageForContext({ conversationId: chatId, directUrl: imageUrl, userText, caption, referenceTs })
            const messages: any[] = [{ role: 'system', content: sys }, ...history]

            const userMsg = (intent.query || userText || caption || 'Servicios')
            if (picked.url) {
                messages.push({ role: 'user', content: [{ type: 'text', text: `${userMsg}\n\nContexto:\n${procsToContext(procs)}${picked.noteToAppend}` }, { type: 'image_url', image_url: { url: picked.url } }] })
            } else {
                messages.push({ role: 'user', content: `${userMsg}\n\nContexto:\n${procsToContext(procs)}` })
            }
            budgetMessages(messages, Number(process.env.IA_PROMPT_BUDGET ?? 110))
            const model = (process.env.IA_TEXT_MODEL || process.env.IA_MODEL || 'gpt-4o-mini')
            let texto = await runChatWithBudget({ model, messages, temperature: Number(process.env.IA_TEMPERATURE ?? 0.35), maxTokens: IA_MAX_TOKENS })
            texto = formatConcise(closeNicely(texto), IA_MAX_LINES, IA_MAX_CHARS, IA_ALLOW_EMOJI)

            const delayMs = await computeReplyDelayMs(chatId); await sleep(delayMs)
            const saved = await persistBotReply({
                conversationId: chatId, empresaId, texto,
                nuevoEstado: ConversationEstado.respondido,
                to: toPhone ?? conversacion.phone, phoneNumberId
            })
            if (!isImage && last?.timestamp) markActuallyReplied(chatId, last.timestamp)
            return { estado: ConversationEstado.respondido, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
        }

        case EsteticaIntent.BOOK: {
            const durationMin = intent.durationMin ?? ctx.rules?.defaultServiceDurationMin ?? 60
            const slots = await findSlots({ empresaId, ctx, hint: intent.when ?? null, durationMin, count: 6 })

            if (!intent.confirm) {
                const txt = fmtProposeSlots(slots, ctx, 'agendar')
                const saved = await persistBotReply({
                    conversationId: chatId, empresaId, texto: txt,
                    nuevoEstado: conversacion.estado,
                    to: toPhone ?? conversacion.phone, phoneNumberId
                })
                return { estado: conversacion.estado, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
            }

            const chosen = intent.when ?? slots[0]
            const appt = await book({
                empresaId,
                conversationId: chatId,
                customerPhone: (toPhone ?? conversacion.phone) || '',
                customerName: intent.customerName ?? conversacion.nombre ?? undefined,
                serviceName: intent.serviceName ?? (intent.query ?? 'Evaluación/Consulta'),
                startAt: chosen!,
                durationMin,
                timezone: ctx.timezone,
                procedureId: intent.procedureId,
                notes: intent.notes,
            }, ctx)

            const txt = fmtConfirmBooking(appt, ctx)

            // (Opcional) Plantilla de confirmación si está configurada: WA_TPL_APPT_CONFIRM="nombre:idioma"
            try {
                const tp = (process.env.WA_TPL_APPT_CONFIRM || '').trim()
                if (tp) {
                    const [tplName, tplLang = 'es'] = tp.split(':')
                    const f = (d: Date) => new Intl.DateTimeFormat('es-CO', { dateStyle: 'full', timeStyle: 'short', timeZone: ctx.timezone }).format(d)
                    const vars: string[] = [
                        appt.customerName || 'cliente',
                        appt.serviceName || 'cita',
                        f(appt.startAt),
                        ctx.logistics?.locationName || '',
                    ]
                    await sendTpl({
                        empresaId,
                        to: (toPhone ?? conversacion.phone)!,
                        name: tplName,
                        lang: tplLang,
                        variables: vars,
                        phoneNumberIdHint: phoneNumberId,
                    })
                }
            } catch (e) {
                console.warn('[estetica.strategy] sendTpl confirmación falló:', (e as any)?.message || e)
            }

            const delayMs = await computeReplyDelayMs(chatId); await sleep(delayMs)
            const saved = await persistBotReply({
                conversationId: chatId, empresaId, texto: txt,
                nuevoEstado: ConversationEstado.respondido,
                to: toPhone ?? conversacion.phone, phoneNumberId
            })
            return { estado: ConversationEstado.respondido, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
        }

        case EsteticaIntent.RESCHEDULE: {
            const durationMin = intent.durationMin ?? ctx.rules?.defaultServiceDurationMin ?? 60
            const slots = await findSlots({ empresaId, ctx, hint: intent.when ?? null, durationMin, count: 6 })
            if (!intent.confirm) {
                const txt = fmtProposeSlots(slots, ctx, 'reagendar')
                const saved = await persistBotReply({
                    conversationId: chatId, empresaId, texto: txt,
                    nuevoEstado: conversacion.estado,
                    to: toPhone ?? conversacion.phone, phoneNumberId
                })
                return { estado: conversacion.estado, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
            }
            if (!intent.appointmentId) {
                const text = 'Para reagendar necesito el ID o la fecha de tu cita actual. ¿Puedes confirmarlo?'
                const saved = await persistBotReply({
                    conversationId: chatId, empresaId, texto: text,
                    nuevoEstado: conversacion.estado,
                    to: toPhone ?? conversacion.phone, phoneNumberId
                })
                return { estado: conversacion.estado, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
            }
            const newDate = intent.when ?? slots[0]
            const appt = await reschedule({ empresaId, appointmentId: intent.appointmentId, newStartAt: newDate! }, ctx)
            const txt = `Tu cita fue reagendada ✅\n${fmtConfirmBooking(appt, ctx)}`
            const delayMs = await computeReplyDelayMs(chatId); await sleep(delayMs)
            const saved = await persistBotReply({
                conversationId: chatId, empresaId, texto: txt,
                nuevoEstado: ConversationEstado.respondido,
                to: toPhone ?? conversacion.phone, phoneNumberId
            })
            return { estado: ConversationEstado.respondido, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
        }

        case EsteticaIntent.CANCEL: {
            if (!intent.appointmentId) {
                const text = 'Para cancelar necesito el ID o fecha aproximada de la cita. ¿Me ayudas con ese dato?'
                const saved = await persistBotReply({
                    conversationId: chatId, empresaId, texto: text,
                    nuevoEstado: conversacion.estado,
                    to: toPhone ?? conversacion.phone, phoneNumberId
                })
                return { estado: conversacion.estado, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
            }
            // cancel( ) → 1 solo argumento (ver ajuste en schedule.ts)
            const appt = await cancel({ empresaId, appointmentId: intent.appointmentId })
            const fmt = (d: Date) => new Intl.DateTimeFormat('es-CO', { dateStyle: 'full', timeStyle: 'short', timeZone: ctx.timezone }).format(d)
            const when = appt?.startAt ? ` (${fmt(appt.startAt)})` : ''
            const windowTxt = ctx.rules?.cancellationWindowHours ? ` — ventana de ${ctx.rules.cancellationWindowHours}h` : ''
            const text = `Cita cancelada ✅${when}${windowTxt}`

            const saved = await persistBotReply({
                conversationId: chatId, empresaId, texto: text,
                nuevoEstado: ConversationEstado.respondido,
                to: toPhone ?? conversacion.phone, phoneNumberId
            })
            return { estado: ConversationEstado.respondido, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
        }

        case EsteticaIntent.GENERAL_QA:
        default: {
            const sys = buildSystemPrompt(ctx)
            // historial + imagen en contexto
            const history = await getRecentHistory(chatId, last?.id, 10)
            const picked = await pickImageForContext({ conversationId: chatId, directUrl: imageUrl, userText, caption, referenceTs })

            const messages: any[] = [{ role: 'system', content: sys }, ...history]
            if (picked.url) {
                messages.push({
                    role: 'user',
                    content: [
                        { type: 'text', text: (userText || caption || 'Hola') + (picked.noteToAppend || '') },
                        { type: 'image_url', image_url: { url: picked.url } },
                    ]
                })
            } else {
                messages.push({ role: 'user', content: userText || caption || 'Hola' })
            }

            budgetMessages(messages, Number(process.env.IA_PROMPT_BUDGET ?? 110))
            const model = (process.env.IA_TEXT_MODEL || process.env.IA_MODEL || 'gpt-4o-mini')
            let texto = await runChatWithBudget({ model, messages, temperature: Number(process.env.IA_TEMPERATURE ?? 0.35), maxTokens: IA_MAX_TOKENS })
            texto = formatConcise(closeNicely(texto), IA_MAX_LINES, IA_MAX_CHARS, IA_ALLOW_EMOJI)

            const delayMs = await computeReplyDelayMs(chatId); await sleep(delayMs)
            const saved = await persistBotReply({
                conversationId: chatId, empresaId, texto,
                nuevoEstado: ConversationEstado.respondido,
                to: toPhone ?? conversacion.phone, phoneNumberId
            })
            if (!isImage && last?.timestamp) markActuallyReplied(chatId, last.timestamp)
            return { estado: ConversationEstado.respondido, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
        }
    }
}

/* ===== Historial compacto ===== */
async function getRecentHistory(conversationId: number, excludeMessageId?: number, take = 10) {
    const where: any = { conversationId }
    if (excludeMessageId) where.id = { not: excludeMessageId }

    const rows = await prisma.message.findMany({
        where, orderBy: { timestamp: 'desc' }, take,
        select: { from: true, contenido: true },
    })
    return rows.reverse().map(r => ({
        role: r.from === MessageFrom.client ? 'user' : 'assistant',
        content: softTrim(r.contenido || '', 220)
    }))
}

/* ===== Persistencia y envío (misma firma que ecommerce/agent) ===== */
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
            // fallback para phoneNumberId
            let phoneId = phoneNumberId
            if (!phoneId) {
                const acc = await prisma.whatsappAccount.findFirst({ where: { empresaId }, select: { phoneNumberId: true } })
                phoneId = acc?.phoneNumberId
            }

            const resp = await Wam.sendWhatsappMessage({
                empresaId,
                to: normalizeToE164(to),
                body: texto,
                phoneNumberIdHint: phoneId,
            })
            wamid = (resp as any)?.data?.messages?.[0]?.id || (resp as any)?.messages?.[0]?.id
            if (wamid) await prisma.message.update({ where: { id: msg.id }, data: { externalId: wamid } })
        } catch (e: any) {
            console.warn('[WA] sendWhatsappMessage fallo:', e?.response?.data || e?.message || e)
        }
    }
    return { messageId: msg.id, texto, wamid }
}

/* ===== formateo catálogo para RAG ===== */
function procsToContext(procs: any[]) {
    if (!procs?.length) return 'Catálogo: sin coincidencias directas.'
    return [
        'Procedimientos relevantes:',
        ...procs.map(p => {
            const precio = p.priceMin ? (p.priceMax && p.priceMax !== p.priceMin ? `$${p.priceMin} - $${p.priceMax}` : `$${p.priceMin}`) : 'Consultar'
            const dur = p.durationMin ? `${p.durationMin} min` : 'Duración variable'
            return `• ${p.name} — ${dur} — ${precio}${p.requiresAssessment ? ' (requiere valoración previa)' : ''}\n   ${p.description ?? p.notes ?? ''}`
        })
    ].join('\n')
}
