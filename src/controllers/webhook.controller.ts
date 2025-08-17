// src/controllers/webhook.controller.ts
import { Request, Response } from 'express'
import prisma from '../lib/prisma'
import { handleIAReply } from '../utils/handleIAReply'
import { MessageFrom, ConversationEstado, MediaType } from '@prisma/client'
import {
    sendText as sendTextSvc,
    getMediaUrl,
    downloadMediaToBuffer,
} from '../services/whatsapp.services'
import { transcribeAudioBuffer } from '../services/transcription.service'

// GET /api/webhook  (verificación con token)
export const verifyWebhook = (req: Request, res: Response) => {
    const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN
    const mode = req.query['hub.mode'] as string | undefined
    const token = req.query['hub.verify_token'] as string | undefined
    const challenge = req.query['hub.challenge'] as string | undefined

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        console.log('🟢 Webhook verificado correctamente')
        return res.status(200).send(challenge ?? '')
    } else {
        console.warn('🔴 Verificación de webhook fallida')
        return res.sendStatus(403)
    }
}

// POST /api/webhook  (recepción de eventos)
export const receiveWhatsappMessage = async (req: Request, res: Response) => {
    console.log('📩 Webhook recibido:', JSON.stringify(req.body, null, 2))

    try {
        const entry: any = req.body?.entry?.[0]
        const change: any = entry?.changes?.[0]
        const value: any = change?.value

        // 1) STATUS callbacks de mensajes salientes
        if (value?.statuses?.length) {
            const io = req.app.get('io') as any
            for (const st of value.statuses as any[]) {
                const codes = (st.errors || []).map((e: any) => e.code)
                console.log('[WA status]', { recipient: st.recipient_id, status: st.status, codes })
                if (st.status === 'failed') {
                    io?.emit?.('wa_policy_error', {
                        conversationId: await resolveConversationIdByWaId(req, st.recipient_id),
                        code: codes?.[0],
                        message:
                            'Ventana de 24h cerrada o error de política. Se requiere plantilla para iniciar la conversación.',
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
        const ts: Date = msg.timestamp ? new Date(parseInt(msg.timestamp as string, 10) * 1000) : new Date()

        if (!phoneNumberId || !fromWa) return res.status(200).json({ ignored: true })

        // Empresa / cuenta
        const cuenta = await prisma.whatsappAccount.findUnique({
            where: { phoneNumberId },
            include: { empresa: true },
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
                data: { phone: fromWa, estado: ConversationEstado.pendiente, empresaId },
            })
        } else if (conversation.estado === ConversationEstado.cerrado) {
            await prisma.conversation.update({
                where: { id: conversation.id },
                data: { estado: ConversationEstado.pendiente },
            })
            conversation.estado = ConversationEstado.pendiente
        }

        // ----- Contenido base (texto/botones)
        let contenido: string =
            msg.text?.body ||
            msg.button?.text ||
            msg.interactive?.list_reply?.title ||
            '[mensaje no soportado]'

        // ----- Campos de media a persistir/emitir
        let inboundMediaType: MediaType | undefined
        let inboundMediaId: string | undefined
        let inboundMime: string | undefined
        let transcription: string | undefined
        let isVoiceNote = false
        let mediaUrlForFrontend: string | undefined

        // 🔊 NOTA DE VOZ / AUDIO: descargar y transcribir
        if (msg.type === 'audio' && msg.audio?.id) {
            inboundMediaType = MediaType.audio
            inboundMediaId = String(msg.audio.id)
            inboundMime = msg.audio?.mime_type as string | undefined
            isVoiceNote = Boolean(msg.audio?.voice)

            try {
                // 1) URL firmada corta (Graph) y descarga a Buffer
                const signedUrl = await getMediaUrl(empresaId, inboundMediaId)
                const buf = await downloadMediaToBuffer(empresaId, signedUrl)

                // 2) Nombre sugerido para el transcriptor (extensión ayuda al SDK)
                const guessedName =
                    inboundMime?.includes('mp3') ? 'nota-voz.mp3'
                        : inboundMime?.includes('wav') ? 'nota-voz.wav'
                            : 'nota-voz.ogg'

                // 3) Transcribir con tu servicio (Whisper / 4o-mini-transcribe)
                const texto = await transcribeAudioBuffer(buf, guessedName)
                transcription = (texto || '').trim()
            } catch (e) {
                console.warn('[AUDIO] No se pudo transcribir.', e)
            }

            // Si no hay transcripción, dejamos placeholder
            contenido = transcription || '[nota de voz]'

            // URL para reproducir desde el front (proxy seguro con JWT)
            if (inboundMediaId) {
                mediaUrlForFrontend = `/api/whatsapp/media/${inboundMediaId}`
            }
        }

        // Guardar ENTRANTE (cliente)
        const inbound = await prisma.message.create({
            data: {
                conversationId: conversation.id,
                empresaId,
                from: MessageFrom.client,
                contenido,
                timestamp: ts,
                mediaType: inboundMediaType,      // enum MediaType
                mediaId: inboundMediaId,
                mimeType: inboundMime,
                isVoiceNote,
                transcription: transcription || undefined,
            },
        })

        // Emitir ENTRANTE al frontend
        const io = req.app.get('io') as any
        io?.emit?.('nuevo_mensaje', {
            conversationId: conversation.id,
            message: {
                id: inbound.id,
                externalId: inbound.externalId ?? null,
                from: 'client',
                contenido,
                timestamp: inbound.timestamp.toISOString(),
                mediaType: inboundMediaType,
                mediaUrl: mediaUrlForFrontend, // /api/whatsapp/media/:mediaId
                mimeType: inboundMime,
                transcription,
                isVoiceNote,
            },
            phone: conversation.phone,
            nombre: conversation.nombre ?? conversation.phone,
            estado: conversation.estado,
        })

        // 3) IA → RESPUESTA
        const result: any = await handleIAReply(conversation.id, contenido)
        if (result?.mensaje) {
            // DEDUPE: evita duplicado
            const yaExiste = await prisma.message.findFirst({
                where: {
                    conversationId: conversation.id,
                    from: MessageFrom.bot,
                    contenido: result.mensaje,
                    timestamp: { gte: ts },
                },
            })
            if (yaExiste) {
                console.warn('[BOT] Evitado duplicado para este inbound.')
                return res.status(200).json({ success: true, deduped: true })
            }

            try {
                console.log('[WA TX] Enviando texto →', {
                    to: conversation.phone,
                    preview: result.mensaje.slice(0, 80),
                })

                const respText = await sendTextSvc({
                    empresaId,
                    to: conversation.phone,
                    body: result.mensaje,
                })
                const outboundId: string | null = respText?.outboundId ?? null
                console.log('[WA TX] OK, outboundId:', outboundId)

                const creado = await prisma.message.create({
                    data: {
                        conversationId: conversation.id,
                        empresaId,
                        from: MessageFrom.bot,
                        contenido: result.mensaje,
                        timestamp: new Date(),
                        // externalId: outboundId || undefined
                    },
                })

                // Emitir BOT al frontend
                io?.emit?.('nuevo_mensaje', {
                    conversationId: conversation.id,
                    message: {
                        id: creado.id,
                        externalId: outboundId,
                        from: 'bot',
                        contenido: result.mensaje,
                        timestamp: creado.timestamp.toISOString(),
                    },
                    estado: result.estado,
                })

                await prisma.conversation.update({
                    where: { id: conversation.id },
                    data: { estado: ConversationEstado.respondido },
                })
            } catch (e: any) {
                const meta = e?.response?.data
                const code = meta?.error?.code
                console.error('[WA TX] ERROR al enviar texto:', code, meta || e?.message)
                io?.emit?.('wa_policy_error', {
                    conversationId: conversation.id,
                    code,
                    message: 'Ventana de 24h cerrada. Se requiere plantilla para iniciar la conversación.',
                })
            }
        }

        return res.status(200).json({ success: true })
    } catch (error) {
        console.error('[receiveWhatsappMessage] Error:', error)
        return res.status(500).json({ error: 'Error al recibir mensaje' })
    }
}

// Ayudante: mapear wa_id (cliente) a conversationId si es posible
async function resolveConversationIdByWaId(_req: Request, waId: string): Promise<number | null> {
    try {
        const conv = await prisma.conversation.findFirst({ where: { phone: waId } })
        return conv?.id ?? null
    } catch {
        return null
    }
}
