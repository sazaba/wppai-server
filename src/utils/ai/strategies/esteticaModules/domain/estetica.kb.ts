// utils/ai/strategies/esteticaModules/domain/estetica.kb.ts
import prisma from "../../../../../lib/prisma";
import { Logger } from "../../esteticaModules/log";

const log = Logger.child("estetica.kb");

// ———————————————————————————————————————————————————————————————————————
// Tipos expuestos
// ———————————————————————————————————————————————————————————————————————
export type KBService = {
    id: number;
    name: string;
    description?: string | null;
    enabled: boolean;
    duration?: number | null;      // minutos (variante 1)
    durationMin?: number | null;   // minutos (variante 2)
    // 💵 NUEVO: precios estructurados
    priceMin?: number | null;      // precio mínimo (COP)
    priceMax?: number | null;      // precio máximo (COP)
    deposit?: number | null;       // anticipo/deposito (COP)
    currency?: string | null;      // "COP" por defecto si viene vacío
    priceNote?: string | null;     // notas de precio/condiciones
    aliases?: string[];            // palabras/alias para matching
};

export type KBStaff = {
    id: number;
    name: string;
    role?: string | null;
    phone?: string | null;
    email?: string | null;
    enabled: boolean;
    specialties?: number[] | string[] | null;
};

export type EsteticaKB = {
    empresaId: number;
    empresaNombre?: string | null;

    timezone: string;
    bufferMin?: number | null;
    rules?: Record<string, any> | null;

    logistics?: {
        locationName?: string | null;
        locationAddress?: string | null;
        locationMapsUrl?: string | null;
        virtualMeetingLink?: string | null;
        parkingInfo?: string | null;
        instructionsArrival?: string | null;
    };

    policies?: string | null;
    reminders?: boolean | null;
    remindersConfig?: Record<string, any> | null;

    services: KBService[];
    staff: KBStaff[];

    kbTexts: {
        businessOverview?: string | null;
        disclaimers?: string | null;
        servicesText?: string | null;
    };
};

