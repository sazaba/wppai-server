import { Request, Response } from 'express'
import prisma from '../lib/prisma'
import { shouldEscalateChat } from '../utils/shouldEscalate'
import { ConversationEstado, MessageFrom } from '@prisma/client'
import { openai } from '../lib/openai'
import { handleIAReply } from '../utils/handleIAReply'
import { sendWhatsappMessage } from '../utils/sendWhatsappMessage'

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
        const conv = await prisma.conversation.findUnique({
            where: { id: Number(id) }
        })

        if (!conv || conv.empresaId !== empresaId) {
            return res.status(403).json({ error: 'No autorizado para ver esta conversación' })
        }

        const total = await prisma.message.count({
            where: { conversationId: conv.id }
        })

        const messages = await prisma.message.findMany({
            where: { conversationId: conv.id },
            orderBy: { timestamp: 'asc' },
            skip,
            take: limit
        })

        res.json({
            messages,
            pagination: {
                total,
                page,
                limit,
                hasMore: skip + limit < total
            }
        })
    } catch (err) {
        console.error(err)
        res.status(500).json({ error: 'Error al obtener mensajes' })
    }
}

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

        const message = await prisma.message.create({
            data: {
                conversationId: conv.id,
                from: MessageFrom.bot,
                contenido,
                timestamp: new Date()
            }
        })

        await prisma.conversation.update({
            where: { id: conv.id },
            data: { estado: ConversationEstado.respondido }
        })

        res.status(201).json(message)
    } catch (error) {
        console.error(error)
        res.status(500).json({ error: 'Error al guardar mensaje o actualizar estado' })
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

        if (!result) {
            return res.status(400).json({ error: 'No se pudo generar respuesta con IA' })
        }

        if (result.estado === ConversationEstado.requiere_agente) {
            return res.json({
                estado: ConversationEstado.requiere_agente,
                mensaje: 'Chat marcado como requiere atención humana'
            })
        }

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
        io.emit('chat_actualizado', {
            id: updated.id,
            estado: updated.estado
        })

        res.status(200).json({ success: true })
    } catch (err) {
        console.error('Error al cerrar conversación:', err)
        res.status(500).json({ error: 'No se pudo cerrar la conversación' })
    }
}

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

        // 1. Guardar mensaje en base de datos
        const message = await prisma.message.create({
            data: {
                conversationId: conv.id,
                from: MessageFrom.agent,
                contenido,
                timestamp: new Date(),
            },
        })

        // 2. Actualizar estado de la conversación
        await prisma.conversation.update({
            where: { id: conv.id },
            data: { estado: 'requiere_agente' },
        })

        // 3. Enviar mensaje real por WhatsApp
        await sendWhatsappMessage(conv.phone, contenido)

        // 4. Emitir evento a frontend
        const io = req.app.get('io')
        io.emit('nuevo_mensaje', {
            conversationId: conv.id,
            from: 'agent',
            contenido,
            timestamp: new Date().toISOString(),
            estado: 'requiere_agente',
        })

        res.status(200).json({ success: true, message })
    } catch (err) {
        console.error('Error al guardar respuesta manual:', err)
        res.status(500).json({ error: 'Error al guardar el mensaje' })
    }
}


// POST /api/chats
export const crearConversacion = async (req: Request, res: Response) => {
    const { phone, nombre } = req.body
    const empresaId = req.user?.empresaId

    if (!empresaId) {
        return res.status(401).json({ error: 'No autorizado' })
    }

    if (!phone) {
        return res.status(400).json({ error: 'El número de teléfono es obligatorio' })
    }

    try {
        const nueva = await prisma.conversation.create({
            data: {
                phone,
                nombre,
                estado: 'pendiente',
                empresaId, // ahora está garantizado como `number`
            }
        })

        return res.status(201).json({ message: 'Conversación creada', chat: nueva })
    } catch (err) {
        console.error('Error al crear conversación:', err)
        return res.status(500).json({ error: 'Error al crear la conversación' })
    }
}
