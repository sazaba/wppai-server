// src/utils/handleIAReply.ts
import axios from 'axios'
import prisma from '../lib/prisma'
import { shouldEscalateChat } from './shouldEscalate'
import { openai } from '../lib/openai'
import { ConversationEstado } from '@prisma/client'

type IAReplyResult = {
    estado: ConversationEstado
    mensaje?: string
    motivo?: 'confianza_baja' | 'palabra_clave' | 'reintentos'
}

/* ===== Config IA ===== */
// Nota: En OpenRouter el ID correcto es "google/gemini-2.0-flash-lite-001"
const RAW_MODEL = process.env.IA_MODEL || 'google/gemini-2.0-flash-lite-001'
const TEMPERATURE = Number(process.env.IA_TEMPERATURE ?? 0.3)
const MAX_COMPLETION_TOKENS = Number(process.env.IA_MAX_TOKENS ?? 350)

// OpenRouter
const OPENROUTER_BASE = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1'
const OPENROUTER_URL = `${OPENROUTER_BASE}/chat/completions`
const OPENROUTER_API_KEY =
    process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY || '' // compat

/** Normaliza IDs comunes (alias → ID válido de OpenRouter) */
function normalizeModelId(model: string): string {
    const m = model.trim()
    if (m === 'google/gemini-2.0-flash-lite') return 'google/gemini-2.0-flash-lite-001' // fix
    // puedes añadir más alias aquí si hace falta
    return m
}

/** Si el modelo parece de OpenRouter (tiene proveedor/modelo con `/`) */
function isOpenRouterModel(model: string): boolean {
    return model.includes('/')
}

/** Fallback económico si el ID no existe o viene vacío */
function fallbackModel(): string {
    // Económicos y muy disponibles en OR; ajusta a tu preferencia:
    // - Gemini 2.0 Flash Lite (001) (Google)
    // - openai/gpt-4o-mini (OpenAI vía OR)
    return 'google/gemini-2.0-flash-lite-001'
}

