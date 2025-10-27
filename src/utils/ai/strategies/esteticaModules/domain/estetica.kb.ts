
// utils/ai/strategies/esteticaModules/domain/estetica.kb.ts
import prisma from "../../../../../lib/prisma";
import type { AppointmentVertical, StaffRole } from "@prisma/client";



// Helper seguro (arriba del archivo o en utils):
function toArraySafe<T = any>(val: any): T[] {
    if (!val) return [];
    if (Array.isArray(val)) return val as T[];
    if (typeof val === "string") {
        try {
            const p = JSON.parse(val);
            return Array.isArray(p) ? (p as T[]) : [];
        } catch { return []; }
    }
    return [];
}

/** ==== Util precio COP ==== */
export function formatCOP(value?: number | null): string | null {
    if (value == null || isNaN(Number(value))) return null;
    return new Intl.NumberFormat("es-CO", {
        style: "currency",
        currency: "COP",
        maximumFractionDigits: 0,
    }).format(Number(value));
}

/** Regex robusto para montos en COP tipo $120.000 / 120.000 COP / $ 1.200.000 */
export const MONEY_RE = /\b(?:COP\s*)?\$?\s?\d{1,3}(?:\.\d{3})+(?:,\d+)?\s?(?:COP)?\b/gi;

/** KB del negocio para la vertical de estética (con info operativa y catálogo) */
export type EsteticaKB = {
    empresaId: number;
    vertical: AppointmentVertical | "custom";
    businessName?: string | null;
    timezone: string;
    bufferMin: number;
    policies?: string | null;
    faqs?: Array<{ q: string; a: string }>;

    location?: {
        name?: string | null;
        address?: string | null;
        mapsUrl?: string | null;
        parkingInfo?: string | null;
        arrivalInstructions?: string | null;
    };

    // Config operativa
    allowSameDay: boolean;
    minNoticeHours?: number | null;
    maxAdvanceDays?: number | null;
    defaultServiceDurationMin?: number | null;

    // Staff disponible (básico)
    staff: Array<{
        id: number;
        name: string;
        role: StaffRole;
        active: boolean;
    }>;

    // Excepciones (solo meta para prompt/razonamiento)
    exceptions: Array<{
        dateISO: string; // YYYY-MM-DD
        isOpen: boolean | null; // si false => cerrado ese día
        start1?: string | null; // "HH:MM"
        end1?: string | null;
        start2?: string | null;
        end2?: string | null;
        reason?: string | null;
    }>;

    // Procedimientos habilitados
    procedures: Array<{
        id: number;
        name: string;
        enabled: boolean;
        aliases: string[];
        durationMin?: number | null;
        requiresAssessment: boolean;
        priceMin?: number | null; // Mostrar “Desde $X” si no es null
        priceMax?: number | null;
        depositRequired: boolean;
        depositAmount?: number | null;
        prepInstructions?: string | null;
        postCare?: string | null;
        contraindications?: string | null;
        notes?: string | null;
        pageUrl?: string | null;
        requiredStaffIds?: number[] | null;
    }>;
};

type LoadKBInput = {
    empresaId: number;
    vertical?: AppointmentVertical | "custom";
};