// ———————————————————————————————————————————————————————————————————————
// Utilidades internas
// ———————————————————————————————————————————————————————————————————————
function norm(s: string) {
    return s
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function tokenScore(a: string, b: string) {
    const ta = new Set(norm(a).split(" ").filter(Boolean));
    const tb = new Set(norm(b).split(" ").filter(Boolean));
    let hit = 0;
    for (const t of ta) if (tb.has(t)) hit++;
    return hit / Math.max(1, ta.size);
}

function parseJSON<T = any>(v: any): T | null {
    try {
        if (v == null) return null;
        if (typeof v === "object") return v as T;
        return JSON.parse(String(v)) as T;
    } catch {
        return null;
    }
}

function splitAliases(raw?: string | null): string[] {
    if (!raw) return [];
    return raw.split(/[;,/|]/g).map(x => x.trim()).filter(Boolean);
}

// ———————————————————————————————————————————————————————————————————————
// Carga KB
// ———————————————————————————————————————————————————————————————————————
export async function loadEsteticaKB(empresaId: number): Promise<EsteticaKB | null> {
    // 1) businessconfig_appt
    const cfg =
        (await (prisma as any)["businessconfig_appt"]?.findFirst?.({ where: { empresaId } } as any)) ??
        (await (prisma as any).businessConfigAppt?.findFirst?.({ where: { empresaId } }));

    // 2) procedimientos
    const procedures =
        (await (prisma as any)["estetica_procedure"]?.findMany?.({
            where: { empresaId },
            orderBy: { id: "asc" },
        } as any)) ??
        (await (prisma as any).esteticaProcedure?.findMany?.({
            where: { empresaId },
            orderBy: { id: "asc" },
        } as any)) ??
        [];

    // 3) staff
    const staffRows =
        (await (prisma as any)["staff"]?.findMany?.({
            where: { empresaId },
            orderBy: { id: "asc" },
        } as any)) ??
        (await (prisma as any).Staff?.findMany?.({
            where: { empresaId },
            orderBy: { id: "asc" },
        } as any)) ??
        [];

    if (!cfg && !procedures.length && !staffRows.length) {
        log.warn("KB vacío para empresa", { empresaId });
        return {
            empresaId,
            empresaNombre: null,
            timezone: "America/Santiago",
            bufferMin: 10,
            rules: null,
            logistics: {},
            policies: null,
            reminders: null,
            remindersConfig: null,
            services: [],
            staff: [],
            kbTexts: {},
        };
    }

    // ——— mapear config
    const timezone = cfg?.timezone || cfg?.timeZone || cfg?.tz || "America/Santiago";
    const bufferMin = cfg?.bufferMin ?? cfg?.bookingBufferMin ?? cfg?.defaultBufferMin ?? null;
    const empresaNombre = cfg?.nombre || cfg?.businessName || cfg?.companyName || null;

    const rules =
        parseJSON<Record<string, any>>(cfg?.rules) ??
        parseJSON<Record<string, any>>(cfg?.rulesJson) ??
        null;

    const remindersConfig =
        parseJSON<Record<string, any>>(cfg?.remindersConfig) ??
        parseJSON<Record<string, any>>(cfg?.reminders_json) ??
        null;

    const logistics = {
        locationName: cfg?.locationName || cfg?.clinicName || cfg?.sede || null,
        locationAddress: cfg?.locationAddress || cfg?.address || null,
        locationMapsUrl: cfg?.locationMapsUrl || cfg?.mapsUrl || null,
        virtualMeetingLink: cfg?.virtualMeetingLink || null,
        parkingInfo: cfg?.parkingInfo || null,
        instructionsArrival: cfg?.instructionsArrival || cfg?.arrivalNotes || null,
    };

    const policies = cfg?.policies || cfg?.politicas || cfg?.policyText || null;
    const reminders = typeof cfg?.reminders === "boolean" ? cfg.reminders : cfg?.sendReminders ?? null;
    const businessOverview = cfg?.businessOverview || cfg?.overview || cfg?.about || null;
    const servicesText = cfg?.servicesText || cfg?.serviciosTexto || null;
    const disclaimers = cfg?.disclaimers || cfg?.avisos || null;

    // ——— mapear procedimientos a KBService[]
    const services: KBService[] = procedures.map((p: any) => {
        const name = p?.name ?? p?.nombre ?? `#${p?.id ?? "?"}`;
        const description = p?.description ?? p?.descripcion ?? null;

        const duration = typeof p?.duration === "number" ? p.duration : null;
        const durationMin =
            typeof p?.durationMin === "number"
                ? p.durationMin
                : typeof p?.duracionMin === "number"
                    ? p.duracionMin
                    : null;

        // 💵 capturamos variantes de precio
        const priceMin =
            asNumber(p?.priceMin) ??
            asNumber(p?.precioMin) ??
            asNumber(p?.price) ??
            asNumber(p?.precio) ??
            asNumber(p?.basePrice) ??
            null;

        const priceMax =
            asNumber(p?.priceMax) ??
            asNumber(p?.precioMax) ??
            asNumber(p?.maxPrice) ??
            asNumber(p?.precio_max) ??
            null;

        const deposit =
            asNumber(p?.deposit) ??
            asNumber(p?.deposito) ??
            asNumber(p?.downpayment) ??
            null;

        const currency = (p?.currency ?? p?.moneda ?? "COP") as string | null;
        const priceNote = p?.priceNote ?? p?.notaPrecio ?? p?.condicionesPrecio ?? null;

        const enabled = (p?.enabled ?? p?.activo ?? true) !== false;

        const aliasesArr: string[] = Array.isArray(p?.aliases)
            ? p.aliases
            : splitAliases(p?.aliases || p?.keywords || p?.etiquetas || null);

        return {
            id: Number(p?.id),
            name,
            description,
            enabled,
            duration,
            durationMin,
            priceMin,
            priceMax,
            deposit,
            currency,
            priceNote,
            aliases: aliasesArr,
        };
    });

    // ——— mapear staff
    const staff: KBStaff[] = staffRows.map((s: any) => ({
        id: Number(s?.id),
        name: s?.name ?? s?.nombre ?? `Staff #${s?.id ?? "?"}`,
        role: s?.role ?? s?.cargo ?? null,
        phone: s?.phone ?? s?.telefono ?? null,
        email: s?.email ?? null,
        enabled: (s?.enabled ?? s?.activo ?? true) !== false,
        specialties:
            s?.specialties ?? s?.especialidades ?? parseJSON(s?.specialtiesJson) ?? null,
    }));

    const kb: EsteticaKB = {
        empresaId,
        empresaNombre,
        timezone,
        bufferMin,
        rules,
        logistics,
        policies,
        reminders,
        remindersConfig,
        services,
        staff,
        kbTexts: {
            businessOverview,
            servicesText,
            disclaimers,
        },
    };

    log.info("KB cargado", {
        empresaId,
        services: kb.services.length,
        staff: kb.staff.length,
        timezone: kb.timezone,
    });

    return kb;
}

function asNumber(v: any): number | null {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

// ———————————————————————————————————————————————————————————————————————
// Matching de servicio
// ———————————————————————————————————————————————————————————————————————
export function resolveServiceName(kb: EsteticaKB, text: string): KBService | null {
    if (!text || !kb?.services?.length) return null;

    const t = text.toLowerCase();
    const candidates = kb.services.filter(s => s.enabled !== false);

    const ntext = norm(t);
    for (const s of candidates) if (norm(s.name) === ntext) return s;

    for (const s of candidates) {
        const nameHit = ntext.includes(norm(s.name));
        const aliasHit = (s.aliases || []).some(a => ntext.includes(norm(a)));
        if (nameHit || aliasHit) return s;
    }

    let best: { svc: KBService; score: number } | null = null;
    for (const s of candidates) {
        let score = tokenScore(s.name, t);
        for (const a of s.aliases || []) score = Math.max(score, tokenScore(a, t));
        if (!best || score > best.score) best = { svc: s, score };
    }
    if (best && best.score >= 0.45) return best.svc;
    return null;
}
