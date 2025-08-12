// src/controllers/whatsapp.controller.ts
import { Request, Response } from 'express'
import axios from 'axios'
import prisma from '../lib/prisma'

const FB_VERSION = process.env.FB_VERSION || 'v20.0'

/* ===================== Helpers de error/log ===================== */
function metaError(err: any) {
    const e = err?.response?.data?.error || err?.response?.data || err
    return {
        ok: false,
        error: {
            message: e?.message ?? err?.message ?? 'Unknown error',
            type: e?.type,
            code: e?.code,
            error_subcode: e?.error_subcode,
            details: e, // cuerpo completo para inspección en frontend
        },
    }
}

function logMetaError(tag: string, err: any) {
    const e = err?.response?.data || err
    console.error(`[${tag}] Meta error:`, JSON.stringify(e, null, 2))
}

/** Helper: obtiene el accessToken guardado para la empresa */
async function getAccessToken(empresaId: number) {
    const acc = await prisma.whatsappAccount.findUnique({
        where: { empresaId },
        select: { accessToken: true },
    })
    if (!acc?.accessToken) throw new Error('No hay accessToken para la empresa')
    return acc.accessToken
}

/* =========================================================================================
 * EXISTENTES
 * =======================================================================================*/

// POST /api/whatsapp/conectar
export const guardarWhatsappAccount = async (req: Request, res: Response) => {
    try {
        const empresaId = (req as any).user?.empresaId
        if (!empresaId) return res.status(401).json({ ok: false, error: 'No autorizado' })

        const { accessToken, phoneNumberId, wabaId, businessId, displayPhoneNumber } = req.body
        if (!accessToken || !phoneNumberId || !wabaId || !businessId || !displayPhoneNumber) {
            return res.status(400).json({ ok: false, error: 'Faltan datos requeridos' })
        }

        const cuenta = await prisma.whatsappAccount.upsert({
            where: { empresaId },
            update: { accessToken, phoneNumberId, wabaId, businessId, displayPhoneNumber },
            create: { empresaId, accessToken, phoneNumberId, wabaId, businessId, displayPhoneNumber },
        })

        return res.json({ ok: true, cuenta })
    } catch (err) {
        console.error('[guardarWhatsappAccount] error:', err)
        return res.status(500).json({ ok: false, error: 'Error al guardar conexión de WhatsApp' })
    }
}

// GET /api/whatsapp/estado
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

// DELETE /api/whatsapp/eliminar
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

/**
 * POST /api/whatsapp/actualizar-datos  (requiere business_management)
 * - Corrige uso de /me?fields=business (singular para System User)
 * - Valida que wabaId y phoneNumberId realmente pertenezcan a ese Business/WABA
 * - Permite forzar wabaId/phoneNumberId vía body
 */
