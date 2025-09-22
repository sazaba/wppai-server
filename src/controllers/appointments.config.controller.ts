import type { Request, Response } from "express";
import prisma from "../lib/prisma";

/** ===== Tipos auxiliares ===== */
type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
type HourRow = {
    day: Weekday;
    isOpen: boolean;
    start1: string | null;
    end1: string | null;
    start2: string | null;
    end2: string | null;
};

type SaveApptBody = {
    appointment: {
        enabled: boolean;
        vertical: "odontologica" | "estetica" | "spa" | "custom";
        verticalCustom?: string | null;
        timezone: string;
        bufferMin: number;
        policies: string | null;
        reminders: boolean;
        aiMode?: "appointments" | "agente" | "ecommerce";
    };
    // Servicios
    servicesText?: string | null;
    services?: string[] | null;

    // Logística
    location?: {
        name?: string | null;
        address?: string | null;
        mapsUrl?: string | null;
        parkingInfo?: string | null;
        virtualLink?: string | null;
        instructionsArrival?: string | null;
    };

    // Reglas
    rules?: {
        cancellationWindowHours?: number | null;
        noShowPolicy?: string | null;
        depositRequired?: boolean | null;
        depositAmount?: number | null;
        maxDailyAppointments?: number | null;
        bookingWindowDays?: number | null;
        blackoutDates?: string[] | null;
        overlapStrategy?: string | null;
    };

    // Recordatorios
    reminders?: {
        schedule?: Array<{ offsetHours: number; channel: string }> | null;
        templateId?: string | null;
        postBookingMessage?: string | null;
    };

    // Preparación por servicio
    prepInstructionsPerSvc?: Record<string, string> | null;

    // Knowledge Base
    kb?: {
        businessOverview?: string | null;
        faqs?: Array<{ q: string; a: string }> | null;
        serviceNotes?: Record<string, string> | null;
        escalationRules?: any | null;
        disclaimers?: string | null;
        media?: any | null;
        freeText?: string | null;
    };

    // Horario semanal (opcional)
    hours?: HourRow[] | null;
};

function normalizeServices(services?: string[] | null, servicesText?: string | null) {
    if (Array.isArray(services) && services.length) return services.filter(Boolean);
    if (!servicesText) return [];
    return servicesText.split(/\n|,/).map(s => s.trim()).filter(Boolean);
}

/** ===== GET /config ===== */
export async function getAppointmentConfig(req: Request, res: Response) {
    const empresaIdRaw = (req as any).user?.empresaId;
    const empresaId = Number(empresaIdRaw);
    if (!Number.isFinite(empresaId)) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });

    const [cfg, hours] = await Promise.all([
        prisma.businessConfigAppt.findUnique({ where: { empresaId } }),
        prisma.appointmentHour.findMany({ where: { empresaId }, orderBy: { day: "asc" } }),
    ]);

    if (!cfg) {
        return res.json({
            appointment: {
                enabled: false,
                vertical: "custom",
                verticalCustom: null,
                timezone: "America/Bogota",
                bufferMin: 10,
                policies: null,
                reminders: true,
                aiMode: "appointments",
            },
            servicesText: "",
            services: [],
            location: {},
            rules: {},
            reminders: { schedule: [], templateId: null, postBookingMessage: null },
            prepInstructionsPerSvc: {},
            kb: {},
            hours: hours.map(h => ({
                day: h.day as Weekday,
                isOpen: h.isOpen,
                start1: h.start1,
                end1: h.end1,
                start2: h.start2,
                end2: h.end2,
            })),
        });
    }

    return res.json({
        appointment: {
            enabled: cfg.appointmentEnabled,
            vertical: cfg.appointmentVertical,
            verticalCustom: cfg.appointmentVerticalCustom ?? null,
            timezone: cfg.appointmentTimezone,
            bufferMin: cfg.appointmentBufferMin,
            policies: cfg.appointmentPolicies ?? null,
            reminders: cfg.appointmentReminders,
            aiMode: (cfg.aiMode as any) ?? "appointments",
        },
        servicesText: cfg.servicesText ?? "",
        services: (cfg.services as any) ?? [],
        location: {
            name: cfg.locationName ?? null,
            address: cfg.locationAddress ?? null,
            mapsUrl: cfg.locationMapsUrl ?? null,
            parkingInfo: cfg.parkingInfo ?? null,
            virtualLink: cfg.virtualMeetingLink ?? null,
            instructionsArrival: cfg.instructionsArrival ?? null,
        },
        rules: {
            cancellationWindowHours: cfg.cancellationWindowHours ?? null,
            noShowPolicy: cfg.noShowPolicy ?? null,
            depositRequired: cfg.depositRequired ?? false,
            depositAmount: cfg.depositAmount ? Number(cfg.depositAmount) : null,
            maxDailyAppointments: cfg.maxDailyAppointments ?? null,
            bookingWindowDays: cfg.bookingWindowDays ?? null,
            blackoutDates: (cfg.blackoutDates as any) ?? null,
            overlapStrategy: cfg.overlapStrategy ?? null,
        },
        reminders: {
            schedule: (cfg.reminderSchedule as any) ?? [],
            templateId: cfg.reminderTemplateId ?? null,
            postBookingMessage: cfg.postBookingMessage ?? null,
        },
        prepInstructionsPerSvc: (cfg.prepInstructionsPerSvc as any) ?? {},
        kb: {
            businessOverview: cfg.kbBusinessOverview ?? null,
            faqs: (cfg.kbFAQs as any) ?? null,
            serviceNotes: (cfg.kbServiceNotes as any) ?? null,
            escalationRules: (cfg.kbEscalationRules as any) ?? null,
            disclaimers: cfg.kbDisclaimers ?? null,
            media: (cfg.kbMedia as any) ?? null,
            freeText: cfg.kbFreeText ?? null,
        },
        hours: hours.map(h => ({
            day: h.day as Weekday,
            isOpen: h.isOpen,
            start1: h.start1,
            end1: h.end1,
            start2: h.start2,
            end2: h.end2,
        })),
    });
}

