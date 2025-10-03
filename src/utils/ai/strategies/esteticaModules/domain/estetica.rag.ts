// server/src/utils/ai/strategies/esteticaModules/estetica.rag.ts
import prisma from "../../../../../lib/prisma";
import type { AppointmentVertical } from "@prisma/client";
import { AppointmentStatus } from "@prisma/client";

/* ======================= Logger mínimo (namespaced) ======================= */
const ESTETICA_DEBUG = String(process.env.ESTETICA_DEBUG ?? "0") !== "0";
type Lvl = "debug" | "info" | "warn" | "error";
function log(level: Lvl, msg: string, meta?: any) {
    if (!ESTETICA_DEBUG && level === "debug") return;
    const tag = `[RAG:${level.toUpperCase()}]`;
    if (meta !== undefined) {
        // eslint-disable-next-line no-console
        (console as any)[level] ? (console as any)[level](tag, msg, meta) : console.log(tag, msg, meta);
    } else {
        // eslint-disable-next-line no-console
        (console as any)[level] ? (console as any)[level](tag, msg) : console.log(tag, msg);
    }
}

/* ===================== UTILS de parseo seguro ===================== */
function asStrArr(v: unknown): string[] | null {
    if (!v && v !== 0) return null;
    if (Array.isArray(v)) return (v.filter((x) => typeof x === "string") as string[]) || null;
    if (typeof v === "string") {
        try {
            const j = JSON.parse(v);
            return Array.isArray(j) ? j.filter((x) => typeof x === "string") : null;
        } catch {
            return null;
        }
    }
    return null;
}
function asNum(v: unknown, dflt?: number | null): number | null {
    const n = Number(v);
    return Number.isFinite(n) ? n : dflt ?? null;
}
function asBool(v: unknown, dflt = false): boolean {
    if (typeof v === "boolean") return v;
    if (typeof v === "string") return ["true", "1", "yes", "si", "sí"].includes(v.toLowerCase());
    if (typeof v === "number") return v !== 0;
    return dflt;
}

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
    const t0 = Date.now();

    if (fromOrchestrator) {
        const o = fromOrchestrator ?? {};
        const rules = o.rules ?? {};
        const ctx: EsteticaCtx = {
            empresaId,
            vertical: (o.vertical as AppointmentVertical) ?? "custom",
            timezone: o.timezone ?? "America/Bogota",
            bufferMin: asNum(o.bufferMin, 10) ?? 10,
            policies: o.policies ?? null,
            logistics: o.logistics ?? {},
            rules: {
                cancellationWindowHours: asNum(rules?.cancellationWindowHours),
                noShowPolicy: rules?.noShowPolicy ?? null,
                depositRequired: typeof rules?.depositRequired === "boolean" ? rules.depositRequired : null,
                depositAmount: rules?.depositAmount ?? null,
                maxDailyAppointments: asNum(rules?.maxDailyAppointments),
                bookingWindowDays:
                    asNum(rules?.bookingWindowDays, asNum(o.appointmentMaxAdvanceDays, 30)) ?? 30,
                blackoutDates: asStrArr(rules?.blackoutDates) ?? null,
                overlapStrategy: (rules?.overlapStrategy as string) ?? "strict",
                minNoticeHours: asNum(o.appointmentMinNoticeHours ?? rules?.minNoticeHours),
                maxAdvanceDays: asNum(o.appointmentMaxAdvanceDays ?? rules?.maxAdvanceDays),
                allowSameDay: asBool(o.allowSameDayBooking ?? rules?.allowSameDay, false),
                requireConfirmation: asBool(
                    o.requireClientConfirmation ?? rules?.requireClientConfirmation,
                    true
                ),
                defaultServiceDurationMin: asNum(o.defaultServiceDurationMin, 60) ?? 60,
                paymentNotes: o.paymentNotes ?? null,
            },
            buildKbContext: async () => {
                const kb = o.kb ?? {};
                const out = [
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
                log("debug", "kb.orchestrator.len", { len: out.length });
                return out;
            },
        };

        log("info", "ctx.loaded.fromOrchestrator", {
            empresaId,
            timezone: ctx.timezone,
            bufferMin: ctx.bufferMin,
            rules: {
                allowSameDay: ctx.rules?.allowSameDay,
                minNoticeHours: ctx.rules?.minNoticeHours,
                bookingWindowDays: ctx.rules?.bookingWindowDays,
                maxDailyAppointments: ctx.rules?.maxDailyAppointments,
                requireConfirmation: ctx.rules?.requireConfirmation,
                defaultServiceDurationMin: ctx.rules?.defaultServiceDurationMin,
                blackoutDatesCount: ctx.rules?.blackoutDates?.length ?? 0,
            },
            ms: Date.now() - t0,
        });
        return ctx;
    }

    const bca = await prisma.businessConfigAppt.findUnique({ where: { empresaId } });

    const ctx: EsteticaCtx = {
        empresaId,
        vertical: (bca?.appointmentVertical as AppointmentVertical) ?? "custom",
        timezone: bca?.appointmentTimezone ?? "America/Bogota",
        bufferMin: asNum(bca?.appointmentBufferMin, 10) ?? 10,
        policies: bca?.appointmentPolicies ?? null,
        logistics: {
            locationName: bca?.locationName ?? undefined,
            locationAddress: bca?.locationAddress ?? undefined,
            locationMapsUrl: bca?.locationMapsUrl ?? undefined,
            instructionsArrival: bca?.instructionsArrival ?? undefined,
            parkingInfo: bca?.parkingInfo ?? undefined,
        },
        rules: {
            cancellationWindowHours: asNum(bca?.cancellationWindowHours),
            noShowPolicy: bca?.noShowPolicy ?? null,
            depositRequired: typeof bca?.depositRequired === "boolean" ? bca.depositRequired : null,
            depositAmount: bca?.depositAmount ?? null,
            maxDailyAppointments: asNum(bca?.maxDailyAppointments),
            bookingWindowDays:
                asNum(bca?.bookingWindowDays, asNum(bca?.appointmentMaxAdvanceDays, 30)) ?? 30,
            blackoutDates: asStrArr(bca?.blackoutDates) ?? null,
            overlapStrategy: bca?.overlapStrategy ?? "strict",
            minNoticeHours: asNum(bca?.appointmentMinNoticeHours),
            maxAdvanceDays: asNum(bca?.appointmentMaxAdvanceDays),
            allowSameDay: asBool(bca?.allowSameDayBooking, false),
            requireConfirmation: asBool(bca?.requireClientConfirmation, true),
            defaultServiceDurationMin: asNum(bca?.defaultServiceDurationMin, 60) ?? 60,
            paymentNotes: null,
        },
        buildKbContext: async () => {
            const out = [
                bca?.kbBusinessOverview && `Sobre la empresa:\n${bca.kbBusinessOverview}`,
                Array.isArray(bca?.kbFAQs) && (bca?.kbFAQs as any[])?.length
                    ? `FAQs:\n${(bca!.kbFAQs as any[]).map((f: any) => `- ${f.q}\n  ${f.a}`).join("\n")}`
                    : "",
                bca?.kbServiceNotes && `Notas de servicios:\n${JSON.stringify(bca.kbServiceNotes, null, 2)}`,
                bca?.kbDisclaimers && `Avisos/Disclaimers:\n${bca.kbDisclaimers}`,
                bca?.kbFreeText && `Notas libres:\n${bca.kbFreeText}`,
            ]
                .filter(Boolean)
                .join("\n\n");
            log("debug", "kb.db.len", { len: out.length });
            return out;
        },
    };

    log("info", "ctx.loaded.fromDB", {
        empresaId,
        timezone: ctx.timezone,
        bufferMin: ctx.bufferMin,
        rules: {
            allowSameDay: ctx.rules?.allowSameDay,
            minNoticeHours: ctx.rules?.minNoticeHours,
            bookingWindowDays: ctx.rules?.bookingWindowDays,
            maxDailyAppointments: ctx.rules?.maxDailyAppointments,
            requireConfirmation: ctx.rules?.requireConfirmation,
            defaultServiceDurationMin: ctx.rules?.defaultServiceDurationMin,
            blackoutDatesCount: ctx.rules?.blackoutDates?.length ?? 0,
        },
        ms: Date.now() - t0,
    });

    return ctx;
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
export async function retrieveProcedures(empresaId: number, rawQuery?: string, topN = 6) {
    const t0 = Date.now();
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
                        { name: { contains: q } as any },
                        { notes: { contains: q } as any },
                        { contraindications: { contains: q } as any },
                        { prepInstructions: { contains: q } as any },
                        { postCare: { contains: q } as any },
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

    log("info", "retrieveProcedures", {
        empresaId,
        qOriginal: rawQuery ?? "",
        qProcessed: q,
        returned: rows.length,
        ms: Date.now() - t0,
    });

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
    const t0 = Date.now();
    const q = nrm(text);
    if (!q) {
        log("warn", "matchProcedureFromText.emptyQuery");
        return null;
    }

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

    log("info", "matchProcedureFromText.result", {
        q,
        bestId: best?.id ?? null,
        bestName: best?.name ?? null,
        bestScore,
        considered: rows.length,
        ms: Date.now() - t0,
    });

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
export async function confirmLatestPendingForPhone(
    empresaId: number,
    phoneE164: string
) {
    const t0 = Date.now();
    const appt = await prisma.appointment.findFirst({
        where: { empresaId, customerPhone: phoneE164, status: AppointmentStatus.pending },
        orderBy: { startAt: "desc" },
        select: { id: true },
    });
    if (!appt) {
        log("debug", "confirmLatestPendingForPhone.none", { empresaId, phoneE164, ms: Date.now() - t0 });
        return null;
    }
    const updated = await prisma.appointment.update({
        where: { id: appt.id },
        data: { status: AppointmentStatus.confirmed },
    });
    log("info", "confirmLatestPendingForPhone.ok", {
        empresaId,
        phoneE164,
        appointmentId: appt.id,
        ms: Date.now() - t0,
    });
    return updated;
}
