import { Request, Response } from 'express'
import prisma from '../lib/prisma'

export const getEmpresa = async (req: Request, res: Response) => {
    try {
        const empresaId = req.user?.empresaId

        if (!empresaId) {
            return res.status(401).json({ error: 'No autorizado' })
        }

        const empresa = await prisma.empresa.findUnique({
            where: { id: empresaId },
            select: { id: true, nombre: true, plan: true, conversationsUsed: true, trialEnd: true }
        })

        if (!empresa) {
            return res.status(404).json({ error: 'Empresa no encontrada' })
        }

        return res.json(empresa)
    } catch (err) {
        console.error('❌ Error al obtener empresa:', err)
        return res.status(500).json({ error: 'Error interno del servidor' })
    }
}

export const cambiarPlan = async (req: Request, res: Response) => {
    const empresaId = req.user?.empresaId // 🔹 Se toma del token autenticado
    const { nuevoPlan } = req.body

    if (!empresaId || !nuevoPlan) {
        return res.status(400).json({ error: 'Faltan datos' })
    }

    // 🔹 Validar que el plan sea válido
    if (!['gratis', 'pro'].includes(nuevoPlan)) {
        return res.status(400).json({ error: 'Plan inválido' })
    }

    try {
        const updateData: any = { plan: nuevoPlan }

        // Si pasa a pro → resetear contador y fechas de prueba
        if (nuevoPlan === 'pro') {
            updateData.conversationsUsed = 0
            updateData.trialStart = null
            updateData.trialEnd = null
        }

        await prisma.empresa.update({
            where: { id: empresaId },
            data: updateData
        })

        return res.json({ message: `Plan actualizado a ${nuevoPlan}` })
    } catch (error) {
        console.error('[cambiarPlan] Error:', error)
        return res.status(500).json({ error: 'Error cambiando plan' })
    }
}