export const actualizarDatosWhatsapp = async (req: Request, res: Response) => {
    try {
        const empresaId = (req as any).user?.empresaId
        if (!empresaId) return res.status(401).json({ ok: false, error: 'No autorizado' })

        const cuenta = await prisma.whatsappAccount.findUnique({ where: { empresaId } })
        if (!cuenta) return res.status(404).json({ ok: false, error: 'No hay conexión de WhatsApp para esta empresa' })

        const accessToken = cuenta.accessToken

        // 1) Obtener el Business del token (System User)
        const meResp = await axios.get(`https://graph.facebook.com/${FB_VERSION}/me`, {
            params: { fields: 'id,name,business', access_token: accessToken },
        })
        const businessId: string | undefined = meResp.data?.business?.id
        if (!businessId) {
            return res.status(400).json({ ok: false, error: 'El token no está vinculado a un Business (System User sin business)' })
        }

        // 2) WABAs pertenecientes al Business
        const wabaResp = await axios.get(
            `https://graph.facebook.com/${FB_VERSION}/${businessId}/owned_whatsapp_business_accounts`,
            { params: { fields: 'id,name', access_token: accessToken } },
        )
        const wabas: Array<{ id: string; name?: string }> = wabaResp.data?.data || []
        if (wabas.length === 0) return res.status(400).json({ ok: false, error: `El Business ${businessId} no posee WABAs` })

        // 3) Elegir WABA: prioriza el enviado por body, sino el ya guardado, sino el primero
        const desiredWabaId: string =
            req.body?.wabaId || cuenta.wabaId || wabas[0].id

        const waba = wabas.find(w => String(w.id) === String(desiredWabaId))
        if (!waba) {
            return res.status(400).json({
                ok: false,
                error: `El WABA ${desiredWabaId} no pertenece al Business del token (${businessId})`,
            })
        }

        // 4) Listar números del WABA y validar phoneNumberId
        const phoneResp = await axios.get(
            `https://graph.facebook.com/${FB_VERSION}/${desiredWabaId}/phone_numbers`,
            { params: { fields: 'id,display_phone_number,wa_id,quality_rating', access_token: accessToken } },
        )
        const phones: Array<{ id: string; display_phone_number: string; wa_id?: string }> = phoneResp.data?.data || []
        if (phones.length === 0) return res.status(400).json({ ok: false, error: `El WABA ${desiredWabaId} no tiene números` })

        // Elegir número: prioriza body, sino el ya guardado, sino el primero
        const desiredPhoneId: string =
            req.body?.phoneNumberId || cuenta.phoneNumberId || phones[0].id

        const phone = phones.find(p => String(p.id) === String(desiredPhoneId))
        if (!phone) {
            return res.status(400).json({
                ok: false,
                error: `El phoneNumberId ${desiredPhoneId} no pertenece al WABA ${desiredWabaId}`,
            })
        }

        // (doble verificación) ficha directa del número
        const pnInfo = await axios.get(
            `https://graph.facebook.com/${FB_VERSION}/${desiredPhoneId}`,
            { params: { fields: 'id,display_phone_number,wa_id,account_mode', access_token: accessToken } },
        )
        const wa_id = pnInfo.data?.wa_id
        if (wa_id && String(wa_id) !== String(desiredWabaId)) {
            return res.status(400).json({
                ok: false,
                error: `El phone_number_id ${desiredPhoneId} pertenece a WABA ${wa_id}, no a ${desiredWabaId}`,
            })
        }

        await prisma.whatsappAccount.update({
            where: { empresaId },
            data: {
                businessId,
                wabaId: String(desiredWabaId),
                phoneNumberId: String(desiredPhoneId),
                displayPhoneNumber: pnInfo.data?.display_phone_number || phone.display_phone_number,
            },
        })

        return res.json({
            ok: true,
            mensaje: 'Datos de WhatsApp actualizados correctamente',
            businessId,
            wabaId: String(desiredWabaId),
            phoneNumberId: String(desiredPhoneId),
            displayPhoneNumber: pnInfo.data?.display_phone_number || phone.display_phone_number,
        })
    } catch (err: any) {
        logMetaError('actualizarDatosWhatsapp', err)
        return res.status(500).json(metaError(err))
    }
}

/* =========================================================================================
 * CLOUD API – Registro / Envío / Utilidades
 * =======================================================================================*/

// POST /api/whatsapp/registrar
export const registrarNumero = async (req: Request, res: Response) => {
    try {
        const empresaId = (req as any).user?.empresaId
        if (!empresaId) return res.status(401).json({ ok: false, error: 'No autorizado' })

        const { phoneNumberId, pin } = req.body
        if (!phoneNumberId) return res.status(400).json({ ok: false, error: 'phoneNumberId requerido' })

        const accessToken = await getAccessToken(empresaId)
        const url = `https://graph.facebook.com/${FB_VERSION}/${phoneNumberId}/register`

        const payload: any = { messaging_product: 'whatsapp' }
        if (pin && String(pin).length === 6) payload.pin = String(pin)

        const { data } = await axios.post(url, payload, {
            headers: { Authorization: `Bearer ${accessToken}` },
        })
        return res.json({ ok: true, data })
    } catch (err: any) {
        logMetaError('registrarNumero', err)
        // Si pin es requerido, devuelve mensaje más claro
        const m = err?.response?.data?.error?.message || ''
        const c = err?.response?.data?.error?.code
        if (c === 100 && /pin/i.test(m)) {
            return res.status(400).json({
                ok: false,
                error: { message: 'Meta exige PIN de 6 dígitos para registrar este número.', code: 100, details: err?.response?.data },
            })
        }
        return res.status(400).json(metaError(err))
    }
}

