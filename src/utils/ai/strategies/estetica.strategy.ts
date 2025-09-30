import axios from 'axios'
import prisma from '../../../lib/prisma'
import { openai } from '../../../lib/openai'
import * as Wam from '../../../services/whatsapp.service'
import { sendTemplateByName as sendTpl } from '../../../services/whatsapp.service'
import { transcribeAudioBuffer } from '../../../services/transcription.service'
import { ConversationEstado, MessageFrom } from '@prisma/client'

import { detectIntent, EsteticaIntent } from './esteticaModules/estetica.intents'
import { buildSystemPrompt, fmtConfirmBooking, fmtProposeSlots } from './esteticaModules/estetica.prompts'
import { loadApptContext, retrieveProcedures, type EsteticaCtx, confirmLatestPendingForPhone } from './esteticaModules/estetica.rag'
import { findSlots, book, reschedule, cancel, cancelMany, listUpcomingApptsForPhone } from './esteticaModules/estetica.schedule'

export type IAReplyResult = {
    estado: ConversationEstado
    mensaje?: string
    motivo?: 'confianza_baja' | 'palabra_clave' | 'reintentos'
    messageId?: number
    wamid?: string
    media?: Array<{ productId: number; imageUrl: string; wamid?: string }>
}

/* =================== Session Store =================== */

type ApptChoice = { id: number; startAt: Date; serviceName?: string | null }
type PendingState =
    | { kind: 'book'; slots: Date[]; durationMin: number; serviceName: string; procedureId?: number; needName: boolean }
    | { kind: 'reschedule'; appts?: ApptChoice[]; selectedApptId?: number; slots?: Date[]; durationMin: number }
    | { kind: 'cancel'; appts?: ApptChoice[] }

const SESSION_TTL_MS = 15 * 60 * 1000
const sessionMap = new Map<number, { expiresAt: number; data: PendingState }>()
function putSession(convId: number, data: PendingState) { sessionMap.set(convId, { expiresAt: Date.now() + SESSION_TTL_MS, data }) }
function getSession(convId: number): PendingState | null {
    const row = sessionMap.get(convId)
    if (!row) return null
    if (Date.now() > row.expiresAt) { sessionMap.delete(convId); return null }
    return row.data
}
function clearSession(convId: number) { sessionMap.delete(convId) }

/* =================== Utilidades varias =================== */

const REPLY_DEDUP_WINDOW_MS = Number(process.env.REPLY_DEDUP_WINDOW_MS ?? 120_000)

const IA_MAX_LINES = Number(process.env.IA_MAX_LINES ?? 5)
const IA_MAX_CHARS = Number(process.env.IA_MAX_CHARS ?? 1000)
const IA_MAX_TOKENS = Number(process.env.IA_MAX_TOKENS ?? 100)
const IA_ALLOW_EMOJI = (process.env.IA_ALLOW_EMOJI ?? '1') === '1'

const processedInbound = new Map<number, number>()
function seenInboundRecently(messageId: number, windowMs = REPLY_DEDUP_WINDOW_MS) {
    const now = Date.now()
    const prev = processedInbound.get(messageId)
    if (prev && now - prev <= windowMs) return true
    processedInbound.set(messageId, now)
    return false
}

const recentReplies = new Map<number, { afterMs: number; repliedAtMs: number }>()
function shouldSkipDoubleReply(conversationId: number, clientTs: Date, windowMs = REPLY_DEDUP_WINDOW_MS) {
    const now = Date.now()
    const prev = recentReplies.get(conversationId)
    const clientMs = clientTs.getTime()
    if (prev && prev.afterMs >= clientMs && now - prev.repliedAtMs <= windowMs) return true
    recentReplies.set(conversationId, { afterMs: clientMs, repliedAtMs: now })
    return false
}
function markActuallyReplied(conversationId: number, clientTs: Date) {
    const now = Date.now()
    recentReplies.set(conversationId, { afterMs: clientTs.getTime(), repliedAtMs: now })
}

