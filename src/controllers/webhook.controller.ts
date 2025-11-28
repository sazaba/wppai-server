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
const REPLY_DELAY_NEXT_MS = Number(process.env.REPLY_DELAY_NEXT_MS ?? 120_000)   // 2 min

/* ===== Helper fechas + estado de acceso (TRIAL + SUSCRIPCIÓN) ===== */

const SUBS_GRACE_DAYS = 2

function addDays(date: Date, days: number): Date {
    const d = new Date(date)
    d.setDate(d.getDate() + days)
    return d
}

// Solo prueba gratuita (7 días). Ya NO usamos plan PRO aquí.
async function getTrialStatus(empresaId: number) {
    const emp = await prisma.empresa.findUnique({
        where: { id: empresaId },
        select: { createdAt: true, trialEnd: true },
    })
    if (!emp) return { active: false, endsAt: null as Date | null }

    const endsAt =
        emp.trialEnd ??
        new Date(emp.createdAt.getTime() + 7 * 24 * 60 * 60 * 1000)

    const active = Date.now() <= endsAt.getTime()
    return { active, endsAt }
}

// Estado de suscripción usando currentPeriodEnd + 2 días de gracia
async function getSubscriptionAccessStatus(empresaId: number) {
    const sub = await prisma.subscription.findFirst({
        where: { empresaId, status: 'active' },
        orderBy: { createdAt: 'desc' },
    })

    if (!sub) {
        return {
            active: false,
            inGrace: false,
            endsAt: null as Date | null,
        }
    }

    const now = new Date()
    const end = sub.currentPeriodEnd
    const graceLimit = addDays(end, SUBS_GRACE_DAYS)

    const active = now <= graceLimit
    const inGrace = now > end && now <= graceLimit

    return {
        active,
        inGrace,
        endsAt: end,
    }
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
        // ⚠️ CAMBIO CRÍTICO: Agregamos include: { empresa: true } para leer los límites
        const cuenta = await prisma.whatsappAccount.findUnique({
            where: { phoneNumberId },
            include: { empresa: true },
        })
        if (!cuenta || cuenta.empresa.estado !== 'activo') {
            console.warn(`⚠️ Empresa inactiva o no encontrada para el número: ${phoneNumberId}`)
            return res.status(200).json({ ignored: true })
        }
        const empresaId = cuenta.empresaId
        const empresaData = cuenta.empresa // Datos completos de la empresa (incluyendo límites)

        // Conversación
        let conversation = await prisma.conversation.findFirst({ where: { phone: fromWa, empresaId } })

        // =================================================================================
        // 🛑 NUEVO: LÓGICA DE LÍMITE DE CONVERSACIONES (300 Mensuales)
        // =================================================================================

        // 1. Detectar si esto cuenta como "Nueva Conversación"
        const isNewSession = !conversation || conversation.estado === ConversationEstado.cerrado

        // 2. Revisar si ya topó el límite
        const isLimitReached = empresaData.conversationsUsed >= empresaData.monthlyConversationLimit

        // 3. BLOQUEAR si es nueva sesión Y no hay cupo
        if (isNewSession && isLimitReached) {
            console.warn(`🚫 [BILLING] Límite alcanzado (${empresaData.conversationsUsed}/${empresaData.monthlyConversationLimit}). Bloqueando.`)

            // Avisar al frontend (Dashboard)
            const io = req.app.get('io') as any
            io?.emit?.('wa_policy_error', {
                conversationId: conversation?.id || 0,
                phone: fromWa,
                code: 'limit_reached',
                message: 'Has alcanzado el límite mensual de conversaciones. Compra más créditos.',
            })

            // Detener ejecución aquí (no guarda mensaje, no responde IA)
            return res.status(200).json({ ignored: true, reason: 'monthly_limit_reached' })
        }

        // 4. Si hay cupo y es nueva sesión, INCREMENTAR contador
        if (isNewSession) {
            await prisma.empresa.update({
                where: { id: empresaId },
                data: { conversationsUsed: { increment: 1 } }
            })
            console.log(`📊 [BILLING] Nueva conversación iniciada. Uso: ${empresaData.conversationsUsed + 1}`)
        }
        // =================================================================================
        // FIN LÓGICA DE LÍMITES
        // =================================================================================


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

        // 🔒 Regla post-agenda: si entra mensaje del cliente y la conversación estaba agendada,
        // pasa automáticamente a "agendado_consulta" y saltamos la IA.
        let isPostAgendaMessage = false
        if (conversation.estado === ConversationEstado.agendado) {
            await prisma.conversation.update({
                where: { id: conversation.id },
                data: { estado: ConversationEstado.agendado_consulta },
            })
            conversation.estado = ConversationEstado.agendado_consulta
            isPostAgendaMessage = true

            // Notificar al frontend del cambio de estado
            const io = req.app.get('io') as any
            io?.emit?.('estado_actualizado', {
                conversationId: conversation.id,
                estado: conversation.estado,
            })
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

        // 👇 Solo bloqueamos IA si el chat está en requiere_agente.
        // En agendado / agendado_consulta SÍ dejamos pasar a la IA para registrar confirmaciones/cambios.
        if (conversation.estado === ConversationEstado.requiere_agente) {
            skipIAForThisWebhook = true
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

        // === BLOQUEAR RESPUESTA DE IA si NO hay trial activo NI suscripción activa (con gracia) ===
        // 🔒 Este es el "Candado de Tiempo"
        const { active: trialActive, endsAt: trialEndsAt } = await getTrialStatus(empresaId)
        const {
            active: subsActive,
            inGrace,
            endsAt: subsEndsAt,
        } = await getSubscriptionAccessStatus(empresaId)

        // 🔒 Regla:
        // - Si hay trial activo → dejamos pasar IA.
        // - Si hay suscripción activa o en gracia → dejamos pasar IA.
        // - Si NO hay trial y NO hay suscripción (ni gracia) → bloqueamos IA.
        if (!trialActive && !subsActive) {
            if (!responded) {
                res.status(200).json({ success: true, access: 'blocked' })
                responded = true
            }

            const ioBlock = req.app.get('io') as any

            // Priorizar mensaje de suscripción si existe
            const ends = subsEndsAt || trialEndsAt
            const fechaStr = ends
                ? ends.toLocaleDateString('es-CO')
                : null

            let code = 'subscription_expired'
            let message =
                'Tu acceso a la IA está inactivo. Por favor renueva o activa un plan.'

            if (subsEndsAt) {
                message = `Tu membresía terminó el ${fechaStr}. Para seguir respondiendo automáticamente, renueva tu plan.`
            } else if (trialEndsAt) {
                code = 'trial_expired'
                message = `La prueba gratuita terminó el ${fechaStr}. Para seguir respondiendo automáticamente, activa tu plan.`
            }

            ioBlock?.emit?.('wa_policy_error', {
                conversationId: conversation.id,
                code,
                message,
            })

            // No llamar IA ni enviar nada saliente
            return
        }


        // 3) IA → RESPUESTA (auto envía y persiste)
        // 👇 Salidas tempranas por skipIAForThisWebhook
        if (skipIAForThisWebhook) {
            if (!responded) {
                res.status(200).json({ success: true, skipped: 'post_agenda' })
                responded = true
            }
            if (process.env.DEBUG_AI === '1') {
                console.log('[IA] Skip: post-agenda (agendado/agendado_consulta) o imagen sin caption. Mensaje entregado sin respuesta automática.')
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

                const mode = (bca?.aiMode || '').toString().trim().toLowerCase()
                let isEstetica = mode === 'estetica' || bca?.appointmentEnabled === true

                // 👇 Fallback: si hay KB de estética disponible, forzamos el modo estética
                try {
                    const { loadEsteticaKB } = await import('../utils/ai/strategies/esteticaModules/domain/estetica.kb')
                    const kb = await loadEsteticaKB({ empresaId })
                    if (kb) isEstetica = true
                } catch { /* no-op */ }

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
                    console.log('[WEBHOOK] human-like delay ms =', delayMs, { mode, appointmentEnabled: bca?.appointmentEnabled, isEstetica })
                }
                await sleep(delayMs)

                console.log('[IA] Llamando handler con:', {
                    conversationId: conversation.id,
                    empresaId,
                    toPhone: conversation.phone,
                    phoneNumberId,
                    contenido,
                    isEstetica,
                    mode,
                })

                // Resultado (de estética o genérico)
                let result: any

                try {
                    if (isEstetica) {
                        // ⚡ Usa el flujo específico para estética
                        const { handleEsteticaReply } = await import('../utils/ai/strategies/estetica.strategy')
                        result = await handleEsteticaReply({
                            conversationId: conversation.id,
                            empresaId,
                            contenido,
                            toPhone: conversation.phone,
                            phoneNumberId,
                        })
                    } else {
                        // 💬 Mantiene el flujo general para otras empresas
                        result = await handleIAReply(conversation.id, contenido, {
                            autoSend: true,
                            toPhone: conversation.phone,
                            phoneNumberId,
                        })
                    }

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
                    console.error('[IA] handler lanzó error:', e?.response?.data || e?.message || e)
                    result = {
                        estado: ConversationEstado.en_proceso,
                        mensaje: 'Gracias por tu mensaje. ¿Podrías darme un poco más de contexto?',
                        messageId: undefined,
                    } as any
                }

                console.log('[IA] Resultado:', {
                    estado: result?.estado,
                    messageId: result?.messageId,
                    wamid: result?.wamid,
                    mediaCount: result?.media?.length || 0,
                    mensaje: result?.mensaje,
                })

                // 4) Persistir/emitir SIEMPRE la respuesta del bot (con fallback)
                let botMessageId = result?.messageId ?? undefined
                let botContenido = (result?.mensaje || '').trim()

                // 🧵 Modo post-agenda: aunque la IA genere texto, NO lo enviamos al cliente.
                // Solo usamos la IA para actualizar conversation_state (summary, draft, etc.).
                if (
                    conversation.estado === ConversationEstado.agendado ||
                    conversation.estado === ConversationEstado.agendado_consulta
                ) {
                    botContenido = ''
                }


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
                        const io2 = req.app.get('io') as any
                        io2?.emit?.('nuevo_mensaje', {
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
                        .map((m: any) => m.wamid)
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
                            const io3 = req.app.get('io') as any
                            io3?.emit?.('nuevo_mensaje', {
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