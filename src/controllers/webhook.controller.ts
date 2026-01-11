// import { Request, Response } from 'express'
// import prisma from '../lib/prisma'
// import { handleIAReply } from '../utils/handleIAReply'
// import { MessageFrom, ConversationEstado, MediaType } from '@prisma/client'
// import {
//     getMediaUrl,
//     downloadMediaToBuffer,
// } from '../services/whatsapp.service'
// import { transcribeAudioBuffer } from '../services/transcription.service'
// import { buildSignedMediaURL } from '../routes/mediaProxy.route'
// import { cacheWhatsappMediaToCloudflare, clearFocus } from '../utils/cacheWhatsappMedia'

// const REPLY_DELAY_FIRST_MS = Number(process.env.REPLY_DELAY_FIRST_MS ?? 180_000)
// const REPLY_DELAY_NEXT_MS = Number(process.env.REPLY_DELAY_NEXT_MS ?? 120_000)

// const SUBS_GRACE_DAYS = 2

// function addDays(date: Date, days: number): Date {
//     const d = new Date(date)
//     d.setDate(d.getDate() + days)
//     return d
// }

// async function getTrialStatus(empresaId: number) {
//     const emp = await prisma.empresa.findUnique({
//         where: { id: empresaId },
//         select: { createdAt: true, trialEnd: true },
//     })
//     if (!emp) return { active: false, endsAt: null as Date | null }

//     const endsAt =
//         emp.trialEnd ??
//         new Date(emp.createdAt.getTime() + 7 * 24 * 60 * 60 * 1000)

//     const active = Date.now() <= endsAt.getTime()
//     return { active, endsAt }
// }

// async function getSubscriptionAccessStatus(empresaId: number) {
//     const sub = await prisma.subscription.findFirst({
//         where: { empresaId, status: 'active' },
//         orderBy: { createdAt: 'desc' },
//     })

//     if (!sub) {
//         return {
//             active: false,
//             inGrace: false,
//             endsAt: null as Date | null,
//         }
//     }

//     const now = new Date()
//     const end = sub.currentPeriodEnd
//     const graceLimit = addDays(end, SUBS_GRACE_DAYS)

//     const active = now <= graceLimit
//     const inGrace = now > end && now <= graceLimit

//     return {
//         active,
//         inGrace,
//         endsAt: end,
//     }
// }

// export const verifyWebhook = (req: Request, res: Response) => {
//     const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN
//     const mode = req.query['hub.mode'] as string | undefined
//     const token = req.query['hub.verify_token'] as string | undefined
//     const challenge = req.query['hub.challenge'] as string | undefined

//     if (mode === 'subscribe' && token === VERIFY_TOKEN) {
//         console.log('🟢 Webhook verificado correctamente')
//         return res.status(200).send(challenge ?? '')
//     } else {
//         console.warn('🔴 Verificación de webhook fallida')
//         return res.sendStatus(403)
//     }
// }

// export const receiveWhatsappMessage = async (req: Request, res: Response) => {
//     console.log('📩 Webhook recibido:', JSON.stringify(req.body, null, 2))

//     let responded = false

//     try {
//         const entry: any = req.body?.entry?.[0]
//         const change: any = entry?.changes?.[0]
//         const value: any = change?.value

//         if (value?.statuses?.length) {
//             const io = req.app.get('io') as any
//             for (const st of value.statuses as any[]) {
//                 const codes = (st.errors || []).map((e: any) => e.code)
//                 console.log('[WA status]', { recipient: st.recipient_id, status: st.status, codes })
//                 if (st.status === 'failed') {
//                     io?.emit?.('wa_policy_error', {
//                         conversationId: await resolveConversationIdByWaId(req, st.recipient_id),
//                         code: codes?.[0],
//                         message:
//                             'Ventana de 24h cerrada o error de política. Se requiere plantilla para iniciar la conversación.',
//                     })
//                 }
//             }
//             return res.status(200).json({ handled: 'statuses' })
//         }

//         if (!value?.messages?.[0]) return res.status(200).json({ ignored: true })

//         const msg: any = value.messages[0]
//         const phoneNumberId: string | undefined = value?.metadata?.phone_number_id
//         const fromWa: string | undefined = msg.from
//         const ts: Date = msg.timestamp ? new Date(parseInt(msg.timestamp as string, 10) * 1000) : new Date()

//         if (!phoneNumberId || !fromWa) return res.status(200).json({ ignored: true })