/** ===== POST /config (upsert completo) =====
 * Solo acepta requests desde el panel de Citas (x-appt-intent: citas)
 */
export async function saveAppointmentConfig(req: Request, res: Response) {
    const empresaIdRaw = (req as any).user?.empresaId;
    const empresaId = Number(empresaIdRaw);
    if (!Number.isFinite(empresaId)) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });

    const apptIntent = String(req.header("x-appt-intent") || "").toLowerCase();
    if (apptIntent !== "citas") {
        return res.status(400).json({ ok: false, error: "APPT_INTENT_REQUIRED" });
    }

    const body = req.body as SaveApptBody;
    if (!body?.appointment) {
        return res.status(400).json({ ok: false, error: "APPOINTMENT_OBJECT_REQUIRED" });
    }

    const servicesArray = normalizeServices(body.services ?? null, body.servicesText ?? null);
    const isCustom = body.appointment.vertical === "custom";
    const verticalCustom = isCustom ? (body.appointment.verticalCustom?.trim() || null) : null;

    const dataConfig: any = {
        aiMode: body.appointment.aiMode ?? "appointments",

        appointmentEnabled: body.appointment.enabled,
        appointmentVertical: body.appointment.vertical,
        appointmentVerticalCustom: verticalCustom,
        appointmentTimezone: body.appointment.timezone,
        appointmentBufferMin: body.appointment.bufferMin,
        appointmentPolicies: body.appointment.policies,
        appointmentReminders: body.appointment.reminders,

        servicesText: body.servicesText ?? null,
        services: servicesArray.length ? servicesArray : [],

        locationName: body.location?.name ?? undefined,
        locationAddress: body.location?.address ?? undefined,
        locationMapsUrl: body.location?.mapsUrl ?? undefined,
        parkingInfo: body.location?.parkingInfo ?? undefined,
        virtualMeetingLink: body.location?.virtualLink ?? undefined,
        instructionsArrival: body.location?.instructionsArrival ?? undefined,

        cancellationWindowHours: body.rules?.cancellationWindowHours ?? undefined,
        noShowPolicy: body.rules?.noShowPolicy ?? undefined,
        depositRequired: body.rules?.depositRequired ?? undefined,
        depositAmount: body.rules?.depositAmount ?? undefined,
        maxDailyAppointments: body.rules?.maxDailyAppointments ?? undefined,
        bookingWindowDays: body.rules?.bookingWindowDays ?? undefined,
        blackoutDates: body.rules?.blackoutDates ?? undefined,
        overlapStrategy: body.rules?.overlapStrategy ?? undefined,

        reminderSchedule: body.reminders?.schedule ?? undefined,
        reminderTemplateId: body.reminders?.templateId ?? undefined,
        postBookingMessage: body.reminders?.postBookingMessage ?? undefined,

        prepInstructionsPerSvc: body.prepInstructionsPerSvc ?? undefined,

        kbBusinessOverview: body.kb?.businessOverview ?? undefined,
        kbFAQs: body.kb?.faqs ?? undefined,
        kbServiceNotes: body.kb?.serviceNotes ?? undefined,
        kbEscalationRules: body.kb?.escalationRules ?? undefined,
        kbDisclaimers: body.kb?.disclaimers ?? undefined,
        kbMedia: body.kb?.media ?? undefined,
        kbFreeText: body.kb?.freeText ?? undefined,
    };

    await prisma.businessConfigAppt.upsert({
        where: { empresaId },
        create: { empresaId, ...dataConfig },
        update: { ...dataConfig },
        select: { id: true },
    });

    // Si mandas hours en este endpoint, actualizamos; si no, no se tocan
    if (Array.isArray(body.hours) && body.hours.length) {
        for (const h of body.hours) {
            await prisma.appointmentHour.upsert({
                where: { empresaId_day: { empresaId, day: h.day } },
                create: {
                    empresaId,
                    day: h.day,
                    isOpen: !!h.isOpen,
                    start1: h.start1 ?? null,
                    end1: h.end1 ?? null,
                    start2: h.start2 ?? null,
                    end2: h.end2 ?? null,
                },
                update: {
                    isOpen: !!h.isOpen,
                    start1: h.start1 ?? null,
                    end1: h.end1 ?? null,
                    start2: h.start2 ?? null,
                    end2: h.end2 ?? null,
                },
            });
        }
    }

    return res.json({ ok: true });
}

