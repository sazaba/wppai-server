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

    // 2) Cargar solo lo necesario para modo agente
    const [bc, empresa] = await Promise.all([
        prisma.businessConfig.findUnique({
            where: { empresaId },
            select: {
                agentSpecialty: true,
                agentPrompt: true,
                agentScope: true,
                agentDisclaimers: true,
                nombre: true, // nombre comercial si lo tienes cargado ahí
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

    // 4) Si mandan solo imagen, pregunta
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

    // 5) Prompt del agente (solo campos de agente) + nombre
    const negocioName = (bc?.nombre || empresa?.nombre || '').trim()
    const especialidad = agent.specialty || bc?.agentSpecialty || 'generico'

    const BASE_SYSTEM = [
        negocioName ? `Te presentas como asistente de orientación de ${humanSpecialty(especialidad as AgentSpecialty)} de "${negocioName}".`
            : `Eres un asistente de orientación de ${humanSpecialty(especialidad as AgentSpecialty)}.`,
        `Responde en **3–5 líneas** máximo, claro y empático.`,
        `No diagnostiques ni prescribas. No reemplazas una consulta clínica.`,
        `Mantente estrictamente en el ámbito de ${humanSpecialty(especialidad as AgentSpecialty)}; si te preguntan algo fuera, dilo y reconduce.`,
        (agent.scope || bc?.agentScope) ? `Ámbito del servicio: ${agent.scope || bc?.agentScope}` : '',
        (agent.disclaimers || bc?.agentDisclaimers) ? `Incluye cuando corresponda: ${agent.disclaimers || bc?.agentDisclaimers}` : '',
    ].filter(Boolean).join('\n')

    const system = (agent.prompt || bc?.agentPrompt)?.trim()
        ? `${BASE_SYSTEM}\n\nInstrucciones del negocio:\n${(agent.prompt || bc?.agentPrompt)!.trim()}`
        : BASE_SYSTEM

    const messages: Array<any> = [{ role: 'system', content: system }]

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

    // 6) LLM con control de presupuesto (retry si 402) y límite de longitud
    const model = process.env.IA_TEXT_MODEL || process.env.IA_MODEL || 'gpt-4o-mini'
    const temperature = Number(process.env.IA_TEMPERATURE ?? 0.5)
    const defaultMax = Number(process.env.IA_MAX_TOKENS ?? 128) // bajo por diseño para WhatsApp

    let texto = ''
    try {
        texto = await runChatWithBudget({ model, messages, temperature, maxTokens: defaultMax })
    } catch (err: any) {
        console.error('[AGENT] OpenAI error (final):', err?.response?.data || err?.message || err)
        texto = 'Gracias por escribirnos. ¿Podrías contarme un poco más para ayudarte mejor?'
    }

    // Recorte server-side (máx. 5 líneas / 420 chars)
    texto = clampConcise(texto, 5, 420)

    // 7) Persistir y responder (en modo agente no hacemos pagos ni flujos comerciales)
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

/* ===== helpers ===== */

async function runChatWithBudget(opts: {
    model: string
    messages: any[]
    temperature: number
    maxTokens: number
}): Promise<string> {
    const { model, messages, temperature } = opts
    let maxTokens = opts.maxTokens

    if (process.env.DEBUG_AI === '1') {
        console.log('[AGENT] model =', model)
        console.log('[AGENT] OPENAI_API_KEY set =', !!process.env.OPENAI_API_KEY)
        console.log('[AGENT] maxTokens try #1 =', maxTokens)
    }

    try {
        const resp1 = await openai.chat.completions.create({
            model, messages, temperature, max_tokens: maxTokens,
        } as any)
        return resp1?.choices?.[0]?.message?.content?.trim() || ''
    } catch (err: any) {
        const msg = String(err?.response?.data || err?.message || '')
        if (process.env.DEBUG_AI === '1') console.error('[AGENT] first call error:', msg)

        // Detecta límite de créditos y reduce tokens
        const affordable = parseAffordableTokens(msg)
        const retryTokens = (typeof affordable === 'number' && Number.isFinite(affordable))
            ? Math.max(16, Math.min(affordable - 3, 96))
            : 96

        if (process.env.DEBUG_AI === '1') console.log('[AGENT] retry with maxTokens =', retryTokens)

        const resp2 = await openai.chat.completions.create({
            model, messages, temperature, max_tokens: retryTokens,
        } as any)
        return resp2?.choices?.[0]?.message?.content?.trim() || ''
    }
}

function parseAffordableTokens(message: string): number | null {
    const m = message.match(/afford\s+(\d+)/i) || message.match(/only\s+(\d+)\s+tokens?/i)
    if (m && m[1]) {
        const n = Number(m[1])
        return Number.isFinite(n) ? n : null
    }
    return null
}

/** Recorta a N líneas y M caracteres, limpia espacios y evita párrafos muy largos */
function clampConcise(text: string, maxLines = 5, maxChars = 420): string {
    let t = String(text || '').replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
    if (!t) return 'Gracias por escribirnos. ¿Podrías contarme un poco más para ayudarte mejor?'
    if (t.length > maxChars) t = t.slice(0, maxChars).replace(/\s+[^\s]*$/, '').trim() + '…'
    const lines = t.split('\n').filter(Boolean)
    if (lines.length > maxLines) t = lines.slice(0, maxLines).join('\n')
    return t
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
    await prisma.conversation.update({
        where: { id: conversationId },
        data: { estado: nuevoEstado },
    })

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
