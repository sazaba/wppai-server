// src/controllers/whatsapp.controller.ts
import { Request, Response } from 'express'
import axios from 'axios'
import fs from 'fs/promises'
import jwt from 'jsonwebtoken'
import prisma from '../lib/prisma'

import {
    sendWhatsappMedia as sendMediaSvc,
    sendText as sendTextSvc,
    uploadToWhatsappMedia,
    sendWhatsappMediaById,
} from '../services/whatsapp.services'

const FB_VERSION = process.env.FB_VERSION || 'v20.0'
// ✅ normaliza (evita espacios o comillas perdidas de la UI del host)
const JWT_SECRET = (process.env.JWT_SECRET ?? 'dev-secret').trim()

/* ===================== Types locales ===================== */
type MulterReq = Request & { file?: Express.Multer.File }

/* ===================== Helpers ===================== */

function metaError(err: any) {
    const e = err?.response?.data?.error || err?.response?.data || err
    return {
        ok: false,
        error: {
            message: e?.message ?? err?.message ?? 'Unknown error',
            type: e?.type,
            code: e?.code,
            error_subcode: e?.error_subcode,
            details: e,
        },
    }
}

function logMetaError(tag: string, err: any) {
    const e = err?.response?.data || err
    console.error(`[${tag}] Meta error:`, JSON.stringify(e, null, 2))
}

async function getAccessToken(empresaId: number) {
    const acc = await prisma.whatsappAccount.findUnique({
        where: { empresaId },
        select: { accessToken: true },
    })
    if (!acc?.accessToken) throw new Error('No hay accessToken para la empresa')
    return acc.accessToken
}

function sanitizePhone(to: string | number) {
    return String(to).replace(/\D+/g, '')
}

/** Deducir tipo soportado por WhatsApp a partir del MIME */
function guessTypeFromMime(mime: string): 'image' | 'video' | 'audio' | 'document' {
    if (!mime) return 'document'
    if (mime.startsWith('image/')) return 'image'
    if (mime.startsWith('video/')) return 'video'
    if (mime.startsWith('audio/')) return 'audio'
    return 'document'
}

/** 🔏 Firma un token corto para pedir /media/:id desde <img>/<video> */
export function signMediaToken(empresaId: number, mediaId: string) {
    return jwt.sign({ empresaId, mediaId }, JWT_SECRET, { expiresIn: '10m' })
}

/** 🔎 1er intento: obtener empresaId desde (1) auth normal o (2) token ?t= */
function resolveEmpresaIdFromRequest(req: Request): { empresaId: number | null; why?: string } {
    const authEmpresa = (req as any).user?.empresaId
    if (authEmpresa) return { empresaId: Number(authEmpresa), why: 'req.user' }

    const tokenQ = (req.query?.t as string) || ''
    if (!tokenQ) return { empresaId: null, why: 'no_query_token' }
    try {
        const decoded = jwt.verify(tokenQ, JWT_SECRET) as any
        return { empresaId: Number(decoded?.empresaId) || null, why: 'jwt_query' }
    } catch (e: any) {
        console.warn('[streamMediaById] JWT inválido:', e?.name, e?.message)
        return { empresaId: null, why: `jwt_error:${e?.name || 'unknown'}` }
    }
}

/** 🔎 2do intento (fallback): inferir empresaId por mediaId desde tu DB */
/** 🔎 2do intento (fallback): inferir empresaId por mediaId desde tu DB */
async function resolveEmpresaIdByMediaId(mediaId: string): Promise<number | null> {
    try {
        // Usamos id (PK) para ordenar; es seguro y existe siempre.
        const msg = await prisma.message.findFirst({
            where: { mediaId },
            select: { empresaId: true, id: true },
            orderBy: { id: 'desc' },
        })
        return msg?.empresaId ?? null
    } catch (e: any) {
        console.warn(
            '[resolveEmpresaIdByMediaId] DB error:',
            e?.message || e
        )
        return null
    }
}


/**
 * ¿Existe la plantilla en Meta?
 */
async function templateExistsInMeta(params: {
    accessToken: string
    wabaId: string
    name: string
}) {
    const { accessToken, wabaId, name } = params
    const url = `https://graph.facebook.com/${FB_VERSION}/${wabaId}/message_templates`
    const { data } = await axios.get(url, {
        params: { access_token: accessToken, name, limit: 1 },
        headers: { 'Content-Type': 'application/json' },
    })
    const list = Array.isArray(data?.data) ? data.data : []
    return list.some((t: any) => t.name === name)
}

/**
 * Intenta crear la plantilla fallback si no existe (no bloquea si falla).
 */
