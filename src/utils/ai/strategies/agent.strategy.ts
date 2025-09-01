// server/src/utils/ai/strategies/agent.strategy.ts
import axios from 'axios'
import prisma from '../../../lib/prisma'
import { openai } from '../../../lib/openai'
import {
    ConversationEstado,
    MediaType,
    MessageFrom,
    AgentSpecialty,
    BusinessConfig,
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

    // 2) BusinessConfig (contexto del negocio y políticas)
    const bc = await prisma.businessConfig.findUnique({ where: { empresaId } })

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
                        await prisma.message.update({
                            where: { id: last.id },
                            data: { transcription: transcript },
                        })
                    }
                }
            } catch (e) {
                if (process.env.DEBUG_AI === '1') {
                    console.error('[AGENT] Transcription error:', (e as any)?.message || e)
                }
            }
        }
        if (transcript) userText = transcript
    }

    const isImage = last?.mediaType === MediaType.image && !!last?.mediaUrl
    const imageUrl = isImage ? String(last?.mediaUrl) : null
    const caption = String(last?.caption || '').trim()

    // 4) Mensaje “pregunta” si envían solo una imagen sin texto
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

    // 5) Construcción del prompt del agente (guardrails + contexto negocio)
    const negocio = bc?.nombre || 'nuestro servicio'
    const datosOperativos = [
        bc?.horarios ? `- Horarios: ${bc.horarios}` : '',
        bc?.canalesAtencion ? `- Canales de atención: ${bc.canalesAtencion}` : '',
        bc?.metodosPago ? `- Métodos de pago: ${bc.metodosPago}` : '',
        bc?.direccionTienda ? `- Dirección: ${bc.direccionTienda}` : '',
        bc?.politicasDevolucion ? `- Devoluciones: ${bc.politicasDevolucion}` : '',
        bc?.politicasGarantia ? `- Garantía: ${bc.politicasGarantia}` : '',
    ].filter(Boolean).join('\n')

    const BASE_SYSTEM = [
        `Eres un asistente de ${humanSpecialty(agent.specialty)} para orientación general del negocio "${negocio}".`,
        `Habla con calidez, naturalidad y precisión. Evita sonar robótico. Responde en como máximo 6 líneas.`,
        `No diagnostiques ni prescribas medicamentos. No reemplazas una consulta clínica.`,
        `Ofrece recomendaciones de autocuidado y cuándo consultar. Si hay signos de alarma, sugiere atención presencial o urgencias.`,
        `No salgas del ámbito de ${humanSpecialty(agent.specialty)} y reconduce si preguntan algo fuera.`,
        agent.scope ? `Ámbito del servicio: ${agent.scope}` : '',
        agent.disclaimers ? `Incluye estos disclaimers cuando corresponda: ${agent.disclaimers}` : '',
        datosOperativos ? `Info del negocio (cuando aplique):\n${datosOperativos}` : '',
        bc?.disclaimers ? `Disclaimers del negocio: ${bc.disclaimers}` : '',
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
                { type: 'image_url', image_url: { url: imageUrl } },
            ],
        })
    } else {
        messages.push({ role: 'user', content: userText || 'Hola' })
    }

    // 6) LLM con control de presupuesto (retry si 402)
    const model = process.env.IA_TEXT_MODEL || process.env.IA_MODEL || 'gpt-4o-mini'
    const temperature = Number(process.env.IA_TEMPERATURE ?? 0.5)
    const defaultMax = Number(process.env.IA_MAX_TOKENS ?? 320)

    let texto = ''
    try {
        texto = await runChatWithBudget({ model, messages, temperature, maxTokens: defaultMax })
    } catch (err: any) {
        console.error('[AGENT] OpenAI error (final):', err?.response?.data || err?.message || err)
        texto = 'Gracias por escribirnos. ¿Podrías contarme un poco más para ayudarte mejor?'
    }

    if (!texto) {
        texto = 'Gracias por escribirnos. ¿Podrías contarme un poco más para ayudarte mejor?'
    }

    // 7) Escalamiento automático si aplica
    const shouldEscalate = computeEscalation(userText, bc)
    if (shouldEscalate) {
        const saved = await persistBotReply({
            conversationId: chatId,
            empresaId,
            texto: 'Gracias por la información. Para darte una atención adecuada, te conectaré con un profesional humano en breve. 🙌',
            nuevoEstado: ConversationEstado.requiere_agente,
            to: toPhone ?? conversacion.phone,
            phoneNumberId,
        })
        return {
            estado: ConversationEstado.requiere_agente,
            mensaje: saved.texto,
            messageId: saved.messageId,
            wamid: saved.wamid,
            media: [],
        }
    }

    // 8) Persistir y responder
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
            model,
            messages,
            temperature,
            max_tokens: maxTokens,
        } as any)
        return resp1?.choices?.[0]?.message?.content?.trim() || ''
    } catch (err: any) {
        const msg = String(err?.response?.data || err?.message || '')
        if (process.env.DEBUG_AI === '1') console.error('[AGENT] first call error:', msg)

        // Detecta límite de créditos y reduce tokens
        const affordable = parseAffordableTokens(msg) // number | null
        let retryTokens = 96
        if (typeof affordable === 'number' && Number.isFinite(affordable)) {
            retryTokens = Math.max(16, Math.min(affordable - 3, 128))
        }
        if (process.env.DEBUG_AI === '1') console.log('[AGENT] retry with maxTokens =', retryTokens)

        const resp2 = await openai.chat.completions.create({
            model,
            messages,
            temperature,
            max_tokens: retryTokens,
        } as any)
        return resp2?.choices?.[0]?.message?.content?.trim() || ''
    }
}

function parseAffordableTokens(message: string): number | null {
    // Busca "can only afford 53" u otros textos similares
    const m = message.match(/afford\s+(\d+)/i) || message.match(/only\s+(\d+)\s+tokens?/i)
    if (m && m[1]) {
        const n = Number(m[1])
        return Number.isFinite(n) ? n : null
    }
    return null
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

function computeEscalation(
    text: string,
    bc?: Pick<BusinessConfig, 'escalarSiNoConfia' | 'escalarPalabrasClave' | 'escalarPorReintentos'> | null
) {
    if (!bc) return false
    const t = (text || '').toLowerCase()

    // Palabras clave
    if (bc.escalarPalabrasClave) {
        const tokens = bc.escalarPalabrasClave.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
        if (tokens.some(k => t.includes(k))) return true
    }

    // “No confía” (heurística simple)
    if (bc.escalarSiNoConfia) {
        const distrust = ['no confío', 'no confio', 'no me sirve', 'habla un humano', 'asesor humano', 'quiero hablar con alguien']
        if (distrust.some(k => t.includes(k))) return true
    }

    return false
}

async function persistBotReply({
    conversationId,
    empresaId,
    texto,
    nuevoEstado,
    to,
    phoneNumberId,
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
                empresaId,
                to: normalizeToE164(to),
                body: texto,
                phoneNumberIdHint: phoneNumberId,
            })
            wamid = (resp as any)?.data?.messages?.[0]?.id || (resp as any)?.messages?.[0]?.id
            if (wamid) {
                await prisma.message.update({
                    where: { id: msg.id },
                    data: { externalId: wamid },
                })
            }
        } catch { /* noop */ }
    }
    return { messageId: msg.id, texto, wamid }
}