//         try {
//             const already = await prisma.message.findFirst({
//                 where: { externalId: String(msg.id) }
//             })
//             if (already) {
//                 console.log('[DEDUP] inbound ya existente, externalId=', msg.id)
//                 return res.status(200).json({ success: true, dedup: true })
//             }
//         } catch (e) {
//             console.warn('[DEDUP] consulta falló (continuo):', (e as any)?.message || e)
//         }

//         const cuenta = await prisma.whatsappAccount.findUnique({
//             where: { phoneNumberId },
//             include: { empresa: true },
//         })
//         if (!cuenta || cuenta.empresa.estado !== 'activo') {
//             console.warn(`⚠️ Empresa inactiva o no encontrada para el número: ${phoneNumberId}`)
//             return res.status(200).json({ ignored: true })
//         }
//         const empresaId = cuenta.empresaId
//         const empresaData = cuenta.empresa

//         let conversation = await prisma.conversation.findFirst({ where: { phone: fromWa, empresaId } })

//         const isNewSession = !conversation || conversation.estado === ConversationEstado.cerrado
//         const isLimitReached = empresaData.conversationsUsed >= empresaData.monthlyConversationLimit

//         if (isNewSession && isLimitReached) {
//             console.warn(`🚫 [BILLING] Límite alcanzado. Bloqueando.`)
//             const io = req.app.get('io') as any
//             io?.emit?.('wa_policy_error', {
//                 conversationId: conversation?.id || 0,
//                 phone: fromWa,
//                 code: 'limit_reached',
//                 message: 'Has alcanzado el límite mensual de conversaciones. Compra más créditos.',
//             })
//             return res.status(200).json({ ignored: true, reason: 'monthly_limit_reached' })
//         }

//         if (isNewSession) {
//             await prisma.empresa.update({
//                 where: { id: empresaId },
//                 data: { conversationsUsed: { increment: 1 } }
//             })
//         }

//         if (!conversation) {
//             conversation = await prisma.conversation.create({
//                 data: { phone: fromWa, estado: ConversationEstado.pendiente, empresaId },
//             })
//             clearFocus(conversation.id)
//             console.log('[CONV] creada', { id: conversation.id, phone: fromWa })
//         } else if (conversation.estado === ConversationEstado.cerrado) {
//             await prisma.conversation.update({
//                 where: { id: conversation.id },
//                 data: { estado: ConversationEstado.pendiente },
//             })
//             conversation.estado = ConversationEstado.pendiente
//             clearFocus(conversation.id)
//             console.log('[CONV] reabierta', { id: conversation.id })
//         }

//         // 🔒 Regla post-agenda: si entra mensaje del cliente y la conversación estaba agendada
//         // pasa automáticamente a "agendado_consulta".
//         let isPostAgendaMessage = false
//         if (conversation.estado === ConversationEstado.agendado) {
//             await prisma.conversation.update({
//                 where: { id: conversation.id },
//                 data: { estado: ConversationEstado.agendado_consulta },
//             })
//             conversation.estado = ConversationEstado.agendado_consulta
//             isPostAgendaMessage = true

//             const io = req.app.get('io') as any
//             io?.emit?.('estado_actualizado', {
//                 conversationId: conversation.id,
//                 estado: conversation.estado,
//             })
//         }

//         let contenido: string =
//             msg.text?.body ||
//             msg.button?.text ||
//             msg.interactive?.list_reply?.title ||
//             '[mensaje no soportado]'

//         let inboundMediaType: MediaType | undefined
//         let inboundMediaId: string | undefined
//         let inboundMime: string | undefined
//         let transcription: string | undefined
//         let isVoiceNote = false
//         let mediaUrlForFrontend: string | undefined
//         let captionForDb: string | undefined

//         let skipIAForThisWebhook = false

//         if (msg.type === 'audio' && msg.audio?.id) {
//             inboundMediaType = MediaType.audio
//             inboundMediaId = String(msg.audio.id)
//             inboundMime = msg.audio?.mime_type as string | undefined
//             isVoiceNote = Boolean(msg.audio?.voice)

//             try {
//                 const signedUrl = await getMediaUrl(empresaId, inboundMediaId)
//                 const buf = await downloadMediaToBuffer(empresaId, signedUrl)

