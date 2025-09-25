import { Request, Response } from "express";
import prisma from "../lib/prisma";
import { hasOverlap } from "./_availability";
import { getEmpresaId } from "./_getEmpresaId";
import { z } from "zod";
import { addMinutes } from "date-fns";

/* ===================== Helpers ===================== */

function parseDateParam(v?: string | string[]) {
    if (!v) return undefined;
    const s = Array.isArray(v) ? v[0] : v;
    const d = new Date(s);
    return Number.isNaN(+d) ? undefined : d;
}

// map JS weekday (0=Sun..6=Sat) -> prisma Weekday enum ('sun'..'sat')
// (mantenido por compatibilidad aunque dejamos de usarlo en TZ)
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

/* ======== NUEVO: helpers de TZ (validación en la zona del negocio) ======== */
type WeekKey = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";

function dayKeyInTZ(d: Date, tz: string): WeekKey {
    // "Mon" -> "mon"
    const wd = new Intl.DateTimeFormat("en-US", {
        weekday: "short",
        timeZone: tz,
    })
        .format(d)
        .toLowerCase()
        .slice(0, 3) as WeekKey;
    return wd;
}

function minutesInTZ(d: Date, tz: string): number {
    const [hh, mm] = new Intl.DateTimeFormat("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: tz,
    })
        .format(d)
        .split(":")
        .map(Number);
    return hh * 60 + mm;
}

function sameCalendarDayInTZ(a: Date, b: Date, tz: string): boolean {
    const fmt = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    });
    return fmt.format(a) === fmt.format(b);
}

/** Valida que (start,end) estén dentro de la disponibilidad del día (si existe)
 *  usando la zona horaria del negocio. Si no hay AppointmentHour para ese día, se permite. */
