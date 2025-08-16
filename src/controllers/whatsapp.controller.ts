// src/controllers/whatsapp.controller.ts
import { Request, Response } from 'express'
import axios from 'axios'
import prisma from '../lib/prisma'
import { sendWhatsappMedia as sendMediaSvc } from '../services/whatsapp.services' // ⬅️ NUEVO

const FB_VERSION = process.env.FB_VERSION || 'v20.0'

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
        headers: { 'Content-Type': 'application/json' }
    })
    const list = Array.isArray(data?.data) ? data.data : []
    return list.some((t: any) => t.name === name)
}

/**
 * Intenta crear la plantilla fallback si no existe (no bloquea si falla).
 * Por defecto: name='hola', lang='es', categoría MARKETING (válida para proactivos).
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
        // seguimos e intentamos crear de todos modos
    }

    const url = `https://graph.facebook.com/${FB_VERSION}/${wabaId}/message_templates?access_token=${encodeURIComponent(accessToken)}`
    const payload = {
        name,
        category: 'MARKETING',
        allow_category_change: true,
        language: lang, // usa 'es' o variante regional si tu WABA lo requiere
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
            headers: { 'Content-Type': 'application/json' }
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

        // 3) Guardar/actualizar credenciales reales por empresa
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
 * Devuelve si la empresa tiene un número conectado y los IDs guardados
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
 * Borra la conexión (desvincula el número de la empresa en tu BD)
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
 * CLOUD API – Envío / Consulta (mínimo para MVP)
 * ========================================================================== */

/**
 * POST /api/whatsapp/enviar-prueba  (texto simple)
 */
export const enviarPrueba = async (req: Request, res: Response) => {
    try {
        const empresaId = (req as any).user?.empresaId
        if (!empresaId) return res.status(401).json({ ok: false, error: 'No autorizado' })

        const { phoneNumberId, to, body } = req.body
        if (!phoneNumberId || !to || !body) {
            return res.status(400).json({ ok: false, error: 'phoneNumberId, to y body son requeridos' })
        }

        const accessToken = await getAccessToken(empresaId)
        const toSanitized = sanitizePhone(to)
        const url = `https://graph.facebook.com/${FB_VERSION}/${phoneNumberId}/messages`

        const { data } = await axios.post(
            url,
            { messaging_product: 'whatsapp', to: toSanitized, type: 'text', text: { body } },
            { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
        )

        return res.json({ ok: true, data })
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
 * POST /api/whatsapp/media  (imagen o video/mp4)
 * body: { to, url, type: 'image' | 'video', caption? }
 */
export const enviarMedia = async (req: Request, res: Response) => {
    try {
        const empresaId = (req as any).user?.empresaId
        if (!empresaId) return res.status(401).json({ ok: false, error: 'No autorizado' })

        const { to, url, type, caption } = req.body as {
            to: string
            url: string
            type: 'image' | 'video'
            caption?: string
        }

        if (!to || !url || !type) {
            return res.status(400).json({ ok: false, error: 'to, url y type son requeridos' })
        }
        if (type !== 'image' && type !== 'video') {
            return res.status(400).json({ ok: false, error: 'type inválido: usa image o video' })
        }

        const toSanitized = sanitizePhone(to)

        const result = await sendMediaSvc({
            empresaId,
            to: toSanitized,
            url,
            type,
            caption,
        })

        return res.json({ ok: true, ...result })
    } catch (err: any) {
        logMetaError('enviarMedia', err)
        const msg = err?.response?.data?.error?.message || ''
        // Nota: para media, el error por ventana de 24h también puede aparecer
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
 * GET /api/whatsapp/numero/:phoneNumberId
 * Ficha del número
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
            headers: { 'Content-Type': 'application/json' }
        })

        return res.json({ ok: true, data })
    } catch (err: any) {
        logMetaError('infoNumero', err)
        return res.status(400).json(metaError(err))
    }
}

/* =============================================================================
 * Utilidades mínimas (soporte)
 * ========================================================================== */

export const debugToken = async (req: Request, res: Response) => {
    try {
        const empresaId = (req as any).user?.empresaId
        if (!empresaId) return res.status(401).json({ ok: false, error: 'No autorizado' })

        const token = await getAccessToken(empresaId)
        const appAccessToken = `${process.env.META_APP_ID}|${process.env.META_APP_SECRET}`

        const { data } = await axios.get(`https://graph.facebook.com/${FB_VERSION}/debug_token`, {
            params: { input_token: token, access_token: appAccessToken },
            headers: { 'Content-Type': 'application/json' }
        })
        return res.json({ ok: true, data })
    } catch (err) {
        logMetaError('debugToken', err)
        return res.status(400).json(metaError(err))
    }
}

export const health = async (req: Request, res: Response) => {
    try {
        const empresaId = (req as any).user?.empresaId
        if (!empresaId) return res.status(401).json({ ok: false, error: 'No autorizado' })

        const acc = await prisma.whatsappAccount.findUnique({ where: { empresaId } })
        if (!acc) return res.json({ ok: false, status: 'no_account' })

        const tokenLen = acc.accessToken?.length || 0
        const phoneOk = !!acc.phoneNumberId
        return res.json({
            ok: true,
            status: 'ready',
            diagnostics: {
                tokenLength: tokenLen,
                hasPhoneNumberId: phoneOk,
                hint: tokenLen < 200 ? 'Posible truncamiento de token' : 'Token OK',
            },
        })
    } catch (err) {
        console.error('[health] error:', err)
        return res.status(500).json({ ok: false, error: 'Error en health check' })
    }
}
