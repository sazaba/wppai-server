// src/controllers/appointments.controller.ts
import { Request, Response } from "express";
import prisma from "../lib/prisma";
import { hasOverlap } from "./_availability";
import { getEmpresaId } from "./_getEmpresaId";

/* ===================== Helpers ===================== */

function parseDateParam(v?: string | string[]) {
    if (!v) return undefined;
    const s = Array.isArray(v) ? v[0] : v;
    const d = new Date(s);
    return Number.isNaN(+d) ? undefined : d;
}

// map JS weekday (0=Sun..6=Sat) -> prisma Weekday enum ('sun'..'sat')
const WEEK: Array<"sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat"> =
    ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const toMinutes = (hhmm?: string | null) => {
    if (!hhmm) return null;
    const [h, m] = hhmm.split(":").map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    return h * 60 + m;
};

function isInsideRanges(
    startMin: number,
    endMin: number,
    r1: { s: number | null; e: number | null },
    r2: { s: number | null; e: number | null }
): boolean {
    const inR1 = r1.s != null && r1.e != null && startMin >= r1.s && endMin <= r1.e;
    const inR2 = r2.s != null && r2.e != null && startMin >= r2.s && endMin <= r2.e;
    return inR1 || inR2;
}

/** Valida que (start,end) estén en un día abierto y dentro de los rangos HH:MM configurados.
 *  Si no hay registro de `AppointmentHour` para ese día, se asume permitido. */
async function ensureWithinBusinessHours(opts: {
    empresaId: number;
    start: Date;
    end: Date;
}) {
    const { empresaId, start, end } = opts;

    // Solo validamos si es la misma fecha de inicio y fin (misma día)
    const sameDay =
        start.getFullYear() === end.getFullYear() &&
        start.getMonth() === end.getMonth() &&
        start.getDate() === end.getDate();

    if (!sameDay) {
        // Si quieres prohibir citas que crucen medianoche, rechaza aquí.
        // return { ok:false, code:400, msg:"La cita no puede cruzar de día" };
        return { ok: true };
    }

    const jsDow = start.getDay(); // 0..6
    const day = WEEK[jsDow];

    const row = await prisma.appointmentHour.findUnique({
        where: { empresaId_day: { empresaId, day } },
    });

    if (!row) return { ok: true }; // sin configuración => permitir
    if (!row.isOpen) {
        return { ok: false, code: 409, msg: "El negocio está cerrado ese día." };
    }

    const sMin = start.getHours() * 60 + start.getMinutes();
    const eMin = end.getHours() * 60 + end.getMinutes();

    const r1 = { s: toMinutes(row.start1), e: toMinutes(row.end1) };
    const r2 = { s: toMinutes(row.start2), e: toMinutes(row.end2) };

    if (!isInsideRanges(sMin, eMin, r1, r2)) {
        return {
            ok: false,
            code: 409,
            msg:
                "Horario fuera de disponibilidad. Ajusta a los rangos permitidos del día.",
        };
    }

    return { ok: true };
}

/* ===================== List ===================== */
// GET /api/appointments?from=&to=&sedeId=&serviceId=&providerId=
export async function listAppointments(req: Request, res: Response) {
    const empresaId = getEmpresaId(req);
    const { sedeId, serviceId, providerId } = req.query;

    const from = parseDateParam(req.query.from as any);
    const to = parseDateParam(req.query.to as any);

    const AND: any[] = [{ empresaId }];
    if (from && to) AND.push({ startAt: { gte: from }, endAt: { lte: to } });
    if (sedeId) AND.push({ sedeId: Number(sedeId) });
    if (serviceId) AND.push({ serviceId: Number(serviceId) });
    if (providerId) AND.push({ providerId: Number(providerId) });

    const data = await prisma.appointment.findMany({
        where: { AND },
        orderBy: { startAt: "asc" },
        select: {
            id: true,
            empresaId: true,
            sedeId: true,
            serviceId: true,
            providerId: true,
            conversationId: true,
            source: true,
            status: true,
            customerName: true,
            customerPhone: true,
            serviceName: true,
            notas: true,
            startAt: true,
            endAt: true,
            timezone: true,
        },
    });

    res.json(data);
}

