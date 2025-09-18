// src/controllers/appointments.controller.ts
import { Request, Response } from "express";
import prisma from "../lib/prisma";
import { hasOverlap } from "./_availability";
import { getEmpresaId } from "./_getEmpresaId";
import { z } from "zod";
import { AiMode } from "@prisma/client";

/* ===================== Helpers ===================== */

function parseDateParam(v?: string | string[]) {
    if (!v) return undefined;
    const s = Array.isArray(v) ? v[0] : v;
    const d = new Date(s);
    return Number.isNaN(+d) ? undefined : d;
}

// map JS weekday (0=Sun..6=Sat) -> prisma Weekday enum ('sun'..'sat')
const WEEK: Array<"sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat"> = [
    "sun",
    "mon",
    "tue",
    "wed",
    "thu",
    "fri",
    "sat",
];

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

/** Valida que (start,end) estén dentro de la disponibilidad del día (si existe).
 *  Si no hay AppointmentHour para ese día, se permite. */
async function ensureWithinBusinessHours(opts: {
    empresaId: number;
    start: Date;
    end: Date;
}) {
    const { empresaId, start, end } = opts;

    // Solo validamos si inicio y fin son el mismo día
    const sameDay =
        start.getFullYear() === end.getFullYear() &&
        start.getMonth() === end.getMonth() &&
        start.getDate() === end.getDate();

    if (!sameDay) {
        // Si quieres prohibir cruzar medianoche, devolver error aquí.
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
            msg: "Horario fuera de disponibilidad. Ajusta a los rangos permitidos del día.",
        };
    }

    return { ok: true };
}

