import { Request, Response, NextFunction } from 'express'
import prisma from '../lib/prisma'

export const checkTrialLimits = async (req: Request, res: Response, next: NextFunction) => {
    const empresaId = req.user?.empresaId

    if (!empresaId) {
        return res.status(401).json({ error: 'No autorizado' })
    }

    try {
        const empresa = await prisma.empresa.findUnique({
            where: { id: empresaId }
        })

        if (!empresa) {
            return res.status(404).json({ error: 'Empresa no encontrada' })
        }

        // Si es plan pro → no validar
        if (empresa.plan === 'pro') {
            return next()
        }

        const ahora = new Date()

        // Verificar expiración de prueba
        if (empresa.trialEnd && ahora > empresa.trialEnd) {
            return res.status(403).json({ error: 'La prueba gratuita ha finalizado' })
        }

        // Verificar límite de mensajes
        if (empresa.conversationsUsed >= 100) {
            return res.status(403).json({ error: 'Límite de 100 mensajes alcanzado en la prueba gratuita' })
        }

        // Incrementar contador de mensajes enviados
        await prisma.empresa.update({
            where: { id: empresaId },
            data: {
                conversationsUsed: { increment: 1 }
            }
        })

        next()
    } catch (error) {
        console.error('[checkTrialLimits] Error:', error)
        return res.status(500).json({ error: 'Error verificando límites de prueba' })
    }
}
