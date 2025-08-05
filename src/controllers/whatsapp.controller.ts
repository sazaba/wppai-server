import { Request, Response } from 'express'
import prisma from '../lib/prisma'

export const guardarWhatsappAccount = async (req: Request, res: Response) => {
    const empresaId = req.user?.empresaId
    const { accessToken, phoneNumberId, wabaId, businessId, displayPhoneNumber } = req.body

    if (!empresaId) return res.status(401).json({ error: 'No autorizado' })

    if (!accessToken || !phoneNumberId || !wabaId || !businessId || !displayPhoneNumber) {
        return res.status(400).json({ error: 'Faltan datos requeridos' })
    }

    try {
        const existente = await prisma.whatsappAccount.findUnique({ where: { empresaId } })

        if (existente) {
            await prisma.whatsappAccount.update({
                where: { empresaId },
                data: { accessToken, phoneNumberId, wabaId, businessId, displayPhoneNumber }
            })
        } else {
            await prisma.whatsappAccount.create({
                data: { empresaId, accessToken, phoneNumberId, wabaId, businessId, displayPhoneNumber }
            })
        }

        res.json({ ok: true, mensaje: 'WhatsApp vinculado correctamente' })
    } catch (err) {
        console.error('Error guardando whatsappAccount:', err)
        res.status(500).json({ error: 'Error al guardar conexión de WhatsApp' })
    }
}

export const estadoWhatsappAccount = async (req: Request, res: Response) => {
    const empresaId = req.user?.empresaId

    try {
        const cuenta = await prisma.whatsappAccount.findUnique({
            where: { empresaId }
        })

        if (!cuenta) {
            return res.json({ conectado: false })
        }

        return res.json({
            conectado: true,
            phoneNumberId: cuenta.phoneNumberId,
            displayPhoneNumber: cuenta.displayPhoneNumber // si ya lo estás guardando
        })
    } catch (err) {
        console.error('Error al obtener estado de WhatsApp:', err)
        return res.status(500).json({ error: 'Error al consultar estado' })
    }
}


export const eliminarWhatsappAccount = async (req: Request, res: Response) => {
    const empresaId = req.user?.empresaId

    if (!empresaId) {
        return res.status(401).json({ error: 'No autorizado' })
    }

    try {
        await prisma.whatsappAccount.delete({
            where: { empresaId }
        })

        res.json({ ok: true, mensaje: 'Cuenta de WhatsApp eliminada correctamente' })
    } catch (err) {
        console.error('Error al eliminar whatsappAccount:', err)
        res.status(500).json({ error: 'Error al eliminar cuenta de WhatsApp' })
    }
}

export const actualizarDatosWhatsapp = async (req: Request, res: Response) => {
    const empresaId = req.user?.empresaId

    if (!empresaId) {
        return res.status(401).json({ error: 'No autorizado' })
    }

    try {
        // 1️⃣ Buscar la cuenta de WhatsApp guardada
        const cuenta = await prisma.whatsappAccount.findUnique({
            where: { empresaId }
        })

        if (!cuenta) {
            return res.status(404).json({ error: 'No hay conexión de WhatsApp para esta empresa' })
        }

        const accessToken = cuenta.accessToken

        // 2️⃣ Obtener los negocios asociados
        const businessRes = await fetch(`https://graph.facebook.com/v20.0/me/businesses?access_token=${accessToken}`)
        const businessData = await businessRes.json()

        if (!businessData.data || businessData.data.length === 0) {
            return res.status(400).json({ error: 'No se encontraron negocios para esta cuenta' })
        }

        const businessId = businessData.data[0].id

        // 3️⃣ Obtener las cuentas de WhatsApp (WABA)
        const wabaRes = await fetch(`https://graph.facebook.com/v20.0/${businessId}/owned_whatsapp_business_accounts?access_token=${accessToken}`)
        const wabaData = await wabaRes.json()

        if (!wabaData.data || wabaData.data.length === 0) {
            return res.status(400).json({ error: 'No se encontraron cuentas WABA' })
        }

        const wabaId = wabaData.data[0].id

        // 4️⃣ Obtener los números de teléfono asociados
        const phoneRes = await fetch(`https://graph.facebook.com/v20.0/${wabaId}/phone_numbers?access_token=${accessToken}`)
        const phoneData = await phoneRes.json()

        if (!phoneData.data || phoneData.data.length === 0) {
            return res.status(400).json({ error: 'No se encontraron números de teléfono' })
        }

        const { id: phoneNumberId, display_phone_number: displayPhoneNumber } = phoneData.data[0]

        // 5️⃣ Actualizar en la base de datos
        await prisma.whatsappAccount.update({
            where: { empresaId },
            data: {
                businessId,
                wabaId,
                phoneNumberId,
                displayPhoneNumber
            }
        })

        return res.json({
            ok: true,
            mensaje: 'Datos de WhatsApp actualizados correctamente',
            businessId,
            wabaId,
            phoneNumberId,
            displayPhoneNumber
        })
    } catch (err) {
        console.error('Error al actualizar datos de WhatsApp:', err)
        return res.status(500).json({ error: 'Error al actualizar datos de WhatsApp' })
    }
}
