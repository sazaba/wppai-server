import { Request, Response, NextFunction } from 'express'
import prisma from '../lib/prisma'

function addDays(d: Date, days: number) {
    const dt = new Date(d)
    dt.setDate(dt.getDate() + days)
    return dt
}

export const checkTrialLimits = async (req: Request, res: Response, next: NextFunction) => {
    // Nota TS: si no tienes tipado en Request, usa (req as any).user
    const empresaId = (req as any)?.user?.empresaId
    if (!empresaId) {
        return res.status(401).json({ error: 'No autorizado' })
    }

    try {
        const empresa = await prisma.empresa.findUnique({
            where: { id: empresaId },
            select: {
                id: true,
                plan: true,           // 'pro' o trial
                createdAt: true,
                trialEnd: true,       // tu campo actual (puede ser null)
                conversationsUsed: true, // tu contador actual
            },
        })

        if (!empresa) {
            return res.status(404).json({ error: 'Empresa no encontrada' })
        }

        // Plan de pago => omitir límites
        const plan = (empresa.plan || '').toString().toLowerCase()
        if (plan === 'pro') return next()

        // === LÓGICA DE PRUEBA DE 7 DÍAS ===
        const endsAt = empresa.trialEnd ?? addDays(empresa.createdAt, 7)
        const now = new Date()
        const isActive = now <= endsAt

        if (!isActive) {
            // Prueba vencida: bloquear TODO envío (IA, manual, plantillas, media)
            return res.status(403).json({ error: 'La prueba gratuita ha finalizado' })
        }

        // === LÍMITE DE ENVÍOS EN PRUEBA (opcional) ===
        // Mantengo tu límite de 100 para no cambiar tu UX actual.
        const used = empresa.conversationsUsed ?? 0
        const LIMIT = 100
        if (used >= LIMIT) {
            return res.status(403).json({ error: 'Límite de 100 mensajes alcanzado en la prueba gratuita' })
        }

        // Incrementar contador de envíos (solo en endpoints que usan este middleware)
        await prisma.empresa.update({
            where: { id: empresaId },
            data: { conversationsUsed: { increment: 1 } },
        })

        return next()
    } catch (error) {
        console.error('[checkTrialLimits] Error:', error)
        return res.status(500).json({ error: 'Error verificando límites de prueba' })
    }
}
