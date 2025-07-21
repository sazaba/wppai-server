// src/controllers/receive.controller.ts
import { Request, Response } from 'express'
import prisma from '../lib/prisma'
import { handleIAReply } from '../utils/handleIAReply'
import { MessageFrom, ConversationEstado } from '@prisma/client'
import { sendWhatsappMessage } from '../utils/sendWhatsappMessage'

export const receiveWhatsappMessage = async (req: Request, res: Response) => {
    try {
        const body = req.body

        const phoneNumberId = body?.entry?.[0]?.id // ← llega desde Meta
        const message = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]
        const from = message?.from
        const contenido = message?.text?.body || '[mensaje no soportado]'
        const timestamp = message?.timestamp
            ? new Date(parseInt(message.timestamp) * 1000).toISOString()
            : new Date().toISOString()

        if (!phoneNumberId || !from) {
            return res.status(200).json({ ignored: true })
        }

        // 🔎 Buscar la empresa a partir del número conectado
        const cuenta = await prisma.whatsappAccount.findUnique({
            where: { phoneNumberId }
        })

        if (!cuenta) {
            console.warn('⚠️ Mensaje recibido de número no vinculado:', phoneNumberId)
            return res.status(200).json({ ignored: true })
        }

        const empresaId = cuenta.empresaId

        // 🧠 Buscar o crear conversación asociada a ese número + empresa
        let conversation = await prisma.conversation.findFirst({
            where: { phone: from, empresaId }
        })

        if (!conversation) {
            conversation = await prisma.conversation.create({
                data: {
                    phone: from,
                    estado: 'pendiente',
                    empresaId
                }
            })
        } else if (conversation.estado === 'cerrado') {
            await prisma.conversation.update({
                where: { id: conversation.id },
                data: { estado: 'pendiente' }
            })
            conversation.estado = 'pendiente'
        }

        // 💬 Guardar el mensaje entrante
        await prisma.message.create({
            data: {
                conversationId: conversation.id,
                from: MessageFrom.client,
                contenido,
                timestamp
            }
        })

        // 🔁 Emitir evento WebSocket
        const io = req.app.get('io')
        io.emit('nuevo_mensaje', {
            conversationId: conversation.id,
            from: 'client',
            contenido,
            timestamp,
            phone: conversation.phone,
            nombre: conversation.nombre ?? conversation.phone,
            estado: conversation.estado
        })

        // 🤖 Generar respuesta con IA
        const result = await handleIAReply(conversation.id, contenido)

        if (result?.mensaje) {
            await sendWhatsappMessage(conversation.phone, result.mensaje)

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
        console.error('[receiveWhatsappMessage] Error:', error)
        res.status(500).json({ error: 'Error al recibir mensaje' })
    }
}


export const verifyWebhook = (req: Request, res: Response) => {
    const VERIFY_TOKEN = 'verificacion-supersecreta'

    const mode = req.query['hub.mode']
    const token = req.query['hub.verify_token']
    const challenge = req.query['hub.challenge']

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        console.log('🟢 Webhook verificado correctamente')
        res.status(200).send(challenge)
    } else {
        console.warn('🔴 Verificación fallida')
        res.sendStatus(403)
    }
}
