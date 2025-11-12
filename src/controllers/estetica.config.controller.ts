// server/controllers/estetica.controller.ts
import { Request, Response } from "express";
import prisma from "../lib/prisma";
import { Prisma, type Weekday, type StaffRole } from "@prisma/client";
import { getEmpresaId } from "./_getEmpresaId";

/** ========= Helpers de tipado ========= */
const WEEKDAY_VALUES: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const ORDER: Weekday[] = WEEKDAY_VALUES;

function asWeekday(v: unknown): Weekday {
    const s = String(v) as Weekday;
    if (WEEKDAY_VALUES.includes(s)) return s;
    throw new Error(`weekday inválido: ${v}`);
}

const STAFF_ROLES: StaffRole[] = ["profesional", "esteticista", "medico"];
function asStaffRole(v: unknown): StaffRole {
    const s = String(v) as StaffRole;
    if (STAFF_ROLES.includes(s)) return s;
    return "esteticista";
}

/** ========= Utils robustos para hours ========= */
function toBool(v: any): boolean {
    if (v === true) return true;
    if (v === 1) return true;
    if (typeof v === "string") {
        const s = v.trim().toLowerCase();
        return s === "true" || s === "1" || s === "on" || s === "yes";
    }
    return false;
}

/** Acepta: "09:00", "9:00", "01:00 PM", "01:00 p. m.", "13:30" → "HH:MM" 24h.
 *  Si no puede parsear, retorna null (lo guardamos como NULL).
 */
function toHHMM(val: any): string | null {
    if (val == null) return null;
    const s = String(val).trim();
    if (!s) return null;

    // "HH:MM" 24h directo
    const re24 = /^([01]?\d|2[0-3]):([0-5]\d)$/;
    const m24 = s.match(re24);
    if (m24) {
        const h = String(Number(m24[1])).padStart(2, "0");
        const mm = m24[2];
        return `${h}:${mm}`;
    }

    // "H:MM am/pm" o variantes con "a. m."/"p. m."
    const re12 = /^(\d{1,2}):([0-5]\d)\s*([ap])(?:\.?\s*m\.?)?$/i;
    const m12 = s.replace(/\s+/g, " ").replace(/\./g, "").match(re12);
    if (m12) {
        let h = parseInt(m12[1], 10);
        const mm = m12[2];
        const ap = m12[3].toLowerCase();
        if (ap === "a") {
            if (h === 12) h = 0;
        } else {
            if (h < 12) h += 12;
        }
        if (h < 0 || h > 23) return null;
        return `${String(h).padStart(2, "0")}:${mm}`;
    }

    return null;
}

/** ========= BusinessConfigAppt ========= */

