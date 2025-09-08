// src/controllers/whatsapp.register.controller.ts
import { Request, Response } from 'express'
import axios from 'axios'
import prisma from '../lib/prisma'

const FB_VERSION = process.env.FB_VERSION || 'v22.0'
const SYSTEM_TOKEN = (process.env.WHATSAPP_TEMP_TOKEN || '').trim()

function onlyDigits(s: string) {
    return String(s || '').replace(/\D+/g, '')
}

function asMetaError(e: any) {
    const x = e?.response?.data?.error || e?.response?.data || e
    return {
        ok: false,
        error: {
            message: x?.message || e?.message || 'Unknown error',
            type: x?.type,
            code: x?.code,
            error_subcode: x?.error_subcode,
            details: x,
        },
    }
}

/** GET /api/whatsapp/waba/:wabaId/phones */
export const listarTelefonosDeWaba = async (req: Request, res: Response) => {
    try {
        if (!SYSTEM_TOKEN) return res.status(500).json({ ok: false, error: 'WHATSAPP_TEMP_TOKEN no configurado' })

        const { wabaId } = req.params
        if (!wabaId) return res.status(400).json({ ok: false, error: 'Falta wabaId' })

        const { data } = await axios.get(
            `https://graph.facebook.com/${FB_VERSION}/${wabaId}/phone_numbers`,
            { headers: { Authorization: `Bearer ${SYSTEM_TOKEN}` } }
        )

        return res.json({ ok: true, data: data?.data || [] })
    } catch (e: any) {
        return res.status(400).json(asMetaError(e))
    }
}

async function findPhoneIdInWaba(
    wabaId: string,
    displayPhoneNumber?: string
): Promise<{ phoneId: string | null; phone?: any }> {
    const { data } = await axios.get(
        `https://graph.facebook.com/${FB_VERSION}/${wabaId}/phone_numbers`,
        { headers: { Authorization: `Bearer ${SYSTEM_TOKEN}` } }
    )

    const list: any[] = Array.isArray(data?.data) ? data.data : []
    if (!list.length) return { phoneId: null }

    if (!displayPhoneNumber) {
        if (list.length === 1) return { phoneId: list[0].id, phone: list[0] }
        return { phoneId: null }
    }

    const wanted = onlyDigits(displayPhoneNumber)
    const match = list.find(p => onlyDigits(p?.display_phone_number) === wanted)
    return { phoneId: match?.id || null, phone: match }
}


// src/controllers/whatsapp.register.controller.ts

export const activarNumero = async (req: Request, res: Response) => {
    try {
        const empresaId = (req as any).user?.empresaId
        if (!empresaId) return res.status(401).json({ ok: false, error: 'No autorizado' })
        if (!SYSTEM_TOKEN) return res.status(500).json({ ok: false, error: 'WHATSAPP_TEMP_TOKEN no configurado' })

        const { wabaId, phoneNumberId: bodyPhoneId, displayPhoneNumber, pin } = (req.body || {}) as {
            wabaId: string
            phoneNumberId?: string
            displayPhoneNumber?: string
            pin?: string
        }

        if (!wabaId) return res.status(400).json({ ok: false, error: 'Falta wabaId' })

        // ⚠️ En este caso Meta exige PIN. Lo volvemos obligatorio.
        const cleanPin = String(pin || '').trim()
        if (!/^\d{6}$/.test(cleanPin)) {
            return res.status(400).json({
                ok: false,
                error: 'Meta exige PIN de 6 dígitos para registrar este número. Ingresa el PIN correcto.',
            })
        }

        let phoneNumberId = (bodyPhoneId || '').trim()
        let phone: any | undefined

        if (!phoneNumberId) {
            const r = await findPhoneIdInWaba(wabaId, (displayPhoneNumber || '').trim())
            phoneNumberId = r.phoneId || ''
            phone = r.phone
            if (!phoneNumberId) {
                return res.status(404).json({
                    ok: false,
                    error: displayPhoneNumber
                        ? `No se encontró phone_number_id para ${displayPhoneNumber} en esta WABA`
                        : 'Hay más de un número en la WABA. Debes indicar displayPhoneNumber o phoneNumberId',
                })
            }
        }

        const url = `https://graph.facebook.com/${FB_VERSION}/${phoneNumberId}/register`
        const payload = { messaging_product: 'whatsapp', pin: cleanPin }

        try {
            await axios.post(url, payload, {
                headers: { Authorization: `Bearer ${SYSTEM_TOKEN}`, 'Content-Type': 'application/json' },
            })
        } catch (e: any) {
            const err = e?.response?.data?.error
            const code = err?.code
            const msg = err?.message || ''

            // Mapear errores comunes con explicación clara
            if (code === 100 && /pin is required/i.test(msg)) {
                return res.status(400).json({
                    ok: false,
                    error:
                        'Meta exige PIN para este número. Debes ingresar un PIN de 6 dígitos (el ya configurado previamente).',
                })
            }
            if (code === 133005 || /two step verification pin mismatch/i.test(msg)) {
                return res.status(400).json({
                    ok: false,
                    error:
                        'PIN incorrecto. Este número ya tiene un PIN configurado anteriormente. Debes usar ese PIN exacto o solicitar el reset desde WhatsApp Manager / soporte de Meta.',
                    details: err,
                })
            }

            console.error('[WA REGISTER ERROR]', {
                url,
                payload,
                code: err?.code,
                subcode: err?.error_subcode,
                type: err?.type,
                message: msg,
                error_data: err?.error_data,
                fbtrace_id: err?.fbtrace_id,
            })
            return res.status(400).json({
                ok: false,
                error: msg || 'Error de Meta al registrar el número',
                details: err,
            })
        }

        await prisma.whatsappAccount.upsert({
            where: { empresaId },
            update: {
                wabaId,
                phoneNumberId,
                displayPhoneNumber: phone?.display_phone_number || displayPhoneNumber || null,
                updatedAt: new Date(),
            },
            create: {
                empresaId,
                wabaId,
                phoneNumberId,
                displayPhoneNumber: phone?.display_phone_number || displayPhoneNumber || null,
                accessToken: '',
            },
        })

        return res.json({
            ok: true,
            message: 'Número activado (registro exitoso).',
            wabaId,
            phoneNumberId,
            displayPhoneNumber: phone?.display_phone_number || displayPhoneNumber || null,
        })
    } catch (e: any) {
        return res.status(400).json(asMetaError(e))
    }
}


