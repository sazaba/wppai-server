// server/src/routes/dashboard.routes.ts
import { Router, Request, Response } from 'express'
import prisma from '../lib/prisma' // ajusta el path según tu estructura

const router = Router()

// GET /api/dashboard/summary?empresaId=123
router.get('/dashboard/summary', async (req: Request, res: Response) => {
    try {
        const empresaId = Number(req.query.empresaId)
        if (!empresaId || Number.isNaN(empresaId)) {
            return res.status(400).json({ error: 'empresaId requerido (number)' })
        }

        const now = new Date()
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate())
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
        const sevenDaysAgo = new Date(now)
        sevenDaysAgo.setDate(now.getDate() - 6)
        sevenDaysAgo.setHours(0, 0, 0, 0)

        // ===== Chats activos (pendiente | en_proceso)
        const chatsActivos = await prisma.conversation.count({
            where: { empresaId, estado: { in: ['pendiente', 'en_proceso'] } }
        })

        // ===== Serie: mensajes últimos 7 días (Message.timestamp)
        const msgs7d = await prisma.message.findMany({
            where: { empresaId, timestamp: { gte: sevenDaysAgo } },
            select: { timestamp: true },
            orderBy: { timestamp: 'asc' }
        })
        const padKey = (n: number) => n.toString().padStart(2, '0')
        const keyOf = (d: Date) => `${d.getFullYear()}-${padKey(d.getMonth() + 1)}-${padKey(d.getDate())}`

        // mapa día -> count
        const msgMap: Record<string, number> = {}
        for (let i = 0; i < 7; i++) {
            const d = new Date(sevenDaysAgo)
            d.setDate(sevenDaysAgo.getDate() + i)
            msgMap[keyOf(d)] = 0
        }
        for (const m of msgs7d) {
            const k = keyOf(new Date(m.timestamp))
            if (k in msgMap) msgMap[k]++
        }
        const messages7d = Object.entries(msgMap).map(([day, count]) => ({ day, count }))

        // ===== Conversaciones por estado
        const byStatus = await prisma.conversation.groupBy({
            by: ['estado'],
            _count: { _all: true },
            where: { empresaId }
        })
        const conversationsByStatus = byStatus.map(s => ({ status: s.estado, count: s._count._all }))

        // ===== Citas de hoy (confirmed|rescheduled|completed cuentan como en agenda)
        const citasHoy = await prisma.appointment.count({
            where: {
                empresaId,
                startAt: { gte: startOfDay, lt: new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000) },
                status: { in: ['confirmed', 'rescheduled', 'completed'] }
            }
        })

        // ===== Ingresos del mes (sumando priceMin del procedimiento de citas completed/confirmed)
        const citasMes = await prisma.appointment.findMany({
            where: {
                empresaId,
                startAt: { gte: startOfMonth },
                status: { in: ['confirmed', 'completed'] }
            },
            select: {
                EsteticaProcedure: { select: { priceMin: true } }
            }
        })
        const ingresosMes = citasMes.reduce((acc, c) => {
            const v = c.EsteticaProcedure?.priceMin ? Number(c.EsteticaProcedure.priceMin) : 0
            return acc + v
        }, 0)

        // ===== Conversión a agendado (citas creadas mes / conversaciones creadas mes)
        const convNumerador = await prisma.appointment.count({
            where: { empresaId, createdAt: { gte: startOfMonth } }
        })
        const convDenominador = await prisma.conversation.count({
            where: { empresaId, createdAt: { gte: startOfMonth } }
        })
        const convAgendadoPct = convDenominador ? Math.round((convNumerador / convDenominador) * 100) : 0

        // ===== No-show (mes)
        const noshowTotal = await prisma.appointment.count({
            where: { empresaId, startAt: { gte: startOfMonth }, status: 'no_show' }
        })
        const citasMesTotal = await prisma.appointment.count({
            where: { empresaId, startAt: { gte: startOfMonth } }
        })
        const noShowMesPct = citasMesTotal ? Math.round((noshowTotal / citasMesTotal) * 100) : 0

        // ===== Escalados a agente (limitado por schema: sin updatedAt en Conversation)
        // Usamos porcentaje de conversaciones del mes que actualmente están en requiere_agente
        const escaladosMes = await prisma.conversation.count({
            where: { empresaId, estado: 'requiere_agente', createdAt: { gte: startOfMonth } }
        })
        const totalConversMes = await prisma.conversation.count({
            where: { empresaId, createdAt: { gte: startOfMonth } }
        })
        const escaladosAgentePct = totalConversMes ? Math.round((escaladosMes / totalConversMes) * 100) : 0

        // ===== Top procedimientos del mes (por citas creadas)
        // ===== Top procedimientos del mes (por cantidad de citas creadas)
        const topRaw = await prisma.appointment.groupBy({
            by: ['procedureId'],
            where: {
                empresaId,
                createdAt: { gte: startOfMonth },
                procedureId: { not: null }, // importantísimo para evitar null en el groupBy
            },
            // contamos por un campo escalar (procedureId) para que Prisma permita orderBy
            _count: { procedureId: true },
            orderBy: { _count: { procedureId: 'desc' } },
            take: 5,
        })

        // ids de procedimiento (ya son number por tu schema)
        const procIds = topRaw
            .map(r => r.procedureId)
            .filter((id): id is number => typeof id === 'number')

        const procs = procIds.length
            ? await prisma.esteticaProcedure.findMany({
                where: { id: { in: procIds } },
                select: { id: true, name: true },
            })
            : []

        const nameMap = new Map<number, string>(procs.map(p => [p.id, p.name]))

        const topProcedures = topRaw.map(r => ({
            id: r.procedureId as number,
            name: nameMap.get(r.procedureId as number) || '—',
            // r._count existe y tiene la propiedad procedureId por la selección de arriba
            count: r._count?.procedureId ?? 0,
        }))


        // ===== Salud de WhatsApp y plantillas (con tus modelos)
        const wa = await prisma.whatsappAccount.findUnique({ where: { empresaId } })
        const whatsappOk = !!(wa?.accessToken && wa?.phoneNumberId)
        const templatesPending = await prisma.messageTemplate.count({
            where: { empresaId, estado: 'pendiente' }
        })

        // ===== Agentes conectados (no hay flag online en schema) -> 0 por ahora
        const agentesConectados = 0

        // ===== Incidencias (no tienes tabla de logs) -> vacío
        const incidents: Array<{ message: string; ts: Date }> = []

        return res.json({
            kpis: {
                chatsActivos,
                respIaSegsAvg: null,       // no hay métrica directa en tu schema (se puede agregar luego)
                citasHoy,
                ingresosMes,
                convAgendadoPct,
                noShowMesPct,
                escaladosAgentePct,
                agentesConectados,
            },
            series: {
                messages7d,
                conversationsByStatus,
                topProcedures,
            },
            health: {
                whatsapp: { ok: whatsappOk },
                templates: { pending: templatesPending },
                webhookErrors24h: 0,
            },
            incidents,
        })
    } catch (err) {
        console.error(err)
        return res.status(500).json({ error: 'internal_error' })
    }
})

export default router
