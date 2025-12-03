import { Request, Response } from 'express'
import prisma from '../lib/prisma'
import bcrypt from 'bcryptjs'

// Validar que el correo sea el maestro (Capa de seguridad interna)
const isSuperAdmin = (email?: string) => {
    return email && email === process.env.SUPERADMIN_EMAIL
}

// GET /api/superadmin/companies
export const getAllCompanies = async (req: Request, res: Response) => {
    try {
        // 🔒 CANDADO DE SEGURIDAD (Doble verificación)
        // Asumimos que tu middleware de auth llena req.user
        const requestUser = (req as any).user
        if (!isSuperAdmin(requestUser?.email)) {
            console.warn(`⚠️ Acceso denegado a getAllCompanies por: ${requestUser?.email}`)
            return res.status(403).json({ error: 'Requiere privilegios de SuperAdmin' })
        }

        const empresas = await prisma.empresa.findMany({
            include: {
                // 1. Usuario Admin (Para ver info y resetear pass)
                usuarios: {
                    where: { rol: 'admin' },
                    select: { id: true, email: true, rol: true }
                },
                // 2. Suscripción Activa (Para ver vencimiento)
                subscriptions: {
                    where: { status: { in: ['active', 'past_due'] } },
                    orderBy: { createdAt: 'desc' },
                    take: 1,
                    include: {
                        plan: true
                    }
                },
                // 3. Último pago (Para saber si ya pagó)
                subscriptionPayments: {
                    orderBy: { createdAt: 'desc' },
                    take: 1,
                    select: { status: true, paidAt: true, amount: true }
                },
                // 4. Compras de Paquetes (Histórico de créditos comprados)
                conversationPurchases: {
                    where: { status: 'paid' },
                    select: { creditsAmount: true }
                },
                // 5. Conteo total histórico
                _count: {
                    select: { conversaciones: true }
                }
            },
            orderBy: { createdAt: 'desc' }
        })

        // Mapeamos la data para que el frontend la reciba limpia y calculada
        const data = empresas.map(emp => {
            const activeSub = emp.subscriptions[0]
            const adminUser = emp.usuarios[0]
            const lastPayment = emp.subscriptionPayments[0]

            // Cálculo de restantes
            const remaining = Math.max(0, emp.monthlyConversationLimit - emp.conversationsUsed)

            // Total de conversaciones extra compradas en la historia
            const totalPurchasedCredits = emp.conversationPurchases.reduce((acc, curr) => acc + curr.creditsAmount, 0)

            return {
                id: emp.id,
                nombre: emp.nombre,
                plan: emp.plan,
                estado: emp.estado,

                // Métricas de Uso y Créditos
                conversationsUsed: emp.conversationsUsed,
                monthlyConversationLimit: emp.monthlyConversationLimit,
                conversationsRemaining: remaining,
                totalConversationsHistory: emp._count.conversaciones,
                totalPurchasedCredits,

                // Estado del último pago
                lastPayment: lastPayment ? {
                    status: lastPayment.status,
                    date: lastPayment.paidAt,
                    amount: lastPayment.amount
                } : null,

                createdAt: emp.createdAt,

                // Info de Usuario
                adminUser: adminUser ? {
                    id: adminUser.id,
                    email: adminUser.email
                } : null,

                // Membresía / Vencimiento
                subscription: activeSub ? {
                    status: activeSub.status,
                    currentPeriodEnd: activeSub.currentPeriodEnd,
                    planName: activeSub.plan?.name
                } : null
            }
        })

        return res.json(data)
    } catch (error) {
        console.error('[SuperAdmin] Error fetching companies:', error)
        return res.status(500).json({ error: 'Error interno al cargar empresas' })
    }
}

// POST /api/superadmin/reset-password
export const resetCompanyPassword = async (req: Request, res: Response) => {
    try {
        // 🔒 CANDADO DE SEGURIDAD (Doble verificación)
        const requestUser = (req as any).user
        if (!isSuperAdmin(requestUser?.email)) {
            console.warn(`⚠️ Acceso denegado a resetPassword por: ${requestUser?.email}`)
            return res.status(403).json({ error: 'Requiere privilegios de SuperAdmin' })
        }

        const { userId, newPassword } = req.body

        if (!userId || !newPassword) {
            return res.status(400).json({ error: 'Faltan datos (userId, newPassword)' })
        }

        const salt = await bcrypt.genSalt(10)
        const hashedPassword = await bcrypt.hash(newPassword, salt)

        await prisma.usuario.update({
            where: { id: Number(userId) },
            data: { password: hashedPassword }
        })

        console.log(`[SuperAdmin] 🔐 Contraseña restablecida para usuario ID ${userId} por el SuperAdmin ${requestUser.email}`)

        return res.json({ ok: true, message: 'Contraseña actualizada correctamente' })

    } catch (error) {
        console.error('[SuperAdmin] Error resetting password:', error)
        return res.status(500).json({ error: 'No se pudo restablecer la contraseña' })
    }
}