/** Llama OpenRouter o OpenAI según el modelo */
async function chatComplete({
    model,
    messages,
    temperature,
    maxTokens
}: {
    model: string
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
    temperature: number
    maxTokens: number
}): Promise<string> {
    const normalized = normalizeModelId(model) || fallbackModel()

    // RUTA OPENROUTER (IDs con proveedor, p.ej. "google/gemini-2.0-flash-lite-001")
    if (isOpenRouterModel(normalized)) {
        if (!OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY no configurada')

        const payload = {
            model: normalized,
            messages,
            temperature,
            // compat entre proveedores:
            max_tokens: maxTokens,
            max_output_tokens: maxTokens
        }

        const { data } = await axios.post(OPENROUTER_URL, payload, {
            headers: {
                Authorization: `Bearer ${OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': process.env.OPENROUTER_REFERRER || 'http://localhost:3000',
                'X-Title': process.env.OPENROUTER_APP_NAME || 'WPP AI SaaS',
            },
            timeout: Number(process.env.IA_HTTP_TIMEOUT_MS || 45000),
        })

        const content = data?.choices?.[0]?.message?.content
        return typeof content === 'string'
            ? content
            : Array.isArray(content)
                ? content.map((c: any) => c?.text || '').join(' ')
                : ''
    }

    // RUTA OPENAI (tu cliente ../lib/openai) — por si usas modelos tipo "gpt-4o-mini"
    const resp = await openai.chat.completions.create({
        model: normalized,
        messages,
        temperature,
        // compat v4
        max_completion_tokens: maxTokens as any,
        // @ts-ignore
        max_tokens: maxTokens,
    } as any)

    return resp?.choices?.[0]?.message?.content ?? ''
}

/* ========================= Helpers ========================= */

function normalizarTexto(texto: string): string {
    return (texto || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\w\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
}

const FRASES_PROHIBIDAS = [
    'correo', 'email', 'telefono', 'llamar', 'formulario', 'lo siento',
    'segun la informacion', 'de acuerdo a la informacion', 'de acuerdo a los datos',
    'segun el sistema', 'lo que tengo', 'pondra en contacto', 'me contactara',
    'no puedo ayudarte', 'no puedo procesar', 'gracias por tu consulta', 'uno de nuestros asesores',
    'soy una ia', 'soy un asistente', 'modelo de lenguaje', 'inteligencia artificial'
].map(normalizarTexto)

function esRespuestaInvalida(respuesta: string): boolean {
    const r = normalizarTexto(respuesta)
    const tieneEmail = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/.test(respuesta)
    const tieneLink = /https?:\/\/|www\./i.test(respuesta)
    const tieneTel = /\+?\d[\d\s().-]{6,}/.test(respuesta)
    const contiene = FRASES_PROHIBIDAS.some(p => r.includes(p))
    return tieneEmail || tieneLink || tieneTel || contiene
}

function buildSystemPrompt(config: any, mensajeEscalamiento: string): string {
    return `Actúas como un asesor humano de la empresa ${config.nombre}.

Responde SOLO con base en:
- Descripción: ${config.descripcion}
- Servicios/Productos: ${config.servicios}
- Preguntas frecuentes: ${config.faq}
- Horario de atención: ${config.horarios}

Tono: profesional, natural y directo, mensajes cortos para WhatsApp.
No digas que eres IA, ni menciones "según la información", "de acuerdo a los datos", etc.
No inventes; si no sabes, responde EXACTAMENTE:
"${mensajeEscalamiento}"

Formato: una respuesta breve y clara (sin listas salvo que el usuario lo pida).`
}

/* ========================= Core ========================= */

export const handleIAReply = async (
    chatId: number,
    mensaje: string
): Promise<IAReplyResult | null> => {
    // 0) Conversación y empresa
    const conversacion = await prisma.conversation.findUnique({
        where: { id: chatId },
        select: { id: true, estado: true, empresaId: true },
    })
    if (!conversacion || conversacion.estado === 'cerrado') {
        console.warn(`[handleIAReply] 🔒 La conversación ${chatId} está cerrada. No se procesará.`)
        return null
    }

    // 1) Config del negocio (multiempresa)
    const config = await prisma.businessConfig.findFirst({
        where: { empresaId: conversacion.empresaId },
        orderBy: { updatedAt: 'desc' },
    })
    const mensajeEscalamiento =
        'Gracias por tu mensaje. En breve uno de nuestros compañeros del equipo te contactará para ayudarte con más detalle.'

    if (!config) {
        console.warn('[handleIAReply] ⚠️ No se encontró configuración del negocio para esta empresa')
        return {
            estado: ConversationEstado.requiere_agente,
            mensaje: mensajeEscalamiento,
            motivo: 'confianza_baja',
        }
    }

    // 2) Reglas previas de escalado (palabras clave)
    const motivoInicial = shouldEscalateChat({
        mensaje,
        config,
        iaConfianzaBaja: false,
        intentosFallidos: 0,
    })
    if (motivoInicial === 'palabra_clave') {
        return { estado: ConversationEstado.requiere_agente, mensaje: mensajeEscalamiento, motivo: motivoInicial }
    }

    // 3) Historial (últimos 12 mensajes)
    const mensajesPrevios = await prisma.message.findMany({
        where: { conversationId: chatId },
        orderBy: { timestamp: 'asc' },
        take: 12,
        select: { from: true, contenido: true },
    })
    const historial = mensajesPrevios
        .filter(m => (m.contenido || '').trim().length > 0)
        .map(m => ({ role: m.from === 'client' ? 'user' : 'assistant', content: m.contenido } as const))

    const systemPrompt = buildSystemPrompt(config, mensajeEscalamiento)

    // 4) Llamada al modelo (OpenRouter/OpenAI según ID)
    let respuestaIA = ''
    try {
        respuestaIA = (await chatComplete({
            model: RAW_MODEL,
            messages: [
                { role: 'system', content: systemPrompt },
                ...historial,
                { role: 'user', content: mensaje },
            ],
            temperature: TEMPERATURE,
            maxTokens: MAX_COMPLETION_TOKENS,
        }))?.trim()
    } catch (e: any) {
        console.error('[IA] error:', e?.message || e)
        // Fallback de emergencia con un modelo económico en OR
        try {
            respuestaIA = (await chatComplete({
                model: fallbackModel(),
                messages: [
                    { role: 'system', content: systemPrompt },
                    ...historial,
                    { role: 'user', content: mensaje },
                ],
                temperature: TEMPERATURE,
                maxTokens: MAX_COMPLETION_TOKENS,
            }))?.trim()
        } catch (e2: any) {
            console.error('[IA] fallback error:', e2?.message || e2)
            // No bloquear el flujo
            return {
                estado: ConversationEstado.en_proceso,
                mensaje: 'Gracias por tu mensaje. ¿Podrías darme un poco más de contexto?',
            }
        }
    }

    console.log('🧠 Respuesta generada por IA:', respuestaIA)

    // 5) Validaciones de contenido → escalado
    const debeEscalar =
        respuestaIA === mensajeEscalamiento ||
        normalizarTexto(respuestaIA) === normalizarTexto(mensajeEscalamiento) ||
        esRespuestaInvalida(respuestaIA)

    if (debeEscalar) {
        return { estado: ConversationEstado.requiere_agente, mensaje: mensajeEscalamiento, motivo: 'confianza_baja' }
    }

    // 6) Reglas finales (longitud/seguridad)
    const iaConfianzaBaja =
        respuestaIA.length < 15 ||
        /no estoy seguro|no tengo certeza|no cuento con esa info/i.test(respuestaIA)

    const motivoFinal = shouldEscalateChat({
        mensaje,
        config,
        iaConfianzaBaja,
        intentosFallidos: 0,
    })

    if (motivoFinal && motivoFinal !== 'palabra_clave') {
        return { estado: ConversationEstado.requiere_agente, mensaje: mensajeEscalamiento, motivo: motivoFinal }
    }

    // 7) Respuesta final OK
    return { estado: ConversationEstado.respondido, mensaje: respuestaIA }
}
