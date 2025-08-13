import { Request, Response } from 'express'
import prisma from '../lib/prisma'
import { shouldEscalateChat } from '../utils/shouldEscalate'
import { ConversationEstado, MessageFrom } from '@prisma/client'
import { openai } from '../lib/openai'
import { handleIAReply } from '../utils/handleIAReply'
import { sendOutboundMessage } from '../services/whatsapp.services'  // <<<< ADD

export const getConversations = async (req: Request, res: Response) => {
    const empresaId = req.user?.empresaId

    try {
        const conversations = await prisma.conversation.findMany({
            where: { empresaId },
            orderBy: { createdAt: 'desc' },
            include: {
                mensajes: {
                    orderBy: { timestamp: 'desc' },
                    take: 1,
                },
            },
        })

        const formatted = conversations.map((c) => ({
            id: c.id,
            nombre: c.nombre ?? c.phone,
            mensaje: c.mensajes[0]?.contenido ?? '',
            estado: c.estado,
            fecha: c.mensajes[0]?.timestamp?.toISOString() ?? '',
        }))

        res.json(formatted)
    } catch (err) {
        console.error(err)
        res.status(500).json({ error: 'Error al obtener conversaciones' })
    }
}

export const getMessagesByConversation = async (req: Request, res: Response) => {
    const empresaId = req.user?.empresaId
    const { id } = req.params
    const page = parseInt(req.query.page as string) || 1
    const limit = parseInt(req.query.limit as string) || 20
    const skip = (page - 1) * limit

    try {
        const conv = await prisma.conversation.findUnique({ where: { id: Number(id) } })
        if (!conv || conv.empresaId !== empresaId) {
            return res.status(403).json({ error: 'No autorizado para ver esta conversación' })
        }

        const total = await prisma.message.count({ where: { conversationId: conv.id } })
        const messages = await prisma.message.findMany({
            where: { conversationId: conv.id },
            orderBy: { timestamp: 'asc' },
            skip, take: limit
        })

        res.json({
            messages,
            pagination: {
                total, page, limit,
                hasMore: skip + limit < total
            }
        })
    } catch (err) {
        console.error(err)
        res.status(500).json({ error: 'Error al obtener mensajes' })
    }
}

/**
 * ✅ NUEVO: responder texto si <=24h; si >24h usa plantilla fallback automáticamente.
 *    Endpoint sugerido: POST /api/chats/:id/responder
 *    Body: { contenido: string }
 */
export const postMessageToConversation = async (req: Request, res: Response) => {
    const empresaId = req.user?.empresaId
    const { id } = req.params
    const { contenido } = req.body

    if (!contenido) {
        return res.status(400).json({ error: 'El mensaje no puede estar vacío' })
    }

    try {
        const conv = await prisma.conversation.findUnique({ where: { id: Number(id) } })
        if (!conv || conv.empresaId !== empresaId) {
            return res.status(403).json({ error: 'No autorizado para responder esta conversación' })
        }

        // Envío real (24h vs plantilla). Usa SIEMPRE la cuenta OAuth de la empresa:
        await sendOutboundMessage({
            conversationId: conv.id,
            empresaId: conv.empresaId,
            to: conv.phone,          // tu campo destino
            body: contenido          // si está dentro de 24h, saldrá como texto
        })

        // Guardar mensaje (saliente del agente/bot manual):
        const message = await prisma.message.create({
            data: {
                conversationId: conv.id,
                from: MessageFrom.agent,     // si usas "bot" para IA, aquí "agent" está bien
                contenido,
                timestamp: new Date()
            }
        })

        await prisma.conversation.update({
            where: { id: conv.id },
            data: { estado: ConversationEstado.respondido } // o 'en_proceso' si prefieres
        })

        // Emitir evento opcional:
        const io = req.app.get('io')
        io?.emit?.('nuevo_mensaje', {
            conversationId: conv.id,
            from: 'agent',
            contenido,
            timestamp: new Date().toISOString(),
            estado: ConversationEstado.respondido,
        })

        res.status(201).json(message)
    } catch (error: any) {
        console.error(error?.response?.data || error)
        res.status(500).json({ error: 'Error al enviar o guardar el mensaje' })
    }
}

export const responderConIA = async (req: Request, res: Response) => {
    const { chatId, mensaje, intentosFallidos = 0 } = req.body
    const empresaId = req.user?.empresaId

    try {
        const conv = await prisma.conversation.findUnique({ where: { id: Number(chatId) } })
        if (!conv || conv.empresaId !== empresaId) {
            return res.status(403).json({ error: 'No autorizado para responder esta conversación' })
        }

        const result = await handleIAReply(chatId, mensaje)
        if (!result) return res.status(400).json({ error: 'No se pudo generar respuesta con IA' })

        if (result.estado === ConversationEstado.requiere_agente) {
            return res.json({
                estado: ConversationEstado.requiere_agente,
                mensaje: 'Chat marcado como requiere atención humana'
            })
        }

        // Si decides que la IA también envíe por WhatsApp:
        // await sendOutboundMessage({ conversationId: conv.id, empresaId: conv.empresaId, to: conv.phone, body: result.mensaje })

        return res.json({ mensaje: result.mensaje })
    } catch (err) {
        console.error('Error al responder con IA:', err)
        return res.status(500).json({ error: 'Error al procesar respuesta de IA' })
    }
}

