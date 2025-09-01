// server/src/utils/ai/strategies/agent.strategy.ts
import axios from 'axios'
import prisma from '../../../lib/prisma'
import { openai } from '../../../lib/openai'
import { ConversationEstado, MediaType, MessageFrom } from '@prisma/client'
import * as Wam from '../../../services/whatsapp.service'
import { transcribeAudioBuffer } from '../../../services/transcription.service'

// Opcional: usar el mismo tipo de resultado que e-commerce para mantener compat.
import type { IAReplyResult } from '../../handleIAReply.ecommerce'

export type AgentConfig = {
    // Debe coincidir con tu enum AgentSpecialty en Prisma (sin acentos)
    specialty: 'generico' | 'medico' | 'dermatologia' | 'nutricion' | 'psicologia' | 'odontologia'
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
        select: { id: true, estado: true, phone: true }
    })
    if (!conversacion) return null

    const last = await prisma.message.findFirst({
        where: { conversationId: chatId, from: 'client' },
        orderBy: { timestamp: 'desc' },
        select: { id: true, mediaType: true, mediaUrl: true, caption: true, isVoiceNote: true, transcription: true, contenido: true, mimeType: true }
    })

    // 2) Preparar texto del usuario (prioriza transcripción si es nota de voz)
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

    const isImage = last?.mediaType === MediaType.image && !!last.mediaUrl
    const imageUrl = isImage ? String(last.mediaUrl) : null
    const caption = String(last?.caption || '').trim()

    // 3) Mensaje “pregunta” si envían solo una imagen sin texto
    if (isImage && !userText && !caption) {
        const ask = 'Veo tu foto 😊 ¿Quieres que te ayude a interpretarla o tienes alguna pregunta específica?'
        const saved = await persistBotReply({ conversationId: chatId, empresaId, texto: ask, nuevoEstado: conversacion.estado, to: toPhone ?? conversacion.phone, phoneNumberId })
        return { estado: conversacion.estado, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
    }

    // 4) Construcción del prompt del agente (guardrails)
    const BASE_SYSTEM = [
        `Eres un asistente de ${humanSpecialty(agent.specialty)} para orientación general.`,
        `Responde con empatía, claridad y pasos prácticos.`,
        `No diagnostiques ni prescribas medicamentos. No reemplazas una consulta clínica.`,
        `Si detectas signos de alarma, sugiere buscar atención presencial o urgencias.`,
        agent.scope ? `Ámbito de atención del servicio: ${agent.scope}` : '',
        agent.disclaimers ? `Disclaimers que debes incluir cuando corresponda: ${agent.disclaimers}` : ''
    ].filter(Boolean).join('\n')

    const system = agent.prompt?.trim()
        ? `${BASE_SYSTEM}\n\nInstrucciones del negocio:\n${agent.prompt.trim()}`
        : BASE_SYSTEM

    const messages: Array<any> = [{ role: 'system', content: system }]

    if (imageUrl) {
        messages.push({
            role: 'user',
            content: [
                { type: 'text', text: userText || caption || 'Analiza la imagen con prudencia clínica y brinda orientación general.' },
                { type: 'image_url', image_url: { url: imageUrl } }
            ]
        })
    } else {
        messages.push({ role: 'user', content: userText || 'Hola' })
    }

    // 5) LLM
    const model = process.env.IA_TEXT_MODEL || process.env.IA_MODEL || 'gpt-4o-mini'
    const temperature = Number(process.env.IA_TEMPERATURE ?? 0.5)
    const maxTokens = Number(process.env.IA_MAX_TOKENS ?? 420)

    let texto = ''
    try {
        const resp = await openai.chat.completions.create({
            model,
            messages,
            temperature,
            max_completion_tokens: maxTokens as any,
            // @ts-ignore
            max_tokens: maxTokens
        } as any)
        texto = resp?.choices?.[0]?.message?.content?.trim() || ''
    } catch {
        texto = 'Gracias por escribirnos. ¿Podrías contarme un poco más para ayudarte mejor?'
    }

    // 6) Persistir y responder
    const saved = await persistBotReply({
        conversationId: chatId,
        empresaId,
        texto,
        nuevoEstado: ConversationEstado.respondido,
        to: toPhone ?? conversacion.phone,
        phoneNumberId
    })

    return { estado: ConversationEstado.respondido, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
}

/* ===== helpers ===== */
function humanSpecialty(s: AgentConfig['specialty']) {
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

async function persistBotReply({ conversationId, empresaId, texto, nuevoEstado, to, phoneNumberId }: {
    conversationId: number; empresaId: number; texto: string; nuevoEstado: ConversationEstado; to?: string; phoneNumberId?: string;
}) {
    const msg = await prisma.message.create({
        data: { conversationId, from: MessageFrom.bot, contenido: texto, empresaId }
    })
    await prisma.conversation.update({ where: { id: conversationId }, data: { estado: nuevoEstado } })

    let wamid: string | undefined
    if (to && String(to).trim()) {
        try {
            const resp = await Wam.sendWhatsappMessage({ empresaId, to: normalizeToE164(to), body: texto, phoneNumberIdHint: phoneNumberId })
            wamid = (resp as any)?.data?.messages?.[0]?.id || (resp as any)?.messages?.[0]?.id
            if (wamid) await prisma.message.update({ where: { id: msg.id }, data: { externalId: wamid } })
        } catch { /* noop */ }
    }
    return { messageId: msg.id, texto, wamid }
}
