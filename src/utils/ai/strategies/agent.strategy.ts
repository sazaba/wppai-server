import axios from 'axios'
import prisma from '../../../lib/prisma'
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
        where: { conversationId: chatId, from: 'client' },
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
        },
    })

    // 2) Configuración del negocio
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

    // 3) Preparar texto del usuario (prioriza transcripción si es nota de voz)
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

    // 4) Si mandan solo imagen, pregunta breve
    if (isImage && !userText && !caption) {
        const ask = 'Veo tu foto 😊 ¿Quieres que te ayude a interpretarla o tienes alguna pregunta específica?'
        const saved = await persistBotReply({
            conversationId: chatId,
            empresaId,
            texto: ask,
            nuevoEstado: conversacion.estado,
            to: toPhone ?? conversacion.phone,
            phoneNumberId,
        })
        return {
            estado: conversacion.estado,
            mensaje: saved.texto,
            messageId: saved.messageId,
            wamid: saved.wamid,
            media: [],
        }
    }

    // 5) System + presupuesto
    const negocioName = (bc?.nombre || empresa?.nombre || '').trim()
    const especialidad = (agent.specialty || bc?.agentSpecialty || 'generico') as AgentSpecialty

    const nameLine = negocioName
        ? `Asistente de orientación de ${humanSpecialty(especialidad)} de "${negocioName}".`
        : `Asistente de orientación de ${humanSpecialty(especialidad)}.`

    const lineScope = softTrim(agent.scope || bc?.agentScope, 160)
    const lineDisc = softTrim(agent.disclaimers || bc?.agentDisclaimers, 160)
    const extraInst = softTrim(agent.prompt || bc?.agentPrompt, 220) // un poco más de espacio para marca/web

    const system = [
        nameLine,
        'Responde en 2–4 líneas, claro y empático. Sé específico y evita párrafos largos.',
        'Puedes usar 1 emoji ocasionalmente (no siempre).',
        'No diagnostiques ni prescribas. No reemplazas consulta clínica.',
        'Si corresponde, puedes mencionar productos del negocio y su web.',
        `Mantente solo en ${humanSpecialty(especialidad)}; si preguntan fuera, indícalo y reconduce.`,
        lineScope ? `Ámbito: ${lineScope}` : '',
        lineDisc ? `Incluye cuando aplique: ${lineDisc}` : '',
        extraInst ? `Sigue estas instrucciones del negocio: ${extraInst}` : '',
    ].filter(Boolean).join('\n')

    // 6) Historial reciente como contexto (últimos 10 mensajes)
    const history = await getRecentHistory(chatId, last?.id, 10)

    const messages: Array<any> = [{ role: 'system', content: system }, ...history]
    if (imageUrl) {
        messages.push({
            role: 'user',
            content: [
                { type: 'text', text: userText || caption || 'Analiza la imagen con prudencia clínica y brinda orientación general.' },
                { type: 'image_url', image_url: { url: imageUrl } },
            ],
        })
    } else {
        messages.push({ role: 'user', content: userText || 'Hola' })
    }

    // Presupuestar prompt total (incluye historial)
    budgetMessages(messages, Number(process.env.IA_PROMPT_BUDGET ?? 110))

    // 7) LLM con retry 402 y salida corta
    const model = process.env.IA_TEXT_MODEL || process.env.IA_MODEL || 'gpt-4o-mini'
    const temperature = Number(process.env.IA_TEMPERATURE ?? 0.35)
    const defaultMax = Number(process.env.IA_MAX_TOKENS ?? 100)

    let texto = ''
    try {
        texto = await runChatWithBudget({ model, messages, temperature, maxTokens: defaultMax })
    } catch (err: any) {
        console.error('[AGENT] OpenAI error (final):', err?.response?.data || err?.message || err)
        texto = 'Gracias por escribirnos. Podemos ayudarte con orientación general sobre tu consulta.'
    }

    // 8) Post-formateo + inyección de marca/web si falta
    // 8) Post-formateo + inyección de marca/web si falta
    texto = clampConcise(texto, 4, 340)
    texto = formatConcise(texto)

    // toma el prompt del negocio desde el agente o, si no, desde la config de la empresa
    const businessPrompt: string | undefined =
        (agent?.prompt && agent.prompt.trim()) ||
        (bc?.agentPrompt && bc.agentPrompt.trim()) ||
        undefined

    texto = maybeInjectBrand(texto, businessPrompt)


    // 9) Persistir y responder
    const saved = await persistBotReply({
        conversationId: chatId,
        empresaId,
        texto,
        nuevoEstado: ConversationEstado.respondido,
        to: toPhone ?? conversacion.phone,
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

/* ================= helpers ================= */

// Historial: últimos N mensajes en formato compacto
async function getRecentHistory(conversationId: number, excludeMessageId?: number, take = 10) {
    const where: any = { conversationId }
    if (excludeMessageId) where.id = { not: excludeMessageId }

    const rows = await prisma.message.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        take,
        select: { from: true, contenido: true },
    })

    return rows.reverse().map(r => {
        const role = r.from === 'client' ? 'user' : 'assistant'
        const content = softTrim(r.contenido || '', 220) // ~55 tokens
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
                ? Math.max(12, Math.min(affordable - 1, 48)) // permite budgets muy bajos
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

    // incluye historial en el conteo
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

    // 1) reducir system a 5 líneas clave
    const lines = sysText.split('\n').map(l => l.trim()).filter(Boolean)
    const keep: string[] = []
    for (const l of lines) {
        if (/Asistente de orientación|Responde en|Puedes usar|No diagnostiques|Mantente solo|Ámbito:|Incluye cuando|Sigue estas/i.test(l)) {
            keep.push(l)
        }
        if (keep.length >= 5) break
    }
    ; (sys as any).content = keep.join('\n') || lines.slice(0, 5).join('\n')

    // 2) recorte user a 200 chars
    if (typeof user?.content === 'string') {
        const ut = String(user.content)
        user.content = ut.length > 200 ? ut.slice(0, 200) : ut
    } else if (Array.isArray(user?.content)) {
        const ut = String(user.content?.[0]?.text || '')
        user.content[0].text = ut.length > 200 ? ut.slice(0, 200) : ut
    }

    // 3) recorta historial si aún excede (de más antiguo a más nuevo)
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
function clampConcise(text: string, maxLines = 4, maxChars = 360): string {
    let t = String(text || '').replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
    if (!t) return t

    // 1) Limite por caracteres: recorta en límite de oración si es posible
    if (t.length > maxChars) {
        const slice = t.slice(0, maxChars + 1)
        const cutAt = Math.max(
            slice.lastIndexOf('. '),
            slice.lastIndexOf('! '),
            slice.lastIndexOf('? '),
            slice.lastIndexOf('\n')
        )
        t = (cutAt > 40 ? slice.slice(0, cutAt + 1) : slice.slice(0, maxChars)).trim()
        if (!/[.!?…]$/.test(t)) t = t.replace(/\s+[^\s]*$/, '').trim() + '…'
    }

    // 2) Limite por líneas
    const lines = t.split('\n').filter(Boolean)
    if (lines.length > maxLines) {
        t = lines.slice(0, maxLines).join('\n').trim()
        if (!/[.!?…]$/.test(t)) t += '…'
    }

    return t
}

function formatConcise(text: string): string {
    let t = String(text || '').trim()
    if (!t) return 'Gracias por escribirnos. Podemos ayudarte con orientación general.'

    // Normaliza y quita viñetas si el modelo metió alguna
    t = t.replace(/^[•\-]\s*/gm, '').replace(/\s+\n/g, '\n').replace(/\n{2,}/g, '\n').trim()

    // Compacta a 2–4 líneas / ~340–360 chars (sin añadir preguntas)
    t = clampConcise(t, 4, 340)

    // Emoji opcional (30%), máx 1, solo si no hay ya uno
    if (!/[^\w\s.,;:()¿?¡!]/.test(t) && Math.random() < 0.30) {
        const EMOJIS = ['🙂', '💡', '👌', '✅', '✨', '🧴', '💬', '🫶']
        t = `${t} ${EMOJIS[Math.floor(Math.random() * EMOJIS.length)]}`
    }
    return t
}

// Inserta marca / web si viene en el prompt y no fue mencionada
function maybeInjectBrand(text: string, businessPrompt?: string): string {
    const p = String(businessPrompt || '')
    const urlMatch = p.match(/(https?:\/\/[^\s]+|www\.[^\s]+)/i)
    const url = urlMatch ? urlMatch[0] : ''
    // Marca: si detectamos "Leavid" explícito, priorizamos ese nombre
    const brand = /leavid/i.test(p) ? 'Leavid Skincare' : ''

    if (!brand && !url) return text

    const low = text.toLowerCase()
    const alreadyHas = (brand && low.includes(brand.toLowerCase())) || (url && low.includes(url.toLowerCase()))
    if (alreadyHas) return text

    const tail = `Más info: ${brand || ''}${brand && url ? ' – ' : ''}${url || ''}`.trim()
    const out = clampConcise(`${text}\n${tail}`, 4, 360)
    return out
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
