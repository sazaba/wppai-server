import prisma from '../lib/prisma'
import { shouldEscalateChat } from './shouldEscalate'
import { openai } from '../lib/openai'
import { MessageFrom, ConversationEstado } from '@prisma/client'

type IAReplyResult = {
    estado: ConversationEstado
    mensaje?: string
    motivo?: 'confianza_baja' | 'palabra_clave' | 'reintentos'
}

function normalizarTexto(texto: string): string {
    return texto
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^\w\s]/gi, '')
        .replace(/\s+/g, ' ')
        .trim()
}

function esRespuestaInvalida(respuesta: string): boolean {
    const prohibidas = [
        'correo',
        'email',
        'teléfono',
        'llamar',
        'formulario',
        'lo siento',
        'según la información',
        'de acuerdo a la información',
        'de acuerdo a los datos',
        'según el sistema',
        'lo que tengo',
        'pondrá en contacto',
        'me contactará',
        'no puedo ayudarte',
        'no puedo procesar',
        'gracias por tu consulta',
        'uno de nuestros asesores'
    ]
    const normalizada = normalizarTexto(respuesta)
    return prohibidas.some(p => normalizada.includes(p))
}

function buildSystemPrompt(config: any, mensajeEscalamiento: string): string {
    return `Actúas como si fueras un asesor humano de la empresa ${config.nombre}. 
  
Tu función es responder preguntas que estén dentro de la siguiente información:

📌 Descripción: ${config.descripcion}
📌 Servicios/Productos: ${config.servicios}
📌 Preguntas frecuentes: ${config.faq}
📌 Horario de atención: ${config.horarios}

🗣️ Habla con un tono profesional, natural y directo, sin sonar como un asistente automatizado. 
Responde con frases normales, como si tú fueras parte del equipo humano. No empieces con frases como:

- "Según la información proporcionada"
- "De acuerdo a la información"
- "Según lo que tengo"
- "Según el sistema"
- "De acuerdo a los datos"
- "Lo que tengo registrado"

❌ Nunca digas que eres una IA. No te refieras al sistema, configuración, o información proporcionada.
❌ No uses expresiones como “lo siento”, “no puedo ayudarte”, “no tengo esa información”.
❌ No menciones correo, teléfono, contacto humano o enlaces si no están textualmente en los datos.
❌ No digas que un asesor se pondrá en contacto contigo.
❌ No inventes. Si no sabes, responde esto:

"${mensajeEscalamiento}"

✅ Sé claro y directo. Usa frases breves y naturales, como si fueras un humano escribiendo por WhatsApp.

Ejemplo:
❌ “Según la información proporcionada, atendemos de lunes a viernes...”
✅ “Atendemos de lunes a viernes de 8:00 a.m. a 5:00 p.m.”
`
}


export const handleIAReply = async (
    chatId: number,
    mensaje: string
): Promise<IAReplyResult | null> => {
    const config = await prisma.businessConfig.findFirst()
    if (!config) {
        console.warn('[handleIAReply] ⚠️ No se encontró configuración del negocio')
        return null
    }

    const conversacion = await prisma.conversation.findUnique({
        where: { id: chatId }
    })

    if (!conversacion || conversacion.estado === 'cerrado') {
        console.warn(`[handleIAReply] 🔒 La conversación ${chatId} está cerrada. No se procesará.`)
        return null
    }

    const mensajeEscalamiento = 'Gracias por tu mensaje. En breve uno de nuestros compañeros del equipo te contactará para ayudarte con más detalle.'

    const motivoInicial = shouldEscalateChat({
        mensaje,
        config,
        iaConfianzaBaja: false,
        intentosFallidos: 0
    })

    if (motivoInicial === 'palabra_clave') {
        console.log('📣 Escalado inmediato por palabra clave')

        await prisma.message.create({
            data: {
                conversationId: chatId,
                contenido: mensajeEscalamiento,
                from: MessageFrom.bot
            }
        })

        await prisma.conversation.update({
            where: { id: chatId },
            data: { estado: ConversationEstado.requiere_agente }
        })

        return {
            estado: ConversationEstado.requiere_agente,
            mensaje: mensajeEscalamiento,
            motivo: motivoInicial
        }
    }

    const mensajesPrevios = await prisma.message.findMany({
        where: { conversationId: chatId },
        orderBy: { timestamp: 'asc' },
        take: 10
    })

    const historial = mensajesPrevios.map((m) => ({
        role: m.from === 'client' ? 'user' : 'assistant',
        content: m.contenido
    }))

    const systemPrompt = buildSystemPrompt(config, mensajeEscalamiento)

    const iaResponse = await openai.chat.completions.create({
        model: 'anthropic/claude-3-haiku',
        messages: [
            { role: 'system', content: systemPrompt },
            ...historial,
            { role: 'user', content: mensaje }
        ],
        temperature: 0.4,
        max_tokens: 200
    } as any)

    const respuestaIA = iaResponse.choices[0].message?.content?.trim() ?? ''
    console.log('🧠 Respuesta generada por IA:', respuestaIA)

    const debeEscalar =
        respuestaIA === mensajeEscalamiento ||
        normalizarTexto(respuestaIA) === normalizarTexto(mensajeEscalamiento) ||
        esRespuestaInvalida(respuestaIA)

    if (debeEscalar) {
        console.log('📣 Escalado automático por respuesta inválida o fallback')

        await prisma.message.create({
            data: {
                conversationId: chatId,
                contenido: mensajeEscalamiento,
                from: MessageFrom.bot
            }
        })

        await prisma.conversation.update({
            where: { id: chatId },
            data: { estado: ConversationEstado.requiere_agente }
        })

        return {
            estado: ConversationEstado.requiere_agente,
            mensaje: mensajeEscalamiento,
            motivo: 'confianza_baja'
        }
    }

    const iaConfianzaBaja =
        respuestaIA.toLowerCase().includes('no estoy seguro') || respuestaIA.length < 15

    const motivoFinal = shouldEscalateChat({
        mensaje,
        config,
        iaConfianzaBaja,
        intentosFallidos: 0
    })

    if (motivoFinal && motivoFinal !== 'palabra_clave') {
        console.log(`📣 Escalado por motivo: ${motivoFinal}`)

        await prisma.message.create({
            data: {
                conversationId: chatId,
                contenido: mensajeEscalamiento,
                from: MessageFrom.bot
            }
        })

        await prisma.conversation.update({
            where: { id: chatId },
            data: { estado: ConversationEstado.requiere_agente }
        })

        return {
            estado: ConversationEstado.requiere_agente,
            mensaje: mensajeEscalamiento,
            motivo: motivoFinal
        }
    }

    await prisma.message.create({
        data: {
            conversationId: chatId,
            contenido: respuestaIA,
            from: MessageFrom.bot
        }
    })

    await prisma.conversation.update({
        where: { id: chatId },
        data: { estado: ConversationEstado.respondido }
    })

    return {
        estado: ConversationEstado.respondido,
        mensaje: respuestaIA
    }
}
