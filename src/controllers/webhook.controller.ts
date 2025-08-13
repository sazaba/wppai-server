// src/controllers/receive.controller.ts
import { Request, Response } from 'express'
import prisma from '../lib/prisma'
import { handleIAReply } from '../utils/handleIAReply'
import { MessageFrom, ConversationEstado } from '@prisma/client'
// ⛔️ Quitar sandbox:
// import { sendWhatsappMessage } from '../utils/sendWhatsappMessage'
// ✅ Usar service real (respeta 24h y plantillas por empresa):
import { sendOutboundMessage, sendTemplate } from '../services/whatsapp.services'

export const receiveWhatsappMessage = async (req: Request, res: Response) => {
    console.log('📩 Webhook recibido:', JSON.stringify(req.body, null, 2))

    try {
        const entry = req.body?.entry?.[0]
        const change = entry?.changes?.[0]
        const value = change?.value

        // ✅ 1) Manejar "statuses" (fallos por 24h → auto-fallback con plantilla)
        if (value?.statuses && Array.isArray(value.statuses) && value.statuses.length) {
            const phoneNumberId = value?.metadata?.phone_number_id
            if (!phoneNumberId) {
                console.warn('⚠️ status sin phone_number_id; se ignora.')
                return res.status(200).json({ ignored: true })
            }

            const cuenta = await prisma.whatsappAccount.findUnique({ where: { phoneNumberId } })
            const empresaId = cuenta?.empresaId

            for (const st of value.statuses) {
                // Solo nos importan fallos
                if (st.status !== 'failed') continue
                const errCodes = (st.errors || []).map((e: any) => e.code)
                const is24hClosed = errCodes.includes(131047) || errCodes.includes(470)

                if (is24hClosed && empresaId) {
                    const to = st.recipient_id // wa_id del cliente
                    // Buscar conversación de esa empresa y ese destino
                    const conv = await prisma.conversation.findFirst({
                        where: { empresaId, phone: to }
                    })
                    if (!conv) {
                        console.warn(`[statuses][${to}] sin conversación asociada; no se hace fallback.`)
                        continue
                    }

                    // Leer fallback por empresa
                    const oc = await prisma.outboundConfig.findUnique({ where: { empresaId } })
                    const templateName = oc?.fallbackTemplateName ?? 'hola'
                    const templateLang = oc?.fallbackTemplateLang ?? 'es'

                    try {
                        // ✅ Reintento automático con plantilla fallback
                        await sendTemplate({
                            empresaId,
                            to,
                            templateName,
                            templateLang,
                            variables: []
                        })

                        // Persistir un rastro del fallback (opcional)
                        await prisma.message.create({
                            data: {
                                conversationId: conv.id,
                                from: MessageFrom.bot,
                                contenido: `[auto-fallback ${templateName}/${templateLang}]`,
                                timestamp: new Date()
                            }
                        })

                        // Notificar al frontend
                        const io = req.app.get('io')
                        io?.emit?.('nuevo_mensaje', {
                            conversationId: conv.id,
                            from: 'bot',
                            contenido: `[auto-fallback ${templateName}/${templateLang}]`,
                            timestamp: new Date().toISOString(),
                            estado: conv.estado
                        })

                        console.log(`[fallback] Enviada plantilla ${templateName}/${templateLang} a ${to}`)
                    } catch (e: any) {
                        console.error('[fallback] Error enviando plantilla:', e?.response?.data || e.message)
                    }
                }
            }

            // No es un entrante del usuario; ya procesamos statuses
            return res.status(200).json({ handled: 'statuses' })
        }

        // ✅ 2) Solo continuar si hay "messages" (entrantes reales)
        if (!value?.messages || !value?.messages[0]) {
            console.log('ℹ️ Evento sin message (probablemente status ya manejado). Ignorado.')
            return res.status(200).json({ ignored: true })
        }

        const msg = value.messages[0]
        const phoneNumberId = value?.metadata?.phone_number_id
        const from = msg.from
        const contenido = msg.text?.body || msg.button?.text || msg.interactive?.list_reply?.title || '[mensaje no soportado]'
        const ts = msg.timestamp ? new Date(parseInt(msg.timestamp, 10) * 1000) : new Date()

        if (!phoneNumberId || !from) {
            console.warn('❌ Faltan datos esenciales en el mensaje entrante.')
            return res.status(200).json({ ignored: true })
        }

        // Cuenta y empresa
        const cuenta = await prisma.whatsappAccount.findUnique({
            where: { phoneNumberId },
            include: { empresa: true }
        })
        if (!cuenta || cuenta.empresa.estado !== 'activo') {
            console.warn(`⚠️ Empresa inactiva o no encontrada para el número: ${phoneNumberId}`)
            return res.status(200).json({ ignored: true })
        }
        const empresaId = cuenta.empresaId

        // Conversación por empresa + wa_id del cliente
        let conversation = await prisma.conversation.findFirst({
            where: { phone: from, empresaId }
        })

        if (!conversation) {
            conversation = await prisma.conversation.create({
                data: { phone: from, estado: ConversationEstado.pendiente, empresaId }
            })
        } else if (conversation.estado === ConversationEstado.cerrado) {
            await prisma.conversation.update({
                where: { id: conversation.id },
                data: { estado: ConversationEstado.pendiente }
            })
            conversation.estado = ConversationEstado.pendiente
        }

        // Guardar ENTRANTE real (cliente)
        await prisma.message.create({
            data: {
                conversationId: conversation.id,
                from: MessageFrom.client,
                contenido,
                timestamp: ts
            }
        })

        // Emitir a frontend
        const io = req.app.get('io')
        io?.emit?.('nuevo_mensaje', {
            conversationId: conversation.id,
            from: 'client',
            contenido,
            timestamp: ts.toISOString(),
            phone: conversation.phone,
            nombre: conversation.nombre ?? conversation.phone,
            estado: conversation.estado
        })

        // IA responde (opcional). Si quieres que la IA también ENVÍE por WA:
        const result = await handleIAReply(conversation.id, contenido)

        if (result?.mensaje) {
            try {
                // ✅ Enviar por 24h vs plantilla (no sandbox)
                await sendOutboundMessage({
                    conversationId: conversation.id,
                    empresaId,
                    to: conversation.phone,
                    body: result.mensaje
                })

                // Persistir salida del bot
                await prisma.message.create({
                    data: {
                        conversationId: conversation.id,
                        from: MessageFrom.bot,
                        contenido: result.mensaje,
                        timestamp: new Date()
                    }
                })

                io?.emit?.('nuevo_mensaje', {
                    conversationId: conversation.id,
                    from: 'bot',
                    contenido: result.mensaje,
                    timestamp: new Date().toISOString(),
                    estado: result.estado
                })
            } catch (e: any) {
                console.error('[IA->WA] Error enviando respuesta:', e?.response?.data || e.message)
            }
        }

        res.status(200).json({ success: true })
    } catch (error) {
        console.error('[receiveWhatsappMessage] Error:', error)
        res.status(500).json({ error: 'Error al recibir mensaje' })
    }
}

export const verifyWebhook = (req: Request, res: Response) => {
    const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN
    const mode = req.query['hub.mode']
    const token = req.query['hub.verify_token']
    const challenge = req.query['hub.challenge']

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        console.log('🟢 Webhook verificado correctamente')
        return res.status(200).send(challenge)
    } else {
        console.warn('🔴 Verificación fallida')
        return res.sendStatus(403)
    }
}