function softTrim(s?: string | null, max = 160) {
    const t = (s || '').trim(); if (!t) return ''
    return t.length <= max ? t : t.slice(0, max).replace(/\s+[^\s]*$/, '') + '…'
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
function formatConcise(text: string, maxLines = IA_MAX_LINES, maxChars = IA_MAX_CHARS, allowEmoji = IA_ALLOW_EMOJI) {
    let t = String(text || '').trim()
    if (!t) return 'Gracias por escribirnos. ¿Cómo puedo ayudarte?'
    t = t.replace(/^[•\-]\s*/gm, '').replace(/\s+\n/g, '\n').replace(/\n{2,}/g, '\n').trim()
    t = t.length > maxChars ? t.slice(0, maxChars - 1) + '…' : t
    t = clampConcise(t, maxLines)
    if (allowEmoji && !/[^\w\s.,;:()¿?¡!…]/.test(t)) {
        const EMOJIS = ['🙂', '💡', '👌', '✅', '✨', '💬', '🫶']
        t = `${t} ${EMOJIS[Math.floor(Math.random() * EMOJIS.length)]}`
        t = clampConcise(t, maxLines)
    }
    return t
}
function closeNicely(raw: string) {
    let t = (raw || '').trim()
    if (!t) return t
    if (/[.!?…]\s*$/.test(t)) return t
    t = t.replace(/\s+[^\s]*$/, '').trim()
    return t ? `${t}…` : raw.trim()
}
async function runChatWithBudget(opts: { model: string; messages: any[]; temperature: number; maxTokens: number }) {
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

function normalizeToE164(n: string) { return String(n || '').replace(/[^\d]/g, '') }
async function persistBotReply({
    conversationId, empresaId, texto, nuevoEstado, to, phoneNumberId,
}: {
    conversationId: number; empresaId: number; texto: string; nuevoEstado: ConversationEstado; to?: string; phoneNumberId?: string
}) {
    const msg = await prisma.message.create({ data: { conversationId, from: MessageFrom.bot, contenido: texto, empresaId } })
    await prisma.conversation.update({ where: { id: conversationId }, data: { estado: nuevoEstado } })
    let wamid: string | undefined
    if (to && String(to).trim()) {
        try {
            let phoneId = phoneNumberId
            if (!phoneId) {
                const acc = await prisma.whatsappAccount.findFirst({ where: { empresaId }, select: { phoneNumberId: true } })
                phoneId = acc?.phoneNumberId
            }
            const resp = await Wam.sendWhatsappMessage({ empresaId, to: normalizeToE164(to), body: texto, phoneNumberIdHint: phoneId })
            wamid = (resp as any)?.data?.messages?.[0]?.id || (resp as any)?.messages?.[0]?.id
            if (wamid) await prisma.message.update({ where: { id: msg.id }, data: { externalId: wamid } })
        } catch (e: any) {
            console.warn('[WA] sendWhatsappMessage fallo:', e?.response?.data || e?.message || e)
        }
    }
    return { messageId: msg.id, texto, wamid }
}

/* ======== NLU helpers (índices + nombre) ======== */
function extractNumberListText(t: string): number[] {
    const s = (t || '').toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/\b(opcion|opciones|numero|nro|num|no|#)\b/g, '')
    const raw = s.match(/(\d{1,2})(?=(?:\D|$))/g)
    if (!raw) return []
    return raw.map(n => Number(n)).filter(n => Number.isFinite(n))
}
function sanitizeNameCandidate(t: string): string {
    let s = (t || '').trim()
    s = s.replace(/^\s*(la\s+)?opci[oó]n\s+\d+\s*/i, '')
        .replace(/^\s*#\s*\d+\s*/i, '')
        .replace(/\b(opci[oó]n|no\.?|num\.?|nro\.?)\s*\d+\b/gi, '')
    s = s.replace(/\s*\b\d+\b\s*/g, ' ')
    s = s.replace(/\s+/g, ' ').trim()
    return s
}
function looksLikeFullNameStrict(text: string): boolean {
    const t = sanitizeNameCandidate(text)
    if (t.length < 4) return false
    if (/\d/.test(t)) return false
    const words = t.split(/\s+/)
    return words.length >= 2 && /^[a-zA-ZÀ-ÿ'´`-]+\s+[a-zA-ZÀ-ÿ'´`-]+/.test(t)
}

/* ========================= ENTRY ========================= */
export async function handleEsteticaReply(opts: {
    chatId: number
    empresaId: number
    mensajeArg?: string
    toPhone?: string
    phoneNumberId?: string
    apptConfig?: any
}): Promise<IAReplyResult | null> {
    const { chatId, empresaId, mensajeArg = '', toPhone, phoneNumberId } = opts

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
        },
    })
    if (last?.id && seenInboundRecently(last.id)) return null

    const ctx: EsteticaCtx = await loadApptContext(empresaId, opts.apptConfig)

    // === Voz → texto
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
    if (!userText && last?.contenido) userText = String(last.contenido || '').trim()

    // Estado pendiente
    const pending = getSession(chatId)
    if (pending) {
        // BOOK
        if (pending.kind === 'book') {
            const list = extractNumberListText(userText)
            if (list.length >= 1) {
                const idx = list[0] - 1
                if (idx >= 0 && idx < pending.slots.length) {
                    const chosen = pending.slots[idx]
                    let nameToSave = conversacion.nombre ?? ''
                    if ((!nameToSave || nameToSave.trim().length < 2) && looksLikeFullNameStrict(userText)) {
                        nameToSave = sanitizeNameCandidate(userText)
                        await prisma.conversation.update({ where: { id: chatId }, data: { nombre: nameToSave } })
                    }
                    const appt = await book({
                        empresaId,
                        conversationId: chatId,
                        customerPhone: (toPhone ?? conversacion.phone) || '',
                        customerName: nameToSave || undefined,
                        serviceName: pending.serviceName,
                        startAt: chosen,
                        durationMin: pending.durationMin,
                        timezone: ctx.timezone,
                        procedureId: pending.procedureId,
                    }, ctx)

                    clearSession(chatId)
                    const txt = fmtConfirmBooking(appt, ctx)

                    try {
                        const tp = (process.env.WA_TPL_APPT_CONFIRM || '').trim()
                        if (tp) {
                            const [tplName, tplLang = 'es'] = tp.split(':')
                            const f = (d: Date) => new Intl.DateTimeFormat('es-CO', { dateStyle: 'full', timeStyle: 'short', timeZone: ctx.timezone }).format(d)
                            const vars: string[] = [appt.customerName || 'cliente', appt.serviceName || 'cita', f(appt.startAt), ctx.logistics?.locationName || '']
                            await sendTpl({ empresaId, to: (toPhone ?? conversacion.phone)!, name: tplName, lang: tplLang, variables: vars, phoneNumberIdHint: phoneNumberId })
                        }
                    } catch { }

                    const saved = await persistBotReply({ conversationId: chatId, empresaId, texto: txt, nuevoEstado: ConversationEstado.respondido, to: toPhone ?? conversacion.phone, phoneNumberId })
                    return { estado: ConversationEstado.respondido, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
                }
            }

            if (pending.needName && looksLikeFullNameStrict(userText)) {
                const clean = sanitizeNameCandidate(userText)
                await prisma.conversation.update({ where: { id: chatId }, data: { nombre: clean } })
                putSession(chatId, { ...pending, needName: false })
                const txt = 'Gracias. Ahora elige un horario con el número de la opción (1-6) para confirmar.'
                const saved = await persistBotReply({ conversationId: chatId, empresaId, texto: txt, nuevoEstado: conversacion.estado, to: toPhone ?? conversacion.phone, phoneNumberId })
                return { estado: conversacion.estado, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
            }
        }

        // RESCHEDULE
        if (pending.kind === 'reschedule') {
            if (pending.appts && !pending.selectedApptId) {
                const list = extractNumberListText(userText)
                const idx = (list[0] ?? NaN) - 1
                if (!Number.isNaN(idx) && idx >= 0 && pending.appts[idx]) {
                    const chosenAppt = pending.appts[idx]
                    const slots = pending.slots ?? await findSlots({ empresaId, ctx, hint: null, durationMin: pending.durationMin, count: 6 })
                    putSession(chatId, { ...pending, selectedApptId: chosenAppt.id, slots })
                    const txt = fmtProposeSlots(slots, ctx, 'reagendar')
                    const saved = await persistBotReply({ conversationId: chatId, empresaId, texto: txt, nuevoEstado: conversacion.estado, to: toPhone ?? conversacion.phone, phoneNumberId })
                    return { estado: conversacion.estado, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
                }
            }
            if (pending.selectedApptId && pending.slots) {
                const list = extractNumberListText(userText)
                const idx = (list[0] ?? NaN) - 1
                if (!Number.isNaN(idx) && idx >= 0 && idx < pending.slots.length) {
                    const newStart = pending.slots[idx]
                    const updated = await reschedule({ empresaId, appointmentId: pending.selectedApptId, newStartAt: newStart }, ctx)
                    clearSession(chatId)
                    const txt = `Tu cita fue reagendada ✅\n${fmtConfirmBooking(updated, ctx)}`
                    const saved = await persistBotReply({ conversationId: chatId, empresaId, texto: txt, nuevoEstado: ConversationEstado.respondido, to: toPhone ?? conversacion.phone, phoneNumberId })
                    return { estado: ConversationEstado.respondido, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
                }
            }
        }

        // CANCEL en estado interactivo
        if (pending.kind === 'cancel' && pending.appts) {
            const list = extractNumberListText(userText)
            if (list.length >= 1) {
                const idxs = list.map(n => n - 1).filter(i => i >= 0 && pending.appts![i])
                if (idxs.length) {
                    const ids = idxs.map(i => pending.appts![i].id)
                    const deleted = await cancelMany({ empresaId, appointmentIds: ids })
                    clearSession(chatId)
                    const f = (d: Date) => new Intl.DateTimeFormat('es-CO', { dateStyle: 'full', timeStyle: 'short', timeZone: ctx.timezone }).format(d)
                    const lines = deleted.map(d => `• ${f(d.startAt)} — ${d.serviceName ?? 'servicio'}`).join('\n')
                    const txt = `Citas canceladas ✅\n${lines}`
                    const saved = await persistBotReply({ conversationId: chatId, empresaId, texto: txt, nuevoEstado: ConversationEstado.respondido, to: toPhone ?? conversacion.phone, phoneNumberId })
                    return { estado: ConversationEstado.respondido, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
                }
            }
        }
    }

    // ===== Sin estado pendiente → Intent detection =====
    const intent = await detectIntent(userText || String(last?.caption || ''), ctx)

    switch (intent.type) {
        case EsteticaIntent.ASK_SERVICES: {
            let procs = await retrieveProcedures(empresaId, intent.query, 12)
            if (!procs.length) procs = await retrieveProcedures(empresaId, '', 12)
            const howMany = 3
            const items = procs.slice(0, howMany).map((p: any, i: number) => {
                const dur = p.durationMin ? `${p.durationMin} minutos` : 'Duración variable'
                const prec = p.priceMin ? (p.priceMax && p.priceMax !== p.priceMin ? `$${p.priceMin} - $${p.priceMax}` : `$${p.priceMin}`) : 'Consultar'
                const req = p.requiresAssessment ? ' (requiere valoración previa)' : ''
                return `${i + 1}. ${p.name}${req}\n   ⏱️ Duración: ${dur}\n   💵 Precio: ${prec}`
            }).join('\n\n')
            const texto = procs.length
                ? `Con gusto, aquí tienes algunas opciones:\n${items}\n\n¿Quieres que te comparta horarios para alguno?`
                : 'Aún no tengo el catálogo cargado. ¿Te gustaría agendar una valoración gratuita? 🙂'
            const saved = await persistBotReply({ conversationId: chatId, empresaId, texto, nuevoEstado: ConversationEstado.respondido, to: toPhone ?? conversacion.phone, phoneNumberId })
            return { estado: ConversationEstado.respondido, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
        }

        case EsteticaIntent.BOOK: {
            const durationMin = intent.durationMin ?? ctx.rules?.defaultServiceDurationMin ?? 60
            const serviceName = intent.serviceName ?? (intent.query ?? 'Evaluación/Consulta')
            const slots = await findSlots({ empresaId, ctx, hint: null, durationMin, count: 6 })
            const needName = !conversacion.nombre || conversacion.nombre.trim().length < 2
            putSession(chatId, { kind: 'book', slots, durationMin, serviceName, procedureId: intent.procedureId, needName })
            const askName = needName ? `\n\nAntes de confirmar, ¿a nombre de quién agendamos? (Nombre y apellido)` : ''
            const txt = fmtProposeSlots(slots, ctx, 'agendar') + askName
            const saved = await persistBotReply({ conversationId: chatId, empresaId, texto: txt, nuevoEstado: conversacion.estado, to: toPhone ?? conversacion.phone, phoneNumberId })
            return { estado: conversacion.estado, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
        }

        case EsteticaIntent.RESCHEDULE: {
            const phone = (toPhone ?? conversacion.phone) || ''
            const appts = await listUpcomingApptsForPhone(empresaId, phone)
            const durationMin = intent.durationMin ?? ctx.rules?.defaultServiceDurationMin ?? 60

            if (!appts.length) {
                const text = 'No encuentro una cita futura asociada a este número. Si tienes el ID o la fecha aproximada, compártemela y te ayudo a reagendar.'
                const saved = await persistBotReply({ conversationId: chatId, empresaId, texto: text, nuevoEstado: conversacion.estado, to: toPhone ?? conversacion.phone, phoneNumberId })
                return { estado: conversacion.estado, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
            }

            if (appts.length === 1) {
                const slots = await findSlots({ empresaId, ctx, hint: null, durationMin, count: 6 })
                putSession(chatId, { kind: 'reschedule', selectedApptId: appts[0].id, slots, durationMin })
                const listTxt = fmtProposeSlots(slots, ctx, 'reagendar')
                const saved = await persistBotReply({ conversationId: chatId, empresaId, texto: listTxt, nuevoEstado: conversacion.estado, to: toPhone ?? conversacion.phone, phoneNumberId })
                return { estado: conversacion.estado, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
            }

            const f = (d: Date) => new Intl.DateTimeFormat('es-CO', { dateStyle: 'full', timeStyle: 'short', timeZone: ctx.timezone }).format(d)
            const lines = appts.map((a, i) => `${i + 1}. ${f(a.startAt)} — ${a.serviceName ?? 'servicio'} (ID ${a.id})`).join('\n')
            putSession(chatId, { kind: 'reschedule', appts, durationMin })
            const txt = `Tienes varias citas:\n${lines}\n\nIndícame el número de la que quieres reagendar.`
            const saved = await persistBotReply({ conversationId: chatId, empresaId, texto: txt, nuevoEstado: conversacion.estado, to: toPhone ?? conversacion.phone, phoneNumberId })
            return { estado: conversacion.estado, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
        }

        case EsteticaIntent.CONFIRM: {
            const phone: string = (toPhone ?? conversacion.phone) || ''
            if (!phone) {
                const txt = '¿Me compartes el teléfono con el que reservaste para ubicar tu cita?'
                const saved = await persistBotReply({ conversationId: chatId, empresaId, texto: txt, nuevoEstado: conversacion.estado, to: toPhone ?? conversacion.phone, phoneNumberId })
                return { estado: conversacion.estado, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
            }
            const appt = await confirmLatestPendingForPhone(empresaId, phone)
            const msg = appt ? '¡Listo! Tu cita quedó confirmada ✅' : 'No encontré una cita pendiente para ese número. Si quieres, te comparto horarios para agendar.'
            const saved = await persistBotReply({ conversationId: chatId, empresaId, texto: msg, nuevoEstado: ConversationEstado.respondido, to: toPhone ?? conversacion.phone, phoneNumberId })
            return { estado: ConversationEstado.respondido, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
        }

        case EsteticaIntent.CANCEL: {
            const phone = (toPhone ?? conversacion.phone) || ''
            const appts = await listUpcomingApptsForPhone(empresaId, phone)
            if (!appts.length) {
                const text = 'No veo una cita futura asociada a este número. Si tienes el ID o fecha aproximada, compártemela y la cancelo por ti.'
                const saved = await persistBotReply({ conversationId: chatId, empresaId, texto: text, nuevoEstado: conversacion.estado, to: phone, phoneNumberId })
                return { estado: conversacion.estado, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
            }

            if ((intent as any).cancelAll) {
                const deleted = await cancelMany({ empresaId, appointmentIds: appts.map(a => a.id) })
                clearSession(chatId)
                const f = (d: Date) => new Intl.DateTimeFormat('es-CO', { dateStyle: 'full', timeStyle: 'short', timeZone: ctx.timezone }).format(d)
                const lines = deleted.map(d => `• ${f(d.startAt)} — ${d.serviceName ?? 'servicio'}`).join('\n')
                const txt = `Listo, cancelé todas tus citas ✅\n${lines}`
                const saved = await persistBotReply({ conversationId: chatId, empresaId, texto: txt, nuevoEstado: ConversationEstado.respondido, to: phone, phoneNumberId })
                return { estado: ConversationEstado.respondido, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
            }

            const numbers = (intent as any).numberList as number[] | undefined
            if (numbers && numbers.length) {
                const idxs = numbers.map(n => n - 1).filter(i => i >= 0 && i < appts.length)
                if (idxs.length) {
                    const ids = idxs.map(i => appts[i].id)
                    const deleted = await cancelMany({ empresaId, appointmentIds: ids })
                    clearSession(chatId)
                    const f = (d: Date) => new Intl.DateTimeFormat('es-CO', { dateStyle: 'full', timeStyle: 'short', timeZone: ctx.timezone }).format(d)
                    const lines = deleted.map(d => `• ${f(d.startAt)} — ${d.serviceName ?? 'servicio'}`).join('\n')
                    const txt = `Citas canceladas ✅\n${lines}`
                    const saved = await persistBotReply({ conversationId: chatId, empresaId, texto: txt, nuevoEstado: ConversationEstado.respondido, to: phone, phoneNumberId })
                    return { estado: ConversationEstado.respondido, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
                }
            }

            if (appts.length === 1) {
                putSession(chatId, { kind: 'cancel', appts })
                const f = (d: Date) => new Intl.DateTimeFormat('es-CO', { dateStyle: 'full', timeStyle: 'short', timeZone: ctx.timezone }).format(d)
                const t = `Confirmo: ¿Quieres cancelar ${f(appts[0].startAt)} — ${appts[0].serviceName ?? 'servicio'}? Responde "sí confirmo" para proceder.`
                const saved = await persistBotReply({ conversationId: chatId, empresaId, texto: t, nuevoEstado: conversacion.estado, to: phone, phoneNumberId })
                return { estado: conversacion.estado, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
            }

            const f = (d: Date) => new Intl.DateTimeFormat('es-CO', { dateStyle: 'full', timeStyle: 'short', timeZone: ctx.timezone }).format(d)
            const lines = appts.map((a, i) => `${i + 1}. ${f(a.startAt)} — ${a.serviceName ?? 'servicio'} (ID ${a.id})`).join('\n')
            putSession(chatId, { kind: 'cancel', appts })
            const txt = `Tienes varias citas:\n${lines}\n\nIndícame el número de las que deseas cancelar (puedes decir "1 y 3" o "las dos").`
            const saved = await persistBotReply({ conversationId: chatId, empresaId, texto: txt, nuevoEstado: conversacion.estado, to: phone, phoneNumberId })
            return { estado: conversacion.estado, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
        }

        case EsteticaIntent.LIST: {
            const phone = (toPhone ?? conversacion.phone) || ''
            const appts = await listUpcomingApptsForPhone(empresaId, phone)
            if (!appts.length) {
                const saved = await persistBotReply({ conversationId: chatId, empresaId, texto: 'No tienes citas pendientes en este momento. ¿Buscamos horarios para agendar?', nuevoEstado: ConversationEstado.respondido, to: phone, phoneNumberId })
                return { estado: ConversationEstado.respondido, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
            }
            const f = (d: Date) => new Intl.DateTimeFormat('es-CO', { dateStyle: 'full', timeStyle: 'short', timeZone: ctx.timezone }).format(d)
            const lines = appts.map((a, i) => `${i + 1}. ${f(a.startAt)} — ${a.serviceName ?? 'servicio'} (ID ${a.id})`).join('\n')
            const txt = `Tienes estas citas agendadas:\n${lines}\n\nSi deseas cancelar o reagendar, dime el número (por ejemplo: "cancelar 2" o "reagendar 1").`
            const saved = await persistBotReply({ conversationId: chatId, empresaId, texto: txt, nuevoEstado: ConversationEstado.respondido, to: phone, phoneNumberId })
            return { estado: ConversationEstado.respondido, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
        }

        case EsteticaIntent.GENERAL_QA:
        default: {
            const sys = buildSystemPrompt(ctx)
            const history = await getRecentHistory(chatId, last?.id, 10)
            const messages: any[] = [{ role: 'system', content: sys }, ...history, { role: 'user', content: userText || 'Hola' }]
            const model = (process.env.IA_TEXT_MODEL || process.env.IA_MODEL || 'gpt-4o-mini')
            let texto = await runChatWithBudget({ model, messages, temperature: Number(process.env.IA_TEMPERATURE ?? 0.35), maxTokens: IA_MAX_TOKENS })
            texto = formatConcise(closeNicely(texto), IA_MAX_LINES, IA_MAX_CHARS, IA_ALLOW_EMOJI)
            const saved = await persistBotReply({ conversationId: chatId, empresaId, texto, nuevoEstado: ConversationEstado.respondido, to: toPhone ?? conversacion.phone, phoneNumberId })
            return { estado: ConversationEstado.respondido, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
        }
    }
}

async function getRecentHistory(conversationId: number, excludeMessageId?: number, take = 10) {
    const where: any = { conversationId }
    if (excludeMessageId) where.id = { not: excludeMessageId }
    const rows = await prisma.message.findMany({ where, orderBy: { timestamp: 'desc' }, take, select: { from: true, contenido: true } })
    return rows.reverse().map(r => ({ role: r.from === MessageFrom.client ? 'user' : 'assistant', content: softTrim(r.contenido || '', 220) }))
}
