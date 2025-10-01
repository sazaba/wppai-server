// server/src/utils/ai/strategies/esteticaModules/estetica.rag.ts
import prisma from "../../../../lib/prisma";
import type { AppointmentVertical } from "@prisma/client";
import { AppointmentStatus } from "@prisma/client";

/* ===========================================================
 * Contexto de negocio para agenda estética (RAG liviano)
 * =========================================================== */

export type EsteticaCtx = {
    empresaId: number;
    vertical: AppointmentVertical | "custom";
    timezone: string;
    bufferMin: number;
    policies?: string | null;
    logistics?: {
        locationName?: string;
        locationAddress?: string;
        locationMapsUrl?: string;
        instructionsArrival?: string;
        parkingInfo?: string;
    };
    rules?: {
        cancellationWindowHours?: number | null;
        noShowPolicy?: string | null;
        depositRequired?: boolean | null;
        depositAmount?: unknown;
        maxDailyAppointments?: number | null;
        bookingWindowDays?: number | null;
        blackoutDates?: string[] | null;
        overlapStrategy?: string | null;
        minNoticeHours?: number | null;
        maxAdvanceDays?: number | null;
        allowSameDay?: boolean | null;
        requireConfirmation?: boolean | null;
        defaultServiceDurationMin?: number | null;
        paymentNotes?: string | null;
    };
    buildKbContext: () => Promise<string>;
};

/** Carga el contexto desde el orquestador (si llega) o desde BD */
export async function loadApptContext(
    empresaId: number,
    fromOrchestrator?: any
): Promise<EsteticaCtx> {
    if (fromOrchestrator) {
        const o = fromOrchestrator ?? {};
        const rules = o.rules ?? {};
        return {
            empresaId,
            vertical: (o.vertical as AppointmentVertical) ?? "custom",
            timezone: o.timezone ?? "America/Bogota",
            bufferMin: Number(o.bufferMin ?? 10),
            policies: o.policies ?? null,
            logistics: o.logistics ?? {},
            rules: {
                cancellationWindowHours: rules?.cancellationWindowHours ?? null,
                noShowPolicy: rules?.noShowPolicy ?? null,
                depositRequired: rules?.depositRequired ?? null,
                depositAmount: rules?.depositAmount ?? null,
                maxDailyAppointments: rules?.maxDailyAppointments ?? null,
                bookingWindowDays: rules?.bookingWindowDays ?? 30,
                blackoutDates: (rules?.blackoutDates as string[] | null) ?? null,
                overlapStrategy: rules?.overlapStrategy ?? "strict",
                minNoticeHours: o.appointmentMinNoticeHours ?? rules?.minNoticeHours ?? null,
                maxAdvanceDays: o.appointmentMaxAdvanceDays ?? rules?.maxAdvanceDays ?? null,
                allowSameDay: o.allowSameDayBooking ?? rules?.allowSameDay ?? false,
                requireConfirmation: o.requireClientConfirmation ?? rules?.requireClientConfirmation ?? true,
                defaultServiceDurationMin: o.defaultServiceDurationMin ?? 60,
                paymentNotes: o.paymentNotes ?? null,
            },
            buildKbContext: async () => {
                const kb = o.kb ?? {};
                return [
                    kb.businessOverview && `Sobre la empresa:\n${kb.businessOverview}`,
                    Array.isArray(kb.faqs) && kb.faqs.length
                        ? `FAQs:\n${kb.faqs.map((f: any) => `- ${f.q}\n  ${f.a}`).join("\n")}`
                        : "",
                    kb.serviceNotes && `Notas de servicios:\n${JSON.stringify(kb.serviceNotes, null, 2)}`,
                    kb.disclaimers && `Avisos/Disclaimers:\n${kb.disclaimers}`,
                    kb.freeText && `Notas libres:\n${kb.freeText}`,
                ]
                    .filter(Boolean)
                    .join("\n\n");
            },
        };
    }

    const bca = await prisma.businessConfigAppt.findUnique({ where: { empresaId } });

    return {
        empresaId,
        vertical: (bca?.appointmentVertical as AppointmentVertical) ?? "custom",
        timezone: bca?.appointmentTimezone ?? "America/Bogota",
        bufferMin: Number(bca?.appointmentBufferMin ?? 10),
        policies: bca?.appointmentPolicies ?? null,
        logistics: {
            locationName: bca?.locationName ?? undefined,
            locationAddress: bca?.locationAddress ?? undefined,
            locationMapsUrl: bca?.locationMapsUrl ?? undefined,
            instructionsArrival: bca?.instructionsArrival ?? undefined,
            parkingInfo: bca?.parkingInfo ?? undefined,
        },
        rules: {
            cancellationWindowHours: bca?.cancellationWindowHours ?? null,
            noShowPolicy: bca?.noShowPolicy ?? null,
            depositRequired: bca?.depositRequired ?? null,
            depositAmount: bca?.depositAmount ?? null,
            maxDailyAppointments: bca?.maxDailyAppointments ?? null,
            bookingWindowDays: bca?.bookingWindowDays ?? 30,
            blackoutDates: (bca?.blackoutDates as unknown as string[]) ?? null,
            overlapStrategy: bca?.overlapStrategy ?? "strict",
            minNoticeHours: bca?.appointmentMinNoticeHours ?? null,
            maxAdvanceDays: bca?.appointmentMaxAdvanceDays ?? null,
            allowSameDay: bca?.allowSameDayBooking ?? false,
            requireConfirmation: bca?.requireClientConfirmation ?? true,
            defaultServiceDurationMin: bca?.defaultServiceDurationMin ?? 60,
            paymentNotes: null,
        },
        buildKbContext: async () =>
            [
                bca?.kbBusinessOverview && `Sobre la empresa:\n${bca.kbBusinessOverview}`,
                Array.isArray(bca?.kbFAQs) && (bca?.kbFAQs as any[])?.length
                    ? `FAQs:\n${(bca!.kbFAQs as any[]).map((f: any) => `- ${f.q}\n  ${f.a}`).join("\n")}`
                    : "",
                bca?.kbServiceNotes && `Notas de servicios:\n${JSON.stringify(bca.kbServiceNotes, null, 2)}`,
                bca?.kbDisclaimers && `Avisos/Disclaimers:\n${bca.kbDisclaimers}`,
                bca?.kbFreeText && `Notas libres:\n${bca.kbFreeText}`,
            ]
                .filter(Boolean)
                .join("\n\n"),
    };
}

