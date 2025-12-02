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
        // 1. Buscamos la empresa y sus datos básicos
        const empresa = await prisma.empresa.findUnique({
            where: { id: empresaId },
            select: {
                id: true,
                plan: true,
                createdAt: true,
                trialEnd: true,
                conversationsUsed: true,
                // ⚠️ IMPORTANTE: Asegúrate de tener este campo en tu DB si usas límites variables
                // monthlyConversationLimit: true 
            },
        })

        if (!empresa) {
            return res.status(404).json({ error: 'Empresa no encontrada' })
        }

        // 2. 🟢 CHECK DE SUSCRIPCIÓN (La solución real)
        // Buscamos si tiene una suscripción activa en la tabla Subscription
        const suscripcionActiva = await prisma.subscription.findFirst({
            where: {
                empresaId,
                status: 'active',
                // Opcional: validar fecha de fin si es necesario, 
                // pero 'active' suele ser suficiente si tu webhook de Stripe/Wompi actualiza el estado.
            },
        })

        // Si el plan es 'pro' (legacy) O tiene suscripción activa => PASE VIP (ignora límites de trial)
        const planLegacy = (empresa.plan || '').toString().toLowerCase()
        if (planLegacy === 'pro' || suscripcionActiva) {
            return next()
        }

        // =========================================================
        // 🔻 AQUI COMIENZA LA LÓGICA SOLO PARA CUENTAS GRATUITAS
        // =========================================================

        // === A. LÓGICA DE TIEMPO (7 DÍAS) ===
        const endsAt = empresa.trialEnd ?? addDays(empresa.createdAt, 7)
        const now = new Date()
        const isTimeValid = now <= endsAt

        if (!isTimeValid) {
            return res.status(403).json({
                error: 'La prueba gratuita ha finalizado. Por favor suscríbete para continuar.'
            })
        }

        // === B. LÍMITE DE MENSAJES (Ahora 300) ===
        const used = empresa.conversationsUsed ?? 0
        const LIMIT = 300 // 👈 AQUÍ ESTABA EL 100, YA LO CAMBIAMOS A 300

        if (used >= LIMIT) {
            return res.status(403).json({
                error: `Límite de ${LIMIT} mensajes alcanzado en la prueba gratuita`
            })
        }

        // Incrementar contador (si pasó todas las validaciones)
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