export async function getApptConfig(req: Request, res: Response) {
    const empresaId =
        getEmpresaId(req) || Number(req.params.empresaId || req.query.empresaId);

    if (!empresaId || Number.isNaN(empresaId)) {
        return res.status(400).json({ ok: false, error: "empresaId requerido" });
    }

    const data = await prisma.businessConfigAppt.findUnique({
        where: { empresaId },
        include: { EsteticaProcedure: true, ReminderRule: true },
    });
    return res.json({ ok: true, data });
}
export async function upsertApptConfig(req: Request, res: Response) {
    const empresaId =
        getEmpresaId(req) || Number(req.params.empresaId || req.body.empresaId);

    if (!empresaId || Number.isNaN(empresaId)) {
        return res.status(400).json({ ok: false, error: "empresaId requerido" });
    }

    // Helpers locales
    const numOrNull = (v: any): number | null => {
        if (v === null || v === undefined || v === "") return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    };
    const toDec = (v: any) =>
        v === null || v === undefined || v === ""
            ? null
            : Number.isFinite(Number(v))
                ? new Prisma.Decimal(Number(v))
                : null;

    // Enum guard (fallback a 'custom' si viene vacío)
    const validVerticals = new Set([
        "none", "salud", "bienestar", "automotriz", "veterinaria", "fitness", "otros",
        "odontologica", "estetica", "spa", "custom",
    ]);
    const body = req.body ?? {};
    const incomingVertical = String(body.appointmentVertical || "custom");
    const safeVertical = validVerticals.has(incomingVertical)
        ? (incomingVertical as any)
        : ("custom" as any);

    // ⚠️ Defaults seguros para TODOS los campos no-null del modelo
    const safePayload = {
        // -------- base / requeridos por el schema (con defaults)
        aiMode: (body.aiMode ?? "estetica") as "ecommerce" | "agente" | "estetica" | "appts",

        appointmentEnabled: toBool(body.appointmentEnabled), // default false
        appointmentVertical: safeVertical,
        appointmentVerticalCustom: body.appointmentVerticalCustom ?? null,
        appointmentTimezone: body.appointmentTimezone || "America/Bogota",
        appointmentBufferMin:
            Number.isFinite(Number(body.appointmentBufferMin))
                ? Number(body.appointmentBufferMin)
                : 10,
        appointmentPolicies: body.appointmentPolicies ?? null,
        appointmentReminders:
            body.appointmentReminders === undefined ? true : toBool(body.appointmentReminders),

        // -------- reglas operativas (opcionales)
        appointmentMinNoticeHours: numOrNull(body.appointmentMinNoticeHours),
        appointmentMaxAdvanceDays: numOrNull(body.appointmentMaxAdvanceDays),
        allowSameDayBooking: toBool(body.allowSameDayBooking),
        requireClientConfirmation:
            body.requireClientConfirmation === undefined
                ? true
                : toBool(body.requireClientConfirmation),
        cancellationAllowedHours: numOrNull(body.cancellationAllowedHours),
        rescheduleAllowedHours: numOrNull(body.rescheduleAllowedHours),
        defaultServiceDurationMin: numOrNull(body.defaultServiceDurationMin),

        // -------- servicios (opcionales)
        servicesText: body.servicesText ?? null,
        services: body.services ?? null,

        // -------- ubicación / logística (opcionales)
        locationName: body.locationName ?? null,
        locationAddress: body.locationAddress ?? null,
        locationMapsUrl: body.locationMapsUrl ?? null,
        parkingInfo: body.parkingInfo ?? null,
        virtualMeetingLink: body.virtualMeetingLink ?? null,
        instructionsArrival: body.instructionsArrival ?? null,

        // -------- reglas extra (opcionales)
        cancellationWindowHours: numOrNull(body.cancellationWindowHours),
        noShowPolicy: body.noShowPolicy ?? null,
        depositRequired: toBool(body.depositRequired),
        depositAmount: toDec(body.depositAmount),
        maxDailyAppointments: numOrNull(body.maxDailyAppointments),
        bookingWindowDays: numOrNull(body.bookingWindowDays),
        blackoutDates: body.blackoutDates ?? null,
        overlapStrategy: body.overlapStrategy ?? null,

        // -------- recordatorios (opcionales)
        reminderSchedule: body.reminderSchedule ?? null,
        reminderTemplateId: body.reminderTemplateId ?? null,
        postBookingMessage: body.postBookingMessage ?? null,
        prepInstructionsPerSvc: body.prepInstructionsPerSvc ?? null,

        // -------- compliance (no-null con defaults)
        requireWhatsappOptIn:
            body.requireWhatsappOptIn === undefined
                ? true
                : toBool(body.requireWhatsappOptIn),
        allowSensitiveTopics: toBool(body.allowSensitiveTopics),
        minClientAge: numOrNull(body.minClientAge),

        // -------- KB (opcionales)
        kbBusinessOverview: body.kbBusinessOverview ?? null,
        kbFAQs: body.kbFAQs ?? null,
        kbServiceNotes: body.kbServiceNotes ?? null,
        kbEscalationRules: body.kbEscalationRules ?? null,
        kbDisclaimers: body.kbDisclaimers ?? null,
        kbMedia: body.kbMedia ?? null,
        kbFreeText: body.kbFreeText ?? null,
    };

    try {
        const data = await prisma.businessConfigAppt.upsert({
            where: { empresaId },
            update: safePayload,
            create: { empresaId, ...safePayload },
        });

        return res.json({ ok: true, data });
    } catch (err: any) {
        // Respuesta clara para depurar
        console.error("❌ upsertApptConfig error:", err);
        // Si Prisma trae meta del constraint, devuélvela
        const msg =
            err?.message ||
            err?.meta?.cause ||
            "Error guardando configuración de agenda";
        return res.status(500).json({ ok: false, error: msg });
    }
}