/* ==================== Catálogo y matching ==================== */

const nrm = (s: string) =>
    String(s || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^\w\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

/**
 * Recupera procedimientos (topN) realizando una búsqueda insensible.
 * Si no hay resultados, devuelve los más recientes/alfabéticos.
 */
export async function retrieveProcedures(
    empresaId: number,
    rawQuery?: string,
    topN = 6
) {
    const q0 = (rawQuery || "").trim();
    const quoted = q0.match(/["“”](.+?)["“”]/)?.[1];
    const q = (quoted || q0)
        .replace(/[?¡!.,:;()]/g, " ")
        .replace(
            /\b(que|qué|cual|cuál|cuales|cuáles|de|del|la|el|los|las|un|una|unos|unas|y|o|u|para|con|sin|sobre|tratamiento|tratamientos|facial|faciales|precio|precios|duración|duracion|mostrar|servicios)\b/gi,
            " "
        )
        .replace(/\s+/g, " ")
        .trim();

    const baseSelect = {
        id: true,
        name: true,
        durationMin: true,
        priceMin: true,
        priceMax: true,
        requiresAssessment: true,
        prepInstructions: true,
        contraindications: true,
        postCare: true,
        notes: true,
    } as const;

    let rows =
        q.length > 0
            ? await prisma.esteticaProcedure.findMany({
                where: {
                    empresaId,
                    enabled: true,
                    OR: [
                        { name: { contains: q, mode: "insensitive" } as any },
                        { notes: { contains: q, mode: "insensitive" } as any },
                        { contraindications: { contains: q, mode: "insensitive" } as any },
                        { prepInstructions: { contains: q, mode: "insensitive" } as any },
                        { postCare: { contains: q, mode: "insensitive" } as any },
                    ],
                },
                orderBy: [{ updatedAt: "desc" }, { name: "asc" }],
                take: topN,
                select: baseSelect,
            })
            : [];

    if (!rows.length) {
        rows = await prisma.esteticaProcedure.findMany({
            where: { empresaId, enabled: true },
            orderBy: [{ updatedAt: "desc" }, { name: "asc" }],
            take: topN,
            select: baseSelect,
        });
    }

    return rows;
}

/**
 * Hace matching aproximado por nombre o alias (normalizado).
 */
export async function matchProcedureFromText(
    empresaId: number,
    text: string
): Promise<{
    id: number;
    name: string;
    durationMin?: number | null;
    depositRequired?: boolean;
    depositAmount?: unknown;
} | null> {
    const q = nrm(text);
    if (!q) return null;

    const rows = await prisma.esteticaProcedure.findMany({
        where: { empresaId, enabled: true },
        select: {
            id: true,
            name: true,
            durationMin: true,
            aliases: true,
            depositRequired: true,
            depositAmount: true,
        },
    });

    type Row = (typeof rows)[number];
    let best: Row | null = null;
    let bestScore = 0;

    for (const r of rows) {
        const nameScore = q.includes(nrm(r.name)) ? 1 : 0;
        let aliasScore = 0;
        const aliases = Array.isArray(r.aliases) ? (r.aliases as unknown as string[]) : [];
        for (const a of aliases) {
            if (typeof a === "string" && q.includes(nrm(a))) {
                aliasScore = Math.max(aliasScore, 0.8);
            }
        }
        const score = Math.max(nameScore, aliasScore);
        if (score > bestScore) {
            best = r;
            bestScore = score;
        }
    }

    return best && bestScore >= 0.6
        ? {
            id: best.id,
            name: best.name,
            durationMin: best.durationMin,
            depositRequired: best.depositRequired ?? undefined,
            depositAmount: best.depositAmount ?? undefined,
        }
        : null;
}

/** Confirma la última cita en estado pending para un teléfono (si existe) */
export async function confirmLatestPendingForPhone(empresaId: number, phoneE164: string) {
    const appt = await prisma.appointment.findFirst({
        where: { empresaId, customerPhone: phoneE164, status: AppointmentStatus.pending },
        orderBy: { startAt: "desc" },
        select: { id: true },
    });
    if (!appt) return null;
    return prisma.appointment.update({
        where: { id: appt.id },
        data: { status: AppointmentStatus.confirmed },
    });
}
