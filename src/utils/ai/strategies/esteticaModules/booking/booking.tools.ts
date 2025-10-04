import prisma from "../../../../../lib/prisma";
import type { EsteticaCtx } from "../domain/estetica.rag";
import {
    findSlotsCore,
    bookCore,
    rescheduleCore,
    cancelCore,
    cancelManyCore,
    listUpcomingApptsForPhone as listUpcomingCore,
} from "./schedule.core";
import { retrieveProcedures } from "../domain/estetica.rag";

/* ================= Utilidades de fechas ================= */
function ymdInTZ(d: Date, tz: string): string {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(d);
}
function makeZonedDate(ymd: string, hhmm: string, tz: string): Date {
    const [y, m, dd] = ymd.split("-").map(Number);
    const [h, mi] = hhmm.split(":").map(Number);
    const guess = new Date(Date.UTC(y, m - 1, dd, h, mi));
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).formatToParts(guess);
    const gotH = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
    const gotM = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
    const delta = h * 60 + mi - (gotH * 60 + gotM);
    return new Date(guess.getTime() + delta * 60000);
}
function startOfTomorrowTZ(tz: string) {
    const now = new Date();
    const ymd = ymdInTZ(now, tz);
    const base = makeZonedDate(ymd, "00:00", tz);
    return new Date(base.getTime() + 86400000);
}
function normalizeToE164(n: string) { return String(n || "").replace(/[^\d]/g, ""); }
function fmtLabel(d: Date, tz: string) {
    return new Intl.DateTimeFormat("es-CO", {
        dateStyle: "full", timeStyle: "short", timeZone: tz,
    }).format(d);
}

/* ===== Helpers presentación: 2 mañana / 2 tarde por día, máx. 6 ===== */
function isMorning(d: Date, tz: string): boolean {
    const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false }).format(d));
    return h < 12;
}
function dayKey(d: Date, tz: string): string { return ymdInTZ(d, tz); }
function pickPerDaySmart(dates: Date[], tz: string, maxTotal = 6): Date[] {
    const groups = new Map<string, { morning: Date[]; afternoon: Date[] }>();
    for (const d of dates) {
        const key = dayKey(d, tz);
        const g = groups.get(key) || { morning: [], afternoon: [] };
        (isMorning(d, tz) ? g.morning : g.afternoon).push(d);
        groups.set(key, g);
    }
    const out: Date[] = [];
    for (const [, g] of groups) {
        g.morning.sort((a, b) => +a - +b);
        g.afternoon.sort((a, b) => +a - +b);
        out.push(...g.morning.slice(0, 2));
        if (out.length >= maxTotal) break;
        out.push(...g.afternoon.slice(0, 2));
        if (out.length >= maxTotal) break;
    }
    return out.slice(0, maxTotal);
}

/* ================= Tipos mínimos ================= */
type Id = number;
type ApptRowLite = { id: Id; startAt: Date | string; status?: string | null; serviceName?: string | null };
type SlotLabel = { idx: number; startISO: string; startLabel: string };
type Ok<T> = { ok: true } & T;
type Fail<R extends string = string> = { ok: false; reason: R; error?: string };

/* ================= Resolver de servicio ================= */
export async function resolveService(empresaId: number, q: { serviceId?: number; name?: string }) {
    if (q.serviceId) {
        const r = await prisma.esteticaProcedure.findFirst({
            where: { id: q.serviceId, empresaId, enabled: true },
            select: { id: true, name: true, durationMin: true },
        });
        if (r) return r;
    }
    if (q.name && q.name.trim()) {
        // intento directo
        const row = await prisma.esteticaProcedure.findFirst({
            where: { empresaId, enabled: true, name: { contains: q.name.trim() } as any },
            select: { id: true, name: true, durationMin: true },
        });
        if (row) return row;
        // intento aprox por alias
        const few = await prisma.esteticaProcedure.findMany({
            where: { empresaId, enabled: true },
            select: { id: true, name: true, durationMin: true, aliases: true },
            take: 50,
        });
        const nrm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        const target = nrm(q.name);
        const found = few.find(p => nrm(p.name).includes(target) || (Array.isArray(p.aliases) && (p.aliases as any[]).some(a => typeof a === "string" && nrm(a).includes(target))));
        if (found) return { id: found.id, name: found.name, durationMin: found.durationMin };
    }
    return null;
}