//                 const guessedName =
//                     inboundMime?.includes('mp3') ? 'nota-voz.mp3'
//                         : inboundMime?.includes('wav') ? 'nota-voz.wav'
//                             : inboundMime?.includes('m4a') ? 'nota-voz.m4a'
//                                 : inboundMime?.includes('webm') ? 'nota-voz.webm'
//                                     : 'nota-voz.ogg'

//                 const texto = await transcribeAudioBuffer(buf, guessedName)
//                 transcription = (texto || '').trim()
//             } catch (e) {
//                 console.warn('[AUDIO] No se pudo transcribir.', e)
//             }

//             contenido = transcription || '[nota de voz]'
//             if (inboundMediaId) mediaUrlForFrontend = buildSignedMediaURL(inboundMediaId, empresaId)
//         }
//         else if (msg.type === 'image' && msg.image?.id) {
//             inboundMediaType = MediaType.image
//             inboundMediaId = String(msg.image.id)
//             inboundMime = msg.image?.mime_type as string | undefined
//             captionForDb = (msg.image?.caption as string | undefined) || undefined

//             contenido = captionForDb || '[imagen]'

//             try {
//                 const accessToken = cuenta.accessToken
//                 const { url } = await cacheWhatsappMediaToCloudflare({
//                     waMediaId: inboundMediaId,
//                     accessToken,
//                 })
//                 mediaUrlForFrontend = url
//             } catch (err) {
//                 if (inboundMediaId) mediaUrlForFrontend = buildSignedMediaURL(inboundMediaId, empresaId)
//             }

//             if (!captionForDb) {
//                 skipIAForThisWebhook = true
//             }
//         }
//         else if (msg.type === 'video' && msg.video?.id) {
//             inboundMediaType = MediaType.video
//             inboundMediaId = String(msg.video.id)
//             inboundMime = msg.video?.mime_type as string | undefined
//             captionForDb = (msg.video?.caption as string | undefined) || undefined

//             contenido = captionForDb || '[video]'
//             if (inboundMediaId) mediaUrlForFrontend = buildSignedMediaURL(inboundMediaId, empresaId)
//         }
//         else if (msg.type === 'document' && msg.document?.id) {
//             inboundMediaType = MediaType.document
//             inboundMediaId = String(msg.document.id)
//             inboundMime = msg.document?.mime_type as string | undefined
//             const filename = (msg.document?.filename as string | undefined) || undefined
//             captionForDb = filename

//             contenido = filename ? `[documento] ${filename}` : '[documento]'
//             if (inboundMediaId) mediaUrlForFrontend = buildSignedMediaURL(inboundMediaId, empresaId)
//         }

//         // =====================================================================
//         // 🛑 CORRECCIÓN AQUÍ: Bloqueamos la IA en 'agendado_consulta'
//         // =====================================================================
//         if (
//             conversation.estado === ConversationEstado.requiere_agente ||
//             conversation.estado === ConversationEstado.agendado_consulta // <--- AGREGADO
//         ) {
//             skipIAForThisWebhook = true
//         }

//         // Guardar ENTRANTE
//         const inboundData: any = {
//             conversationId: conversation.id,
//             empresaId,
//             from: MessageFrom.client,
//             contenido,
//             timestamp: ts,
//             mediaType: inboundMediaType,
//             mediaId: inboundMediaId,
//             mediaUrl: mediaUrlForFrontend,
//             mimeType: inboundMime,
//             transcription: transcription || undefined,
//             externalId: String(msg.id),
//         }
//         if (captionForDb) inboundData.caption = captionForDb
//         if (process.env.FEATURE_ISVOICENOTE === '1') inboundData.isVoiceNote = Boolean(isVoiceNote)

//         const inbound = await prisma.message.create({ data: inboundData })

//         const io = req.app.get('io') as any
//         io?.emit?.('nuevo_mensaje', {
//             conversationId: conversation.id,
//             message: {
//                 id: inbound.id,
//                 externalId: inbound.externalId ?? null,
//                 from: 'client',
//                 contenido,
//                 timestamp: inbound.timestamp.toISOString(),
//                 mediaType: inboundMediaType,
//                 mediaUrl: mediaUrlForFrontend,
//                 mimeType: inboundMime,
//                 transcription,
//                 isVoiceNote,
//                 caption: captionForDb,
//                 mediaId: inboundMediaId,
//             },
//             phone: conversation.phone,
//             nombre: conversation.nombre ?? conversation.phone,
//             estado: conversation.estado,
//         })

//         const skipEscalateForAudioNoTranscript = (msg.type === 'audio' && !transcription)