async function ensureWithinBusinessHours(opts: {
    empresaId: number;
    start: Date;
    end: Date;
    timezone: string; // 👈 importante
}) {
    const { empresaId, start, end, timezone } = opts;

    // Validamos “mismo día” según la TZ del negocio
    if (!sameCalendarDayInTZ(start, end, timezone)) return { ok: true };

    const day = dayKeyInTZ(start, timezone);

    const row = await prisma.appointmentHour.findUnique({
        where: { empresaId_day: { empresaId, day } },
    });

    if (!row) return { ok: true }; // sin configuración => permitir
    if (!row.isOpen) {
        return { ok: false, code: 409, msg: "El negocio está cerrado ese día." };
    }

    const sMin = minutesInTZ(start, timezone);
    const eMin = minutesInTZ(end, timezone);

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

/* ===================== Config runtime (Appt > Legacy) ===================== */
async function loadApptRuntimeConfig(empresaId: number) {
    const [cfgAppt, cfgLegacy] = await Promise.all([
        prisma.businessConfigAppt.findUnique({ where: { empresaId } }),
        prisma.businessConfig.findUnique({
            where: { empresaId },
            select: {
                appointmentEnabled: true,
                appointmentTimezone: true,
                appointmentBufferMin: true,
                appointmentPolicies: true,
                appointmentReminders: true,
            },
        }),
    ]);

    return {
        appointmentEnabled:
            (cfgAppt?.appointmentEnabled ?? cfgLegacy?.appointmentEnabled) ?? false,
        timezone:
            (cfgAppt?.appointmentTimezone ?? cfgLegacy?.appointmentTimezone) ||
            "America/Bogota",
        bufferMin:
            (cfgAppt?.appointmentBufferMin ?? cfgLegacy?.appointmentBufferMin) ?? 10,

        // Reglas nuevas (opcionales)
        minNoticeH: cfgAppt?.appointmentMinNoticeHours ?? null,
        maxAdvanceD: cfgAppt?.appointmentMaxAdvanceDays ?? null,
        allowSameDay: cfgAppt?.allowSameDayBooking ?? false,

        // Caches opcionales
        locationName: cfgAppt?.locationName ?? null,
        defaultServiceDurationMin: cfgAppt?.defaultServiceDurationMin ?? null,
    };
}

/* ===================== Reglas de ventana / excepciones / overlap ===================== */

function violatesNoticeAndWindow(
    cfg: { minNoticeH: number | null; maxAdvanceD: number | null; allowSameDay: boolean },
    startAt: Date
) {
    const now = new Date();
    const sameDay = startAt.toDateString() === now.toDateString();
    if (!cfg.allowSameDay && sameDay) return true;

    const hoursDiff = (startAt.getTime() - now.getTime()) / 3_600_000;
    if (cfg.minNoticeH != null && hoursDiff < cfg.minNoticeH) return true;

    if (cfg.maxAdvanceD != null) {
        const maxMs = cfg.maxAdvanceD * 24 * 3_600_000;
        if (startAt.getTime() - now.getTime() > maxMs) return true;
    }
    return false;
}

async function isExceptionDay(empresaId: number, d: Date) {
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const ex = await prisma.appointmentException.findFirst({
        where: { empresaId, date: day },
        select: { id: true },
    });
    return !!ex;
}

async function hasOverlapWithBuffer(opts: {
    empresaId: number;
    startAt: Date;
    endAt: Date;
    bufferMin: number;
    ignoreId?: number;
}) {
    const { empresaId, startAt, endAt, bufferMin, ignoreId } = opts;
    const startBuf = addMinutes(startAt, -bufferMin);
    const endBuf = addMinutes(endAt, bufferMin);

    const overlap = await prisma.appointment.findFirst({
        where: {
            empresaId,
            ...(ignoreId ? { id: { not: ignoreId } } : {}),
            status: { in: ["pending", "confirmed", "rescheduled"] },
            OR: [{ startAt: { lt: endBuf }, endAt: { gt: startBuf } }],
        },
        select: { id: true },
    });
    return !!overlap;
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
            procedureId,        // opcional
            serviceDurationMin, // opcional (cache)
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

        // === Config combinada (Appt > Legacy) ===
        const cfg = await loadApptRuntimeConfig(empresaId);
        if (!cfg.appointmentEnabled) {
            return res
                .status(403)
                .json({ error: "La agenda está deshabilitada para esta empresa." });
        }

        // 1) Horario de atención (en TZ de negocio) + excepción
        const wh = await ensureWithinBusinessHours({
            empresaId,
            start,
            end,
            timezone: cfg.timezone, // 👈 clave
        });
        if (!wh.ok) return res.status(wh.code!).json({ error: wh.msg });

        const dayExcept = await isExceptionDay(empresaId, start);
        if (dayExcept)
            return res.status(409).json({ error: "Día bloqueado por excepción." });

        // 2) Reglas de ventana (minNotice / maxAdvance / same-day)
        const violates = violatesNoticeAndWindow(
            {
                minNoticeH: cfg.minNoticeH,
                maxAdvanceD: cfg.maxAdvanceD,
                allowSameDay: cfg.allowSameDay,
            },
            start
        );
        if (violates) {
            return res
                .status(409)
                .json({ error: "El horario solicitado no cumple con las reglas de reserva." });
        }

        // 3) Solapamiento con BUFFER desde config
        const overlap = await hasOverlapWithBuffer({
            empresaId,
            startAt: start,
            endAt: end,
            bufferMin: cfg.bufferMin,
        });
        if (overlap)
            return res
                .status(409)
                .json({ error: "Existe otra cita en ese intervalo (buffer aplicado)." });

        // 4) Crear cita
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
                timezone: timezone || cfg.timezone || "America/Bogota",
                // nuevos opcionales
                procedureId: procedureId ? Number(procedureId) : null,
                customerDisplayName: customerName ?? null,
                serviceDurationMin:
                    serviceDurationMin ??
                    cfg.defaultServiceDurationMin ??
                    null,
                locationNameCache: cfg.locationName ?? null,
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

        // Cargar config para buffer/ventanas
        const cfg = await loadApptRuntimeConfig(empresaId);

        if (changedWindow) {
            // Horario de atención (en TZ) + excepción
            const wh = await ensureWithinBusinessHours({
                empresaId,
                start,
                end,
                timezone: cfg.timezone, // 👈 clave también aquí
            });
            if (!wh.ok) return res.status(wh.code!).json({ error: wh.msg });

            const dayExcept = await isExceptionDay(empresaId, start);
            if (dayExcept)
                return res.status(409).json({ error: "Día bloqueado por excepción." });

            // Ventanas (minNotice/maxAdvance/same-day)
            const violates = violatesNoticeAndWindow(
                {
                    minNoticeH: cfg.minNoticeH,
                    maxAdvanceD: cfg.maxAdvanceD,
                    allowSameDay: cfg.allowSameDay,
                },
                start
            );
            if (violates)
                return res
                    .status(409)
                    .json({ error: "El horario solicitado no cumple con las reglas de reserva." });

            // Solapamiento con BUFFER (ignorando la propia cita)
            const overlap = await hasOverlapWithBuffer({
                empresaId,
                startAt: start,
                endAt: end,
                bufferMin: cfg.bufferMin,
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
                // opcionales nuevos
                procedureId:
                    patch.procedureId !== undefined
                        ? (patch.procedureId ? Number(patch.procedureId) : null)
                        : existing.procedureId,
                customerDisplayName:
                    patch.customerDisplayName ?? existing.customerDisplayName,
                serviceDurationMin:
                    patch.serviceDurationMin ?? existing.serviceDurationMin,
                locationNameCache:
                    patch.locationNameCache ?? existing.locationNameCache,
            },
        });

        res.json(appt);
    } catch (err: any) {
        console.error("[updateAppointment] ❌", err);
        res.status(err?.status || 500).json({ error: err?.message || "Error interno" });
    }
}

