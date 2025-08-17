import prisma from '../lib/prisma'
import { shouldEscalateChat } from './shouldEscalate'
import { openai } from '../lib/openai'
import { ConversationEstado } from '@prisma/client'

type IAReplyResult = {
    estado: ConversationEstado
    mensaje?: string
    motivo?: 'confianza_baja' | 'palabra_clave' | 'reintentos'
}

/* ===== Config IA (OpenRouter) ===== */
const MODEL = process.env.IA_MODEL || 'google/gemini-2.0-flash-lite'
const TEMPERATURE = 0.3
const MAX_COMPLETION_TOKENS = 350 // respuestas cortas (WhatsApp)

/* ========================= Helpers ========================= */

function normalizarTexto(texto: string): string {
    return (texto || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') // quita tildes
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

    // 1) Config del negocio por empresa (multiempresa)
    const config = await prisma.businessConfig.findFirst({
        where: { empresaId: conversacion.empresaId },
        orderBy: { updatedAt: 'desc' },
    })
    if (!config) {
        console.warn('[handleIAReply] ⚠️ No se encontró configuración del negocio para esta empresa')
        return {
            estado: ConversationEstado.requiere_agente,
            mensaje: 'Gracias por tu mensaje. En breve uno de nuestros compañeros del equipo te contactará para ayudarte con más detalle.',
            motivo: 'confianza_baja',
        }
    }

    const mensajeEscalamiento =
        'Gracias por tu mensaje. En breve uno de nuestros compañeros del equipo te contactará para ayudarte con más detalle.'

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
        .map(m => ({ role: m.from === 'client' ? 'user' : 'assistant', content: m.contenido }))

    const systemPrompt = buildSystemPrompt(config, mensajeEscalamiento)

    // 4) Llamada al modelo (OpenRouter)
    const iaResponse = await openai.chat.completions.create({
        model: MODEL,
        messages: [
            { role: 'system', content: systemPrompt },
            ...historial,
            { role: 'user', content: mensaje },
        ],
        temperature: TEMPERATURE,
        // compatibilidad SDK v4
        max_completion_tokens: MAX_COMPLETION_TOKENS as any,
        // @ts-ignore
        max_tokens: MAX_COMPLETION_TOKENS,
    } as any)

    const respuestaIA = iaResponse?.choices?.[0]?.message?.content?.trim() ?? ''
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
