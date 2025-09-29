// server/src/controllers/webhook.controller.ts
import { Request, Response } from 'express'
import prisma from '../lib/prisma'
import { handleIAReply } from '../utils/handleIAReply'
import { MessageFrom, ConversationEstado, MediaType } from '@prisma/client'
import {
    getMediaUrl,
    downloadMediaToBuffer,
} from '../services/whatsapp.service'
import { transcribeAudioBuffer } from '../services/transcription.service'
import { buildSignedMediaURL } from '../routes/mediaProxy.route' // 👈 proxy firmado

// ⬇️ Cachear imágenes en Cloudflare Images
import { cacheWhatsappMediaToCloudflare, clearFocus } from '../utils/cacheWhatsappMedia' // 👈 limpiamos foco al (re)abrir conv

/** ===== Retraso humano simulado ===== */
const REPLY_DELAY_FIRST_MS = Number(process.env.REPLY_DELAY_FIRST_MS ?? 180_000) // 3 min
const REPLY_DELAY_NEXT_MS = Number(process.env.REPLY_DELAY_NEXT_MS ?? 120_000)  // 2 min

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

    let responded = false // para evitar doble respuesta HTTP

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

        // 🔁 IDEMPOTENCIA POR WA MESSAGE ID (evita duplicados al reintentar Meta)
        try {
            const already = await prisma.message.findFirst({
                where: { externalId: String(msg.id) } // usamos externalId también para inbound
            })
            if (already) {
                console.log('[DEDUP] inbound ya existente, externalId=', msg.id)
                return res.status(200).json({ success: true, dedup: true })
            }
        } catch (e) {
            console.warn('[DEDUP] consulta falló (continuo):', (e as any)?.message || e)
        }

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
            // 🧠 limpiar foco por si acaso (nueva conv)
            clearFocus(conversation.id)
            console.log('[CONV] creada', { id: conversation.id, phone: fromWa })
        } else if (conversation.estado === ConversationEstado.cerrado) {
            await prisma.conversation.update({
                where: { id: conversation.id },
                data: { estado: ConversationEstado.pendiente },
            })
            conversation.estado = ConversationEstado.pendiente
            // 🧠 limpiar foco al reabrir
            clearFocus(conversation.id)
            console.log('[CONV] reabierta', { id: conversation.id })
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

        // Flag para decidir si llamamos a IA en este webhook
        let skipIAForThisWebhook = false

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
                            : inboundMime?.includes('m4a') ? 'nota-voz.m4a'
                                : inboundMime?.includes('webm') ? 'nota-voz.webm'
                                    : 'nota-voz.ogg'

                const texto = await transcribeAudioBuffer(buf, guessedName)
                transcription = (texto || '').trim()
            } catch (e) {
                console.warn('[AUDIO] No se pudo transcribir.', e)
            }

            contenido = transcription || '[nota de voz]'
            if (inboundMediaId) mediaUrlForFrontend = buildSignedMediaURL(inboundMediaId, empresaId)
            // Para audio sí dejamos pasar a IA (tu lógica ya trata el caso sin transcripción)
        }
        // 🖼️ IMAGEN (➡️ cache a Cloudflare Images con fallback al proxy)
        else if (msg.type === 'image' && msg.image?.id) {
            inboundMediaType = MediaType.image
            inboundMediaId = String(msg.image.id)
            inboundMime = msg.image?.mime_type as string | undefined
            captionForDb = (msg.image?.caption as string | undefined) || undefined

            contenido = captionForDb || '[imagen]'

            // 1) Intentar cachear en Cloudflare Images
            try {
                const accessToken = cuenta.accessToken
                const { url } = await cacheWhatsappMediaToCloudflare({
                    waMediaId: inboundMediaId,
                    accessToken,
                })
                mediaUrlForFrontend = url // URL pública de CF Images (variant)
            } catch (err) {
                console.warn('[IMAGE] cache CF falló, uso proxy firmado:', (err as any)?.message || err)
                // 2) Fallback a tu proxy firmado
                if (inboundMediaId) mediaUrlForFrontend = buildSignedMediaURL(inboundMediaId, empresaId)
            }

            // ❗ Si es imagen SIN caption ⇒ NO invocamos IA (esperamos el texto siguiente)
            if (!captionForDb) {
                skipIAForThisWebhook = true
            }
        }
        // 🎞️ VIDEO (proxy firmado)
        else if (msg.type === 'video' && msg.video?.id) {
            inboundMediaType = MediaType.video
            inboundMediaId = String(msg.video.id)
            inboundMime = msg.video?.mime_type as string | undefined
            captionForDb = (msg.video?.caption as string | undefined) || undefined

            contenido = captionForDb || '[video]'
            if (inboundMediaId) mediaUrlForFrontend = buildSignedMediaURL(inboundMediaId, empresaId)
            // (opcional) si quieres lo mismo que imagen:
            // if (!captionForDb) skipIAForThisWebhook = true
        }
        // 📎 DOCUMENTO (proxy firmado)
        else if (msg.type === 'document' && msg.document?.id) {
            inboundMediaType = MediaType.document
            inboundMediaId = String(msg.document.id)
            inboundMime = msg.document?.mime_type as string | undefined
            const filename = (msg.document?.filename as string | undefined) || undefined
            captionForDb = filename

            contenido = filename ? `[documento] ${filename}` : '[documento]'
            if (inboundMediaId) mediaUrlForFrontend = buildSignedMediaURL(inboundMediaId, empresaId)
            // (opcional) mismo criterio que imagen/video:
            // if (!captionForDb) skipIAForThisWebhook = true
        }

        // Guardar ENTRANTE (ahora también persistimos mediaUrl si existe)
        const inboundData: any = {
            conversationId: conversation.id,
            empresaId,
            from: MessageFrom.client,
            contenido,
            timestamp: ts,
            mediaType: inboundMediaType,
            mediaId: inboundMediaId,
            mediaUrl: mediaUrlForFrontend, // CF o proxy
            mimeType: inboundMime,
            transcription: transcription || undefined,
            externalId: String(msg.id), // 🔁 idempotencia por WA message id
        }
        if (captionForDb) inboundData.caption = captionForDb
        if (process.env.FEATURE_ISVOICENOTE === '1') inboundData.isVoiceNote = Boolean(isVoiceNote)

        const inbound = await prisma.message.create({ data: inboundData })
        console.log('[INBOUND] guardado', {
            id: inbound.id,
            conv: conversation.id,
            type: inboundMediaType || 'text',
            mediaId: inboundMediaId,
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
                mediaUrl: mediaUrlForFrontend,
                mimeType: inboundMime,
                transcription,
                isVoiceNote,
                caption: captionForDb,
                mediaId: inboundMediaId,
            },
            phone: conversation.phone,
            nombre: conversation.nombre ?? conversation.phone,
            estado: conversation.estado,
        })

        // ----- Evitar falso escalado con audio sin transcripción
        const skipEscalateForAudioNoTranscript = (msg.type === 'audio' && !transcription)

        // 3) IA → RESPUESTA (auto envía y persiste)
        // 👇 Si es imagen SIN caption, NO invocamos IA (esperamos el texto siguiente)
        if (skipIAForThisWebhook) {
            if (!responded) {
                res.status(200).json({ success: true, skipped: 'image_without_caption' })
                responded = true
            }
            if (process.env.DEBUG_AI === '1') {
                console.log('[IA] Skip: imagen sin caption; esperamos texto para responder.')
            }
            return
        }

        // 🔔 ACK TEMPRANO para que Meta no reintente el webhook
        if (!responded) {
            res.status(200).json({ success: true, processing: true })
            responded = true
        }

        // ⚙️ Ejecutar IA en background tras el ACK **con delay dinámico**
        ; (async () => {
            try {
                // === Delay humano (dinámico por modo) ===
                // Si es Estética (o citas habilitadas), respondemos INMEDIATO
                const bca = await prisma.businessConfigAppt.findUnique({
                    where: { empresaId },
                    select: { aiMode: true, appointmentEnabled: true },
                })
                const isEstetica = (bca?.aiMode === 'estetica') || (bca?.appointmentEnabled === true)

                let delayMs = 0
                if (!isEstetica) {
                    // Mantén el comportamiento anterior para otros verticales
                    const prevBot = await prisma.message.findFirst({
                        where: { conversationId: conversation.id, from: MessageFrom.bot },
                        select: { id: true },
                    })
                    delayMs = prevBot ? REPLY_DELAY_NEXT_MS : REPLY_DELAY_FIRST_MS
                }

                if (process.env.DEBUG_AI === '1') {
                    console.log('[WEBHOOK] delay humano ms =', delayMs, 'isEstetica?', isEstetica)
                }
                await sleep(delayMs)

                console.log('[IA] Llamando handleIAReply con:', {
                    conversationId: conversation.id,
                    empresaId,
                    toPhone: conversation.phone,
                    phoneNumberId,
                    contenido,
                })

                let result: Awaited<ReturnType<typeof handleIAReply>>
                try {
                    result = await handleIAReply(conversation.id, contenido, {
                        autoSend: true,
                        toPhone: conversation.phone,
                        phoneNumberId,
                    })

                    if (
                        skipEscalateForAudioNoTranscript &&
                        result?.estado === ConversationEstado.requiere_agente &&
                        (result as any)?.motivo === 'palabra_clave'
                    ) {
                        result = {
                            estado: ConversationEstado.en_proceso,
                            mensaje: 'No pude escuchar bien tu nota de voz. ¿Puedes repetir o escribir lo que necesitas?',
                            messageId: undefined,
                        } as any
                    }
                } catch (e: any) {
                    console.error('[IA] handleIAReply lanzó error:', e?.response?.data || e?.message || e)
                    result = {
                        estado: ConversationEstado.en_proceso,
                        mensaje: 'Gracias por tu mensaje. ¿Podrías darme un poco más de contexto?',
                        messageId: undefined,
                    } as any
                }

                console.log('[IA] Resultado handleIAReply:', {
                    estado: result?.estado,
                    messageId: result?.messageId,
                    wamid: result?.wamid,
                    mediaCount: result?.media?.length || 0,
                    mensaje: result?.mensaje,
                })

                // 4) Persistir/emitir SIEMPRE la respuesta del bot (con fallback)
                let botMessageId = result?.messageId ?? undefined
                let botContenido = (result?.mensaje || '').trim()

                if (botContenido && !botMessageId) {
                    const creadoFallback = await prisma.message.create({
                        data: {
                            conversationId: conversation.id,
                            empresaId,
                            from: MessageFrom.bot,
                            contenido: botContenido,
                            timestamp: new Date(),
                        },
                    })
                    botMessageId = creadoFallback.id
                    console.log('[BOT] persistido fallback', { id: botMessageId })
                }

                if (botContenido && botMessageId) {
                    const creado = await prisma.message.findUnique({ where: { id: botMessageId } })

                    if (result?.estado && result.estado !== conversation.estado) {
                        await prisma.conversation.update({
                            where: { id: conversation.id },
                            data: { estado: result.estado },
                        })
                        conversation.estado = result.estado
                        console.log('[CONV] estado actualizado por IA', { id: conversation.id, estado: conversation.estado })
                    }

                    if (creado) {
                        io?.emit?.('nuevo_mensaje', {
                            conversationId: conversation.id,
                            message: {
                                id: creado.id,
                                externalId: creado.externalId ?? null,
                                from: 'bot',
                                contenido: creado.contenido,
                                timestamp: creado.timestamp.toISOString(),
                            },
                            estado: conversation.estado,
                        })
                    }
                }

                // 5) Si el handler envió imágenes de productos, emítelas también
                if (result?.media?.length) {
                    const wamids = result.media
                        .map(m => m.wamid)
                        .filter(Boolean) as string[]

                    if (wamids.length) {
                        const medias = await prisma.message.findMany({
                            where: {
                                conversationId: conversation.id,
                                from: MessageFrom.bot,
                                externalId: { in: wamids },
                            },
                            orderBy: { id: 'asc' },
                            select: {
                                id: true,
                                externalId: true,
                                mediaType: true,
                                mediaUrl: true,
                                caption: true,
                                timestamp: true,
                            }
                        })

                        for (const m of medias) {
                            io?.emit?.('nuevo_mensaje', {
                                conversationId: conversation.id,
                                message: {
                                    id: m.id,
                                    externalId: m.externalId ?? null,
                                    from: 'bot',
                                    contenido: '', // el texto va en caption
                                    mediaType: m.mediaType,
                                    mediaUrl: m.mediaUrl,
                                    caption: m.caption,
                                    timestamp: m.timestamp.toISOString(),
                                },
                            })
                        }
                    }
                }
            } catch (e) {
                console.error('[WEBHOOK bg IA] Error post-ACK:', e)
            }
        })()

        // Ya respondimos antes; nada más que hacer aquí
        return
    } catch (error) {
        console.error('[receiveWhatsappMessage] Error:', error)
        if (!responded) {
            return res.status(500).json({ error: 'Error al recibir mensaje' })
        }
        // si ya respondimos, solo log
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

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms))
}