//         const { active: trialActive, endsAt: trialEndsAt } = await getTrialStatus(empresaId)
//         const {
//             active: subsActive,
//             inGrace,
//             endsAt: subsEndsAt,
//         } = await getSubscriptionAccessStatus(empresaId)

//         if (!trialActive && !subsActive) {
//             if (!responded) {
//                 res.status(200).json({ success: true, access: 'blocked' })
//                 responded = true
//             }

//             const ioBlock = req.app.get('io') as any
//             const ends = subsEndsAt || trialEndsAt
//             const fechaStr = ends ? ends.toLocaleDateString('es-CO') : null

//             let code = 'subscription_expired'
//             let message = 'Tu acceso a la IA está inactivo. Por favor renueva o activa un plan.'

//             if (subsEndsAt) {
//                 message = `Tu membresía terminó el ${fechaStr}. Renueva tu plan.`
//             } else if (trialEndsAt) {
//                 code = 'trial_expired'
//                 message = `La prueba gratuita terminó el ${fechaStr}. Activa tu plan.`
//             }

//             ioBlock?.emit?.('wa_policy_error', {
//                 conversationId: conversation.id,
//                 code,
//                 message,
//             })
//             return
//         }


//         if (skipIAForThisWebhook) {
//             if (!responded) {
//                 res.status(200).json({ success: true, skipped: 'post_agenda_or_manual' })
//                 responded = true
//             }
//             return
//         }

//         if (!responded) {
//             res.status(200).json({ success: true, processing: true })
//             responded = true
//         }

//         // ⚙️ Ejecutar IA en background
//         ; (async () => {
//             try {
//                 const bca = await prisma.businessConfigAppt.findUnique({
//                     where: { empresaId },
//                     select: { aiMode: true, appointmentEnabled: true },
//                 })

//                 const mode = (bca?.aiMode || '').toString().trim().toLowerCase()
//                 let isEstetica = mode === 'estetica' || bca?.appointmentEnabled === true

//                 try {
//                     const { loadEsteticaKB } = await import('../utils/ai/strategies/esteticaModules/domain/estetica.kb')
//                     const kb = await loadEsteticaKB({ empresaId })
//                     if (kb) isEstetica = true
//                 } catch { /* no-op */ }

//                 let delayMs = 0
//                 if (!isEstetica) {
//                     const prevBot = await prisma.message.findFirst({
//                         where: { conversationId: conversation.id, from: MessageFrom.bot },
//                         select: { id: true },
//                     })
//                     delayMs = prevBot ? REPLY_DELAY_NEXT_MS : REPLY_DELAY_FIRST_MS
//                 }

//                 await sleep(delayMs)

//                 let result: any

//                 try {
//                     if (isEstetica) {
//                         const { handleEsteticaReply } = await import('../utils/ai/strategies/estetica.strategy')
//                         result = await handleEsteticaReply({
//                             conversationId: conversation.id,
//                             empresaId,
//                             contenido,
//                             toPhone: conversation.phone,
//                             phoneNumberId,
//                         })
//                     } else {
//                         result = await handleIAReply(conversation.id, contenido, {
//                             autoSend: true,
//                             toPhone: conversation.phone,
//                             phoneNumberId,
//                         })
//                     }

//                     if (
//                         skipEscalateForAudioNoTranscript &&
//                         result?.estado === ConversationEstado.requiere_agente &&
//                         (result as any)?.motivo === 'palabra_clave'
//                     ) {
//                         result = {
//                             estado: ConversationEstado.en_proceso,
//                             mensaje: 'No pude escuchar bien tu nota de voz. ¿Puedes repetir o escribir lo que necesitas?',
//                             messageId: undefined,
//                         } as any
//                     }
//                 } catch (e: any) {
//                     console.error('[IA] handler lanzó error:', e)
//                     result = {
//                         estado: ConversationEstado.en_proceso,
//                         mensaje: 'Gracias por tu mensaje. ¿Podrías darme un poco más de contexto?',
//                         messageId: undefined,
//                     } as any
//                 }

//                 let botMessageId = result?.messageId ?? undefined
//                 let botContenido = (result?.mensaje || '').trim()

//                 if (botContenido && !botMessageId) {
//                     const creadoFallback = await prisma.message.create({
//                         data: {
//                             conversationId: conversation.id,
//                             empresaId,
//                             from: MessageFrom.bot,
//                             contenido: botContenido,
//                             timestamp: new Date(),
//                         },
//                     })
//                     botMessageId = creadoFallback.id
//                 }