/* ================= API: Slots / Book / List / Cancel ================= */
export async function apiFindSlots(
    ctx: EsteticaCtx,
    args: { serviceId?: number; serviceName?: string; fromISO?: string; max?: number }
): Promise<Ok<{ durationMin: number; serviceName: string | null; slots: SlotLabel[] }>> {
    const svc = await resolveService(ctx.empresaId, { serviceId: args.serviceId, name: args.serviceName });
    const durationMin = svc?.durationMin ?? ctx.rules?.defaultServiceDurationMin ?? 60;

    let hint = args.fromISO ? new Date(args.fromISO) : startOfTomorrowTZ(ctx.timezone);
    const sameDayNotAllowed = !(ctx.rules?.allowSameDay ?? false);
    const todayYmd = ymdInTZ(new Date(), ctx.timezone);
    if (sameDayNotAllowed && ymdInTZ(hint, ctx.timezone) === todayYmd) {
        hint = startOfTomorrowTZ(ctx.timezone);
    }

    const raw = await findSlotsCore({
        empresaId: ctx.empresaId,
        ctx,
        hint,
        durationMin,
        count: Math.min(12, Math.max(1, Number(args.max ?? 8))),
    });

    const now = new Date();
    const smart = pickPerDaySmart(raw.filter(d => +d > +now), ctx.timezone, 6);

    const labels: SlotLabel[] = smart.map((d, i) => ({
        idx: i + 1, startISO: d.toISOString(), startLabel: fmtLabel(d, ctx.timezone),
    }));

    return { ok: true, durationMin, serviceName: svc?.name ?? args.serviceName ?? null, slots: labels };
}

export async function apiBook(
    ctx: EsteticaCtx,
    args: { serviceId?: number; serviceName?: string; startISO: string; phone: string; fullName: string; notes?: string; durationMin?: number },
    session?: { conversationId?: number }
): Promise<Ok<{ data: { id: Id; startISO: string; startLabel: string; status?: string | null; serviceName: string | null } }> | Fail<"INVALID_PHONE" | "SERVICE_NOT_FOUND" | "BOOK_FAILED">> {
    const phoneE164 = normalizeToE164(args.phone || "");
    if (!phoneE164) return { ok: false, reason: "INVALID_PHONE" };

    const svc = await resolveService(ctx.empresaId, { serviceId: args.serviceId, name: args.serviceName });
    if (!svc) {
        const suggestions = await prisma.esteticaProcedure.findMany({
            where: { empresaId: ctx.empresaId, enabled: true },
            select: { id: true, name: true, durationMin: true },
            take: 6,
        });
        return { ok: false, reason: "SERVICE_NOT_FOUND", error: JSON.stringify(suggestions) };
    }

    const durationMin = args.durationMin ?? svc.durationMin ?? ctx.rules?.defaultServiceDurationMin ?? 60;

    try {
        const appt = await bookCore({
            empresaId: ctx.empresaId,
            conversationId: Number(session?.conversationId ?? 0),
            customerPhone: phoneE164,
            customerName: String(args.fullName || "").trim(),
            serviceName: svc.name,
            startAt: new Date(args.startISO),
            durationMin,
            timezone: ctx.timezone,
            procedureId: svc.id,
            notes: args.notes || undefined,
        }, ctx);

        return {
            ok: true,
            data: {
                id: appt.id,
                startISO: (appt.startAt as Date).toISOString(),
                startLabel: fmtLabel(appt.startAt as Date, ctx.timezone),
                status: (appt as any).status ?? null,
                serviceName: (appt as any).serviceName ?? svc.name ?? null,
            },
        };
    } catch (e: any) {
        return { ok: false, reason: "BOOK_FAILED", error: e?.message ?? "UNKNOWN" };
    }
}

export async function apiReschedule(ctx: EsteticaCtx, args: { appointmentId: number; newStartISO: string }) {
    try {
        const updated = await rescheduleCore({ empresaId: ctx.empresaId, appointmentId: Number(args.appointmentId), newStartAt: new Date(args.newStartISO) }, ctx);
        const start = updated.startAt as Date;
        return { ok: true, data: { id: updated.id, startISO: start.toISOString(), startLabel: fmtLabel(start, ctx.timezone), status: (updated as any).status ?? null } };
    } catch (e: any) { return { ok: false, reason: "RESCHEDULE_FAILED", error: e?.message ?? "UNKNOWN" }; }
}

export async function apiCancel(ctx: EsteticaCtx, args: { appointmentId: number }) {
    try {
        const deleted = await cancelCore({ empresaId: ctx.empresaId, appointmentId: Number(args.appointmentId) });
        const d = new Date(deleted.startAt as any);
        return { ok: true, data: { id: deleted.id, startISO: d.toISOString(), startLabel: fmtLabel(d, ctx.timezone), status: (deleted as any).status ?? null } };
    } catch (e: any) { return { ok: false, reason: "CANCEL_FAILED", error: e?.message ?? "UNKNOWN" }; }
}

export async function apiCancelMany(ctx: EsteticaCtx, ids: number[]) {
    try {
        const rows = await cancelManyCore({ empresaId: ctx.empresaId, appointmentIds: ids });
        const data = (rows as ApptRowLite[]).map((r) => {
            const d = new Date(r.startAt as any);
            return { id: r.id, startISO: d.toISOString(), startLabel: fmtLabel(d, ctx.timezone), serviceName: r.serviceName ?? null };
        });
        return { ok: true, data };
    } catch (e: any) { return { ok: false, reason: "CANCEL_MANY_FAILED", error: e?.message ?? "UNKNOWN" }; }
}

