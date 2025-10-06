// utils/ai/strategies/esteticaModules/domain/estetica.kb.ts
import prisma from "../../../../../lib/prisma";

export type KBService = {
    id: number;
    name: string;
    enabled: boolean;
    durationMin?: number | null;
    requiresAssessment?: boolean;
    aliases: string[];
    priceMin?: number | null;
    priceMax?: number | null;
    depositRequired?: boolean;
    depositAmount?: number | null;
    prepInstructions?: string | null;
    postCare?: string | null;
    contraindications?: string | null;
    notes?: string | null;
};

export type StaffView = {
    id: number;
    name: string;
    role: string;
    active: boolean;
    availability?: any;
};

export type EsteticaKB = {
    empresaId: number;
    empresaNombre: string;
    timezone: string;
    bufferMin: number;
    logistics?: {
        locationName?: string;
        locationAddress?: string;
        locationMapsUrl?: string;
        virtualMeetingLink?: string;
        parkingInfo?: string;
        instructionsArrival?: string;
    };
    rules?: {
        cancellationWindowHours?: number;
        noShowPolicy?: string;
        depositRequired?: boolean;
        depositAmount?: any;
        maxDailyAppointments?: number;
        bookingWindowDays?: number;
        blackoutDates?: any;
        overlapStrategy?: "strict" | "flexible";
    };
    kbTexts: {
        businessOverview?: string;
        disclaimers?: string;
        freeText?: string;
    };
    faqs?: Array<{ q: string; a: string }>;
    serviceNotes?: Record<string, string>;
    services: KBService[];           // fuente de verdad para “qué se puede agendar”
    staff: StaffView[];
};

export function normalize(str: string): string {
    return (str || "")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .trim();
}

export async function loadEsteticaKB(empresaId: number): Promise<EsteticaKB | null> {
    const [empresa, bca, procedures, staff] = await Promise.all([
        prisma.empresa.findUnique({ where: { id: empresaId } }),
        prisma.businessConfigAppt.findUnique({ where: { empresaId } }),
        prisma.esteticaProcedure.findMany({ where: { empresaId, enabled: true }, orderBy: { name: "asc" } }),
        prisma.staff.findMany({ where: { empresaId, active: true }, orderBy: { name: "asc" } }),
    ]);

    if (!empresa || !bca) return null;

    const services: KBService[] = procedures.map((p) => ({
        id: p.id,
        name: p.name,
        enabled: p.enabled,
        durationMin: p.durationMin ?? null,
        requiresAssessment: p.requiresAssessment ?? false,
        aliases: Array.isArray(p.aliases) ? (p.aliases as string[]) : [],
        priceMin: (p.priceMin as any) ?? null,
        priceMax: (p.priceMax as any) ?? null,
        depositRequired: p.depositRequired ?? false,
        depositAmount: (p.depositAmount as any) ?? null,
        prepInstructions: p.prepInstructions ?? null,
        postCare: p.postCare ?? null,
        contraindications: p.contraindications ?? null,
        notes: p.notes ?? null,
    }));

    const staffView: StaffView[] = staff.map((s) => ({
        id: s.id,
        name: s.name,
        role: s.role,
        active: s.active,
        availability: s.availability ?? undefined,
    }));

    const faqs = Array.isArray(bca.kbFAQs) ? (bca.kbFAQs as any[]) : undefined;
    const svcNotes = (bca.kbServiceNotes as any) ?? undefined;

    return {
        empresaId,
        empresaNombre: empresa.nombre,
        timezone: bca.appointmentTimezone ?? "America/Bogota",
        bufferMin: bca.appointmentBufferMin ?? 10,
        logistics: {
            locationName: bca.locationName ?? undefined,
            locationAddress: bca.locationAddress ?? undefined,
            locationMapsUrl: bca.locationMapsUrl ?? undefined,
            virtualMeetingLink: bca.virtualMeetingLink ?? undefined,
            parkingInfo: bca.parkingInfo ?? undefined,
            instructionsArrival: bca.instructionsArrival ?? undefined,
        },
        rules: {
            cancellationWindowHours: bca.cancellationWindowHours ?? undefined,
            noShowPolicy: bca.noShowPolicy ?? undefined,
            depositRequired: bca.depositRequired ?? undefined,
            depositAmount: bca.depositAmount as any,
            maxDailyAppointments: bca.maxDailyAppointments ?? undefined,
            bookingWindowDays: bca.bookingWindowDays ?? undefined,
            blackoutDates: (bca.blackoutDates ?? undefined) as any,
            overlapStrategy: (bca.overlapStrategy as any) ?? "strict",
        },
        kbTexts: {
            businessOverview: bca.kbBusinessOverview ?? undefined,
            disclaimers: bca.kbDisclaimers ?? undefined,
            freeText: bca.kbFreeText ?? undefined,
        },
        faqs: faqs?.map((f) => ({ q: String(f.q ?? ""), a: String(f.a ?? "") })),
        serviceNotes: svcNotes,
        services,
        staff: staffView,
    };
}

// ——— Resolver nombre de servicio contra catálogo + aliases
export function resolveServiceName(kb: EsteticaKB, userText: string): KBService | null {
    const q = normalize(userText);
    // 1) match exact
    const exact = kb.services.find((s) => normalize(s.name) === q);
    if (exact) return exact;
    // 2) contiene
    const contains = kb.services.find((s) => q.includes(normalize(s.name)));
    if (contains) return contains;
    // 3) aliases
    for (const s of kb.services) {
        if (s.aliases?.some((a) => normalize(a) === q || q.includes(normalize(a)))) return s;
    }
    return null;
}
