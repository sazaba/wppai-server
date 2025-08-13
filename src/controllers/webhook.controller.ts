// controllers/webhook.controller.ts
import { Request, Response } from 'express'
import prisma from '../lib/prisma'
import { handleIAReply } from '../utils/handleIAReply'
import { MessageFrom, ConversationEstado } from '@prisma/client'
import { sendText } from '../services/whatsapp.services' // usamos TEXTO directo (sin plantillas)

export const receiveWhatsappMessage = async (req: Request, res: Response) => {
    console.log('📩 Webhook recibido:', JSON.stringify(req.body, null, 2))

    try {
        const entry: any = req.body?.entry?.[0]
        const change: any = entry?.changes?.[0]
        const value: any = change?.value

        // 1) STATUSES: log + posible aviso al frontend si falla (ventana 24h cerrada u otro error)
        if (value?.statuses?.length) {
            const io: any = req.app.get('io')
            for (const st of value.statuses as any[]) {
                const codes = (st.errors || []).map((e: any) => e.code)
                console.log('[WA status]', { recipient: st.recipient_id, status: st.status, codes })
                if (st.status === 'failed') {
                    // Aviso al frontend para mostrar banner
                    io?.emit?.('wa_policy_error', {
                        // intentamos mapear a conversación (si existe)
                        conversationId: await resolveConversationIdByWaId(req, st.recipient_id),
                        code: codes?.[0],
                        message: 'Ventana de 24h cerrada o error de política. Se requiere plantilla para iniciar la conversación.'
                    })
                }
            }
            return res.status(200).json({ handled: 'statuses' })
        }

        // 2) MENSAJE ENTRANTE REAL
        if (!value?.messages?.[0]) return res.status(200).json({ ignored: true })

        const msg: any = value.messages[0]
        const phoneNumberId: string | undefined = value?.metadata?.phone_number_id
        const fromWa: string | undefined = msg.from

        const contenido: string =
            msg.text?.body ||
            msg.button?.text ||
            msg.interactive?.list_reply?.title ||
            '[mensaje no soportado]'

        const ts: Date = msg.timestamp ? new Date(parseInt(msg.timestamp as string, 10) * 1000) : new Date()

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
        const inbound = await prisma.message.create({
            data: {
                conversationId: conversation.id,
                from: MessageFrom.client,
                contenido,
                timestamp: ts
            }
        })

        // Emitir ENTRANTE al frontend (con id, externalId)
        const io: any = req.app.get('io')
        io?.emit?.('nuevo_mensaje', {
            conversationId: conversation.id,
            message: {
                id: inbound.id,
                externalId: (inbound as any).externalId ?? null,
                from: 'client',
                contenido,
                timestamp: inbound.timestamp.toISOString()
            },
            phone: conversation.phone,
            nombre: conversation.nombre ?? conversation.phone,
            estado: conversation.estado
        })

        // 3) IA → RESPUESTA (dedupe relativo al inbound + envío de texto)
        const result: any = await handleIAReply(conversation.id, contenido)
        if (result?.mensaje) {
            // DEDUPE: solo consideramos duplicado si ya hay un bot >= ts (este inbound)
            const yaExiste = await prisma.message.findFirst({
                where: {
                    conversationId: conversation.id,
                    from: MessageFrom.bot,
                    contenido: result.mensaje,
                    timestamp: { gte: ts }
                }
            })
            if (yaExiste) {
                console.warn('[BOT] Evitado duplicado para este inbound.')
                return res.status(200).json({ success: true, deduped: true })
            }

            try {
                console.log('[WA TX] Enviando texto →', {
                    to: conversation.phone,
                    preview: result.mensaje.slice(0, 80)
                })

                const respText = await sendText({
                    empresaId,
                    to: conversation.phone,
                    body: result.mensaje
                })
                const outboundId: string | null = respText?.outboundId ?? null
                console.log('[WA TX] OK, outboundId:', outboundId)

                const creado = await prisma.message.create({
                    data: {
                        conversationId: conversation.id,
                        from: MessageFrom.bot,
                        contenido: result.mensaje,
                        timestamp: new Date()
                        // externalId: outboundId || undefined // habilítalo cuando agregues la columna
                    }
                })

                // Emitir BOT al frontend
                io?.emit?.('nuevo_mensaje', {
                    conversationId: conversation.id,
                    message: {
                        id: creado.id,
                        externalId: outboundId,
                        from: 'bot',
                        contenido: result.mensaje,
                        timestamp: creado.timestamp.toISOString()
                    },
                    estado: result.estado
                })

                await prisma.conversation.update({
                    where: { id: conversation.id },
                    data: { estado: ConversationEstado.respondido }
                })
            } catch (e: any) {
                const meta = e?.response?.data
                const code = meta?.error?.code
                console.error('[WA TX] ERROR al enviar texto:', code, meta || e?.message)

                // 🚨 Emitimos el aviso al frontend para mostrar el banner de 24h cerrada
                io?.emit?.('wa_policy_error', {
                    conversationId: conversation.id,
                    code,
                    message: 'Ventana de 24h cerrada. Se requiere plantilla para iniciar la conversación.'
                })
            }
        }

        return res.status(200).json({ success: true })
    } catch (error) {
        console.error('[receiveWhatsappMessage] Error:', error)
        return res.status(500).json({ error: 'Error al recibir mensaje' })
    }
}

// Ayudante: intentar mapear un wa_id (cliente) a conversationId
async function resolveConversationIdByWaId(req: Request, waId: string): Promise<number | null> {
    try {
        const io: any = req.app.get('io') // no se usa aquí, pero dejamos la firma simétrica
        const conv = await prisma.conversation.findFirst({ where: { phone: waId } })
        return conv?.id ?? null
    } catch {
        return null
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
