// server/src/controllers/estetica.config.controller.ts
import { Request, Response } from "express";
import prisma from "../lib/prisma";
import { Prisma, type Weekday, type StaffRole } from "@prisma/client";
import { getEmpresaId } from "./_getEmpresaId";

/** ========= Helpers de tipado ========= */
const WEEKDAY_VALUES: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
function asWeekday(v: unknown): Weekday {
    const s = String(v) as Weekday;
    if (WEEKDAY_VALUES.includes(s)) return s;
    throw new Error(`weekday inválido: ${v}`);
}

const STAFF_ROLES: StaffRole[] = ["profesional", "esteticista", "medico"];
function asStaffRole(v: unknown): StaffRole {
    const s = String(v) as StaffRole;
    if (STAFF_ROLES.includes(s)) return s;
    return "esteticista"; // valor por defecto
}

/** ========= BusinessConfigAppt ========= */

export async function getApptConfig(req: Request, res: Response) {
    // 1) JWT → 2) params → 3) query
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
    // 1) JWT → 2) params → 3) body
    const empresaId =
        getEmpresaId(req) || Number(req.params.empresaId || req.body.empresaId);

    if (!empresaId || Number.isNaN(empresaId)) {
        return res.status(400).json({ ok: false, error: "empresaId requerido" });
    }

    // Los campos son opcionales; Prisma ignora undefined
    const payload = {
        aiMode: req.body.aiMode,
        appointmentEnabled: req.body.appointmentEnabled as boolean | undefined,
        appointmentVertical: req.body.appointmentVertical,
        appointmentVerticalCustom: req.body.appointmentVerticalCustom ?? null,
        appointmentTimezone: req.body.appointmentTimezone as string | undefined,
        appointmentBufferMin: req.body.appointmentBufferMin as number | undefined,
        appointmentPolicies: req.body.appointmentPolicies ?? null,
        appointmentReminders: req.body.appointmentReminders as boolean | undefined,

        appointmentMinNoticeHours: req.body.appointmentMinNoticeHours ?? null,
        appointmentMaxAdvanceDays: req.body.appointmentMaxAdvanceDays ?? null,
        allowSameDayBooking: req.body.allowSameDayBooking as boolean | undefined,
        requireClientConfirmation: req.body.requireClientConfirmation as boolean | undefined,
        cancellationAllowedHours: req.body.cancellationAllowedHours ?? null,
        rescheduleAllowedHours: req.body.rescheduleAllowedHours ?? null,
        defaultServiceDurationMin: req.body.defaultServiceDurationMin ?? null,

        servicesText: req.body.servicesText ?? null,
        services: req.body.services ?? null,

        locationName: req.body.locationName ?? null,
        locationAddress: req.body.locationAddress ?? null,
        locationMapsUrl: req.body.locationMapsUrl ?? null,
        parkingInfo: req.body.parkingInfo ?? null,
        virtualMeetingLink: req.body.virtualMeetingLink ?? null,
        instructionsArrival: req.body.instructionsArrival ?? null,

        cancellationWindowHours: req.body.cancellationWindowHours ?? null,
        noShowPolicy: req.body.noShowPolicy ?? null,
        depositRequired: req.body.depositRequired as boolean | undefined,
        depositAmount: req.body.depositAmount ?? null,
        maxDailyAppointments: req.body.maxDailyAppointments ?? null,
        bookingWindowDays: req.body.bookingWindowDays ?? null,
        blackoutDates: req.body.blackoutDates ?? null,
        overlapStrategy: req.body.overlapStrategy ?? null,

        reminderSchedule: req.body.reminderSchedule ?? null,
        reminderTemplateId: req.body.reminderTemplateId ?? null,
        postBookingMessage: req.body.postBookingMessage ?? null,
        prepInstructionsPerSvc: req.body.prepInstructionsPerSvc ?? null,

        requireWhatsappOptIn: req.body.requireWhatsappOptIn as boolean | undefined,
        allowSensitiveTopics: req.body.allowSensitiveTopics as boolean | undefined,
        minClientAge: req.body.minClientAge ?? null,

        kbBusinessOverview: req.body.kbBusinessOverview ?? null,
        kbFAQs: req.body.kbFAQs ?? null,
        kbServiceNotes: req.body.kbServiceNotes ?? null,
        kbEscalationRules: req.body.kbEscalationRules ?? null,
        kbDisclaimers: req.body.kbDisclaimers ?? null,
        kbMedia: req.body.kbMedia ?? null,
        kbFreeText: req.body.kbFreeText ?? null,
    };

    const data = await prisma.businessConfigAppt.upsert({
        where: { empresaId },
        update: payload,
        create: { empresaId, ...payload },
    });
    return res.json({ ok: true, data });
}