/** GET /api/whatsapp/numero/:phoneNumberId/estado */
export const estadoNumero = async (req: Request, res: Response) => {
    try {
        if (!SYSTEM_TOKEN) return res.status(500).json({ ok: false, error: 'WHATSAPP_TEMP_TOKEN no configurado' })

        const phoneNumberId = req.params.phoneNumberId
        if (!phoneNumberId) return res.status(400).json({ ok: false, error: 'Falta phoneNumberId' })

        const { data } = await axios.get(`https://graph.facebook.com/${FB_VERSION}/${phoneNumberId}`, {
            params: {
                fields: 'id,display_phone_number,quality_rating,name_status,account_mode,verified_name,status',
                access_token: SYSTEM_TOKEN,
            },
        })

        return res.json({ ok: true, data })
    } catch (e: any) {
        return res.status(400).json(asMetaError(e))
    }
}

/** POST /api/whatsapp/numero/:phoneNumberId/two-step
 *  Body: { pin: "123456" }
 *  Configura/actualiza el PIN (two-step verification) del número.
 */
export const setTwoStepPin = async (req: Request, res: Response) => {
    try {
        if (!SYSTEM_TOKEN) return res.status(500).json({ ok: false, error: 'WHATSAPP_TEMP_TOKEN no configurado' })

        const phoneNumberId = (req.params?.phoneNumberId || '').trim()
        const pin = (req.body?.pin || '').toString().trim()

        if (!phoneNumberId) return res.status(400).json({ ok: false, error: 'Falta phoneNumberId' })
        if (!/^\d{6}$/.test(pin)) return res.status(400).json({ ok: false, error: 'PIN inválido: debe ser de 6 dígitos' })

        const url = `https://graph.facebook.com/${FB_VERSION}/${phoneNumberId}/two_step_verification`
        const payload = { pin }

        const { data } = await axios.post(url, payload, {
            headers: { Authorization: `Bearer ${SYSTEM_TOKEN}`, 'Content-Type': 'application/json' },
        })

        return res.json({ ok: true, data })
    } catch (e: any) {
        return res.status(400).json(asMetaError(e))
    }
}

/** POST /api/whatsapp/numero/:phoneNumberId/request-code
 *  Body: { code_method?: "SMS"|"VOICE", locale?: "en_US"|"es_ES"|... }
 *  (Opcional) Pide código de verificación del número (proceso clásico).
 */
export const requestVerificationCode = async (req: Request, res: Response) => {
    try {
        if (!SYSTEM_TOKEN) return res.status(500).json({ ok: false, error: 'WHATSAPP_TEMP_TOKEN no configurado' })

        const phoneNumberId = (req.params?.phoneNumberId || '').trim()
        if (!phoneNumberId) return res.status(400).json({ ok: false, error: 'Falta phoneNumberId' })

        const code_method = (req.body?.code_method || 'SMS').toString().toUpperCase()
        const locale = (req.body?.locale || 'en_US').toString()

        const url = `https://graph.facebook.com/${FB_VERSION}/${phoneNumberId}/request_code`
        const payload = { code_method, locale }

        const { data } = await axios.post(url, payload, {
            headers: { Authorization: `Bearer ${SYSTEM_TOKEN}`, 'Content-Type': 'application/json' },
        })

        return res.json({ ok: true, data })
    } catch (e: any) {
        return res.status(400).json(asMetaError(e))
    }
}

/** POST /api/whatsapp/numero/:phoneNumberId/verify-code
 *  Body: { code: "123456" }
 *  (Opcional) Verifica el código recibido en el paso anterior.
 */
export const verifyCode = async (req: Request, res: Response) => {
    try {
        if (!SYSTEM_TOKEN) return res.status(500).json({ ok: false, error: 'WHATSAPP_TEMP_TOKEN no configurado' })

        const phoneNumberId = (req.params?.phoneNumberId || '').trim()
        const code = (req.body?.code || '').toString().trim()

        if (!phoneNumberId) return res.status(400).json({ ok: false, error: 'Falta phoneNumberId' })
        if (!/^\d{6}$/.test(code)) return res.status(400).json({ ok: false, error: 'Código inválido: debe ser de 6 dígitos' })

        const url = `https://graph.facebook.com/${FB_VERSION}/${phoneNumberId}/verify_code`
        const payload = { code }

        const { data } = await axios.post(url, payload, {
            headers: { Authorization: `Bearer ${SYSTEM_TOKEN}`, 'Content-Type': 'application/json' },
        })

        return res.json({ ok: true, data })
    } catch (e: any) {
        return res.status(400).json(asMetaError(e))
    }
}