/* ===================== List ===================== */
// GET /api/appointments?from=&to=
export async function listAppointments(req: Request, res: Response) {
    const empresaId = getEmpresaId(req);

    const from = parseDateParam(req.query.from as any);
    const to = parseDateParam(req.query.to as any);

    const AND: any[] = [{ empresaId }];
    if (from && to) AND.push({ startAt: { gte: from }, endAt: { lte: to } });

    const data = await prisma.appointment.findMany({
        where: { AND },
        orderBy: { startAt: "asc" },
        select: {
            id: true,
            empresaId: true,
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
            createdAt: true,
            updatedAt: true,
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
            return res.status(400).json({ error: "startAt debe ser menor que endAt" });

        // 1) Horario de atención
        const wh = await ensureWithinBusinessHours({ empresaId, start, end });
        if (!wh.ok) return res.status(wh.code!).json({ error: wh.msg });

        // 2) Solapamiento
        const overlap = await hasOverlap({ empresaId, startAt: start, endAt: end });
        if (overlap)
            return res.status(409).json({ error: "Existe otra cita en ese intervalo" });

        const appt = await prisma.appointment.create({
            data: {
                empresaId,
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
        res.status(err?.status || 500).json({ error: err?.message || "Error interno" });
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
            return res.status(400).json({ error: "startAt debe ser menor que endAt" });

        const changedWindow = Boolean(patch.startAt || patch.endAt);

        if (changedWindow) {
            // Horario de atención
            const wh = await ensureWithinBusinessHours({ empresaId, start, end });
            if (!wh.ok) return res.status(wh.code!).json({ error: wh.msg });

            // Solapamiento (ignorando la propia cita)
            const overlap = await hasOverlap({
                empresaId,
                startAt: start,
                endAt: end,
                ignoreId: id,
            });
            if (overlap)
                return res.status(409).json({ error: "Existe otra cita en ese intervalo" });
        }

        const appt = await prisma.appointment.update({
            where: { id },
            data: {
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
        res.status(err?.status || 500).json({ error: err?.message || "Error interno" });
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
        res.status(err?.status || 500).json({ error: err?.message || "Error interno" });
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
        res.status(err?.status || 500).json({ error: err?.message || "Error interno" });
    }
}

/* ===================== CONFIG (GET + POST) ===================== */

const timeZ = z.string().regex(/^\d{2}:\d{2}$/).nullable().optional();
const dayZ = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

const saveConfigDtoZ = z.object({
    appointment: z.object({
        enabled: z.boolean(),
        vertical: z.enum([
            "none",
            "salud",
            "bienestar",
            "automotriz",
            "veterinaria",
            "fitness",
            "otros",
        ]),
        timezone: z.string(),
        bufferMin: z.number().int().min(0).max(240),
        policies: z.string().nullable().optional(),
        reminders: z.boolean(),
    }),
    hours: z
        .array(
            z.object({
                day: dayZ,
                isOpen: z.boolean(),
                start1: timeZ,
                end1: timeZ,
                start2: timeZ,
                end2: timeZ,
            })
        )
        .length(7, "Deben venir los 7 días"),
    // provider: eliminado (opcional a futuro)
});

/** GET /api/appointments/config
 *  👉 Responde PLANO: { config, hours, provider } para alinear con el front/lib */
export async function getAppointmentConfig(req: Request, res: Response) {
    const empresaId = getEmpresaId(req);

    const [config, hours] = await Promise.all([
        prisma.businessConfig.findUnique({
            where: { empresaId },
            select: {
                appointmentEnabled: true,
                appointmentVertical: true,
                appointmentTimezone: true,
                appointmentBufferMin: true,
                appointmentPolicies: true,
                appointmentReminders: true,
            },
        }),
        prisma.appointmentHour.findMany({
            where: { empresaId },
            orderBy: { day: "asc" },
            select: {
                day: true,
                isOpen: true,
                start1: true,
                end1: true,
                start2: true,
                end2: true,
            },
        }),
    ]);

    // mantener null hasta que implementes provider principal
    const provider = null;

    // ✨ sin envoltorio { ok, data }, así lo espera el front
    return res.json({ config, hours, provider });
}

/** POST /api/appointments/config
 *  👉 Guarda config + hours. Responde { ok: true } */
export async function saveAppointmentConfig(req: Request, res: Response) {
    try {
        const empresaId = getEmpresaId(req);
        const parsed = saveConfigDtoZ.parse(req.body);
        const { appointment, hours } = parsed;

        const forceAppointments = appointment.enabled === true;

        await prisma.$transaction(async (tx) => {
            const exists = await tx.businessConfig.findUnique({ where: { empresaId } });

            await tx.businessConfig.upsert({
                where: { empresaId },
                create: {
                    empresaId,
                    // citas
                    appointmentEnabled: appointment.enabled,
                    appointmentVertical: appointment.vertical as any,
                    appointmentTimezone: appointment.timezone,
                    appointmentBufferMin: appointment.bufferMin,
                    appointmentPolicies: appointment.policies ?? null,
                    appointmentReminders: appointment.reminders,
                    // mínimos
                    nombre: "",
                    descripcion: "",
                    servicios: "",
                    faq: "",
                    horarios: "",
                    // ✅ al CREAR: si enabled -> appointments, si no -> agente (evita default DB)
                    aiMode: forceAppointments ? "appointments" : "agente",
                },
                update: {
                    appointmentEnabled: appointment.enabled,
                    appointmentVertical: appointment.vertical as any,
                    appointmentTimezone: appointment.timezone,
                    appointmentBufferMin: appointment.bufferMin,
                    appointmentPolicies: appointment.policies ?? null,
                    appointmentReminders: appointment.reminders,
                    updatedAt: new Date(),
                    // ✅ en UPDATE: solo si enabled=true forzamos appointments; si false, NO tocamos aiMode
                    ...(forceAppointments && { aiMode: "appointments" }),
                },
            });

            // horarios
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
        });

        return res.json({ ok: true });
    } catch (err: any) {
        console.error("[saveAppointmentConfig] ❌", err);
        return res.status(400).json({ ok: false, error: err?.message || "bad_request" });
    }
}

/* ===================== RESET CONFIG (NUEVO) ===================== */
/** POST /api/appointments/reset
 *  👉 Borra todos los horarios y deja la configuración de citas en *defaults* (enabled=false, etc.)
 *  No toca otros campos del negocio (nombre, descripcion, etc.). */
export async function resetAppointments(req: Request, res: Response) {
    try {
        const empresaId = getEmpresaId(req);

        await prisma.$transaction(async (tx) => {
            // 1) BORRAR HORARIOS
            await tx.appointmentHour.deleteMany({ where: { empresaId } });

            // 2) DEJAR CONFIG EN DEFAULTS (upsert por empresa)
            await tx.businessConfig.upsert({
                where: { empresaId },
                create: {
                    empresaId,
                    // Defaults de agenda
                    appointmentEnabled: false,
                    appointmentVertical: "none" as any,
                    appointmentTimezone: "America/Bogota",
                    appointmentBufferMin: 10,
                    appointmentPolicies: null,
                    appointmentReminders: true,
                    // mínimos para constraints
                    nombre: "",
                    descripcion: "",
                    servicios: "",
                    faq: "",
                    horarios: "",
                    // (Opcional) aiMode neutro inicial:
                    // aiMode: AiMode.agente,
                },
                update: {
                    appointmentEnabled: false,
                    appointmentVertical: "none" as any,
                    appointmentTimezone: "America/Bogota",
                    appointmentBufferMin: 10,
                    appointmentPolicies: null,
                    appointmentReminders: true,
                    updatedAt: new Date(),
                    // (Opcional) aiMode neutro:
                    // aiMode: AiMode.agente,
                },
            });
        });

        return res.json({ ok: true });
    } catch (e: any) {
        console.error("[appointments.reset] error:", e);
        return res.status(500).json({ error: "No se pudo reiniciar la agenda" });
    }
}
