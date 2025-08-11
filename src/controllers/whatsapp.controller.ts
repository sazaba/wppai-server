// src/controllers/whatsapp.controller.ts
import { Request, Response } from 'express'
import axios from 'axios'
import prisma from '../lib/prisma'

const FB_VERSION = process.env.FB_VERSION || 'v20.0'

/** Helper: obtiene el accessToken guardado para la empresa */
async function getAccessToken(empresaId: number) {
    const acc = await prisma.whatsappAccount.findUnique({
        where: { empresaId },
        select: { accessToken: true }
    })
    if (!acc?.accessToken) throw new Error('No hay accessToken para la empresa')
    return acc.accessToken
}

/* =========================================================================================
 * EXISTENTES
 * =======================================================================================*/

// POST /api/whatsapp/conectar
// Guarda/actualiza la cuenta de WhatsApp seleccionada tras el OAuth
export const guardarWhatsappAccount = async (req: Request, res: Response) => {
    try {
        const empresaId = req.user?.empresaId
        if (!empresaId) return res.status(401).json({ error: 'No autorizado' })

        const { accessToken, phoneNumberId, wabaId, businessId, displayPhoneNumber } = req.body
        if (!accessToken || !phoneNumberId || !wabaId || !businessId || !displayPhoneNumber) {
            return res.status(400).json({ error: 'Faltan datos requeridos' })
        }

        const cuenta = await prisma.whatsappAccount.upsert({
            where: { empresaId },
            update: { accessToken, phoneNumberId, wabaId, businessId, displayPhoneNumber },
            create: { empresaId, accessToken, phoneNumberId, wabaId, businessId, displayPhoneNumber }
        })

        return res.json({ ok: true, cuenta })
    } catch (err) {
        console.error('[guardarWhatsappAccount] error:', err)
        return res.status(500).json({ error: 'Error al guardar conexión de WhatsApp' })
    }
}

// GET /api/whatsapp/estado
export const estadoWhatsappAccount = async (req: Request, res: Response) => {
    try {
        const empresaId = req.user?.empresaId
        if (!empresaId) return res.status(401).json({ error: 'No autorizado' })

        const cuenta = await prisma.whatsappAccount.findUnique({ where: { empresaId } })
        if (!cuenta) return res.json({ conectado: false })

        return res.json({
            conectado: true,
            phoneNumberId: cuenta.phoneNumberId,
            displayPhoneNumber: cuenta.displayPhoneNumber,
            wabaId: cuenta.wabaId,
            businessId: cuenta.businessId
        })
    } catch (err) {
        console.error('[estadoWhatsappAccount] error:', err)
        return res.status(500).json({ error: 'Error al consultar estado' })
    }
}

// DELETE /api/whatsapp/eliminar
export const eliminarWhatsappAccount = async (req: Request, res: Response) => {
    try {
        const empresaId = req.user?.empresaId
        if (!empresaId) return res.status(401).json({ error: 'No autorizado' })

        await prisma.whatsappAccount.delete({ where: { empresaId } }).catch(() => null)
        return res.json({ ok: true, mensaje: 'Cuenta de WhatsApp eliminada correctamente' })
    } catch (err) {
        console.error('[eliminarWhatsappAccount] error:', err)
        return res.status(500).json({ error: 'Error al eliminar cuenta de WhatsApp' })
    }
}

