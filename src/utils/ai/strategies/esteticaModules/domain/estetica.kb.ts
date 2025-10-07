// utils/ai/strategies/esteticaModules/domain/estetica.kb.ts
import prisma from "../../../../../lib/prisma";
import { Logger } from "../../esteticaModules/log";

const log = Logger.child("estetica.kb");

// ———————————————————————————————————————————————————————————————————————
// Tipos expuestos al resto del agente
// ———————————————————————————————————————————————————————————————————————
export type KBService = {
    id: number;
    name: string;
    description?: string | null;
    enabled: boolean;
    duration?: number | null;     // variantes: duration | durationMin
    durationMin?: number | null;
    price?: number | null;        // mapeamos priceMin si existe
    currency?: string | null;
    aliases?: string[];
};

export type KBStaff = {
    id: number;
    name: string;
    role?: string | null;         // StaffRole (string)
    phone?: string | null;        // no está en el schema; queda opcional
    email?: string | null;        // idem
    enabled: boolean;
    specialties?: number[] | string[] | null; // libre
};

export type EsteticaKB = {
    empresaId: number;
    empresaNombre?: string | null;

    // Reglas/params de agenda (la lógica vive en schedule)
    timezone: string;
    bufferMin?: number | null;
    rules?: Record<string, any> | null;

    // Logística/UI
    logistics?: {
        locationName?: string | null;
        locationAddress?: string | null;
        locationMapsUrl?: string | null;
        virtualMeetingLink?: string | null;
        parkingInfo?: string | null;
        instructionsArrival?: string | null;
    };

    // Políticas y recordatorios
    policies?: string | null;
    reminders?: boolean | null;
    remindersConfig?: Record<string, any> | null;

    // Catálogo
    services: KBService[];
    staff: KBStaff[];

    // Bloques de texto útiles para el prompt
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
    return raw
        .split(/[;,/|]/g)
        .map((x) => x.trim())
        .filter(Boolean);
}