// export async function upsertApptConfig(req: Request, res: Response) {
//     const empresaId =
//         getEmpresaId(req) || Number(req.params.empresaId || req.body.empresaId);

//     if (!empresaId || Number.isNaN(empresaId)) {
//         return res.status(400).json({ ok: false, error: "empresaId requerido" });
//     }

//     const payload = {
//         aiMode: (req.body.aiMode ?? "estetica") as "ecommerce" | "agente" | "estetica" | "appts",
//         appointmentEnabled: req.body.appointmentEnabled as boolean | undefined,
//         appointmentVertical: req.body.appointmentVertical,
//         appointmentVerticalCustom: req.body.appointmentVerticalCustom ?? null,
//         appointmentTimezone: req.body.appointmentTimezone as string | undefined,
//         appointmentBufferMin: req.body.appointmentBufferMin as number | undefined,
//         appointmentPolicies: req.body.appointmentPolicies ?? null,
//         appointmentReminders: req.body.appointmentReminders as boolean | undefined,

//         appointmentMinNoticeHours: req.body.appointmentMinNoticeHours ?? null,
//         appointmentMaxAdvanceDays: req.body.appointmentMaxAdvanceDays ?? null,
//         allowSameDayBooking: req.body.allowSameDayBooking as boolean | undefined,
//         requireClientConfirmation: req.body.requireClientConfirmation as boolean | undefined,
//         cancellationAllowedHours: req.body.cancellationAllowedHours ?? null,
//         rescheduleAllowedHours: req.body.rescheduleAllowedHours ?? null,
//         defaultServiceDurationMin: req.body.defaultServiceDurationMin ?? null,

//         servicesText: req.body.servicesText ?? null,
//         services: req.body.services ?? null,

//         locationName: req.body.locationName ?? null,
//         locationAddress: req.body.locationAddress ?? null,
//         locationMapsUrl: req.body.locationMapsUrl ?? null,
//         parkingInfo: req.body.parkingInfo ?? null,
//         virtualMeetingLink: req.body.virtualMeetingLink ?? null,
//         instructionsArrival: req.body.instructionsArrival ?? null,

//         cancellationWindowHours: req.body.cancellationWindowHours ?? null,
//         noShowPolicy: req.body.noShowPolicy ?? null,
//         depositRequired: req.body.depositRequired as boolean | undefined,
//         depositAmount: req.body.depositAmount ?? null,
//         maxDailyAppointments: req.body.maxDailyAppointments ?? null,
//         bookingWindowDays: req.body.bookingWindowDays ?? null,
//         blackoutDates: req.body.blackoutDates ?? null,
//         overlapStrategy: req.body.overlapStrategy ?? null,

//         reminderSchedule: req.body.reminderSchedule ?? null,
//         reminderTemplateId: req.body.reminderTemplateId ?? null,
//         postBookingMessage: req.body.postBookingMessage ?? null,
//         prepInstructionsPerSvc: req.body.prepInstructionsPerSvc ?? null,

//         requireWhatsappOptIn: req.body.requireWhatsappOptIn as boolean | undefined,
//         allowSensitiveTopics: req.body.allowSensitiveTopics as boolean | undefined,
//         minClientAge: req.body.minClientAge ?? null,