/* ===================== CONFIG (GET + POST) ===================== */

// ⏱️ "HH:MM"
const timeZ = z.string().regex(/^\d{2}:\d{2}$/).nullable().optional();
const dayZ = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

// Inferir aiMode según vertical: estética => "estetica"; resto => "appts"
function inferAiModeByVertical(vertical: string | undefined): "estetica" | "appts" {
    if (vertical === "estetica") return "estetica";
    return "appts";
}

// Acepta aiMode opcional desde el front
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
            "odontologica",
            "estetica",
            "spa",
            "custom",
        ]),
        timezone: z.string(),
        bufferMin: z.number().int().min(0).max(240),
        policies: z.string().nullable().optional(),
        reminders: z.boolean(),
        aiMode: z.enum(["agente", "appts", "estetica"]).optional(),
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
});

/** GET /api/appointments/config
 *  👉 Responde PLANO: { config, hours, provider } */
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

    const provider = null;
    return res.json({ config, hours, provider });
}

/** POST /api/appointments/config
 *  👉 Guarda config + hours. Responde { ok: true } */
export async function saveAppointmentConfig(req: Request, res: Response) {
    console.log("[appointments.config] body:", JSON.stringify(req.body));
    try {
        const empresaId = getEmpresaId(req);
        const parsed = saveConfigDtoZ.parse(req.body);
        const { appointment, hours } = parsed;

        const forceAppointments = appointment.enabled === true;
        const fromClient = appointment.aiMode; // "agente" | "appts" | "estetica" | undefined
        const inferredAiMode = inferAiModeByVertical(appointment.vertical);

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
                    // aiMode
                    aiMode: forceAppointments ? inferredAiMode : (fromClient ?? "agente"),
                },
                update: {
                    appointmentEnabled: appointment.enabled,
                    appointmentVertical: appointment.vertical as any,
                    appointmentTimezone: appointment.timezone,
                    appointmentBufferMin: appointment.bufferMin,
                    appointmentPolicies: appointment.policies ?? null,
                    appointmentReminders: appointment.reminders,
                    updatedAt: new Date(),
                    ...(forceAppointments
                        ? { aiMode: inferredAiMode }
                        : fromClient
                            ? { aiMode: fromClient }
                            : {}),
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
        });

        return res.json({ ok: true });
    } catch (err: any) {
        console.error("[saveAppointmentConfig] ❌", err);
        return res.status(400).json({ ok: false, error: err?.message || "bad_request" });
    }
}

