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
    // 💵 precios estructurados desde BD
    priceMin?: number | null;      // precio mínimo (COP)
    priceMax?: number | null;      // precio máximo (COP)
    deposit?: number | null;       // anticipo/deposito (COP)
    currency?: string | null;      // "COP" por defecto si viene vacío
    priceNote?: string | null;     // notas de precio/condiciones
    aliases?: string[];            // palabras/alias para matching
    // textos clínicos opcionales
    prepInstructions?: string | null;
    postCare?: string | null;
    contraindications?: string | null;
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
export const MONEY_RE = /\$?\s?\d{2,3}(?:\.\d{3})*(?:,\d{2})?/g;

function normBasic(s: string) {
    return s
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function tokenScore(a: string, b: string) {
    const ta = new Set(normBasic(a).split(" ").filter(Boolean));
    const tb = new Set(normBasic(b).split(" ").filter(Boolean));
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
    const base = raw.split(/[;,/|]/g).map((x) => normBasic(String(x))).filter(Boolean);
    const expand: string[] = [];
    for (const a of base) {
        expand.push(a);
        if (a.endsWith("s")) expand.push(a.replace(/s$/, ""));
        else expand.push(`${a}s`);
    }
    return Array.from(new Set(expand));
}

function stripPrices(s?: string | null) {
    if (!s) return s ?? null;
    return s.replace(MONEY_RE, "precio");
}

function asNumber(v: any): number | null {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

// ———————————————————————————————————————————————————————————————————————
export async function loadEsteticaKB(empresaId: number): Promise<EsteticaKB | null> {
    // 1) businessconfig_appt
    const cfg =
        (await (prisma as any)["businessconfig_appt"]?.findFirst?.({ where: { empresaId } } as any)) ??
        (await (prisma as any).businessConfigAppt?.findFirst?.({ where: { empresaId } } as any));

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

    const rules = parseJSON<Record<string, any>>(cfg?.rules) ?? parseJSON<Record<string, any>>(cfg?.rulesJson) ?? null;
    const remindersConfig =
        parseJSON<Record<string, any>>(cfg?.remindersConfig) ?? parseJSON<Record<string, any>>(cfg?.reminders_json) ?? null;

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

    // Sanitizar textos libres para evitar montos
    const businessOverview = stripPrices(cfg?.businessOverview || cfg?.overview || cfg?.about || null);
    const servicesText = stripPrices(cfg?.servicesText || cfg?.serviciosTexto || null);
    const disclaimers = stripPrices(cfg?.disclaimers || cfg?.avisos || null);

    // ——— mapear procedimientos a KBService[]
    const services: KBService[] = procedures.map((p: any) => {
        const name = p?.name ?? p?.nombre ?? `#${p?.id ?? "?"}`;
        const description = p?.description ?? p?.descripcion ?? null;

        const duration = typeof p?.duration === "number" ? p.duration : null;
        const durationMin =
            typeof p?.durationMin === "number"
                ? p?.durationMin
                : typeof p?.duracionMin === "number"
                    ? p?.duracionMin
                    : null;

        // 💵 precios SOLO desde campos numéricos
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

        const deposit = asNumber(p?.deposit) ?? asNumber(p?.deposito) ?? asNumber(p?.downpayment) ?? null;

        const currency = (p?.currency ?? p?.moneda ?? "COP") as string | null;
        const priceNote = p?.priceNote ?? p?.notaPrecio ?? p?.condicionesPrecio ?? null;

        const enabled = (p?.enabled ?? p?.activo ?? true) !== false;

        const aliasesArr: string[] = Array.isArray(p?.aliases)
            ? (p.aliases as string[]).map((a) => normBasic(String(a)))
            : splitAliases(p?.aliases || p?.keywords || p?.etiquetas || null);

        // textos clínicos (opcionales)
        const prepInstructions = p?.prepInstructions ?? null;
        const postCare = p?.postCare ?? null;
        const contraindications = p?.contraindications ?? null;

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
            prepInstructions,
            postCare,
            contraindications,
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
        specialties: s?.specialties ?? s?.especialidades ?? parseJSON(s?.specialtiesJson) ?? null,
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

// ———————————————————————————————————————————————————————————————————————
// Helpers exportables de precio
// ———————————————————————————————————————————————————————————————————————
export function serviceDisplayPrice(proc?: { priceMin?: number | null }) {
    const v = proc?.priceMin != null ? Number(proc.priceMin) : null;
    if (v == null || !Number.isFinite(v)) return null;
    return new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(v);
}

export function hasStructuredPrice(svc: KBService) {
    return typeof svc.priceMin === "number" && Number.isFinite(svc.priceMin);
}

// ———————————————————————————————————————————————————————————————————————
// Matching de servicio
// ———————————————————————————————————————————————————————————————————————
export function resolveServiceName(kb: EsteticaKB, text: string): KBService | null {
    if (!text || !kb?.services?.length) return null;

    const t = text.toLowerCase();
    const candidates = kb.services.filter((s) => s.enabled !== false);

    const ntext = normBasic(t);

    // match exact normalizado
    for (const s of candidates) if (ntext === normBasic(s.name)) return s;

    // inclusiones / startsWith en nombre/alias
    for (const s of candidates) {
        const nn = normBasic(s.name);
        if (ntext.includes(nn) || nn.startsWith(ntext) || ntext.startsWith(nn)) return s;

        const aliasHit = (s.aliases || []).some((a) => {
            const aa = normBasic(a);
            return ntext.includes(aa) || aa.startsWith(ntext) || ntext.startsWith(aa);
        });
        if (aliasHit) return s;
    }

    // puente común: “botox” → servicio con “toxina/botul” si existe
    if (ntext.includes("botox")) {
        const cand = candidates.find((s) => /toxina|botul/i.test(s.name));
        if (cand) return cand;
    }

    // fuzzy por tokens (umbral conservador)
    let best: { svc: KBService; score: number } | null = null;
    for (const s of candidates) {
        let score = tokenScore(s.name, t);
        for (const a of s.aliases || []) score = Math.max(score, tokenScore(a, t));
        if (!best || score > best.score) best = { svc: s, score };
    }
    if (best && best.score >= 0.45) return best.svc;
    return null;
}