async function ensureFallbackTemplateInMeta(params: {
    accessToken: string
    wabaId: string
    name: string
    lang: string
}) {
    const { accessToken, wabaId, name, lang } = params

    try {
        const exists = await templateExistsInMeta({ accessToken, wabaId, name })
        if (exists) return
    } catch (e) {
        console.warn(
            '[ensureFallbackTemplateInMeta] fallo consultando templates:',
            (e as any)?.response?.data || (e as any)?.message
        )
    }

    const url = `https://graph.facebook.com/${FB_VERSION}/${wabaId}/message_templates?access_token=${encodeURIComponent(
        accessToken
    )}`
    const payload = {
        name,
        category: 'MARKETING',
        allow_category_change: true,
        language: lang,
        components: [{ type: 'BODY', text: '¡Hola! Gracias por escribirnos. ¿En qué podemos ayudarte?' }],
    }

    try {
        await axios.post(url, payload, { headers: { 'Content-Type': 'application/json' } })
        console.log(`[Templates] Creada plantilla ${name}/${lang} en WABA ${wabaId}`)
    } catch (e: any) {
        console.warn('[Templates] No se pudo crear plantilla fallback:', e?.response?.data || e.message)
    }
}

/* =============================================================================
 * CONEXIÓN (flujo único)
 * ========================================================================== */