//                 if (botContenido && botMessageId) {
//                     const creado = await prisma.message.findUnique({ where: { id: botMessageId } })

//                     if (result?.estado && result.estado !== conversation.estado) {
//                         await prisma.conversation.update({
//                             where: { id: conversation.id },
//                             data: { estado: result.estado },
//                         })
//                         conversation.estado = result.estado
//                     }

//                     if (creado) {
//                         const io2 = req.app.get('io') as any
//                         io2?.emit?.('nuevo_mensaje', {
//                             conversationId: conversation.id,
//                             message: {
//                                 id: creado.id,
//                                 externalId: creado.externalId ?? null,
//                                 from: 'bot',
//                                 contenido: creado.contenido,
//                                 timestamp: creado.timestamp.toISOString(),
//                             },
//                             estado: conversation.estado,
//                         })
//                     }
//                 }

//                 if (result?.media?.length) {
//                     // ... lógica de media (se mantiene igual)
//                 }
//             } catch (e) {
//                 console.error('[WEBHOOK bg IA] Error post-ACK:', e)
//             }
//         })()

//         return
//     } catch (error) {
//         console.error('[receiveWhatsappMessage] Error:', error)
//         if (!responded) {
//             return res.status(500).json({ error: 'Error al recibir mensaje' })
//         }
//     }
// }

// async function resolveConversationIdByWaId(_req: Request, waId: string): Promise<number | null> {
//     try {
//         const conv = await prisma.conversation.findFirst({ where: { phone: waId } })
//         return conv?.id ?? null
//     } catch {
//         return null
//     }
// }

// function sleep(ms: number) {
//     return new Promise(resolve => setTimeout(resolve, ms))
// }

import { Request, Response } from 'express'
import prisma from '../lib/prisma'
import { handleIAReply } from '../utils/handleIAReply'
import { MessageFrom, ConversationEstado, MediaType } from '@prisma/client'
import { getMediaUrl, downloadMediaToBuffer } from '../services/whatsapp.service'
import { transcribeAudioBuffer } from '../services/transcription.service'
import { buildSignedMediaURL } from '../routes/mediaProxy.route'
import { cacheWhatsappMediaToCloudflare, clearFocus } from '../utils/cacheWhatsappMedia'

const REPLY_DELAY_FIRST_MS = Number(process.env.REPLY_DELAY_FIRST_MS ?? 180_000)
const REPLY_DELAY_NEXT_MS = Number(process.env.REPLY_DELAY_NEXT_MS ?? 120_000)

const SUBS_GRACE_DAYS = 2

function addDays(date: Date, days: number): Date {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  return d
}

async function getTrialStatus(empresaId: number) {
  const emp = await prisma.empresa.findUnique({
    where: { id: empresaId },
    select: { createdAt: true, trialEnd: true },
  })
  if (!emp) return { active: false, endsAt: null as Date | null }

  const endsAt =
    emp.trialEnd ?? new Date(emp.createdAt.getTime() + 7 * 24 * 60 * 60 * 1000)

  const active = Date.now() <= endsAt.getTime()
  return { active, endsAt }
}

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

