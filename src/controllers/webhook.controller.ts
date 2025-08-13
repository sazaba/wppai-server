import { Request, Response } from 'express'
import prisma from '../lib/prisma'
import { handleIAReply } from '../utils/handleIAReply'
import { MessageFrom, ConversationEstado } from '@prisma/client'
import { sendOutboundMessage, sendTemplate } from '../services/whatsapp.services'

export const receiveWhatsappMessage = async (req: Request, res: Response) => {
    console.log('📩 Webhook recibido:', JSON.stringify(req.body, null, 2))

    try {
        const entry: any = req.body?.entry?.[0]
        const change: any = entry?.changes?.[0]
        const value: any = change?.value

        // 1) STATUSES (fallas por 24h → fallback con plantilla)
        if (value?.statuses?.length) {
            const phoneNumberId: string | undefined = value?.metadata?.phone_number_id
            if (!phoneNumberId) return res.status(200).json({ ignored: true })

            const cuenta = await prisma.whatsappAccount.findUnique({ where: { phoneNumberId } })
            const empresaId = cuenta?.empresaId

            for (const st of value.statuses as any[]) {
                if (st.status !== 'failed') continue
                const codes = (st.errors || []).map((e: any) => e.code)
                const is24hClosed = codes.includes(131047) || codes.includes(470)
                if (!is24hClosed || !empresaId) continue

                const to: string = st.recipient_id // wa_id del cliente
                const conv = await prisma.conversation.findFirst({ where: { empresaId, phone: to } })
                if (!conv) continue

                const templateName = 'hello_world'
                const templateLang = 'es'

                try {
                    await sendTemplate({ empresaId, to, templateName, templateLang, variables: [] })

                    await prisma.message.create({
                        data: {
                            conversationId: conv.id,
                            from: MessageFrom.bot,
                            contenido: `[auto-fallback ${templateName}/${templateLang}]`,
                            timestamp: new Date()
                        }
                    })

                    const io: any = req.app.get('io')
                    io?.emit?.('nuevo_mensaje', {
                        conversationId: conv.id,
                        from: 'bot',
                        contenido: `[auto-fallback ${templateName}/${templateLang}]`,
                        timestamp: new Date().toISOString(),
                        estado: conv.estado
                    })
                } catch (e: any) {
                    console.error('[fallback] Error enviando plantilla:', e?.response?.data || e.message)
                }
            }
            return res.status(200).json({ handled: 'statuses' })
        }

        // 2) MENSAJES ENTRANTES REALES
        if (!value?.messages?.[0]) return res.status(200).json({ ignored: true })

        const msg: any = value.messages[0]
        const inboundId: string = msg.id // (útil si luego haces idempotencia por DB)
        const phoneNumberId: string | undefined = value?.metadata?.phone_number_id
        const fromWa: string | undefined = msg.from

        const contenido: string =
            msg.text?.body ||
            msg.button?.text ||
            msg.interactive?.list_reply?.title ||
            '[mensaje no soportado]'

        const ts = msg.timestamp ? new Date(parseInt(msg.timestamp as string, 10) * 1000) : new Date()

        if (!phoneNumberId || !fromWa) return res.status(200).json({ ignored: true })

        // Empresa/cta
        const cuenta = await prisma.whatsappAccount.findUnique({
            where: { phoneNumberId },
            include: { empresa: true }
        })
        if (!cuenta || cuenta.empresa.estado !== 'activo') {
            console.warn(`⚠️ Empresa inactiva o no encontrada para el número: ${phoneNumberId}`)
            return res.status(200).json({ ignored: true })
        }
        const empresaId = cuenta.empresaId

        // Conversación
        let conversation = await prisma.conversation.findFirst({ where: { phone: fromWa, empresaId } })
        if (!conversation) {
            conversation = await prisma.conversation.create({
                data: { phone: fromWa, estado: ConversationEstado.pendiente, empresaId }
            })
        } else if (conversation.estado === ConversationEstado.cerrado) {
            await prisma.conversation.update({
                where: { id: conversation.id },
                data: { estado: ConversationEstado.pendiente }
            })
            conversation.estado = ConversationEstado.pendiente
        }

        // Guardar ENTRANTE (cliente)
        await prisma.message.create({
            data: {
                conversationId: conversation.id,
                from: MessageFrom.client,
                contenido,
                timestamp: ts
            }
        })

        // Emitir a frontend
        const io: any = req.app.get('io')
        io?.emit?.('nuevo_mensaje', {
            conversationId: conversation.id,
            from: 'client',
            contenido,
            timestamp: ts.toISOString(),
            phone: conversation.phone,
            nombre: conversation.nombre ?? conversation.phone,
            estado: conversation.estado
        })

        // 3) IA → RESPUESTA (guard anti-duplicados)
        const result: any = await handleIAReply(conversation.id, contenido)
        if (result?.mensaje) {
            const yaExiste = await prisma.message.findFirst({
                where: {
                    conversationId: conversation.id,
                    from: MessageFrom.bot,
                    contenido: result.mensaje,
                    timestamp: { gte: new Date(Date.now() - 15_000) }
                }
            })
            if (yaExiste) {
                console.warn('[BOT] Evitado duplicado por guard (mensaje idéntico reciente).')
                return res.status(200).json({ success: true, deduped: true })
            }

            try {
                const resp = await sendOutboundMessage({
                    conversationId: conversation.id,
                    empresaId,
                    to: conversation.phone,
                    body: result.mensaje
                })

                // ← usa el wamid retornado por el service (si lo quieres guardar luego)
                const outboundId: string | null = resp?.outboundId ?? null

                const creado = await prisma.message.create({
                    data: {
                        conversationId: conversation.id,
                        from: MessageFrom.bot,
                        contenido: result.mensaje,
                        timestamp: new Date()
                        // externalId: outboundId || undefined,        // habilítalo si agregas la columna
                        // inReplyToExternalId: inboundId || undefined // habilítalo si agregas la columna
                    }
                })

                io?.emit?.('nuevo_mensaje', {
                    conversationId: conversation.id,
                    from: 'bot',
                    contenido: result.mensaje,
                    timestamp: creado.timestamp.toISOString(),
                    estado: result.estado
                })

                await prisma.conversation.update({
                    where: { id: conversation.id },
                    data: { estado: ConversationEstado.respondido }
                })
            } catch (e: any) {
                console.error('[IA->WA] Error enviando respuesta:', e?.response?.data || e.message)
            }
        }

        return res.status(200).json({ success: true })
    } catch (error) {
        console.error('[receiveWhatsappMessage] Error:', error)
        return res.status(500).json({ error: 'Error al recibir mensaje' })
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