// POST /api/whatsapp/vincular
export const vincular = async (req: Request, res: Response) => {
    try {
        const empresaId = (req as any).user?.empresaId
        if (!empresaId) return res.status(401).json({ ok: false, error: 'No autorizado' })

        const { accessToken, phoneNumberId, wabaId, businessId, displayPhoneNumber } = req.body
        if (!accessToken || !phoneNumberId || !wabaId) {
            return res.status(400).json({ ok: false, error: 'Faltan accessToken, phoneNumberId o wabaId' })
        }

        // 1) Permisos del usuario
        const perms = await axios.get(`https://graph.facebook.com/${FB_VERSION}/me/permissions`, {
            params: { access_token: accessToken },
            headers: { 'Content-Type': 'application/json' },
        })
        const granted: string[] = (perms.data?.data || [])
            .filter((p: any) => p.status === 'granted')
            .map((p: any) => p.permission)
        const need = ['business_management', 'whatsapp_business_management', 'whatsapp_business_messaging']
        const missing = need.filter((p) => !granted.includes(p))
        if (missing.length) return res.status(403).json({ ok: false, error: `Faltan permisos: ${missing.join(', ')}` })

        // 2) Suscribir app a la WABA
        await axios
            .post(
                `https://graph.facebook.com/${FB_VERSION}/${wabaId}/subscribed_apps`,
                {},
                { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
            )
            .catch((e) => {
                const msg = e?.response?.data?.error?.message || e?.message
                throw new Error(`No pudimos suscribir tu WABA a la app. Detalle: ${msg}`)
            })

        // 3) Guardar/actualizar credenciales
        await prisma.whatsappAccount.upsert({
            where: { empresaId },
            update: {
                accessToken,
                phoneNumberId,
                wabaId,
                businessId: businessId || null,
                displayPhoneNumber: displayPhoneNumber || null,
                updatedAt: new Date(),
            },
            create: {
                empresaId,
                accessToken,
                phoneNumberId,
                wabaId,
                businessId: businessId || null,
                displayPhoneNumber: displayPhoneNumber || null,
            },
        })

        return res.json({ ok: true })
    } catch (e: any) {
        console.error('[vincular] error:', e?.response?.data || e?.message || e)
        return res.status(500).json({ ok: false, error: 'Error al guardar conexión de WhatsApp' })
    }
}

/**
 * GET /api/whatsapp/estado
 */
export const estadoWhatsappAccount = async (req: Request, res: Response) => {
    try {
        const empresaId = (req as any).user?.empresaId
        if (!empresaId) return res.status(401).json({ ok: false, error: 'No autorizado' })

        const cuenta = await prisma.whatsappAccount.findUnique({ where: { empresaId } })
        if (!cuenta) return res.json({ conectado: false })

        return res.json({
            conectado: true,
            phoneNumberId: cuenta.phoneNumberId,
            displayPhoneNumber: cuenta.displayPhoneNumber,
            wabaId: cuenta.wabaId,
            businessId: cuenta.businessId,
        })
    } catch (err) {
        console.error('[estadoWhatsappAccount] error:', err)
        return res.status(500).json({ ok: false, error: 'Error al consultar estado' })
    }
}

/**
 * DELETE /api/whatsapp/eliminar
 */
export const eliminarWhatsappAccount = async (req: Request, res: Response) => {
    try {
        const empresaId = (req as any).user?.empresaId
        if (!empresaId) return res.status(401).json({ ok: false, error: 'No autorizado' })

        await prisma.whatsappAccount.delete({ where: { empresaId } }).catch(() => null)
        return res.json({ ok: true, mensaje: 'Cuenta de WhatsApp eliminada correctamente' })
    } catch (err) {
        console.error('[eliminarWhatsappAccount] error:', err)
        return res.status(500).json({ ok: false, error: 'Error al eliminar cuenta de WhatsApp' })
    }
}

/* =============================================================================
 * CLOUD API – Envío / Consulta
 * ========================================================================== */

export const enviarPrueba = async (req: Request, res: Response) => {
    try {
        const empresaId = (req as any).user?.empresaId
        if (!empresaId) return res.status(401).json({ ok: false, error: 'No autorizado' })

        const { to, body, conversationId } = req.body as {
            to: string
            body: string
            conversationId?: number
            phoneNumberId?: string
        }
        if (!to || !body) {
            return res.status(400).json({ ok: false, error: 'to y body son requeridos' })
        }

        const toSanitized = sanitizePhone(to)
        const result = await sendTextSvc({ empresaId, to: toSanitized, body, conversationId })
        return res.json({ ok: true, ...result })
    } catch (err: any) {
        logMetaError('enviarPrueba', err)
        const code = err?.response?.data?.error?.code
        const msg = err?.response?.data?.error?.message || ''
        if (/24|template|message template|HSM|outside the 24/i.test(msg)) {
            return res.status(400).json({
                ok: false,
                error: {
                    message: 'El usuario está fuera de la ventana de 24h: usa una plantilla aprobada.',
                    code,
                    details: err?.response?.data,
                },
            })
        }
        if (/not registered|phone number is not registered/i.test(msg)) {
            return res.status(400).json({
                ok: false,
                error: {
                    message: 'El número no está registrado en Cloud API: registra/valida el número desde Meta.',
                    code,
                    details: err?.response?.data,
                },
            })
        }
        return res.status(400).json(metaError(err))
    }
}

/**
 * POST /api/whatsapp/media (por LINK)
 */
export const enviarMedia = async (req: Request, res: Response) => {
    try {
        const empresaId = (req as any).user?.empresaId as number
        if (!empresaId) return res.status(401).json({ ok: false, error: 'No autorizado' })

        const { to, url, type, caption, conversationId } = req.body as {
            to?: string
            url: string
            type: 'image' | 'video' | 'audio' | 'document'
            caption?: string
            conversationId?: number
        }

        // Resolver destino y conversationId
        let toFinal = (to || '').trim()
        let convId = conversationId
        if (!toFinal && conversationId) {
            const conv = await prisma.conversation.findUnique({
                where: { id: conversationId },
                select: { phone: true },
            })
            toFinal = conv?.phone || ''
        } else if (toFinal && !convId) {
            const existing = await prisma.conversation.findFirst({
                where: { phone: sanitizePhone(toFinal), empresaId },
                select: { id: true },
            })
            convId =
                existing?.id ||
                (
                    await prisma.conversation.create({
                        data: { phone: sanitizePhone(toFinal), estado: 'pendiente', empresaId },
                    })
                ).id
        }

        if (!toFinal || !url || !type) {
            return res.status(400).json({ ok: false, error: 'to, url y type son requeridos' })
        }
        if (!['image', 'video', 'audio', 'document'].includes(type)) {
            return res.status(400).json({ ok: false, error: 'type inválido' })
        }

        const toSanitized = sanitizePhone(toFinal)

        // 1) Enviar por LINK
        const result = await sendMediaSvc({
            empresaId,
            to: toSanitized,
            url,
            type,
            caption,
            conversationId: convId,
        })

        // 2) Emitir al frontend (mediaUrl = url pública)
        const io = req.app.get('io') as any
        if (io && convId) {
            io.emit('nuevo_mensaje', {
                conversationId: convId,
                message: {
                    id: null,
                    externalId: result?.outboundId ?? null,
                    from: 'bot',
                    contenido:
                        caption ||
                        (type === 'image'
                            ? '[imagen]'
                            : type === 'video'
                                ? '[video]'
                                : type === 'audio'
                                    ? '[nota de voz]'
                                    : '[documento]'),
                    timestamp: new Date().toISOString(),
                    mediaType: type,
                    mediaUrl: url,
                    mimeType: null,
                    caption: caption || null,
                },
            })
        }

        return res.json({ ok: true, ...result })
    } catch (err: any) {
        logMetaError('enviarMedia', err)
        const msg = err?.response?.data?.error?.message || ''
        if (/24|template|message template|HSM|outside the 24/i.test(msg)) {
            return res.status(400).json({
                ok: false,
                error: {
                    message: 'Fuera de la ventana de 24h: debes usar una plantilla aprobada para iniciar la conversación.',
                    details: err?.response?.data,
                },
            })
        }
        return res.status(400).json(metaError(err))
    }
}

/**
 * POST /api/whatsapp/media-upload
 */
export const enviarMediaUpload = async (req: MulterReq, res: Response) => {
    const tmpPath = req.file?.path
    try {
        const empresaId = Number((req as any).user?.empresaId)
        if (!empresaId) return res.status(401).json({ ok: false, error: 'No autorizado' })
        if (!tmpPath) return res.status(400).json({ ok: false, error: 'Archivo requerido (file)' })

        const body = (req.body || {}) as {
            to?: string
            type?: 'image' | 'video' | 'audio' | 'document'
            caption?: string
            conversationId?: number | string
        }

        const caption = (body.caption || '').toString()
        const mime = req.file!.mimetype || 'application/octet-stream'

        const waType = (body.type as any) || guessTypeFromMime(mime)
        if (!['image', 'video', 'audio', 'document'].includes(waType)) {
            return res.status(400).json({ ok: false, error: 'type inválido' })
        }

        // Resolver destino y conversación
        let toFinal = (body.to || '').trim()
        let convId = body.conversationId ? Number(body.conversationId) : undefined
        if (!toFinal && convId) {
            const conv = await prisma.conversation.findUnique({
                where: { id: convId },
                select: { phone: true },
            })
            toFinal = conv?.phone || ''
        } else if (toFinal && !convId) {
            const existing = await prisma.conversation.findFirst({
                where: { phone: sanitizePhone(toFinal), empresaId },
                select: { id: true },
            })
            convId =
                existing?.id ||
                (
                    await prisma.conversation.create({
                        data: { phone: sanitizePhone(toFinal), estado: 'pendiente', empresaId },
                    })
                ).id
        }
        if (!toFinal) {
            return res.status(400).json({ ok: false, error: 'to o conversationId son requeridos' })
        }

        const toSanitized = sanitizePhone(toFinal)

        // 1) subir archivo a /media
        const mediaId = await uploadToWhatsappMedia(empresaId, tmpPath, mime)

        // 2) enviar por media_id
        const result = await sendWhatsappMediaById({
            empresaId,
            to: toSanitized,
            type: waType,
            mediaId,
            caption,
            conversationId: convId,
            mimeType: mime,
        })

        // 3) Firmar URL del proxy para el frontend
        const token = signMediaToken(empresaId, mediaId)
        const mediaUrl = `/api/whatsapp/media/${mediaId}?t=${encodeURIComponent(token)}`

        // 4) Emitir al frontend
        const io = req.app.get('io') as any
        if (io && convId) {
            io.emit('nuevo_mensaje', {
                conversationId: convId,
                message: {
                    id: null,
                    externalId: result?.outboundId ?? null,
                    from: 'bot',
                    contenido:
                        caption ||
                        (waType === 'image'
                            ? '[imagen]'
                            : waType === 'video'
                                ? '[video]'
                                : waType === 'audio'
                                    ? '[nota de voz]'
                                    : '[documento]'),
                    timestamp: new Date().toISOString(),
                    mediaType: waType,
                    mediaUrl, // URL firmada
                    mimeType: mime ?? null,
                    caption: caption || null,
                    mediaId, // incluye mediaId para fallback en el front
                },
            })
        }

        // 5) limpiar archivo temporal
        try {
            await fs.unlink(tmpPath)
        } catch { }

        return res.json({ ok: true, mediaId, ...result })
    } catch (err: any) {
        try {
            if (tmpPath) await fs.unlink(tmpPath)
        } catch { }
        logMetaError('enviarMediaUpload', err)
        return res.status(400).json(metaError(err))
    }
}

/**
 * GET /api/whatsapp/numero/:phoneNumberId
 */
export const infoNumero = async (req: Request, res: Response) => {
    try {
        const empresaId = (req as any).user?.empresaId
        if (!empresaId) return res.status(401).json({ ok: false, error: 'No autorizado' })

        const { phoneNumberId } = req.params
        const accessToken = await getAccessToken(empresaId)

        const url = `https://graph.facebook.com/${FB_VERSION}/${phoneNumberId}`
        const { data } = await axios.get(url, {
            params: {
                fields: 'display_phone_number,verified_name,name_status,wa_id,account_mode',
                access_token: accessToken,
            },
            headers: { 'Content-Type': 'application/json' },
        })

        return res.json({ ok: true, data })
    } catch (err: any) {
        logMetaError('infoNumero', err)
        return res.status(400).json(metaError(err))
    }
}

/* =============================================================================
 * Stream de media por mediaId (proxy a WhatsApp)
 * ========================================================================== */

/**
 * GET /api/whatsapp/media/:mediaId
 * - Soporta auth normal (req.user) o token corto en ?t=
 * - Si el token falla, intenta resolver empresaId por DB (Message.mediaId)
 * - Devuelve en modo "inline".
 */
export const streamMediaById = async (req: Request, res: Response) => {
    try {
        const { mediaId } = req.params as { mediaId: string }
        if (!mediaId) return res.status(400).json({ ok: false, error: 'mediaId requerido' })

        // 1) Intento por token / req.user
        const attempt = resolveEmpresaIdFromRequest(req)

        // 2) Fallback por DB si falla
        let empresaId = attempt.empresaId
        if (!empresaId) {
            empresaId = await resolveEmpresaIdByMediaId(mediaId)
            if (empresaId) {
                console.log(`[streamMediaById] Fallback DB OK → empresaId=${empresaId} (mediaId=${mediaId})`)
            }
        } else {
            console.log(`[streamMediaById] Auth via ${attempt.why} → empresaId=${empresaId}`)
        }

        if (!empresaId) {
            console.warn('[streamMediaById] 401: empresaId nulo. query.t presente?', typeof req.query?.t === 'string')
            return res.status(401).json({ ok: false, error: 'No autorizado', reason: attempt.why || 'unknown' })
        }

        const accessToken = await getAccessToken(empresaId)

        // 3) Obtener URL firmada de Graph (pide también mime_type)
        const meta = await axios.get(`https://graph.facebook.com/${FB_VERSION}/${mediaId}`, {
            params: { fields: 'url,mime_type,file_size' },
            headers: { Authorization: `Bearer ${accessToken}` },
            timeout: 15000,
        })
        const mediaUrl = meta?.data?.url
        const mime = meta?.data?.mime_type as string | undefined

        if (!mediaUrl) return res.status(404).json({ ok: false, error: 'Media no encontrada' })

        // 4) Descargar y streamear
        const file = await axios.get(mediaUrl, {
            responseType: 'stream',
            headers: { Authorization: `Bearer ${accessToken}` },
            timeout: 30000,
        })

        res.setHeader('Content-Type', mime || file.headers['content-type'] || 'application/octet-stream')
        res.setHeader('Content-Disposition', 'inline')
        if (file.headers['content-length']) {
            res.setHeader('Content-Length', file.headers['content-length'] as string)
        }
        // Cache corto (5 min) — suficiente para evitar recargas agresivas del mismo media
        res.setHeader('Cache-Control', 'private, max-age=300')

        file.data.pipe(res)
    } catch (err: any) {
        const status = err?.response?.status
        const data = err?.response?.data
        if (status === 404) return res.status(404).json({ ok: false, error: 'Media no encontrada' })
        if (status === 401 || status === 403) {
            console.warn('[streamMediaById] 401/403 desde Graph:', data)
            return res.status(401).json({ ok: false, error: 'No autorizado para este media' })
        }
        console.error('[streamMediaById] error:', data || err.message || err)
        return res.status(500).json({ ok: false, error: 'No se pudo obtener la media' })
    }
}

/* =============================================================================
 * Utilidades
 * ========================================================================== */

export const debugToken = async (req: Request, res: Response) => {
    try {
        const empresaId = (req as any).user?.empresaId
        if (!empresaId) return res.status(401).json({ ok: false, error: 'No autorizado' })

        const token = await getAccessToken(empresaId)
        const appAccessToken = `${process.env.META_APP_ID}|${process.env.META_APP_SECRET}`

        const { data } = await axios.get(`https://graph.facebook.com/${FB_VERSION}/debug_token`, {
            params: { input_token: token, access_token: appAccessToken },
            headers: { 'Content-Type': 'application/json' },
        })
        return res.json({ ok: true, data })
    } catch (err) {
        logMetaError('debugToken', err)
        return res.status(400).json(metaError(err))
    }
}

export const health = async (_req: Request, res: Response) => {
    try {
        return res.json({ ok: true, status: 'ready' })
    } catch (err) {
        console.error('[health] error:', err)
        return res.status(500).json({ ok: false, error: 'Error en health check' })
    }
}
