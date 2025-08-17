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
// 🆕: firmador de token corto para URLs de media
import { signMediaToken } from './whatsapp.controller'

// 🆕 helper: construye URL firmada para que <img>/<video> puedan cargar sin Authorization
function buildSignedMediaUrl(empresaId: number, mediaId: string) {
    const t = signMediaToken(empresaId, mediaId)
    return `/api/whatsapp/media/${mediaId}?t=${encodeURIComponent(t)}`
}

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
        let captionForDb: string | undefined

        // 🔊 NOTA DE VOZ / AUDIO
        if (msg.type === 'audio' && msg.audio?.id) {
            inboundMediaType = MediaType.audio
            inboundMediaId = String(msg.audio.id)
            inboundMime = msg.audio?.mime_type as string | undefined
            isVoiceNote = Boolean(msg.audio?.voice)

            try {
                const signedUrl = await getMediaUrl(empresaId, inboundMediaId)
                const buf = await downloadMediaToBuffer(empresaId, signedUrl)

                const guessedName =
                    inboundMime?.includes('mp3') ? 'nota-voz.mp3'
                        : inboundMime?.includes('wav') ? 'nota-voz.wav'
                            : 'nota-voz.ogg'

                const texto = await transcribeAudioBuffer(buf, guessedName)
                transcription = (texto || '').trim()
            } catch (e) {
                console.warn('[AUDIO] No se pudo transcribir.', e)
            }

            contenido = transcription || '[nota de voz]'
            if (inboundMediaId) mediaUrlForFrontend = buildSignedMediaUrl(empresaId, inboundMediaId)
        }
        // 🖼️ IMAGEN
        else if (msg.type === 'image' && msg.image?.id) {
            inboundMediaType = MediaType.image
            inboundMediaId = String(msg.image.id)
            inboundMime = msg.image?.mime_type as string | undefined
            captionForDb = (msg.image?.caption as string | undefined) || undefined

            contenido = captionForDb || '[imagen]'
            if (inboundMediaId) mediaUrlForFrontend = buildSignedMediaUrl(empresaId, inboundMediaId)
        }
        // 🎞️ VIDEO
        else if (msg.type === 'video' && msg.video?.id) {
            inboundMediaType = MediaType.video
            inboundMediaId = String(msg.video.id)
            inboundMime = msg.video?.mime_type as string | undefined
            captionForDb = (msg.video?.caption as string | undefined) || undefined

            contenido = captionForDb || '[video]'
            if (inboundMediaId) mediaUrlForFrontend = buildSignedMediaUrl(empresaId, inboundMediaId)
        }
        // 📎 DOCUMENTO
        else if (msg.type === 'document' && msg.document?.id) {
            inboundMediaType = MediaType.document
            inboundMediaId = String(msg.document.id)
            inboundMime = msg.document?.mime_type as string | undefined
            const filename = (msg.document?.filename as string | undefined) || undefined
            captionForDb = filename

            contenido = filename ? `[documento] ${filename}` : '[documento]'
            if (inboundMediaId) mediaUrlForFrontend = buildSignedMediaUrl(empresaId, inboundMediaId)
        }

        // Guardar ENTRANTE
        const inboundData: any = {
            conversationId: conversation.id,
            empresaId,
            from: MessageFrom.client,
            contenido,
            timestamp: ts,
            mediaType: inboundMediaType,
            mediaId: inboundMediaId,
            mimeType: inboundMime,
            transcription: transcription || undefined,
        }
        if (captionForDb) inboundData.caption = captionForDb
        if (process.env.FEATURE_ISVOICENOTE === '1') inboundData.isVoiceNote = Boolean(isVoiceNote)

        const inbound = await prisma.message.create({ data: inboundData })

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
                mediaUrl: mediaUrlForFrontend,
                mimeType: inboundMime,
                transcription,
                isVoiceNote,
                caption: captionForDb,
                mediaId: inboundMediaId,   // 🆕 añadido para el front
            },
            phone: conversation.phone,
            nombre: conversation.nombre ?? conversation.phone,
            estado: conversation.estado,
        })

        // ----- Evitar falso escalado con audio sin transcripción
        const skipEscalateForAudioNoTranscript = (msg.type === 'audio' && !transcription)

        // 3) IA → RESPUESTA
        let result: Awaited<ReturnType<typeof handleIAReply>>
        try {
            result = await handleIAReply(conversation.id, contenido)

            if (
                skipEscalateForAudioNoTranscript &&
                result?.estado === ConversationEstado.requiere_agente &&
                (result as any)?.motivo === 'palabra_clave'
            ) {
                result = {
                    estado: ConversationEstado.en_proceso,
                    mensaje: 'No pude escuchar bien tu nota de voz. ¿Puedes repetir o escribir lo que necesitas?'
                }
            }
        } catch {
            result = {
                estado: ConversationEstado.en_proceso,
                mensaje: 'Gracias por tu mensaje. ¿Podrías darme un poco más de contexto?'
            }
        }

        if (result?.mensaje) {
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
                    },
                })

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

// Ayudante: mapear wa_id (cliente) a conversationId
async function resolveConversationIdByWaId(_req: Request, waId: string): Promise<number | null> {
    try {
        const conv = await prisma.conversation.findFirst({ where: { phone: waId } })
        return conv?.id ?? null
    } catch {
        return null
    }
}