export async function apiListUpcomingByPhone(ctx: EsteticaCtx, phone: string, limit = 5) {
    const phoneE164 = normalizeToE164(phone || "");
    if (!phoneE164) return { ok: false, reason: "INVALID_PHONE" } as const;

    const items = (await listUpcomingCore(ctx.empresaId, phoneE164)) as ApptRowLite[];
    const mapped = items.slice(0, Math.max(1, Number(limit))).map((r) => {
        const d = new Date(r.startAt as any);
        return { id: r.id, startISO: d.toISOString(), startLabel: fmtLabel(d, ctx.timezone), serviceName: r.serviceName ?? null };
    });
    return { ok: true, items: mapped } as const;
}

/* =============== NEW: catálogo/servicios bonitos =============== */
export async function apiListProcedures(ctx: EsteticaCtx, query?: string, top = 8) {
    const rows = await retrieveProcedures(ctx.empresaId, query, top);
    return {
        ok: true,
        items: rows.map(r => ({
            id: r.id,
            name: r.name,
            durationMin: r.durationMin ?? null,
            priceMin: (r as any).priceMin ?? null,
            priceMax: (r as any).priceMax ?? null,
        })),
    } as const;
}

/* ================= OpenAI tools: specs + handlers ================= */
export const toolSpecs = [
    {
        type: "function", function: {
            name: "findSlots",
            description: "Busca horarios disponibles (máx. 6; 2 mañana + 2 tarde por día).",
            parameters: {
                type: "object", properties: {
                    serviceId: { type: "number" }, serviceName: { type: "string" }, fromISO: { type: "string" }, max: { type: "number" },
                }, additionalProperties: false
            }
        }
    },
    {
        type: "function", function: {
            name: "book",
            description: "Reserva. Requiere servicio, startISO, nombre completo y teléfono.",
            parameters: {
                type: "object", properties: {
                    serviceId: { type: "number" }, serviceName: { type: "string" }, startISO: { type: "string" },
                    phone: { type: "string" }, fullName: { type: "string" }, notes: { type: "string" }, durationMin: { type: "number" },
                }, required: ["startISO", "phone", "fullName"], additionalProperties: false
            }
        }
    },
    {
        type: "function", function: {
            name: "reschedule",
            description: "Reagenda una cita a un nuevo horario.",
            parameters: {
                type: "object", properties: { appointmentId: { type: "number" }, newStartISO: { type: "string" } },
                required: ["appointmentId", "newStartISO"], additionalProperties: false
            }
        }
    },
    {
        type: "function", function: {
            name: "cancel",
            description: "Cancela una cita por ID.",
            parameters: {
                type: "object", properties: { appointmentId: { type: "number" } },
                required: ["appointmentId"], additionalProperties: false
            }
        }
    },
    {
        type: "function", function: {
            name: "cancelMany",
            description: "Cancela múltiples citas por IDs.",
            parameters: {
                type: "object", properties: { ids: { type: "array", items: { type: "number" } } },
                required: ["ids"], additionalProperties: false
            }
        }
    },
    {
        type: "function", function: {
            name: "listUpcomingApptsForPhone",
            description: "Lista próximas citas del cliente por teléfono.",
            parameters: {
                type: "object", properties: { phone: { type: "string" }, limit: { type: "number" } },
                required: ["phone"], additionalProperties: false
            }
        }
    },
    {
        type: "function", function: {
            name: "listProcedures",
            description: "Devuelve el catálogo de servicios (con duración y precios si existen).",
            parameters: {
                type: "object", properties: { query: { type: "string" }, top: { type: "number" } },
                additionalProperties: false
            }
        }
    },
] as const;

export function toolHandlers(ctx: EsteticaCtx, session?: { conversationId?: number }) {
    return {
        async findSlots(args: { serviceId?: number; serviceName?: string; fromISO?: string; max?: number }) {
            return apiFindSlots(ctx, args);
        },
        async book(args: { serviceId?: number; serviceName?: string; startISO: string; phone: string; fullName: string; notes?: string; durationMin?: number }) {
            return apiBook(ctx, args, session);
        },
        async reschedule(args: { appointmentId: number; newStartISO: string }) { return apiReschedule(ctx, args); },
        async cancel(args: { appointmentId: number }) { return apiCancel(ctx, args); },
        async cancelMany(args: { ids: number[] }) { return apiCancelMany(ctx, args.ids); },
        async listUpcomingApptsForPhone(args: { phone: string; limit?: number }) { return apiListUpcomingByPhone(ctx, args.phone, Number(args.limit ?? 5)); },
        async listProcedures(args: { query?: string; top?: number }) { return apiListProcedures(ctx, args.query, Number(args.top ?? 8)); },
    };
}