// POST /api/whatsapp/actualizar-datos
// Nota: requerirá `business_management` para listar WABAs/teléfonos.
export const actualizarDatosWhatsapp = async (req: Request, res: Response) => {
    try {
        const empresaId = req.user?.empresaId
        if (!empresaId) return res.status(401).json({ error: 'No autorizado' })

        const cuenta = await prisma.whatsappAccount.findUnique({ where: { empresaId } })
        if (!cuenta) return res.status(404).json({ error: 'No hay conexión de WhatsApp para esta empresa' })

        const accessToken = cuenta.accessToken

        // 1) Businesses del usuario
        const bizResp = await axios.get('https://graph.facebook.com/v20.0/me', {
            params: { fields: 'businesses{name}', access_token: accessToken }
        })
        const businesses: Array<{ id: string; name: string }> = bizResp.data?.businesses?.data || []
        if (businesses.length === 0) return res.status(400).json({ error: 'No se encontraron negocios asociados' })
        const businessId = businesses[0].id

        // 2) WABAs del business
        const wabaResp = await axios.get(
            `https://graph.facebook.com/v20.0/${businessId}/owned_whatsapp_business_accounts`,
            { params: { fields: 'name', access_token: accessToken } }
        )
        const wabas: Array<{ id: string; name?: string }> = wabaResp.data?.data || []
        if (wabas.length === 0) return res.status(400).json({ error: 'No se encontraron cuentas WABA' })
        const wabaId = wabas[0].id

        // 3) Phones de la WABA
        const phoneResp = await axios.get(
            `https://graph.facebook.com/v20.0/${wabaId}/phone_numbers`,
            { params: { fields: 'display_phone_number', access_token: accessToken } }
        )
        const phones: Array<{ id: string; display_phone_number: string }> = phoneResp.data?.data || []
        if (phones.length === 0) return res.status(400).json({ error: 'No se encontraron números de teléfono' })
        const { id: phoneNumberId, display_phone_number: displayPhoneNumber } = phones[0]

        // 4) Guardar
        await prisma.whatsappAccount.update({
            where: { empresaId },
            data: { businessId, wabaId, phoneNumberId, displayPhoneNumber }
        })

        return res.json({
            ok: true,
            mensaje: 'Datos de WhatsApp actualizados correctamente',
            businessId,
            wabaId,
            phoneNumberId,
            displayPhoneNumber
        })
    } catch (err: any) {
        const metaErr = err?.response?.data
        if (metaErr) console.error('[actualizarDatosWhatsapp] Meta error:', metaErr)
        else console.error('[actualizarDatosWhatsapp] error:', err)

        return res.status(500).json({ error: 'Error al actualizar datos de WhatsApp' })
    }
}

/* =========================================================================================
 * NUEVAS (Cloud API)
 * =======================================================================================*/

// POST /api/whatsapp/register
// Registra el número (si PIN está habilitado, incluir { pin: '123456' })
export const registrarNumero = async (req: Request, res: Response) => {
    try {
        const empresaId = req.user?.empresaId
        if (!empresaId) return res.status(401).json({ error: 'No autorizado' })

        const { phoneNumberId, pin } = req.body
        if (!phoneNumberId) return res.status(400).json({ error: 'phoneNumberId requerido' })

        const accessToken = await getAccessToken(empresaId)
        const url = `https://graph.facebook.com/${FB_VERSION}/${phoneNumberId}/register`

        const payload: any = { messaging_product: 'whatsapp' }
        if (pin && String(pin).length === 6) payload.pin = String(pin)

        const { data } = await axios.post(url, payload, {
            headers: { Authorization: `Bearer ${accessToken}` }
        })



        return res.json({ ok: true, data })
    } catch (err: any) {
        return res.status(400).json({ ok: false, error: err?.response?.data || err.message })
    }
}

// POST /api/whatsapp/send-test
export const enviarPrueba = async (req: Request, res: Response) => {
    try {
        const empresaId = req.user?.empresaId
        if (!empresaId) return res.status(401).json({ error: 'No autorizado' })

        const { phoneNumberId, to, body } = req.body
        if (!phoneNumberId || !to || !body)
            return res.status(400).json({ error: 'phoneNumberId, to y body son requeridos' })

        const accessToken = await getAccessToken(empresaId)
        const url = `https://graph.facebook.com/${FB_VERSION}/${phoneNumberId}/messages`

        const { data } = await axios.post(
            url,
            { messaging_product: 'whatsapp', to, type: 'text', text: { body } },
            { headers: { Authorization: `Bearer ${accessToken}` } }
        )

        return res.json({ ok: true, data })
    } catch (err: any) {
        return res.status(400).json({ ok: false, error: err?.response?.data || err.message })
    }
}

// GET /api/whatsapp/number/:phoneNumberId
// Info básica del número (útil para mostrar en el panel)
export const infoNumero = async (req: Request, res: Response) => {
    try {
        const empresaId = req.user?.empresaId
        if (!empresaId) return res.status(401).json({ error: 'No autorizado' })

        const { phoneNumberId } = req.params
        const accessToken = await getAccessToken(empresaId)

        const url = `https://graph.facebook.com/${FB_VERSION}/${phoneNumberId}`
        const { data } = await axios.get(url, {
            params: { fields: 'display_phone_number,verified_name,name_status', access_token: accessToken }
        })

        return res.json({ ok: true, data })
    } catch (err: any) {
        return res.status(400).json({ ok: false, error: err?.response?.data || err.message })
    }
}