//         kbBusinessOverview: req.body.kbBusinessOverview ?? null,
//         kbFAQs: req.body.kbFAQs ?? null,
//         kbServiceNotes: req.body.kbServiceNotes ?? null,
//         kbEscalationRules: req.body.kbEscalationRules ?? null,
//         kbDisclaimers: req.body.kbDisclaimers ?? null,
//         kbMedia: req.body.kbMedia ?? null,
//         kbFreeText: req.body.kbFreeText ?? null,
//     };

//     const data = await prisma.businessConfigAppt.upsert({
//         where: { empresaId },
//         update: payload,
//         create: { empresaId, ...payload },
//     });
//     return res.json({ ok: true, data });
// }

/** ========= AppointmentHour ========= */

export async function listHours(req: Request, res: Response) {
    const empresaId =
        getEmpresaId(req) ||
        Number(req.params.empresaId || req.query.empresaId);

    if (!empresaId || Number.isNaN(empresaId)) {
        return res.status(400).json({ ok: false, error: "empresaId requerido" });
    }

    const data = await prisma.appointmentHour.findMany({
        where: { empresaId },
        orderBy: { day: "asc" },
    });
    res.json({ ok: true, data });
}

export async function upsertHours(req: Request, res: Response) {
    const empresaId =
        getEmpresaId(req) ||
        Number(req.params.empresaId || req.query.empresaId || req.body.empresaId);

    if (!empresaId || Number.isNaN(empresaId)) {
        return res.status(400).json({ ok: false, error: "empresaId requerido" });
    }

    // Acepta body.hours o body.days
    const incoming = Array.isArray(req.body.hours)
        ? req.body.hours
        : Array.isArray(req.body.days)
            ? req.body.days
            : [];

    // Normalizamos SIEMPRE a 7 filas en orden fijo y con coerción de tipos/formatos
    const rows = ORDER.map((dayKey) => {
        const r = incoming.find((x: any) => String(x?.day) === dayKey) ?? {};
        const open = toBool(r.isOpen);
        const start1 = open ? toHHMM(r.start1) : null;
        const end1 = open ? toHHMM(r.end1) : null;
        const start2 = open ? toHHMM(r.start2) : null;
        const end2 = open ? toHHMM(r.end2) : null;

        return {
            empresaId,
            day: asWeekday(dayKey),
            isOpen: open,
            start1,
            end1,
            start2,
            end2,
        };
    });

    await prisma.$transaction([
        prisma.appointmentHour.deleteMany({ where: { empresaId } }),
        prisma.appointmentHour.createMany({ data: rows }),
    ]);

    const data = await prisma.appointmentHour.findMany({
        where: { empresaId },
        orderBy: { day: "asc" },
    });

    return res.json({ ok: true, data });
}

/** ========= EsteticaProcedure ========= */

export async function listProcedures(req: Request, res: Response) {
    const empresaId =
        getEmpresaId(req) || Number(req.params.empresaId || req.query.empresaId);

    if (!empresaId || Number.isNaN(empresaId)) {
        return res.status(400).json({ ok: false, error: "empresaId requerido" });
    }

    const data = await prisma.esteticaProcedure.findMany({
        where: { empresaId },
        orderBy: { name: "asc" },
    });
    res.json({ ok: true, data });
}

