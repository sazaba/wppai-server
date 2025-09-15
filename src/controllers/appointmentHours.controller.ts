import { Request, Response } from "express"
import prisma from "../lib/prisma"
import { getEmpresaId } from "./_getEmpresaId"

// Prisma enum Weekday: 'mon'|'tue'|'wed'|'thu'|'fri'|'sat'|'sun'
type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun"

const DAYS: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
const DAY_ORDER: Record<Weekday, number> = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 }

const isHHMM = (v?: unknown) =>
    typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v)

const toMinutes = (hhmm: string) => {
    const [h, m] = hhmm.split(":").map(Number)
    return h * 60 + m
}

function parseDayParam(p?: string): Weekday | null {
    if (!p) return null
    const d = p.toLowerCase() as Weekday
    return (DAYS as string[]).includes(d) ? d : null
}

/** Garantiza que existan 7 filas (una por día). */
async function ensureWeekSeed(empresaId: number) {
    const existing = await prisma.appointmentHour.findMany({ where: { empresaId } })
    if (existing.length >= 7) return

    const have = new Set(existing.map(e => e.day))
    const toCreate = DAYS.filter(d => !have.has(d)).map(day => ({ empresaId, day, isOpen: false }))
    if (toCreate.length) {
        await prisma.appointmentHour.createMany({ data: toCreate, skipDuplicates: true })
    }
}

/** GET /api/appointment-hours  -> Lista 7 días (crea faltantes). */
export async function listAppointmentHours(req: Request, res: Response) {
    const empresaId = getEmpresaId(req)
    await ensureWeekSeed(empresaId)

    const rows = await prisma.appointmentHour.findMany({
        where: { empresaId },
        orderBy: [{ day: "asc" }], // Prisma ordena alfabéticamente; reordenamos luego
    })

    // ordenar Lun..Dom
    const sorted = [...rows].sort((a, b) => DAY_ORDER[a.day as Weekday] - DAY_ORDER[b.day as Weekday])
    res.json(sorted)
}

/** PUT /api/appointment-hours/:day  -> Actualiza un día concreto. */
export async function upsertAppointmentHour(req: Request, res: Response) {
    const empresaId = getEmpresaId(req)
    const day = parseDayParam(req.params.day)
    if (!day) return res.status(400).json({ error: "Parámetro :day inválido" })

    const { isOpen, start1, end1, start2, end2 } = req.body as {
        isOpen?: boolean
        start1?: string | null
        end1?: string | null
        start2?: string | null
        end2?: string | null
    }

    // Validación
    if (isOpen) {
        // Al menos 1 franja válida requerida
        if (!(isHHMM(start1) && isHHMM(end1))) {
            return res.status(400).json({ error: "Para días abiertos, start1 y end1 (HH:MM) son obligatorios" })
        }
        const s1 = toMinutes(start1!), e1 = toMinutes(end1!)
        if (s1 >= e1) return res.status(400).json({ error: "start1 debe ser menor que end1" })

        if (start2 || end2) {
            if (!(isHHMM(start2) && isHHMM(end2))) {
                return res.status(400).json({ error: "start2/end2 deben tener formato HH:MM" })
            }
            const s2 = toMinutes(start2!), e2 = toMinutes(end2!)
            if (s2 >= e2) return res.status(400).json({ error: "start2 debe ser menor que end2" })
            // Sin solapar franja 1
            const overlap = Math.max(s1, s2) < Math.min(e1, e2)
            if (overlap) return res.status(400).json({ error: "Las franjas se solapan" })
        }
    } else {
        // si está cerrado, ignoramos horas
    }

    // Normalizamos nulos cuando no se usan
    const payload = {
        isOpen: Boolean(isOpen),
        start1: isOpen ? (start1 ?? null) : null,
        end1: isOpen ? (end1 ?? null) : null,
        start2: isOpen ? (start2 ?? null) : null,
        end2: isOpen ? (end2 ?? null) : null,
    }

    const exists = await prisma.appointmentHour.findUnique({
        where: { empresaId_day: { empresaId, day } },
    })

    const row = exists
        ? await prisma.appointmentHour.update({
            where: { empresaId_day: { empresaId, day } },
            data: payload,
        })
        : await prisma.appointmentHour.create({
            data: { empresaId, day, ...payload },
        })

    res.json(row)
}

/** PUT /api/appointment-hours  (bulk)
 *  Body: { days: Array<{day,isOpen,start1,end1,start2,end2}> }
 */
export async function bulkUpsertAppointmentHours(req: Request, res: Response) {
    const empresaId = getEmpresaId(req)
    const items = Array.isArray(req.body?.days) ? req.body.days : []

    // Validación básica item por item (mismo criterio que upsertAppointmentHour)
    for (const it of items) {
        const day = parseDayParam(it?.day)
        if (!day) return res.status(400).json({ error: "day inválido en uno de los elementos" })
        if (it?.isOpen) {
            if (!(isHHMM(it.start1) && isHHMM(it.end1))) {
                return res.status(400).json({ error: `start1/end1 requeridos para ${day}` })
            }
            const s1 = toMinutes(it.start1), e1 = toMinutes(it.end1)
            if (s1 >= e1) return res.status(400).json({ error: `start1 >= end1 en ${day}` })
            if (it.start2 || it.end2) {
                if (!(isHHMM(it.start2) && isHHMM(it.end2))) {
                    return res.status(400).json({ error: `start2/end2 inválidos en ${day}` })
                }
                const s2 = toMinutes(it.start2), e2 = toMinutes(it.end2)
                if (s2 >= e2) return res.status(400).json({ error: `start2 >= end2 en ${day}` })
                const overlap = Math.max(s1, s2) < Math.min(e1, e2)
                if (overlap) return res.status(400).json({ error: `Franjas solapadas en ${day}` })
            }
        }
    }

    await ensureWeekSeed(empresaId)

    const ops = items.map((it: any) =>
        prisma.appointmentHour.upsert({
            where: { empresaId_day: { empresaId, day: it.day } },
            update: {
                isOpen: Boolean(it.isOpen),
                start1: it.isOpen ? (it.start1 ?? null) : null,
                end1: it.isOpen ? (it.end1 ?? null) : null,
                start2: it.isOpen ? (it.start2 ?? null) : null,
                end2: it.isOpen ? (it.end2 ?? null) : null,
            },
            create: {
                empresaId,
                day: it.day,
                isOpen: Boolean(it.isOpen),
                start1: it.isOpen ? (it.start1 ?? null) : null,
                end1: it.isOpen ? (it.end1 ?? null) : null,
                start2: it.isOpen ? (it.start2 ?? null) : null,
                end2: it.isOpen ? (it.end2 ?? null) : null,
            }
        })
    )

    const result = await prisma.$transaction(ops)
    res.json(result.sort((a, b) => DAY_ORDER[a.day as Weekday] - DAY_ORDER[b.day as Weekday]))
}
