import { Request, Response } from 'express'
import axios from 'axios'
import prisma from '../lib/prisma'

const FB_VERSION = process.env.FB_VERSION || 'v20.0'

function onlyDigits(s: string) {
    return String(s || '').replace(/\D+/g, '')
}

function metaErr(e: any) {
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

/**
 * Busca el phone_number_id por display_phone_number dentro de la WABA
 * guardada para la empresa en tu DB.
 */
async function findPhoneIdByDisplay(
    empresaId: number,
    accessToken: string,
    displayPhoneNumber: string
): Promise<{ phoneId: string | null; wabaId: string | null }> {
    const acc = await prisma.whatsappAccount.findUnique({
        where: { empresaId },
        select: { wabaId: true },
    })
    const wabaId = acc?.wabaId || null
    if (!wabaId) return { phoneId: null, wabaId: null }

    const { data } = await axios.get(
        `https://graph.facebook.com/${FB_VERSION}/${wabaId}/phone_numbers`,
        { params: { access_token: accessToken } }
    )

    const list: any[] = Array.isArray(data?.data) ? data.data : []
    const wanted = onlyDigits(displayPhoneNumber)
    const match = list.find((p) => onlyDigits(p?.display_phone_number) === wanted)

    return { phoneId: match?.id || null, wabaId }
}

/**
 * POST /api/whatsapp/activar-numero
 * Body:
 *  - phoneNumberId?: string
 *  - displayPhoneNumber?: string
 *  - accessToken?: string  (si no llega, usa el guardado en DB)
 */
export const activarNumero = async (req: Request, res: Response) => {
    try {
        const empresaId = (req as any).user?.empresaId
        if (!empresaId) return res.status(401).json({ ok: false, error: 'No autorizado' })

        const { phoneNumberId: bodyPhoneId, displayPhoneNumber, accessToken: bodyToken } =
            (req.body || {}) as { phoneNumberId?: string; displayPhoneNumber?: string; accessToken?: string }

        // 1) Access token: usar el enviado o el persistido
        let accessToken = bodyToken
        if (!accessToken) {
            const acc = await prisma.whatsappAccount.findUnique({
                where: { empresaId },
                select: { accessToken: true },
            })
            accessToken = acc?.accessToken || ''
        }
        if (!accessToken) return res.status(400).json({ ok: false, error: 'Falta accessToken' })

        // 2) Resolver phone_number_id si vino el número “bonito”
        let phoneNumberId = (bodyPhoneId || '').trim()
        let wabaId: string | null = null

        if (!phoneNumberId) {
            const disp = (displayPhoneNumber || '').trim()
            if (!disp) return res.status(400).json({ ok: false, error: 'Envía phoneNumberId o displayPhoneNumber' })
            const r = await findPhoneIdByDisplay(empresaId, accessToken, disp)
            phoneNumberId = r.phoneId || ''
            wabaId = r.wabaId
            if (!phoneNumberId) {
                return res.status(404).json({
                    ok: false,
                    error: `No se encontró phone_number_id para ${disp} en tu WABA`,
                })
            }
        }

        // 3) Registrar
        const url = `https://graph.facebook.com/${FB_VERSION}/${phoneNumberId}/register`
        const { data } = await axios.post(
            url,
            { messaging_product: 'whatsapp' },
            { headers: { Authorization: `Bearer ${accessToken}` } }
        )

        // 4) Persistir phoneNumberId si descubrimos WABA
        if (wabaId) {
            await prisma.whatsappAccount.update({
                where: { empresaId },
                data: { phoneNumberId },
            }).catch(() => null)
        }

        return res.json({ ok: true, data })
    } catch (e: any) {
        // Si ya está registrado, Meta suele devolver (#131000). Puedes tratarlo como success si quieres.
        return res.status(400).json(metaErr(e))
    }
}

/**
 * GET /api/whatsapp/numero/:phoneNumberId/estado
 */
export const estadoNumero = async (req: Request, res: Response) => {
    try {
        const empresaId = (req as any).user?.empresaId
        if (!empresaId) return res.status(401).json({ ok: false, error: 'No autorizado' })

        const phoneNumberId = req.params.phoneNumberId
        if (!phoneNumberId) return res.status(400).json({ ok: false, error: 'Falta phoneNumberId' })

        const acc = await prisma.whatsappAccount.findUnique({
            where: { empresaId },
            select: { accessToken: true },
        })
        const token = acc?.accessToken
        if (!token) return res.status(400).json({ ok: false, error: 'Falta accessToken para la empresa' })

        const { data } = await axios.get(`https://graph.facebook.com/${FB_VERSION}/${phoneNumberId}`, {
            params: {
                fields: 'id,display_phone_number,quality_rating,name_status,account_mode,verified_name',
                access_token: token,
            },
        })

        return res.json({ ok: true, data })
    } catch (e: any) {
        return res.status(400).json(metaErr(e))
    }
}