export async function upsertProcedure(req: Request, res: Response) {
    const empresaId =
        getEmpresaId(req) || Number(req.params.empresaId || req.body.empresaId);

    if (!empresaId || Number.isNaN(empresaId)) {
        return res.status(400).json({ ok: false, error: "empresaId requerido" });
    }

    const cfg = await prisma.businessConfigAppt.findUnique({ where: { empresaId } });
    if (!cfg) return res.status(400).json({ ok: false, error: "BusinessConfigAppt no encontrado" });

    const dto = req.body as {
        id?: number;
        name: string;
        enabled?: boolean;
        aliases?: unknown;
        durationMin?: number | null;
        requiresAssessment?: boolean;
        priceMin?: number | null;
        priceMax?: number | null;
        depositRequired?: boolean;
        depositAmount?: number | null;
        prepInstructions?: string | null;
        postCare?: string | null;
        contraindications?: string | null;
        notes?: string | null;
        pageUrl?: string | null;
        requiredStaffIds?: unknown;
    };

    const toDecimalNum = (v: unknown) => {
        if (v === null || v === undefined || v === "") return null;
        const n = typeof v === "number" ? v : Number(v);
        if (!Number.isFinite(n)) return null;
        return new Prisma.Decimal(n);
    };

    const requiredStaffIdsJson =
        Array.isArray(dto.requiredStaffIds)
            ? (dto.requiredStaffIds as any[]).map(Number).filter(Number.isFinite)
            : null;

    const createData: Prisma.EsteticaProcedureUncheckedCreateInput = {
        empresaId,
        configApptId: cfg.id,
        name: dto.name,
        enabled: dto.enabled ?? true,
        aliases: (dto.aliases ?? null) as Prisma.InputJsonValue,
        durationMin: dto.durationMin ?? null,
        requiresAssessment: dto.requiresAssessment ?? false,
        priceMin: toDecimalNum(dto.priceMin),
        priceMax: toDecimalNum(dto.priceMax),
        depositRequired: dto.depositRequired ?? false,
        depositAmount: toDecimalNum(dto.depositAmount),
        prepInstructions: dto.prepInstructions ?? null,
        postCare: dto.postCare ?? null,
        contraindications: dto.contraindications ?? null,
        notes: dto.notes ?? null,
        pageUrl: dto.pageUrl ?? null,
        requiredStaffIds: (requiredStaffIdsJson ?? null) as Prisma.InputJsonValue,
    };

    const updateData: Prisma.EsteticaProcedureUncheckedUpdateInput = {
        empresaId,
        configApptId: cfg.id,
        name: dto.name,
        enabled: dto.enabled ?? true,
        aliases: (dto.aliases ?? null) as Prisma.InputJsonValue,
        durationMin: dto.durationMin ?? null,
        requiresAssessment: dto.requiresAssessment ?? false,
        priceMin: toDecimalNum(dto.priceMin) as any,
        priceMax: toDecimalNum(dto.priceMax) as any,
        depositRequired: dto.depositRequired ?? false,
        depositAmount: toDecimalNum(dto.depositAmount) as any,
        prepInstructions: dto.prepInstructions ?? null,
        postCare: dto.postCare ?? null,
        contraindications: dto.contraindications ?? null,
        notes: dto.notes ?? null,
        pageUrl: dto.pageUrl ?? null,
        requiredStaffIds: (requiredStaffIdsJson ?? null) as Prisma.InputJsonValue,
    };

    const data = dto.id
        ? await prisma.esteticaProcedure.update({ where: { id: Number(dto.id) }, data: updateData })
        : await prisma.esteticaProcedure.create({ data: createData });

    res.json({ ok: true, data });
}

/** ========= Staff ========= */

export async function listStaff(req: Request, res: Response) {
    const empresaId =
        getEmpresaId(req) || Number(req.params.empresaId || req.query.empresaId);

    if (!empresaId || Number.isNaN(empresaId)) {
        return res.status(400).json({ ok: false, error: "empresaId requerido" });
    }

    const data = await prisma.staff.findMany({ where: { empresaId }, orderBy: { name: "asc" } });
    res.json({ ok: true, data });
}

export async function upsertStaff(req: Request, res: Response) {
    const empresaId =
        getEmpresaId(req) || Number(req.params.empresaId || req.body.empresaId);

    if (!empresaId || Number.isNaN(empresaId)) {
        return res.status(400).json({ ok: false, error: "empresaId requerido" });
    }

    const { id, name, role, active = true, availability } = req.body as {
        id?: number;
        name: string;
        role?: string;
        active?: boolean;
        availability?: unknown;
    };

    const roleParsed: StaffRole = asStaffRole(role);
    const availabilityJson = (availability ?? null) as Prisma.InputJsonValue;

    const data = id
        ? await prisma.staff.update({
            where: { id: Number(id) },
            data: { name, role: roleParsed, active, availability: availabilityJson },
        })
        : await prisma.staff.create({
            data: { empresaId, name, role: roleParsed, active, availability: availabilityJson },
        });

    res.json({ ok: true, data });
}

