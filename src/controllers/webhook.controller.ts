import { Request, Response } from 'express'
import prisma from '../lib/prisma'
import { handleIAReply } from '../utils/handleIAReply'
import { MessageFrom, ConversationEstado } from '@prisma/client'
import { sendText } from '../services/whatsapp.services' // usamos texto directo

export const receiveWhatsappMessage = async (req: Request, res: Response) => {
    console.log('📩 Webhook recibido:', JSON.stringify(req.body, null, 2))

    try {
        const entry: any = req.body?.entry?.[0]
        const change: any = entry?.changes?.[0]
        const value: any = change?.value

        // 1) STATUSES (solo log, sin plantillas)
        if (value?.statuses?.length) {
            for (const st of value.statuses as any[]) {
                if (st.status === 'failed') {
                    const codes = (st.errors || []).map((e: any) => e.code)
                    console.warn('[WA status][failed]', { recipient: st.recipient_id, codes })
                    // opcional: emitir evento al frontend para mostrar aviso
                    // const io: any = req.app.get('io')
                    // io?.emit?.('wa_policy_error', { waId: st.recipient_id, codes })
                }
            }
            return res.status(200).json({ handled: 'statuses' })
        }

        // 2) MENSAJES ENTRANTES REALES
        if (!value?.messages?.[0]) return res.status(200).json({ ignored: true })

        const msg: any = value.messages[0]
        const phoneNumberId: string | undefined = value?.metadata?.phone_number_id
        const fromWa: string | undefined = msg.from

        const contenido: string =
            msg.text?.body ||
            msg.button?.text ||
            msg.interactive?.list_reply?.title ||
            '[mensaje no soportado]'

        const ts = msg.timestamp ? new Date(parseInt(msg.timestamp as string, 10) * 1000) : new Date()

        if (!phoneNumberId || !fromWa) return res.status(200).json({ ignored: true })

        // Empresa / cuenta
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

        // 3) IA → RESPUESTA (anti-duplicado + envío de texto)
        const result: any = await handleIAReply(conversation.id, contenido)
        if (result?.mensaje) {
            // Anti-duplicado 15s
            const yaExiste = await prisma.message.findFirst({
                where: {
                    conversationId: conversation.id,
                    from: MessageFrom.bot,
                    contenido: result.mensaje,
                    timestamp: { gte: new Date(Date.now() - 15_000) }
                }
            })
            if (yaExiste) {
                console.warn('[BOT] Evitado duplicado (mensaje idéntico reciente).')
                return res.status(200).json({ success: true, deduped: true })
            }

            try {
                // TEXTO directo. Si Meta detecta ventana cerrada → lanzará error 131047/470
                const respText = await sendText({
                    empresaId,
                    to: conversation.phone,
                    body: result.mensaje
                })
                const outboundId: string | null = respText?.outboundId ?? null // por si luego guardas externalId

                const creado = await prisma.message.create({
                    data: {
                        conversationId: conversation.id,
                        from: MessageFrom.bot,
                        contenido: result.mensaje,
                        timestamp: new Date()
                        // externalId: outboundId || undefined
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
                const metaCode = e?.response?.data?.error?.code
                console.error('[IA->WA] Error al enviar texto:', metaCode, e?.response?.data || e?.message)

                // Opcional: notificar al frontend para que muestre el aviso “sesión de 24h cerrada”
                // io?.emit?.('wa_policy_error', { conversationId: conversation.id, code: metaCode })
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
