import { Request, Response } from 'express'
import prisma from '../lib/prisma'
import { shouldEscalateChat } from '../utils/shouldEscalate'
import { ConversationEstado, MessageFrom } from '@prisma/client'
import { openai } from '../lib/openai'
import { handleIAReply } from '../utils/handleIAReply'

export const getConversations = async (_req: Request, res: Response) => {
    try {
        const conversations = await prisma.conversation.findMany({
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
    const { id } = req.params
    const page = parseInt(req.query.page as string) || 1
    const limit = parseInt(req.query.limit as string) || 20
    const skip = (page - 1) * limit

    try {
        const total = await prisma.message.count({
            where: { conversationId: parseInt(id) }
        })

        const messages = await prisma.message.findMany({
            where: { conversationId: parseInt(id) },
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
    const { id } = req.params
    const { contenido } = req.body

    if (!contenido) {
        return res.status(400).json({ error: 'El mensaje no puede estar vacío' })
    }

    try {
        const message = await prisma.message.create({
            data: {
                conversationId: parseInt(id),
                from: MessageFrom.bot, // ← USANDO ENUM MessageFrom
                contenido,
                timestamp: new Date()
            }
        })

        // 🔁 Actualizar estado de la conversación a "respondido"
        await prisma.conversation.update({
            where: { id: parseInt(id) },
            data: { estado: ConversationEstado.respondido } // ← USANDO ENUM ConversationEstado
        })

        res.status(201).json(message)
    } catch (error) {
        console.error(error)
        res.status(500).json({ error: 'Error al guardar mensaje o actualizar estado' })
    }
}


export const responderConIA = async (req: Request, res: Response) => {
    const { chatId, mensaje, intentosFallidos = 0 } = req.body

    try {
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

        // Ya validamos que estado !== requiere_agente, entonces mensaje existe
        return res.json({ mensaje: result.mensaje })
    } catch (err) {
        console.error('Error al responder con IA:', err)
        return res.status(500).json({ error: 'Error al procesar respuesta de IA' })
    }
}

export const updateConversationEstado = async (req: Request, res: Response) => {
    const { id } = req.params
    const { estado } = req.body

    if (!estado || !Object.values(ConversationEstado).includes(estado)) {
        return res.status(400).json({ error: 'Estado inválido' })
    }

    try {
        const updated = await prisma.conversation.update({
            where: { id: parseInt(id) },
            data: { estado }
        })

        return res.json({ success: true, estado: updated.estado })
    } catch (err) {
        console.error('❌ Error actualizando estado:', err)
        return res.status(500).json({ error: 'Error actualizando estado de la conversación' })
    }
}

// PUT /api/chats/:id/cerrar
export const cerrarConversacion = async (req: Request, res: Response) => {
    const { id } = req.params

    try {
        const updated = await prisma.conversation.update({
            where: { id: Number(id) },
            data: { estado: 'cerrado' }
        })

        // Emitir evento WebSocket
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


// POST /api/chats/:id/responder-manual
export const responderManual = async (req: Request, res: Response) => {
    const { id } = req.params;
    const { contenido } = req.body;

    if (!contenido) {
        return res.status(400).json({ error: 'El contenido del mensaje es requerido' });
    }

    try {
        const message = await prisma.message.create({
            data: {
                conversationId: Number(id),
                from: MessageFrom.agent, // ✅ aquí el cambio
                contenido,
                timestamp: new Date(),
            },
        });

        await prisma.conversation.update({
            where: { id: Number(id) },
            data: { estado: 'requiere_agente' },
        });

        const io = req.app.get('io');
        io.emit('nuevo_mensaje', {
            conversationId: Number(id),
            from: 'agent',
            contenido,
            timestamp: new Date().toISOString(),
            estado: 'requiere_agente',
        });

        res.status(200).json({ success: true, message });
    } catch (err) {
        console.error('Error al guardar respuesta manual:', err);
        res.status(500).json({ error: 'Error al guardar el mensaje' });
    }
};