/** ===== PATCH /config (update parcial) =====
 * Solo acepta requests desde el panel de Citas (x-appt-intent: citas)
 */
export async function patchAppointmentConfig(req: Request, res: Response) {
    const empresaIdRaw = (req as any).user?.empresaId;
    const empresaId = Number(empresaIdRaw);
    if (!Number.isFinite(empresaId)) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });

    const apptIntent = String(req.header("x-appt-intent") || "").toLowerCase();
    if (apptIntent !== "citas") {
        return res.status(400).json({ ok: false, error: "APPT_INTENT_REQUIRED" });
    }

    const body = req.body as Partial<SaveApptBody>;

    let servicesArray: string[] | undefined = undefined;
    if ("services" in body || "servicesText" in body) {
        servicesArray = normalizeServices(body.services ?? null, body.servicesText ?? null);
    }

    const isCustom = body.appointment?.vertical === "custom";
    const verticalCustom =
        isCustom ? (body.appointment?.verticalCustom?.trim() || null)
            : (body.appointment?.vertical ? null : undefined);

    const dataConfig: any = {
        ...(body.appointment?.aiMode !== undefined && { aiMode: body.appointment.aiMode }),
        ...(body.appointment?.enabled !== undefined && { appointmentEnabled: body.appointment.enabled }),
        ...(body.appointment?.vertical !== undefined && { appointmentVertical: body.appointment.vertical }),
        ...(verticalCustom !== undefined && { appointmentVerticalCustom: verticalCustom }),
        ...(body.appointment?.timezone !== undefined && { appointmentTimezone: body.appointment.timezone }),
        ...(body.appointment?.bufferMin !== undefined && { appointmentBufferMin: body.appointment.bufferMin }),
        ...(body.appointment?.policies !== undefined && { appointmentPolicies: body.appointment.policies }),
        ...(body.appointment?.reminders !== undefined && { appointmentReminders: body.appointment.reminders }),

        ...(body.servicesText !== undefined && { servicesText: body.servicesText }),
        ...(servicesArray !== undefined && { services: servicesArray }),

        ...(body.location?.name !== undefined && { locationName: body.location.name }),
        ...(body.location?.address !== undefined && { locationAddress: body.location.address }),
        ...(body.location?.mapsUrl !== undefined && { locationMapsUrl: body.location.mapsUrl }),
        ...(body.location?.parkingInfo !== undefined && { parkingInfo: body.location.parkingInfo }),
        ...(body.location?.virtualLink !== undefined && { virtualMeetingLink: body.location.virtualLink }),
        ...(body.location?.instructionsArrival !== undefined && { instructionsArrival: body.location.instructionsArrival }),

        ...(body.rules?.cancellationWindowHours !== undefined && { cancellationWindowHours: body.rules.cancellationWindowHours }),
        ...(body.rules?.noShowPolicy !== undefined && { noShowPolicy: body.rules.noShowPolicy }),
        ...(body.rules?.depositRequired !== undefined && { depositRequired: body.rules?.depositRequired }),
        ...(body.rules?.depositAmount !== undefined && { depositAmount: body.rules?.depositAmount }),
        ...(body.rules?.maxDailyAppointments !== undefined && { maxDailyAppointments: body.rules?.maxDailyAppointments }),
        ...(body.rules?.bookingWindowDays !== undefined && { bookingWindowDays: body.rules?.bookingWindowDays }),
        ...(body.rules?.blackoutDates !== undefined && { blackoutDates: body.rules?.blackoutDates }),
        ...(body.rules?.overlapStrategy !== undefined && { overlapStrategy: body.rules?.overlapStrategy }),

        ...(body.reminders?.schedule !== undefined && { reminderSchedule: body.reminders.schedule }),
        ...(body.reminders?.templateId !== undefined && { reminderTemplateId: body.reminders.templateId }),
        ...(body.reminders?.postBookingMessage !== undefined && { postBookingMessage: body.reminders.postBookingMessage }),

        ...(body.prepInstructionsPerSvc !== undefined && { prepInstructionsPerSvc: body.prepInstructionsPerSvc }),

        ...(body.kb?.businessOverview !== undefined && { kbBusinessOverview: body.kb.businessOverview }),
        ...(body.kb?.faqs !== undefined && { kbFAQs: body.kb.faqs }),
        ...(body.kb?.serviceNotes !== undefined && { kbServiceNotes: body.kb.serviceNotes }),
        ...(body.kb?.escalationRules !== undefined && { kbEscalationRules: body.kb.escalationRules }),
        ...(body.kb?.disclaimers !== undefined && { kbDisclaimers: body.kb.disclaimers }),
        ...(body.kb?.media !== undefined && { kbMedia: body.kb.media }),
        ...(body.kb?.freeText !== undefined && { kbFreeText: body.kb.freeText }),
    };

    if (!Object.keys(dataConfig).length && !body.hours) {
        return res.json({ ok: true, noop: true });
    }

    await prisma.businessConfigAppt.upsert({
        where: { empresaId },
        create: {
            empresaId,
            appointmentVertical: "custom",
            appointmentTimezone: "America/Bogota",
            appointmentBufferMin: 10,
            appointmentReminders: true,
            ...dataConfig,
        },
        update: dataConfig,
        select: { id: true },
    });

    if (Array.isArray(body.hours)) {
        for (const h of body.hours) {
            await prisma.appointmentHour.upsert({
                where: { empresaId_day: { empresaId, day: h.day } },
                create: {
                    empresaId,
                    day: h.day,
                    isOpen: !!h.isOpen,
                    start1: h.start1 ?? null,
                    end1: h.end1 ?? null,
                    start2: h.start2 ?? null,
                    end2: h.end2 ?? null,
                },
                update: {
                    isOpen: !!h.isOpen,
                    start1: h.start1 ?? null,
                    end1: h.end1 ?? null,
                    start2: h.start2 ?? null,
                    end2: h.end2 ?? null,
                },
            });
        }
    }

    return res.json({ ok: true });
}

