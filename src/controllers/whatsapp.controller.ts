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

