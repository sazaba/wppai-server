// src/controllers/whatsapp.controller.ts
import { Request, Response } from 'express'
import axios from 'axios'
import prisma from '../lib/prisma'

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

        // Si no existe, delete lanzará error — lo atrapamos y respondemos ok=false
        await prisma.whatsappAccount.delete({ where: { empresaId } }).catch(() => null)

        return res.json({ ok: true, mensaje: 'Cuenta de WhatsApp eliminada correctamente' })
    } catch (err) {
        console.error('[eliminarWhatsappAccount] error:', err)
        return res.status(500).json({ error: 'Error al eliminar cuenta de WhatsApp' })
    }
}

// POST /api/whatsapp/actualizar-datos
// Vuelve a consultar en Meta y refresca businessId, wabaId, phoneNumberId y displayPhoneNumber
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
        // Manejo de errores de Meta (por permisos/expiración token)
        const metaErr = err?.response?.data
        if (metaErr) console.error('[actualizarDatosWhatsapp] Meta error:', metaErr)
        else console.error('[actualizarDatosWhatsapp] error:', err)

        return res.status(500).json({ error: 'Error al actualizar datos de WhatsApp' })
    }
}