/* ===================== Create ===================== */
// POST /api/appointments
export async function createAppointment(req: Request, res: Response) {
    try {
        const empresaId = getEmpresaId(req);
        const {
            sedeId,
            serviceId,
            providerId,
            conversationId,
            source,
            status,
            customerName,
            customerPhone,
            serviceName,
            notas,
            startAt,
            endAt,
            timezone,
        } = req.body;

        if (!customerName || !customerPhone || !serviceName || !startAt || !endAt) {
            return res.status(400).json({
                error:
                    "Campos requeridos: customerName, customerPhone, serviceName, startAt, endAt",
            });
        }

        const start = new Date(startAt);
        const end = new Date(endAt);
        if (!(start < end))
            return res
                .status(400)
                .json({ error: "startAt debe ser menor que endAt" });

        // 1) Validar horario de atención (si hay configurado)
        const wh = await ensureWithinBusinessHours({ empresaId, start, end });
        if (!wh.ok) return res.status(wh.code!).json({ error: wh.msg });

        // 2) Validar solapamiento
        const overlap = await hasOverlap({
            empresaId,
            sedeId: sedeId ? Number(sedeId) : undefined,
            providerId: providerId ? Number(providerId) : undefined,
            startAt: start,
            endAt: end,
        });
        if (overlap)
            return res.status(409).json({ error: "Existe otra cita en ese intervalo" });

        const appt = await prisma.appointment.create({
            data: {
                empresaId,
                sedeId: sedeId ? Number(sedeId) : null,
                serviceId: serviceId ? Number(serviceId) : null,
                providerId: providerId ? Number(providerId) : null,
                conversationId: conversationId ? Number(conversationId) : null,
                source: (source as any) ?? "client",
                status: (status as any) ?? "pending",
                customerName,
                customerPhone,
                serviceName,
                notas: notas ?? null,
                startAt: start,
                endAt: end,
                timezone: timezone || "America/Bogota",
            },
        });

        res.status(201).json(appt);
    } catch (err: any) {
        console.error("[createAppointment] ❌", err);
        res
            .status(err?.status || 500)
            .json({ error: err?.message || "Error interno" });
    }
}

/* ===================== Update ===================== */
// PUT /api/appointments/:id
export async function updateAppointment(req: Request, res: Response) {
    try {
        const empresaId = getEmpresaId(req);
        const id = Number(req.params.id);
        const patch = req.body;

        const existing = await prisma.appointment.findUnique({ where: { id } });
        if (!existing || existing.empresaId !== empresaId)
            return res.status(404).json({ error: "No encontrado" });

        let start = existing.startAt;
        let end = existing.endAt;

        if (patch.startAt) start = new Date(patch.startAt);
        if (patch.endAt) end = new Date(patch.endAt);
        if (!(start < end))
            return res
                .status(400)
                .json({ error: "startAt debe ser menor que endAt" });

        const changedWindow =
            patch.startAt || patch.endAt || patch.sedeId || patch.providerId;

        if (changedWindow) {
            // Validar horario de atención
            const wh = await ensureWithinBusinessHours({ empresaId, start, end });
            if (!wh.ok) return res.status(wh.code!).json({ error: wh.msg });

            // Validar solapamiento
            const overlap = await hasOverlap({
                empresaId,
                sedeId: patch.sedeId ?? existing.sedeId ?? undefined,
                providerId: patch.providerId ?? existing.providerId ?? undefined,
                startAt: start,
                endAt: end,
                ignoreId: id,
            });
            if (overlap)
                return res
                    .status(409)
                    .json({ error: "Existe otra cita en ese intervalo" });
        }

        const appt = await prisma.appointment.update({
            where: { id },
            data: {
                sedeId: patch.sedeId ?? existing.sedeId,
                serviceId: patch.serviceId ?? existing.serviceId,
                providerId: patch.providerId ?? existing.providerId,
                conversationId: patch.conversationId ?? existing.conversationId,
                source: (patch.source as any) ?? existing.source,
                status: (patch.status as any) ?? existing.status,
                customerName: patch.customerName ?? existing.customerName,
                customerPhone: patch.customerPhone ?? existing.customerPhone,
                serviceName: patch.serviceName ?? existing.serviceName,
                notas: patch.notas ?? existing.notas,
                startAt: start,
                endAt: end,
                timezone: patch.timezone ?? existing.timezone,
            },
        });

        res.json(appt);
    } catch (err: any) {
        console.error("[updateAppointment] ❌", err);
        res
            .status(err?.status || 500)
            .json({ error: err?.message || "Error interno" });
    }
}

/* ===================== Update Status ===================== */
// PUT /api/appointments/:id/status
export async function updateAppointmentStatus(req: Request, res: Response) {
    try {
        const empresaId = getEmpresaId(req);
        const id = Number(req.params.id);
        const { status } = req.body as { status: any };
        if (!status) return res.status(400).json({ error: "status requerido" });

        const appt = await prisma.appointment.update({
            where: { id },
            data: { status },
        });
        if (appt.empresaId !== empresaId)
            return res.status(403).json({ error: "forbidden" });
        res.json(appt);
    } catch (err: any) {
        console.error("[updateAppointmentStatus] ❌", err);
        res
            .status(err?.status || 500)
            .json({ error: err?.message || "Error interno" });
    }
}

/* ===================== Delete ===================== */
// DELETE /api/appointments/:id
export async function deleteAppointment(req: Request, res: Response) {
    try {
        const empresaId = getEmpresaId(req);
        const id = Number(req.params.id);

        const appt = await prisma.appointment.findUnique({ where: { id } });
        if (!appt || appt.empresaId !== empresaId)
            return res.status(404).json({ error: "No encontrado" });

        await prisma.appointment.delete({ where: { id } });
        res.json({ ok: true });
    } catch (err: any) {
        console.error("[deleteAppointment] ❌", err);
        res
            .status(err?.status || 500)
            .json({ error: err?.message || "Error interno" });
    }
}

