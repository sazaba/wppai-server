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
        const requestUser = (req as any).user
        if (!isSuperAdmin(requestUser?.email)) {
            return res.status(403).json({ error: 'Requiere privilegios de SuperAdmin' })
        }

        const empresas = await prisma.empresa.findMany({
            include: {
                usuarios: {
                    where: { rol: 'admin' },
                    select: { id: true, email: true, rol: true }
                },
                subscriptions: {
                    where: { status: { in: ['active', 'past_due'] } },
                    orderBy: { createdAt: 'desc' },
                    take: 1,
                    include: {
                        plan: true
                    }
                },
                subscriptionPayments: {
                    orderBy: { createdAt: 'desc' },
                    take: 1,
                    select: { status: true, paidAt: true, amount: true }
                },
                conversationPurchases: {
                    where: { status: 'paid' },
                    select: { creditsAmount: true }
                },
                _count: {
                    select: { conversaciones: true }
                }
            },
            orderBy: { createdAt: 'desc' }
        })

        const data = empresas.map(emp => {
            const activeSub = emp.subscriptions[0]
            const adminUser = emp.usuarios[0]
            const lastPayment = emp.subscriptionPayments[0]
            const remaining = Math.max(0, emp.monthlyConversationLimit - emp.conversationsUsed)
            const totalPurchasedCredits = emp.conversationPurchases.reduce((acc, curr) => acc + curr.creditsAmount, 0)

            return {
                id: emp.id,
                nombre: emp.nombre,
                plan: emp.plan,
                estado: emp.estado,
                conversationsUsed: emp.conversationsUsed,
                monthlyConversationLimit: emp.monthlyConversationLimit,
                conversationsRemaining: remaining,
                totalConversationsHistory: emp._count.conversaciones,
                totalPurchasedCredits,
                lastPayment: lastPayment ? {
                    status: lastPayment.status,
                    date: lastPayment.paidAt,
                    amount: lastPayment.amount
                } : null,
                createdAt: emp.createdAt,
                adminUser: adminUser ? {
                    id: adminUser.id,
                    email: adminUser.email
                } : null,
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
        const requestUser = (req as any).user
        if (!isSuperAdmin(requestUser?.email)) {
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

        console.log(`[SuperAdmin] 🔐 Contraseña restablecida para usuario ID ${userId}`)
        return res.json({ ok: true, message: 'Contraseña actualizada correctamente' })

    } catch (error) {
        console.error('[SuperAdmin] Error resetting password:', error)
        return res.status(500).json({ error: 'No se pudo restablecer la contraseña' })
    }
}

// DELETE /api/superadmin/companies/:id
export const deleteCompany = async (req: Request, res: Response) => {
    const { id } = req.params
    const empresaId = Number(id)

    try {
        const requestUser = (req as any).user
        if (!isSuperAdmin(requestUser?.email)) {
            return res.status(403).json({ error: 'Requiere privilegios de SuperAdmin' })
        }

        if (!empresaId) {
            return res.status(400).json({ error: 'ID de empresa inválido' })
        }

        // CORRECCIÓN: Aumentamos el timeout a 60 segundos (60000ms) para evitar el error P2028
        await prisma.$transaction(async (tx) => {

            // 1. Estética/Citas
            await tx.appointmentReminderLog.deleteMany({ where: { appointment: { empresaId } } })
            await tx.appointment.deleteMany({ where: { empresaId } })
            await tx.appointmentException.deleteMany({ where: { empresaId } })
            await tx.appointmentHour.deleteMany({ where: { empresaId } })
            await tx.esteticaProcedure.deleteMany({ where: { empresaId } })
            await tx.reminderRule.deleteMany({ where: { empresaId } })
            await tx.staff.deleteMany({ where: { empresaId } })
            await tx.businessConfigAppt.deleteMany({ where: { empresaId } })

            // 2. E-commerce
            await tx.orderItem.deleteMany({ where: { order: { empresaId } } })
            await tx.paymentReceipt.deleteMany({ where: { order: { empresaId } } })
            await tx.order.deleteMany({ where: { empresaId } })
            await tx.productImage.deleteMany({ where: { product: { empresaId } } })
            await tx.product.deleteMany({ where: { empresaId } })

            // 3. Chat y Mensajería
            await tx.message.deleteMany({ where: { empresaId } })
            await tx.conversationState.deleteMany({ where: { conversation: { empresaId } } })
            await tx.conversation.deleteMany({ where: { empresaId } })
            await tx.messageTemplate.deleteMany({ where: { empresaId } })
            await tx.whatsappAccount.deleteMany({ where: { empresaId } })

            // 4. Configuración
            await tx.businessConfig.deleteMany({ where: { empresaId } })

            // 5. Facturación
            await tx.subscriptionPayment.deleteMany({ where: { empresaId } })
            await tx.conversationPurchase.deleteMany({ where: { empresaId } })
            await tx.paymentMethod.deleteMany({ where: { empresaId } })
            await tx.subscription.deleteMany({ where: { empresaId } })

            // 6. Usuarios
            await tx.usuario.deleteMany({ where: { empresaId } })

            // 7. Empresa
            await tx.empresa.delete({ where: { id: empresaId } })
        }, {
            timeout: 60000, // 60 segundos de tolerancia
            maxWait: 10000  // 10 segundos esperando turno
        })

        console.log(`[SuperAdmin] 🗑️ Empresa ID ${empresaId} eliminada con éxito`)
        return res.json({ ok: true, message: 'Empresa eliminada correctamente' })

    } catch (error) {
        console.error('[SuperAdmin] Error deleting company:', error)
        return res.status(500).json({ error: 'No se pudo eliminar la empresa. Revisa los logs del servidor.' })
    }
}