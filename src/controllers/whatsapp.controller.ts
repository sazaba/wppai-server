// src/controllers/whatsapp.controller.ts
import { Request, Response } from 'express'
import axios from 'axios'
import prisma from '../lib/prisma'

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

/* =============================================================================
 * CONEXIÓN (flujo único)
 * ========================================================================== */

/**
 * POST /api/whatsapp/vincular
 * Guarda la selección hecha en el callback (token de usuario OAuth + WABA/phone elegidos)
 */
// export const vincular = async (req: Request, res: Response) => {
//     try {
//         const empresaId = (req as any).user?.empresaId
//         if (!empresaId) return res.status(401).json({ ok: false, error: 'No autorizado' })

//         const { accessToken, phoneNumberId, wabaId, businessId, displayPhoneNumber } = req.body

//         if (!accessToken || !phoneNumberId || !wabaId) {
//             return res.status(400).json({ ok: false, error: 'Faltan datos requeridos: accessToken, phoneNumberId, wabaId' })
//         }

//         const cuenta = await prisma.whatsappAccount.upsert({
//             where: { empresaId },
//             update: { accessToken, phoneNumberId, wabaId, businessId, displayPhoneNumber },
//             create: { empresaId, accessToken, phoneNumberId, wabaId, businessId, displayPhoneNumber },
//         })
//         // Suscribir la app al WABA del cliente
//         await axios.post(
//             `https://graph.facebook.com/v20.0/${wabaId}/subscribed_apps`,
//             {},
//             { headers: { Authorization: `Bearer ${accessToken}` } }
//         )


//         return res.json({ ok: true, cuenta })
//     } catch (err) {
//         console.error('[vincular] error:', err)
//         return res.status(500).json({ ok: false, error: 'Error al guardar conexión de WhatsApp' })
//     }
// }

export const vincular = async (req: Request, res: Response) => {
    try {
        const empresaId = (req as any).user?.empresaId
        if (!empresaId) return res.status(401).json({ ok: false, error: 'No autorizado' })

        const { accessToken, phoneNumberId, wabaId, businessId, displayPhoneNumber } = req.body
        if (!accessToken || !phoneNumberId || !wabaId) {
            return res.status(400).json({
                ok: false,
                error: 'Faltan datos requeridos: accessToken, phoneNumberId, wabaId'
            })
        }

        // 1) Comprobar permisos del token del usuario
        const permsResp = await axios.get(
            `https://graph.facebook.com/${FB_VERSION}/me/permissions`,
            { params: { access_token: accessToken } }
        )
        const granted: string[] = (permsResp.data?.data || [])
            .filter((p: any) => p.status === 'granted')
            .map((p: any) => p.permission)

        const need = [
            'business_management',
            'whatsapp_business_management',
            'whatsapp_business_messaging',
        ]
        const missing = need.filter(p => !granted.includes(p))
        if (missing.length) {
            return res.status(403).json({
                ok: false,
                error: `El usuario no otorgó permisos necesarios: ${missing.join(', ')}`
            })
        }

        // 2) (Opcional) Convertir a long‑lived token de usuario (si procede)
        //    Solo funciona si tu app está en Live y el usuario es válido
        let tokenToStore = accessToken
        let tokenExpiresAt: Date | null = null
        try {
            const ll = await axios.get(`https://graph.facebook.com/${FB_VERSION}/oauth/access_token`, {
                params: {
                    grant_type: 'fb_exchange_token',
                    client_id: process.env.META_APP_ID,
                    client_secret: process.env.META_APP_SECRET,
                    fb_exchange_token: accessToken,
                }
            })
            if (ll.data?.access_token) {
                tokenToStore = ll.data.access_token
                if (ll.data?.expires_in) {
                    tokenExpiresAt = new Date(Date.now() + Number(ll.data.expires_in) * 1000)
                }
            }
        } catch (e) {
            // no es crítico: si falla, guardamos el token corto igualmente
            console.warn('[vincular] No se pudo extender token a long-lived:', (e as any)?.response?.data || (e as any)?.message)
        }

        // 3) Suscribir tu app a la WABA del cliente
        try {
            await axios.post(
                `https://graph.facebook.com/${FB_VERSION}/${wabaId}/subscribed_apps`,
                {},
                { headers: { Authorization: `Bearer ${accessToken}` } } // usa el token del usuario admin
            )
        } catch (e: any) {
            const msg = e?.response?.data?.error?.message || e?.message
            // error común si el usuario no es admin de esa WABA/Business
            return res.status(403).json({
                ok: false,
                error: `No pudimos suscribir tu WABA a la app. Asegúrate de ser administrador del negocio/WABA. Detalle: ${msg}`
            })
        }

        // 4) Guardar/actualizar en tu BD
        const cuenta = await prisma.whatsappAccount.upsert({
            where: { empresaId },
            update: {
                accessToken: tokenToStore,
                phoneNumberId,
                wabaId,
                businessId,
                displayPhoneNumber,
                updatedAt: new Date(),
                // Si añadiste la columna en tu schema:
                // tokenExpiresAt: tokenExpiresAt || null,
            },
            create: {
                empresaId,
                accessToken: tokenToStore,
                phoneNumberId,
                wabaId,
                businessId,
                displayPhoneNumber,
                // tokenExpiresAt: tokenExpiresAt || null,
            },
        })

        return res.json({ ok: true, cuenta })
    } catch (err) {
        const e: any = err;
        // log más claro sin romper TypeScript
        console.error('[vincular] error:', e?.response?.data || e?.message || e);

        return res.status(500).json({
            ok: false,
            error: 'Error al guardar conexión de WhatsApp'
        });
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
        const toSanitized = String(to).replace(/\D+/g, '')
        const url = `https://graph.facebook.com/${FB_VERSION}/${phoneNumberId}/messages`

        const { data } = await axios.post(
            url,
            { messaging_product: 'whatsapp', to: toSanitized, type: 'text', text: { body } },
            { headers: { Authorization: `Bearer ${accessToken}` } },
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
                    message:
                        'El número no está registrado en Cloud API: registra/valida el número desde Meta (no usamos registro manual en el MVP).',
                    code,
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