// POST /api/whatsapp/request-code  (SMS/VOICE)
export const requestCode = async (req: Request, res: Response) => {
    try {
        const empresaId = (req as any).user?.empresaId
        if (!empresaId) return res.status(401).json({ ok: false, error: 'No autorizado' })

        const { phoneNumberId, method = 'SMS', locale = 'es_CO' } = req.body
        if (!phoneNumberId) return res.status(400).json({ ok: false, error: 'phoneNumberId requerido' })

        const accessToken = await getAccessToken(empresaId)
        const url = `https://graph.facebook.com/${FB_VERSION}/${phoneNumberId}/request_code`

        const { data } = await axios.post(
            url,
            { method, locale },
            { headers: { Authorization: `Bearer ${accessToken}` } },
        )
        return res.json({ ok: true, data })
    } catch (err: any) {
        logMetaError('requestCode', err)
        return res.status(400).json(metaError(err))
    }
}

// POST /api/whatsapp/verify-code
export const verifyCode = async (req: Request, res: Response) => {
    try {
        const empresaId = (req as any).user?.empresaId
        if (!empresaId) return res.status(401).json({ ok: false, error: 'No autorizado' })

        const { phoneNumberId, code } = req.body
        if (!phoneNumberId || !code) return res.status(400).json({ ok: false, error: 'phoneNumberId y code requeridos' })

        const accessToken = await getAccessToken(empresaId)
        const url = `https://graph.facebook.com/${FB_VERSION}/${phoneNumberId}/verify_code`

        const { data } = await axios.post(
            url,
            { code: String(code) },
            { headers: { Authorization: `Bearer ${accessToken}` } },
        )
        return res.json({ ok: true, data })
    } catch (err: any) {
        logMetaError('verifyCode', err)
        return res.status(400).json(metaError(err))
    }
}

// POST /api/whatsapp/enviar-prueba  (texto libre)
export const enviarPrueba = async (req: Request, res: Response) => {
    try {
        const empresaId = (req as any).user?.empresaId
        if (!empresaId) return res.status(401).json({ ok: false, error: 'No autorizado' })

        const { phoneNumberId, to, body } = req.body
        if (!phoneNumberId || !to || !body) {
            return res.status(400).json({ ok: false, error: 'phoneNumberId, to y body son requeridos' })
        }

        const accessToken = await getAccessToken(empresaId)
        // Cloud API espera E.164 sin "+"
        const toSanitized = String(to).replace(/\D+/g, '')
        console.log('[enviarPrueba] phoneNumberId:', phoneNumberId, 'to:', toSanitized, 'bodyLen:', String(body).length)

        const url = `https://graph.facebook.com/${FB_VERSION}/${phoneNumberId}/messages`
        const { data } = await axios.post(
            url,
            { messaging_product: 'whatsapp', to: toSanitized, type: 'text', text: { body } },
            { headers: { Authorization: `Bearer ${accessToken}` } },
        )

        return res.json({ ok: true, data })
    } catch (err: any) {
        logMetaError('enviarPrueba', err)
        // Diagnósticos comunes
        const code = err?.response?.data?.error?.code
        const msg = err?.response?.data?.error?.message || ''
        // Ventana 24h / requiere plantilla
        if (/24|template|message template|HSM|outside the 24/i.test(msg)) {
            return res.status(400).json({
                ok: false,
                error: { message: 'El usuario está fuera de la ventana de 24h: usa una plantilla aprobada.', code, details: err?.response?.data },
            })
        }
        // Número no registrado
        if (/not registered|phone number is not registered/i.test(msg)) {
            return res.status(400).json({
                ok: false,
                error: { message: 'El número no está registrado en Cloud API: completa request_code → verify_code → register (con PIN si aplica).', code, details: err?.response?.data },
            })
        }
        return res.status(400).json(metaError(err))
    }
}