export async function loadEsteticaKB(params: LoadKBInput): Promise<EsteticaKB | null> {
    const { empresaId, vertical = "estetica" as AppointmentVertical } = params;

    const [empresa, apptCfg, procedures, staff, exceptions] = await Promise.all([
        prisma.empresa.findUnique({
            where: { id: empresaId },
            select: { id: true, nombre: true },
        }),
        prisma.businessConfigAppt.findUnique({
            where: { empresaId },
            select: {
                appointmentVertical: true,
                appointmentTimezone: true,
                appointmentBufferMin: true,
                appointmentPolicies: true,
                allowSameDayBooking: true,
                appointmentMinNoticeHours: true,
                appointmentMaxAdvanceDays: true,
                defaultServiceDurationMin: true,

                locationName: true,
                locationAddress: true,
                locationMapsUrl: true,
                parkingInfo: true,
                instructionsArrival: true,
                kbFAQs: true,
            },
        }),
        prisma.esteticaProcedure.findMany({
            where: { empresaId, enabled: true },
            orderBy: { name: "asc" },
        }),
        prisma.staff.findMany({
            where: { empresaId, active: true },
            select: { id: true, name: true, role: true, active: true },
            orderBy: { name: "asc" },
        }),
        prisma.appointmentException.findMany({
            where: { empresaId },
            orderBy: { date: "asc" },
        }),
    ]);

    if (!empresa || !apptCfg) return null;
    // === FAQs desde businessConfigAppt (parse seguro) ===
    const faqsFromCfg = toArraySafe<{ q?: string; a?: string }>(apptCfg.kbFAQs)
        .filter(f => (f?.q || "").trim() && (f?.a || "").trim())
        .map(f => ({ q: String(f.q).trim(), a: String(f.a).trim() }));


    return {
        empresaId,
        vertical: (apptCfg.appointmentVertical as AppointmentVertical) ?? "custom",
        businessName: empresa.nombre,
        timezone: apptCfg.appointmentTimezone || "America/Bogota",
        bufferMin: apptCfg.appointmentBufferMin ?? 10,
        policies: apptCfg.appointmentPolicies ?? null,
        faqs: faqsFromCfg,


        allowSameDay: !!apptCfg.allowSameDayBooking,
        minNoticeHours: apptCfg.appointmentMinNoticeHours ?? null,
        maxAdvanceDays: apptCfg.appointmentMaxAdvanceDays ?? null,
        defaultServiceDurationMin: apptCfg.defaultServiceDurationMin ?? null,

        location: {
            name: apptCfg.locationName,
            address: apptCfg.locationAddress,
            mapsUrl: apptCfg.locationMapsUrl,
            parkingInfo: apptCfg.parkingInfo,
            arrivalInstructions: apptCfg.instructionsArrival,
        },

        staff: staff.map((s) => ({ ...s })),

        exceptions: exceptions.map((e) => ({
            dateISO: e.date.toISOString().slice(0, 10),
            isOpen: e.isOpen ?? null,
            start1: e.start1,
            end1: e.end1,
            start2: e.start2,
            end2: e.end2,
            reason: e.reason ?? null,
        })),


        procedures: procedures.map((p) => ({
            id: p.id,
            name: p.name,
            enabled: p.enabled,
            aliases: Array.isArray(p.aliases) ? (p.aliases as string[]) : [],
            durationMin: p.durationMin ?? null,
            requiresAssessment: p.requiresAssessment ?? false,
            priceMin: p.priceMin != null ? Number(p.priceMin) : null, // <- Decimal a number
            priceMax: p.priceMax != null ? Number(p.priceMax) : null,
            depositRequired: p.depositRequired ?? false,
            depositAmount: p.depositAmount != null ? Number(p.depositAmount) : null,
            prepInstructions: p.prepInstructions ?? null,
            postCare: p.postCare ?? null,
            contraindications: p.contraindications ?? null,
            notes: p.notes ?? null,
            pageUrl: p.pageUrl ?? null,
            requiredStaffIds: (p.requiredStaffIds as number[] | null) ?? null,

        })),
    };
}

/** Resolver nombre/alias de servicio (case-insensitive, acentos tolerantes) */
export function resolveServiceName(
    kb: EsteticaKB,
    userText: string
): { procedure: EsteticaKB["procedures"][number] | null; matched: string | null } {
    const norm = (s: string) =>
        (s || "")
            .toLowerCase()
            .normalize("NFD")
            .replace(/\p{Diacritic}/gu, "");

    const text = norm(userText);
    // match por nombre
    for (const p of kb.procedures) {
        if (text.includes(norm(p.name))) return { procedure: p, matched: p.name };
    }
    // match por alias
    for (const p of kb.procedures) {
        for (const a of p.aliases || []) {
            if (a && text.includes(norm(a))) return { procedure: p, matched: a };
        }
    }
    return { procedure: null, matched: null };
}

/** Etiqueta “Desde $X (COP)” usando priceMin */
export function serviceDisplayPrice(proc: { priceMin?: number | null }): string | null {
    const f = formatCOP(proc?.priceMin ?? null);
    return f ? `${f} (COP)` : null;
}