/** ========= AppointmentHour ========= */

export async function listHours(req: Request, res: Response) {
    const empresaId =
        getEmpresaId(req) || Number(req.params.empresaId || req.query.empresaId);

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
        getEmpresaId(req) || Number(req.params.empresaId || req.body.empresaId);

    const hours = Array.isArray(req.body.hours) ? req.body.hours : [];
    if (!empresaId || Number.isNaN(empresaId)) {
        return res.status(400).json({ ok: false, error: "empresaId requerido" });
    }

    // tipar y validar day como Weekday
    const rows = hours.map((h: any) => ({
        empresaId,
        day: asWeekday(h.day),
        isOpen: !!h.isOpen,
        start1: h.start1 ?? null,
        end1: h.end1 ?? null,
        start2: h.start2 ?? null,
        end2: h.end2 ?? null,
    }));

    await prisma.$transaction([
        prisma.appointmentHour.deleteMany({ where: { empresaId } }),
        prisma.appointmentHour.createMany({ data: rows }),
    ]);

    const data = await prisma.appointmentHour.findMany({
        where: { empresaId },
        orderBy: { day: "asc" },
    });
    res.json({ ok: true, data });
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
        priceMin?: string | number | null;
        priceMax?: string | number | null;
        depositRequired?: boolean;
        depositAmount?: string | number | null;
        prepInstructions?: string | null;
        postCare?: string | null;
        contraindications?: string | null;
        notes?: string | null;
        pageUrl?: string | null;
        requiredStaffIds?: unknown;
    };

    const toDecimal = (v: unknown) =>
        v === null || v === undefined || v === "" ? null : new Prisma.Decimal(v as any);

    const createData: Prisma.EsteticaProcedureUncheckedCreateInput = {
        empresaId,
        configApptId: cfg.id,
        name: dto.name,
        enabled: dto.enabled ?? true,
        aliases: (dto.aliases ?? null) as Prisma.InputJsonValue,
        durationMin: dto.durationMin ?? null,
        requiresAssessment: dto.requiresAssessment ?? false,
        priceMin: toDecimal(dto.priceMin),
        priceMax: toDecimal(dto.priceMax),
        depositRequired: dto.depositRequired ?? false,
        depositAmount: toDecimal(dto.depositAmount),
        prepInstructions: dto.prepInstructions ?? null,
        postCare: dto.postCare ?? null,
        contraindications: dto.contraindications ?? null,
        notes: dto.notes ?? null,
        pageUrl: dto.pageUrl ?? null,
        requiredStaffIds: (dto.requiredStaffIds ?? null) as Prisma.InputJsonValue,
    };

    const updateData: Prisma.EsteticaProcedureUncheckedUpdateInput = {
        empresaId,
        configApptId: cfg.id,
        name: dto.name,
        enabled: dto.enabled ?? true,
        aliases: (dto.aliases ?? null) as Prisma.InputJsonValue,
        durationMin: dto.durationMin ?? null,
        requiresAssessment: dto.requiresAssessment ?? false,
        priceMin: toDecimal(dto.priceMin) as any,
        priceMax: toDecimal(dto.priceMax) as any,
        depositRequired: dto.depositRequired ?? false,
        depositAmount: toDecimal(dto.depositAmount) as any,
        prepInstructions: dto.prepInstructions ?? null,
        postCare: dto.postCare ?? null,
        contraindications: dto.contraindications ?? null,
        notes: dto.notes ?? null,
        pageUrl: dto.pageUrl ?? null,
        requiredStaffIds: (dto.requiredStaffIds ?? null) as Prisma.InputJsonValue,
    };

    const data = dto.id
        ? await prisma.esteticaProcedure.update({ where: { id: Number(dto.id) }, data: updateData })
        : await prisma.esteticaProcedure.create({ data: createData });

    res.json({ ok: true, data });
}

/** ========= Staff (opcional) ========= */

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

/** ========= Excepciones (opcional) ========= */

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