// GET /api/whatsapp/numero/:phoneNumberId
export const infoNumero = async (req: Request, res: Response) => {
    try {
        const empresaId = (req as any).user?.empresaId
        if (!empresaId) return res.status(401).json({ ok: false, error: 'No autorizado' })

        const { phoneNumberId } = req.params
        const accessToken = await getAccessToken(empresaId)

        const url = `https://graph.facebook.com/${FB_VERSION}/${phoneNumberId}`
        const { data } = await axios.get(url, {
            params: { fields: 'display_phone_number,verified_name,name_status,wa_id,account_mode', access_token: accessToken },
        })

        return res.json({ ok: true, data })
    } catch (err: any) {
        logMetaError('infoNumero', err)
        return res.status(400).json(metaError(err))
    }
}

// POST /api/whatsapp/vincular-manual
export const vincularManual = async (req: Request, res: Response) => {
    try {
        const empresaId = (req as any).user?.empresaId
        if (!empresaId) return res.status(401).json({ ok: false, error: 'No autorizado' })

        const { accessToken, wabaId, phoneNumberId, displayPhoneNumber, businessId } = req.body
        if (!accessToken) return res.status(400).json({ ok: false, error: 'accessToken requerido' })

        const actual = await prisma.whatsappAccount.findUnique({ where: { empresaId } })

        const update: any = {
            accessToken,
            wabaId: wabaId ?? actual?.wabaId ?? '',
            phoneNumberId: phoneNumberId ?? actual?.phoneNumberId ?? '',
            displayPhoneNumber: displayPhoneNumber ?? actual?.displayPhoneNumber ?? '',
            businessId: businessId ?? actual?.businessId ?? 'unknown',
        }

        const cuenta = await prisma.whatsappAccount.upsert({
            where: { empresaId },
            update,
            create: { empresaId, ...update },
        })

        return res.json({ ok: true, cuenta })
    } catch (err) {
        console.error('[vincularManual] error:', err)
        return res.status(500).json({ ok: false, error: 'Error al guardar datos de WhatsApp' })
    }
}

/* ===================== Utilidades de debug & health ===================== */

// GET /api/whatsapp/debug-token  (debug del token guardado en BD)
export const debugToken = async (req: Request, res: Response) => {
    try {
        const empresaId = (req as any).user?.empresaId
        if (!empresaId) return res.status(401).json({ ok: false, error: 'No autorizado' })

        const token = await getAccessToken(empresaId)
        const appAccessToken = `${process.env.META_APP_ID}|${process.env.META_APP_SECRET}`

        const { data } = await axios.get(`https://graph.facebook.com/${FB_VERSION}/debug_token`, {
            params: { input_token: token, access_token: appAccessToken },
        })
        return res.json({ ok: true, data })
    } catch (err) {
        logMetaError('debugToken', err)
        return res.status(400).json(metaError(err))
    }
}

// POST /api/whatsapp/debug-token-inline  (opcional: debug de un token pegado en body)
export const debugTokenInline = async (req: Request, res: Response) => {
    try {
        const { input_token, expected_waba_id } = req.body as { input_token: string; expected_waba_id?: string }
        if (!input_token) return res.status(400).json({ ok: false, error: 'Falta input_token' })

        const APP_ID = process.env.META_APP_ID
        const APP_SECRET = process.env.META_APP_SECRET
        if (!APP_ID || !APP_SECRET) return res.status(500).json({ ok: false, error: 'Faltan META_APP_ID / META_APP_SECRET' })

        const appAccessToken = `${APP_ID}|${APP_SECRET}`
        const { data } = await axios.get(`https://graph.facebook.com/${FB_VERSION}/debug_token`, {
            params: { input_token, access_token: appAccessToken },
        })

        const gs = (data?.data?.granular_scopes || []) as Array<{ scope: string; target_ids?: string[] }>
        const wabaTargets = gs
            .filter(g => g.scope.startsWith('whatsapp_business_'))
            .flatMap(g => g.target_ids || [])
            .filter((v, i, a) => a.indexOf(v) === i)

        return res.json({
            ok: true,
            app_id: data?.data?.app_id,
            is_valid: data?.data?.is_valid,
            scopes: data?.data?.scopes,
            granular_scopes: gs,
            waba_ids: wabaTargets,
            matches_expected_waba: expected_waba_id ? wabaTargets.includes(String(expected_waba_id)) : undefined,
            raw: data,
        })
    } catch (err) {
        logMetaError('debugTokenInline', err)
        return res.status(400).json(metaError(err))
    }
}

// GET /api/whatsapp/health
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