/* ===================== RESET CONFIG ===================== */
// POST /api/appointments/reset
export async function resetAppointments(req: Request, res: Response) {
    try {
        const empresaId = getEmpresaId(req);

        await prisma.$transaction(async (tx) => {
            // 1) BORRAR HORARIOS
            await tx.appointmentHour.deleteMany({ where: { empresaId } });

            // 2) DEFAULTS de agenda (no tocamos otros campos)
            await tx.businessConfig.upsert({
                where: { empresaId },
                create: {
                    empresaId,
                    appointmentEnabled: false,
                    appointmentVertical: "none" as any,
                    appointmentTimezone: "America/Bogota",
                    appointmentBufferMin: 10,
                    appointmentPolicies: null,
                    appointmentReminders: true,
                    nombre: "",
                    descripcion: "",
                    servicios: "",
                    faq: "",
                    horarios: "",
                },
                update: {
                    appointmentEnabled: false,
                    appointmentVertical: "none" as any,
                    appointmentTimezone: "America/Bogota",
                    appointmentBufferMin: 10,
                    appointmentPolicies: null,
                    appointmentReminders: true,
                    updatedAt: new Date(),
                },
            });
        });

        return res.json({ ok: true });
    } catch (e: any) {
        console.error("[appointments.reset] error:", e);
        return res.status(500).json({ error: "No se pudo reiniciar la agenda" });
    }
}

/* ===================== NUEVO: Reminder Rules + Tick ===================== */

// GET /api/appointments/reminders
export async function listReminderRules(req: Request, res: Response) {
    const empresaId = getEmpresaId(req);
    const data = await prisma.reminderRule.findMany({
        where: { empresaId },
        orderBy: { offsetHours: "asc" },
    });
    res.json(data);
}

// POST /api/appointments/reminders  (create/update)
export async function upsertReminderRule(req: Request, res: Response) {
    const empresaId = getEmpresaId(req);
    const cfg = await prisma.businessConfigAppt.findUnique({ where: { empresaId } });
    if (!cfg) return res.status(400).json({ error: "BusinessConfigAppt no encontrado" });

    const dto = req.body;
    const base = {
        empresaId,
        configApptId: cfg.id,
        active: dto.active ?? true,
        offsetHours: dto.offsetHours ?? 24,
        messageTemplateId: Number(dto.messageTemplateId),
        templateName: String(dto.templateName),
        templateLang: dto.templateLang ?? "es",
        templateParams: dto.templateParams ?? null,
    };

    const data = dto.id
        ? await prisma.reminderRule.update({ where: { id: Number(dto.id) }, data: base })
        : await prisma.reminderRule.create({ data: base });

    res.json(data);
}

// POST /api/appointments/reminders/tick?window=5
// Solo para pruebas: selecciona "debidos" y marca queued
export async function triggerReminderTick(req: Request, res: Response) {
    const windowMinutes = Number(req.query.window || 5);

    const rows = await prisma.$queryRawUnsafe<any[]>(
        `
    SELECT a.id as appointmentId, rr.id as ruleId
    FROM appointment a
    JOIN reminder_rule rr ON rr.empresaId = a.empresaId AND rr.active = 1
    LEFT JOIN appointment_reminder_log l
      ON l.appointmentId = a.id AND l.reminderRuleId = rr.id
    WHERE a.status IN ('confirmed')
      AND l.id IS NULL
      AND TIMESTAMPDIFF(MINUTE, NOW(), a.startAt) BETWEEN (rr.offsetHours*60) AND (rr.offsetHours*60 + ?)
  `,
        windowMinutes
    );

    // Simulación: marcamos en cola (queued)
    for (const r of rows) {
        await prisma.appointmentReminderLog.create({
            data: {
                appointmentId: r.appointmentId,
                reminderRuleId: r.ruleId,
                status: "queued",
            },
        });
    }

    res.json({ ok: true, count: rows.length, sample: rows.slice(0, 10) });
}