/** ========= Excepciones ========= */

export async function listExceptions(req: Request, res: Response) {
    const empresaId =
        getEmpresaId(req) || Number(req.params.empresaId || req.query.empresaId);

    if (!empresaId || Number.isNaN(empresaId)) {
        return res.status(400).json({ ok: false, error: "empresaId requerido" });
    }

    const data = await prisma.appointmentException.findMany({
        where: { empresaId },
        orderBy: { date: "asc" },
    });
    res.json({ ok: true, data });
}

export async function upsertException(req: Request, res: Response) {
    const empresaId =
        getEmpresaId(req) || Number(req.params.empresaId || req.body.empresaId);

    if (!empresaId || Number.isNaN(empresaId)) {
        return res.status(400).json({ ok: false, error: "empresaId requerido" });
    }

    const { id, date, reason } = req.body as {
        id?: number;
        date: string | Date;
        reason?: string | null;
    };
    const dateObj = new Date(date);

    const data = id
        ? await prisma.appointmentException.update({
            where: { id: Number(id) },
            data: { date: dateObj, reason: reason ?? null },
        })
        : await prisma.appointmentException.create({
            data: { empresaId, date: dateObj, reason: reason ?? null },
        });

    res.json({ ok: true, data });
}

// ================= PURGE TOTAL (empresa) =================

/**
 * DELETE /api/estetica/purge
 * Borra TODO lo relativo a Estética para la empresa:
 * - appointment_exception
 * - staff
 * - appointment_hour
 * - estetica_procedure
 * - reminder_rule (si existe el modelo)
 * - business_config_appt
 */
export async function purgeAllEsteticaData(req: Request, res: Response) {
    const empresaId =
        getEmpresaId(req) || Number(req.params.empresaId || req.query.empresaId);

    if (!empresaId || Number.isNaN(empresaId)) {
        return res.status(400).json({ ok: false, error: "empresaId requerido" });
    }

    // Buscamos config para conocer el configApptId y limpiar children que dependan de él
    const cfg = await prisma.businessConfigAppt.findUnique({
        where: { empresaId },
        select: { id: true },
    });

    // Ejecutamos en tx y devolvemos conteos por transparencia
    const result = await prisma.$transaction(async (tx) => {
        const deleted: Record<string, number> = {};

        // 1) Hijos por empresaId directos
        const delExceptions = await tx.appointmentException.deleteMany({ where: { empresaId } });
        deleted.appointmentException = delExceptions.count;

        const delStaff = await tx.staff.deleteMany({ where: { empresaId } });
        deleted.staff = delStaff.count;

        const delHours = await tx.appointmentHour.deleteMany({ where: { empresaId } });
        deleted.appointmentHour = delHours.count;

        // 2) Hijos ligados a configApptId + (por compat) empresaId
        let delProceduresCount = 0;
        if (cfg?.id) {
            const delProcedures = await tx.esteticaProcedure.deleteMany({
                where: {
                    OR: [
                        { empresaId },               // muchos modelos lo tienen
                        { configApptId: cfg.id },    // y además FK directa a config
                    ],
                },
            });
            delProceduresCount = delProcedures.count;
        } else {
            const delProcedures = await tx.esteticaProcedure.deleteMany({ where: { empresaId } });
            delProceduresCount = delProcedures.count;
        }
        deleted.esteticaProcedure = delProceduresCount;

        // 3) ReminderRule (si existe el modelo en tu schema)
        //    Intentamos por configApptId y por empresaId (según cómo lo tengas modelado).
        try {
            if ((tx as any).reminderRule) {
                let delRR = { count: 0 };
                if (cfg?.id) {
                    delRR = await (tx as any).reminderRule.deleteMany({
                        where: {
                            OR: [{ configApptId: cfg.id }, { empresaId }],
                        },
                    });
                } else {
                    delRR = await (tx as any).reminderRule.deleteMany({ where: { empresaId } });
                }
                deleted.reminderRule = delRR.count;
            }
        } catch {
            // Si no existe ReminderRule en tu schema, ignoramos silenciosamente
        }

        // 4) Finalmente, el padre
        let delConfigCount = 0;
        if (cfg?.id) {
            const delCfg = await tx.businessConfigAppt.deleteMany({ where: { empresaId } });
            delConfigCount = delCfg.count;
        }
        deleted.businessConfigAppt = delConfigCount;

        return deleted;
    });

    return res.json({ ok: true, deleted: result });
}