// ———————————————————————————————————————————————————————————————————————
// Carga KB
// ———————————————————————————————————————————————————————————————————————
export async function loadEsteticaKB(empresaId: number): Promise<EsteticaKB | null> {
    // 1) BusinessConfigAppt (camelCase) o businessconfig_appt (snake_case)
    const cfgCamel =
        await (prisma as any).businessConfigAppt?.findFirst?.({
            where: { empresaId },
        } as any);

    const cfgSnake =
        await (prisma as any)["businessconfig_appt"]?.findFirst?.({
            where: { empresaId },
        } as any);

    const cfg: any = cfgCamel ?? cfgSnake ?? null;

    // 2) EsteticaProcedure (camelCase) o estetica_procedure (snake_case)
    const procedures =
        (await (prisma as any).esteticaProcedure?.findMany?.({
            where: { empresaId },
            orderBy: { id: "asc" },
        } as any)) ??
        (await (prisma as any)["estetica_procedure"]?.findMany?.({
            where: { empresaId },
            orderBy: { id: "asc" },
        } as any)) ??
        [];

    // 3) Staff (camelCase) o staff (snake_case)
    const staffRows =
        (await (prisma as any).Staff?.findMany?.({
            where: { empresaId },
            orderBy: { id: "asc" },
        } as any)) ??
        (await (prisma as any)["staff"]?.findMany?.({
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

    // ——— mapeo de config usando nombres reales del schema:
    // BusinessConfigAppt:
    // appointmentTimezone, appointmentBufferMin, appointmentPolicies,
    // appointmentReminders, servicesText, location*, kbBusinessOverview, kbDisclaimers
    const timezone: string =
        cfg?.appointmentTimezone ||
        cfg?.timezone ||
        "America/Santiago";

    const bufferMin: number | null =
        (typeof cfg?.appointmentBufferMin === "number" ? cfg.appointmentBufferMin : null) ??
        (typeof cfg?.bufferMin === "number" ? cfg.bufferMin : null);

    const empresaNombre: string | null =
        cfg?.businessName || cfg?.companyName || cfg?.nombre || null;

    const rules: Record<string, any> | null =
        parseJSON<Record<string, any>>(cfg?.appointmentRules) ??
        parseJSON<Record<string, any>>(cfg?.rules) ??
        null;

    const remindersConfig: Record<string, any> | null =
        parseJSON<Record<string, any>>(cfg?.reminderSchedule) ??
        parseJSON<Record<string, any>>(cfg?.remindersConfig) ??
        null;

    const logistics = {
        locationName: cfg?.locationName ?? null,
        locationAddress: cfg?.locationAddress ?? null,
        locationMapsUrl: cfg?.locationMapsUrl ?? null,
        virtualMeetingLink: cfg?.virtualMeetingLink ?? null,
        parkingInfo: cfg?.parkingInfo ?? null,
        instructionsArrival: cfg?.instructionsArrival ?? null,
    };

    const policies: string | null =
        cfg?.appointmentPolicies ?? cfg?.policies ?? null;

    const reminders: boolean | null =
        typeof cfg?.appointmentReminders === "boolean"
            ? cfg.appointmentReminders
            : (typeof cfg?.reminders === "boolean" ? cfg.reminders : null);

    const businessOverview: string | null =
        cfg?.kbBusinessOverview ?? cfg?.businessOverview ?? null;

    const servicesText: string | null =
        cfg?.servicesText ?? null;

    const disclaimers: string | null =
        cfg?.kbDisclaimers ?? cfg?.disclaimers ?? null;

    // ——— mapear procedimientos a KBService[]
    const services: KBService[] = procedures.map((p: any) => {
        const name = p?.name ?? p?.nombre ?? `#${p?.id ?? "?"}`;
        const description = p?.description ?? p?.descripcion ?? null;

        const duration =
            typeof p?.duration === "number" ? p.duration : null;
        const durationMin =
            typeof p?.durationMin === "number"
                ? p.durationMin
                : typeof p?.duracionMin === "number"
                    ? p.duracionMin
                    : null;

        // En tu schema, EsteticaProcedure tiene priceMin/priceMax
        const price =
            typeof p?.priceMin === "number"
                ? Number(p.priceMin)
                : typeof p?.precio === "number"
                    ? p.precio
                    : null;

        const currency = p?.currency ?? p?.moneda ?? null;

        const enabled = (p?.enabled ?? p?.activo ?? true) !== false;

        const aliasesArr: string[] =
            Array.isArray(p?.aliases)
                ? (p.aliases as string[])
                : splitAliases(p?.aliases || p?.keywords || p?.etiquetas || null);

        return {
            id: Number(p?.id),
            name,
            description,
            enabled,
            duration,
            durationMin,
            price,
            currency,
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
        enabled: (s?.active ?? s?.enabled ?? s?.activo ?? true) !== false,
        specialties:
            s?.specialties ??
            s?.especialidades ??
            parseJSON(s?.specialtiesJson) ??
            null,
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
// Matching de servicio por texto libre
// ———————————————————————————————————————————————————————————————————————
export function resolveServiceName(kb: EsteticaKB, text: string): KBService | null {
    if (!text || !kb?.services?.length) return null;

    const t = text.toLowerCase();
    const candidates = kb.services.filter((s) => s.enabled !== false);

    // 1) Coincidencia exacta por nombre normalizado
    const ntext = norm(t);
    for (const s of candidates) {
        if (norm(s.name) === ntext) return s;
    }

    // 2) Coincidencia por "incluye" en nombre o aliases
    for (const s of candidates) {
        const nameHit = ntext.includes(norm(s.name));
        const aliasHit = (s.aliases || []).some((a) => ntext.includes(norm(a)));
        if (nameHit || aliasHit) return s;
    }

    // 3) Heurística por score de tokens
    let best: { svc: KBService; score: number } | null = null;
    for (const s of candidates) {
        let score = tokenScore(s.name, t);
        for (const a of s.aliases || []) {
            score = Math.max(score, tokenScore(a, t));
        }
        if (!best || score > best.score) best = { svc: s, score };
    }

    if (best && best.score >= 0.45) return best.svc;
    return null;
}