export const receiveWhatsappMessage = async (req: Request, res: Response) => {
  console.log('📩 Webhook recibido:', JSON.stringify(req.body, null, 2))

  let responded = false

  try {
    const entry: any = req.body?.entry?.[0]
    const change: any = entry?.changes?.[0]
    const value: any = change?.value

    // =========================
    // ✅ STATUS UPDATES (failed, delivered, etc.)
    // =========================
    if (value?.statuses?.length) {
      const io = req.app.get('io') as any
      const statusPhoneNumberId: string | undefined =
        value?.metadata?.phone_number_id

      for (const st of value.statuses as any[]) {
        const codes = (st.errors || []).map((e: any) => e.code)
        console.log('[WA status]', {
          recipient: st.recipient_id,
          status: st.status,
          codes,
        })

        if (st.status === 'failed') {
          io?.emit?.('wa_policy_error', {
            conversationId: await resolveConversationIdByWaId(
              statusPhoneNumberId,
              st.recipient_id
            ),
            code: codes?.[0],
            message:
              'Ventana de 24h cerrada o error de política. Se requiere plantilla para iniciar la conversación.',
          })
        }
      }

      return res.status(200).json({ handled: 'statuses' })
    }

    if (!value?.messages?.[0]) return res.status(200).json({ ignored: true })

    const msg: any = value.messages[0]
    const phoneNumberId: string | undefined = value?.metadata?.phone_number_id
    const fromWa: string | undefined = msg.from
    const ts: Date = msg.timestamp
      ? new Date(parseInt(msg.timestamp as string, 10) * 1000)
      : new Date()

    if (!phoneNumberId || !fromWa) return res.status(200).json({ ignored: true })

    const cuenta = await prisma.whatsappAccount.findUnique({
      where: { phoneNumberId },
      include: { empresa: true },
    })
    if (!cuenta || cuenta.empresa.estado !== 'activo') {
      console.warn(
        `⚠️ Empresa inactiva o no encontrada para el número: ${phoneNumberId}`
      )
      return res.status(200).json({ ignored: true })
    }

    const empresaId = cuenta.empresaId
    const empresaData = cuenta.empresa

    // ✅ Dedup "rápido" (multi-tenant)
    try {
      const already = await prisma.message.findFirst({
        where: {
          empresaId,
          externalId: String(msg.id),
        },
        select: { id: true },
      })
      if (already) {
        console.log('[DEDUP] inbound ya existente, externalId=', msg.id)
        return res.status(200).json({ success: true, dedup: true })
      }
    } catch (e) {
      console.warn('[DEDUP] consulta falló (continuo):', (e as any)?.message || e)
    }

    let conversation = await prisma.conversation.findFirst({
      where: { phone: fromWa, empresaId },
    })

    const isNewSession =
      !conversation || conversation.estado === ConversationEstado.cerrado
    const isLimitReached =
      empresaData.conversationsUsed >= empresaData.monthlyConversationLimit

    if (isNewSession && isLimitReached) {
      console.warn(`🚫 [BILLING] Límite alcanzado. Bloqueando.`)
      const io = req.app.get('io') as any
      io?.emit?.('wa_policy_error', {
        conversationId: conversation?.id || 0,
        phone: fromWa,
        code: 'limit_reached',
        message:
          'Has alcanzado el límite mensual de conversaciones. Compra más créditos.',
      })
      return res
        .status(200)
        .json({ ignored: true, reason: 'monthly_limit_reached' })
    }

    if (isNewSession) {
      await prisma.empresa.update({
        where: { id: empresaId },
        data: { conversationsUsed: { increment: 1 } },
      })
    }

    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: { phone: fromWa, estado: ConversationEstado.pendiente, empresaId },
      })
      clearFocus(conversation.id)
      console.log('[CONV] creada', { id: conversation.id, phone: fromWa })
    } else if (conversation.estado === ConversationEstado.cerrado) {
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { estado: ConversationEstado.pendiente },
      })
      conversation.estado = ConversationEstado.pendiente
      clearFocus(conversation.id)
      console.log('[CONV] reabierta', { id: conversation.id })
    }

    // 🔒 Regla post-agenda: si entra mensaje del cliente y la conversación estaba agendada
    // pasa automáticamente a "agendado_consulta".
    let isPostAgendaMessage = false
    if (conversation.estado === ConversationEstado.agendado) {
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { estado: ConversationEstado.agendado_consulta },
      })
      conversation.estado = ConversationEstado.agendado_consulta
      isPostAgendaMessage = true

      const io = req.app.get('io') as any
      io?.emit?.('estado_actualizado', {
        conversationId: conversation.id,
        estado: conversation.estado,
      })
    }

    let contenido: string =
      msg.text?.body ||
      msg.button?.text ||
      msg.interactive?.list_reply?.title ||
      '[mensaje no soportado]'

    let inboundMediaType: MediaType | undefined
    let inboundMediaId: string | undefined
    let inboundMime: string | undefined
    let transcription: string | undefined
    let isVoiceNote = false
    let mediaUrlForFrontend: string | undefined
    let captionForDb: string | undefined

    let skipIAForThisWebhook = false

    if (msg.type === 'audio' && msg.audio?.id) {
      inboundMediaType = MediaType.audio
      inboundMediaId = String(msg.audio.id)
      inboundMime = msg.audio?.mime_type as string | undefined
      isVoiceNote = Boolean(msg.audio?.voice)

      try {
        const signedUrl = await getMediaUrl(empresaId, inboundMediaId)
        const buf = await downloadMediaToBuffer(empresaId, signedUrl)

        const guessedName = inboundMime?.includes('mp3')
          ? 'nota-voz.mp3'
          : inboundMime?.includes('wav')
            ? 'nota-voz.wav'
            : inboundMime?.includes('m4a')
              ? 'nota-voz.m4a'
              : inboundMime?.includes('webm')
                ? 'nota-voz.webm'
                : 'nota-voz.ogg'

        const texto = await transcribeAudioBuffer(buf, guessedName)
        transcription = (texto || '').trim()
      } catch (e) {
        console.warn('[AUDIO] No se pudo transcribir.', e)
      }

      contenido = transcription || '[nota de voz]'
      if (inboundMediaId)
        mediaUrlForFrontend = buildSignedMediaURL(inboundMediaId, empresaId)
    } else if (msg.type === 'image' && msg.image?.id) {
      inboundMediaType = MediaType.image
      inboundMediaId = String(msg.image.id)
      inboundMime = msg.image?.mime_type as string | undefined
      captionForDb = (msg.image?.caption as string | undefined) || undefined

      contenido = captionForDb || '[imagen]'

      try {
        const accessToken = cuenta.accessToken
        const { url } = await cacheWhatsappMediaToCloudflare({
          waMediaId: inboundMediaId,
          accessToken,
        })
        mediaUrlForFrontend = url
      } catch (err) {
        if (inboundMediaId)
          mediaUrlForFrontend = buildSignedMediaURL(inboundMediaId, empresaId)
      }

      if (!captionForDb) {
        skipIAForThisWebhook = true
      }
    } else if (msg.type === 'video' && msg.video?.id) {
      inboundMediaType = MediaType.video
      inboundMediaId = String(msg.video.id)
      inboundMime = msg.video?.mime_type as string | undefined
      captionForDb = (msg.video?.caption as string | undefined) || undefined

      contenido = captionForDb || '[video]'
      if (inboundMediaId)
        mediaUrlForFrontend = buildSignedMediaURL(inboundMediaId, empresaId)
    } else if (msg.type === 'document' && msg.document?.id) {
      inboundMediaType = MediaType.document
      inboundMediaId = String(msg.document.id)
      inboundMime = msg.document?.mime_type as string | undefined
      const filename = (msg.document?.filename as string | undefined) || undefined
      captionForDb = filename

      contenido = filename ? `[documento] ${filename}` : '[documento]'
      if (inboundMediaId)
        mediaUrlForFrontend = buildSignedMediaURL(inboundMediaId, empresaId)
    }

    // =====================================================================
    // 🛑 Bloqueamos la IA en 'requiere_agente' y 'agendado_consulta'
    // =====================================================================
    if (
      conversation.estado === ConversationEstado.requiere_agente ||
      conversation.estado === ConversationEstado.agendado_consulta
    ) {
      skipIAForThisWebhook = true
    }

    // Guardar ENTRANTE (con dedup REAL por P2002)
    const inboundData: any = {
      conversationId: conversation.id,
      empresaId,
      from: MessageFrom.client,
      contenido,
      timestamp: ts,
      mediaType: inboundMediaType,
      mediaId: inboundMediaId,
      mediaUrl: mediaUrlForFrontend,
      mimeType: inboundMime,
      transcription: transcription || undefined,
      externalId: String(msg.id),
    }
    if (captionForDb) inboundData.caption = captionForDb
    if (process.env.FEATURE_ISVOICENOTE === '1')
      inboundData.isVoiceNote = Boolean(isVoiceNote)

    let inbound: any
    try {
      inbound = await prisma.message.create({ data: inboundData })
    } catch (e: any) {
      if (e?.code === 'P2002') {
        console.log('[DEDUP] inbound duplicado (P2002), externalId=', msg.id)
        return res.status(200).json({ success: true, dedup: true })
      }
      throw e
    }

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

    const skipEscalateForAudioNoTranscript =
      msg.type === 'audio' && !transcription

    const { active: trialActive, endsAt: trialEndsAt } = await getTrialStatus(
      empresaId
    )
    const { active: subsActive, inGrace, endsAt: subsEndsAt } =
      await getSubscriptionAccessStatus(empresaId)

    void inGrace // (por si TS te marca "unused"; si no, bórralo)

    if (!trialActive && !subsActive) {
      if (!responded) {
        res.status(200).json({ success: true, access: 'blocked' })
        responded = true
      }

      const ioBlock = req.app.get('io') as any
      const ends = subsEndsAt || trialEndsAt
      const fechaStr = ends ? ends.toLocaleDateString('es-CO') : null

      let code = 'subscription_expired'
      let message = 'Tu acceso a la IA está inactivo. Por favor renueva o activa un plan.'

      if (subsEndsAt) {
        message = `Tu membresía terminó el ${fechaStr}. Renueva tu plan.`
      } else if (trialEndsAt) {
        code = 'trial_expired'
        message = `La prueba gratuita terminó el ${fechaStr}. Activa tu plan.`
      }

      ioBlock?.emit?.('wa_policy_error', {
        conversationId: conversation.id,
        code,
        message,
      })
      return
    }

    if (skipIAForThisWebhook) {
      if (!responded) {
        res.status(200).json({ success: true, skipped: 'post_agenda_or_manual' })
        responded = true
      }
      return
    }

    if (!responded) {
      res.status(200).json({ success: true, processing: true })
      responded = true
    }

    // ⚙️ Ejecutar IA en background
    ;(async () => {
      try {
        const bca = await prisma.businessConfigAppt.findUnique({
          where: { empresaId },
          select: { aiMode: true, appointmentEnabled: true },
        })

        const mode = (bca?.aiMode || '').toString().trim().toLowerCase()
        let isEstetica = mode === 'estetica' || bca?.appointmentEnabled === true

        try {
          const { loadEsteticaKB } = await import(
            '../utils/ai/strategies/esteticaModules/domain/estetica.kb'
          )
          const kb = await loadEsteticaKB({ empresaId })
          if (kb) isEstetica = true
        } catch {
          /* no-op */
        }

        let delayMs = 0
        if (!isEstetica) {
          const prevBot = await prisma.message.findFirst({
            where: { conversationId: conversation.id, from: MessageFrom.bot },
            select: { id: true },
          })
          delayMs = prevBot ? REPLY_DELAY_NEXT_MS : REPLY_DELAY_FIRST_MS
        }

        await sleep(delayMs)

        let result: any

        try {
          if (isEstetica) {
            const { handleEsteticaReply } = await import(
              '../utils/ai/strategies/estetica.strategy'
            )
            result = await handleEsteticaReply({
              conversationId: conversation.id,
              empresaId,
              contenido,
              toPhone: conversation.phone,
              phoneNumberId,
            })
          } else {
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
              mensaje:
                'No pude escuchar bien tu nota de voz. ¿Puedes repetir o escribir lo que necesitas?',
              messageId: undefined,
            } as any
          }
        } catch (e: any) {
          console.error('[IA] handler lanzó error:', e)
          result = {
            estado: ConversationEstado.en_proceso,
            mensaje: 'Gracias por tu mensaje. ¿Podrías darme un poco más de contexto?',
            messageId: undefined,
          } as any
        }

        let botMessageId = result?.messageId ?? undefined
        const botContenido = (result?.mensaje || '').trim()

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
        }

        if (botContenido && botMessageId) {
          const creado = await prisma.message.findUnique({
            where: { id: botMessageId },
          })

          if (result?.estado && result.estado !== conversation.estado) {
            await prisma.conversation.update({
              where: { id: conversation.id },
              data: { estado: result.estado },
            })
            conversation.estado = result.estado
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

        if (result?.media?.length) {
          // ... lógica de media (se mantiene igual)
        }
      } catch (e) {
        console.error('[WEBHOOK bg IA] Error post-ACK:', e)
      }
    })()

    return
  } catch (error) {
    console.error('[receiveWhatsappMessage] Error:', error)
    if (!responded) {
      return res.status(500).json({ error: 'Error al recibir mensaje' })
    }
  }
}

// ✅ Multi-tenant resolver (con soporte cuando llega sin phoneNumberId)
async function resolveConversationIdByWaId(
  phoneNumberId: string | undefined,
  waId: string
): Promise<number | null> {
  try {
    if (!phoneNumberId) {
      const conv = await prisma.conversation.findFirst({
        where: { phone: waId },
        select: { id: true },
      })
      return conv?.id ?? null
    }

    const cuenta = await prisma.whatsappAccount.findUnique({
      where: { phoneNumberId },
      select: { empresaId: true },
    })
    if (!cuenta) return null

    const conv = await prisma.conversation.findFirst({
      where: { phone: waId, empresaId: cuenta.empresaId },
      select: { id: true },
    })

    return conv?.id ?? null
  } catch {
    return null
  }
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}
