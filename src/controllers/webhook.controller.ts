import { Request, Response } from 'express'
import prisma from '../lib/prisma'
import { handleIAReply } from '../utils/handleIAReply'
import { MessageFrom, ConversationEstado } from '@prisma/client'

export const receiveWhatsappMessage = async (req: Request, res: Response) => {
    try {
        const { from, message } = req.body

        const timestamp = req.body.timestamp
            ? new Date(req.body.timestamp).toISOString()
            : new Date().toISOString()

        let conversation = await prisma.conversation.findFirst({ where: { phone: from } })

        if (!conversation) {
            conversation = await prisma.conversation.create({
                data: {
                    phone: from,
                    estado: 'pendiente'
                }
            })
        } else if (conversation.estado === 'cerrado') {
            // 🟢 Reabrir si estaba cerrada
            await prisma.conversation.update({
                where: { id: conversation.id },
                data: { estado: 'pendiente' }
            })
            conversation.estado = 'pendiente'
        }

        // 📨 Guardar el mensaje del cliente
        await prisma.message.create({
            data: {
                conversationId: conversation.id,
                from: MessageFrom.client,
                contenido: message,
                timestamp
            }
        })

        const io = req.app.get('io')

        // 📡 Emitir mensaje del cliente
        io.emit('nuevo_mensaje', {
            conversationId: conversation.id,
            from: 'client',
            contenido: message,
            timestamp,
            phone: conversation.phone,
            nombre: conversation.nombre ?? conversation.phone,
            estado: conversation.estado
        })

        // 🤖 Procesar con IA
        const result = await handleIAReply(conversation.id, message)

        // 📡 Emitir respuesta de la IA si existe
        if (result?.mensaje) {
            io.emit('nuevo_mensaje', {
                conversationId: conversation.id,
                from: 'bot',
                contenido: result.mensaje,
                timestamp: new Date().toISOString(),
                estado: result.estado
            })
        }

        res.status(200).json({ success: true })
    } catch (error) {
        console.error(error)
        res.status(500).json({ error: 'Error al recibir mensaje' })
    }
}