export const updateConversationEstado = async (req: Request, res: Response) => {
    const { id } = req.params
    const { estado } = req.body
    const empresaId = req.user?.empresaId

    if (!estado || !Object.values(ConversationEstado).includes(estado)) {
        return res.status(400).json({ error: 'Estado inválido' })
    }

    try {
        const conv = await prisma.conversation.findUnique({ where: { id: Number(id) } })
        if (!conv || conv.empresaId !== empresaId) {
            return res.status(403).json({ error: 'No autorizado para modificar esta conversación' })
        }

        const updated = await prisma.conversation.update({
            where: { id: conv.id },
            data: { estado }
        })

        return res.json({ success: true, estado: updated.estado })
    } catch (err) {
        console.error('❌ Error actualizando estado:', err)
        return res.status(500).json({ error: 'Error actualizando estado de la conversación' })
    }
}

export const cerrarConversacion = async (req: Request, res: Response) => {
    const { id } = req.params
    const empresaId = req.user?.empresaId

    try {
        const conv = await prisma.conversation.findUnique({ where: { id: Number(id) } })
        if (!conv || conv.empresaId !== empresaId) {
            return res.status(403).json({ error: 'No autorizado para cerrar esta conversación' })
        }

        const updated = await prisma.conversation.update({
            where: { id: conv.id },
            data: { estado: 'cerrado' }
        })

        const io = req.app.get('io')
        io.emit('chat_actualizado', { id: updated.id, estado: updated.estado })

        res.status(200).json({ success: true })
    } catch (err) {
        console.error('Error al cerrar conversación:', err)
        res.status(500).json({ error: 'No se pudo cerrar la conversación' })
    }
}

/**
 * 🧑‍💻 Respuesta manual (UI del agente) — ahora sin sandbox:
 *   - Envia por Graph (24h vs plantilla fallback).
 *   - Persiste tu mensaje como "agent".
 *   - Mantengo tu estado "requiere_agente" si así lo deseas (puedes cambiar a "respondido").
 */
export const responderManual = async (req: Request, res: Response) => {
    const { id } = req.params
    const { contenido } = req.body
    const empresaId = req.user?.empresaId

    if (!contenido) {
        return res.status(400).json({ error: 'El contenido del mensaje es requerido' })
    }

    try {
        const conv = await prisma.conversation.findUnique({ where: { id: Number(id) } })
        if (!conv || conv.empresaId !== empresaId) {
            return res.status(403).json({ error: 'No autorizado para responder esta conversación' })
        }

        // Envío real (24h vs plantilla):
        await sendOutboundMessage({
            conversationId: conv.id,
            empresaId: conv.empresaId,
            to: conv.phone,
            body: contenido
        })

        // Guardar mensaje
        const message = await prisma.message.create({
            data: {
                conversationId: conv.id,
                from: MessageFrom.agent,
                contenido,
                timestamp: new Date(),
            },
        })

        // Estado: si prefieres, cambia a respondido
        await prisma.conversation.update({
            where: { id: conv.id },
            data: { estado: 'requiere_agente' },
        })

        const io = req.app.get('io')
        io.emit('nuevo_mensaje', {
            conversationId: conv.id,
            from: 'agent',
            contenido,
            timestamp: new Date().toISOString(),
            estado: 'requiere_agente',
        })

        res.status(200).json({ success: true, message })
    } catch (err: any) {
        console.error('Error al guardar respuesta manual:', err?.response?.data || err.message)
        res.status(500).json({ error: 'Error al guardar el mensaje' })
    }
}

// POST /api/chats
export const crearConversacion = async (req: Request, res: Response) => {
    const { phone, nombre } = req.body
    const empresaId = req.user?.empresaId

    if (!empresaId) return res.status(401).json({ error: 'No autorizado' })
    if (!phone) return res.status(400).json({ error: 'El número de teléfono es obligatorio' })

    try {
        const nueva = await prisma.conversation.create({
            data: { phone, nombre, estado: 'pendiente', empresaId }
        })
        return res.status(201).json({ message: 'Conversación creada', chat: nueva })
    } catch (err) {
        console.error('Error al crear conversación:', err)
        return res.status(500).json({ error: 'Error al crear la conversación' })
    }
}

/**
 * ✅ NUEVO endpoint: forzar inicio/reapertura con PLANTILLA
 *    POST /api/chats/iniciar
 *    Body: { empresaId, to, templateName?, templateLang?, variables?, conversationId? }
 */
export const iniciarChat = async (req: Request, res: Response) => {
    try {
        const { conversationId, empresaId, to, templateName, templateLang, variables } = req.body as {
            conversationId?: number
            empresaId: number
            to: string
            templateName?: string
            templateLang?: string
            variables?: string[]
        }

        let convId = conversationId
        if (!convId) {
            const conv = await prisma.conversation.create({
                data: { empresaId, phone: to, estado: 'pendiente' }
            })
            convId = conv.id
        }

        const result = await sendOutboundMessage({
            conversationId: convId!,
            empresaId,
            to,
            forceTemplate: (templateName && templateLang) ? { name: templateName, lang: templateLang, variables } : undefined
        })

        return res.json({ ok: true, conversationId: convId, result })
    } catch (err: any) {
        console.error('[iniciarChat] Error:', err?.response?.data || err.message)
        return res.status(500).json({ error: 'Error enviando plantilla', detail: err?.response?.data || err.message })
    }
}