// en controllers/estetica.config.controller.ts
export async function deleteStaff(req: Request, res: Response) {
    const empresaId = getEmpresaId(req) || Number(req.params.empresaId || req.query.empresaId)
    if (!empresaId || Number.isNaN(empresaId)) {
        return res.status(400).json({ ok: false, error: "empresaId requerido" })
    }
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'id inválido' })

    // seguridad básica: eliminar solo si pertenece a la empresa
    const exists = await prisma.staff.findFirst({ where: { id, empresaId }, select: { id: true } })
    if (!exists) return res.status(404).json({ ok: false, error: 'No encontrado' })

    await prisma.staff.delete({ where: { id } })
    return res.json({ ok: true })
}

// ========= Eliminar EsteticaProcedure =========

export async function deleteProcedure(req: Request, res: Response) {
    const empresaId =
        getEmpresaId(req) || Number(req.params.empresaId || req.query.empresaId);

    if (!empresaId || Number.isNaN(empresaId)) {
        return res.status(400).json({ ok: false, error: "empresaId requerido" });
    }

    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
        return res.status(400).json({ ok: false, error: "id inválido" });
    }

    // Verifica que el procedimiento pertenezca a la empresa
    const exists = await prisma.esteticaProcedure.findFirst({
        where: { id, empresaId },
        select: { id: true, name: true },
    });

    if (!exists) {
        return res.status(404).json({ ok: false, error: "Procedimiento no encontrado" });
    }

    try {
        await prisma.esteticaProcedure.delete({ where: { id } });
        return res.json({ ok: true });
    } catch (err: any) {
        // Manejo elegante de constraints/relaciones (por ejemplo, si hay citas ligadas)
        // Prisma: P2003 → foreign key constraint failed
        const code = err?.code || err?.meta?.code;
        if (code === "P2003") {
            return res.status(409).json({
                ok: false,
                error:
                    "No se puede eliminar porque el servicio está relacionado con otros registros (por ejemplo, citas).",
            });
        }
        console.error("❌ deleteProcedure error:", err);
        const msg =
            err?.message ||
            err?.meta?.cause ||
            "Error eliminando el procedimiento";
        return res.status(500).json({ ok: false, error: msg });
    }
}

export async function deleteException(req: Request, res: Response) {
    const empresaId =
        getEmpresaId(req) || Number(req.params.empresaId || req.query.empresaId)
    const id = Number(req.params.id)

    if (!empresaId || Number.isNaN(empresaId)) {
        return res.status(400).json({ ok: false, error: "empresaId requerido" })
    }
    if (!Number.isFinite(id)) {
        return res.status(400).json({ ok: false, error: "id inválido" })
    }

    try {
        const del = await prisma.appointmentException.deleteMany({
            where: { id, empresaId },
        })
        if (del.count === 0) {
            return res.status(404).json({ ok: false, error: "Excepción no encontrada" })
        }
        return res.json({ ok: true, deleted: del.count })
    } catch (err: any) {
        const msg = err?.message || "Error eliminando excepción"
        return res.status(500).json({ ok: false, error: msg })
    }
}