/** ===== POST /reset =====
 * Reinicia la config de appointments eliminando config + hours
 */
export async function resetAppointments(req: Request, res: Response) {
    const empresaIdRaw = (req as any).user?.empresaId;
    const empresaId = Number(empresaIdRaw);
    if (!Number.isFinite(empresaId)) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });

    await prisma.$transaction(async (tx) => {
        await tx.businessConfigAppt.deleteMany({ where: { empresaId } });
        await tx.appointmentHour.deleteMany({ where: { empresaId } });
    });

    return res.json({ ok: true, reset: true, purgedHours: true });
}

/** ===== DELETE /config ===== */
export async function deleteAppointmentConfig(req: Request, res: Response) {
    const empresaIdRaw = (req as any).user?.empresaId;
    const empresaId = Number(empresaIdRaw);
    if (!Number.isFinite(empresaId)) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });

    const purgeHours =
        String(req.query.purgeHours || "").toLowerCase() === "true" ||
        req.query.purgeHours === "1";

    await prisma.$transaction(async (tx) => {
        await tx.businessConfigAppt.deleteMany({ where: { empresaId } });
        if (purgeHours) {
            await tx.appointmentHour.deleteMany({ where: { empresaId } });
        }
    });

    return res.json({ ok: true, purgedHours: purgeHours });
}
