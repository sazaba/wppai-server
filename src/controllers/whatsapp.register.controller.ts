// src/controllers/whatsapp.register.controller.ts
import { Request, Response } from 'express'
import axios from 'axios'
import prisma from '../lib/prisma'

const FB_VERSION = process.env.FB_VERSION || 'v20.0'
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

/** POST /api/whatsapp/activar-numero */
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

        const payload: Record<string, any> = { messaging_product: 'whatsapp' }
        if (pin) payload.pin = String(pin)

        const url = `https://graph.facebook.com/${FB_VERSION}/${phoneNumberId}/register`

        try {
            await axios.post(url, payload, { headers: { Authorization: `Bearer ${SYSTEM_TOKEN}` } })
        } catch (e: any) {
            const code = e?.response?.data?.error?.code
            const msg = e?.response?.data?.error?.message || ''
            if (code === 131000 || /already registered/i.test(msg)) {
                // ya estaba registrado → OK
            } else {
                throw e
            }
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
            message: 'Número activado (o ya estaba activo).',
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
