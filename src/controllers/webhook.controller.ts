// src/controllers/receive.controller.ts
import { Request, Response } from 'express'
import prisma from '../lib/prisma'
import { handleIAReply } from '../utils/handleIAReply'
import { MessageFrom, ConversationEstado } from '@prisma/client'
import { sendWhatsappMessage } from '../utils/sendWhatsappMessage'

export const receiveWhatsappMessage = async (req: Request, res: Response) => {
    console.log('📩 Webhook recibido:', JSON.stringify(req.body, null, 2))

    try {
        const change = req.body?.entry?.[0]?.changes?.[0]
        const value = change?.value
        const message = value?.messages?.[0]

        if (!value?.metadata?.phone_number_id || !message) {
            console.warn('❌ Faltan datos esenciales en el mensaje entrante.')
            return res.status(200).json({ ignored: true })
        }

        const phoneNumberId = value.metadata.phone_number_id
        const from = message.from
        const contenido = message.text?.body || '[mensaje no soportado]'
        const timestamp = message.timestamp
            ? new Date(parseInt(message.timestamp) * 1000).toISOString()
            : new Date().toISOString()

        const cuenta = await prisma.whatsappAccount.findUnique({
            where: { phoneNumberId },
            include: { empresa: true }
        })

        if (!cuenta || cuenta.empresa.estado !== 'activo') {
            console.warn(`⚠️ Empresa inactiva o no encontrada para el número: ${phoneNumberId}`)
            return res.status(200).json({ ignored: true })
        }

        const empresaId = cuenta.empresaId

        let conversation = await prisma.conversation.findFirst({
            where: { phone: from, empresaId }
        })

        if (!conversation) {
            conversation = await prisma.conversation.create({
                data: { phone: from, estado: 'pendiente', empresaId }
            })
        } else if (conversation.estado === 'cerrado') {
            await prisma.conversation.update({
                where: { id: conversation.id },
                data: { estado: 'pendiente' }
            })
            conversation.estado = 'pendiente'
        }

        await prisma.message.create({
            data: {
                conversationId: conversation.id,
                from: MessageFrom.client,
                contenido,
                timestamp
            }
        })

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