// ===================== CONFIG (save + get) =====================
import { z } from 'zod';

const timeZ = z.string().regex(/^\d{2}:\d{2}$/).nullable().optional();
const dayZ = z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);

const saveConfigDtoZ = z.object({
    appointment: z.object({
        enabled: z.boolean(),
        vertical: z.enum(['none', 'salud', 'bienestar', 'automotriz', 'veterinaria', 'fitness', 'otros']),
        timezone: z.string(),
        bufferMin: z.number().int().min(0).max(240),
        policies: z.string().nullable().optional(),
        reminders: z.boolean(),
    }),
    hours: z.array(z.object({
        day: dayZ,
        isOpen: z.boolean(),
        start1: timeZ, end1: timeZ, start2: timeZ, end2: timeZ,
    })).length(7, 'Deben venir los 7 días'),
    provider: z.object({
        id: z.number().int().optional(),
        nombre: z.string().min(1),
        cargo: z.string().optional(),
        email: z.string().optional(),
        phone: z.string().optional(),
        colorHex: z.string().optional(),
        activo: z.boolean().optional(),
    }).nullable().optional(),
});

export async function getAppointmentConfig(req: Request, res: Response) {
    const empresaId = getEmpresaId(req);
    const [config, hours] = await Promise.all([
        prisma.businessConfig.findUnique({ where: { empresaId } }),
        prisma.appointmentHour.findMany({ where: { empresaId }, orderBy: { day: 'asc' } }),
    ]);
    return res.json({ ok: true, data: { config, hours } });
}

export async function saveAppointmentConfig(req: Request, res: Response) {
    try {
        const empresaId = getEmpresaId(req);
        const parsed = saveConfigDtoZ.parse(req.body);
        const { appointment, hours, provider } = parsed;

        const result = await prisma.$transaction(async (tx) => {
            // A) BusinessConfig
            await tx.businessConfig.upsert({
                where: { empresaId },
                create: {
                    empresaId,
                    appointmentEnabled: appointment.enabled,
                    appointmentVertical: appointment.vertical as any,
                    appointmentTimezone: appointment.timezone,
                    appointmentBufferMin: appointment.bufferMin,
                    appointmentPolicies: appointment.policies ?? null,
                    appointmentReminders: appointment.reminders,
                },
                update: {
                    appointmentEnabled: appointment.enabled,
                    appointmentVertical: appointment.vertical as any,
                    appointmentTimezone: appointment.timezone,
                    appointmentBufferMin: appointment.bufferMin,
                    appointmentPolicies: appointment.policies ?? null,
                    appointmentReminders: appointment.reminders,
                    updatedAt: new Date(),
                },
            });

            // B) Horarios (upsert por día)
            for (const h of hours) {
                await tx.appointmentHour.upsert({
                    where: { empresaId_day: { empresaId, day: h.day as any } },
                    create: {
                        empresaId,
                        day: h.day as any,
                        isOpen: h.isOpen,
                        start1: h.start1 ?? null,
                        end1: h.end1 ?? null,
                        start2: h.start2 ?? null,
                        end2: h.end2 ?? null,
                    },
                    update: {
                        isOpen: h.isOpen,
                        start1: h.start1 ?? null,
                        end1: h.end1 ?? null,
                        start2: h.start2 ?? null,
                        end2: h.end2 ?? null,
                        updatedAt: new Date(),
                    },
                });
            }

            // C) Provider opcional (si quieres guardar “agente”)
            let savedProvider: any = null;
            if (provider) {
                if (provider.id) {
                    savedProvider = await tx.provider.update({
                        where: { id: provider.id },
                        data: {
                            nombre: provider.nombre,
                            cargo: provider.cargo ?? '',
                            email: provider.email ?? '',
                            phone: provider.phone ?? '',
                            colorHex: provider.colorHex ?? '',
                            activo: provider.activo ?? true,
                            updatedAt: new Date(),
                        },
                    });
                } else {
                    savedProvider = await tx.provider.create({
                        data: {
                            empresaId,
                            nombre: provider.nombre,
                            cargo: provider.cargo ?? '',
                            email: provider.email ?? '',
                            phone: provider.phone ?? '',
                            colorHex: provider.colorHex ?? '',
                            activo: provider.activo ?? true,
                        },
                    });
                }
            }

            const [configNow, hoursNow] = await Promise.all([
                tx.businessConfig.findUnique({ where: { empresaId } }),
                tx.appointmentHour.findMany({ where: { empresaId }, orderBy: { day: 'asc' } }),
            ]);

            return { config: configNow, hours: hoursNow, provider: savedProvider };
        });

        return res.json({ ok: true, data: result });
    } catch (err: any) {
        console.error('[saveAppointmentConfig] ❌', err);
        return res.status(400).json({ ok: false, error: err?.message || 'bad_request' });
    }
}
