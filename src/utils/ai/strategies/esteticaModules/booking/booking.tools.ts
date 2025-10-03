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
        timeZone: tz,
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
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

function normalizeToE164(n: string) {
    return String(n || "").replace(/[^\d]/g, "");
}

function fmtLabel(d: Date, tz: string) {
    return new Intl.DateTimeFormat("es-CO", {
        dateStyle: "full",
        timeStyle: "short",
        timeZone: tz,
    }).format(d);
}

/* ================= Tipos mínimos ================= */

type Id = number;
type ApptRowLite = {
    id: Id;
    startAt: Date | string;
    status?: string | null;
    serviceName?: string | null;
};
type SlotLabel = { idx: number; startISO: string; startLabel: string };
type Ok<T> = { ok: true } & T;
type Fail<R extends string = string> = { ok: false; reason: R; error?: string };

/* ================= Resolver de servicio ================= */

export async function resolveService(
    empresaId: number,
    q: { serviceId?: number; name?: string }
) {
    if (q.serviceId) {
        const r = await prisma.esteticaProcedure.findFirst({
            where: { id: q.serviceId, empresaId, enabled: true },
            select: { id: true, name: true, durationMin: true },
        });
        if (r) return r;
    }
    if (q.name && q.name.trim()) {
        const row = await prisma.esteticaProcedure.findFirst({
            where: {
                empresaId,
                enabled: true,
                name: { contains: q.name.trim() },
            },
            select: { id: true, name: true, durationMin: true },
        });
        if (row) return row;

        // matching aproximado básico
        const few = await prisma.esteticaProcedure.findMany({
            where: { empresaId, enabled: true },
            select: { id: true, name: true, durationMin: true },
            take: 25,
        });
        const norm = (s: string) =>
            s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        const target = norm(q.name);
        const found = few.find((p) => norm(p.name).includes(target));
        if (found) return found;
    }
    return null;
}

/* ============ helpers de render agrupado (2 mañana + 2 tarde) ============ */

function isMorning(d: Date, tz: string) {
    const hour = Number(
        new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: tz })
            .format(d)
    );
    return hour < 12;
}

function buildPrettyList(slots: Date[], tz: string): string {
    if (!slots.length) return "No encontré cupos disponibles en las fechas consultadas.";

    // agrupar por día
    const byDay = new Map<string, Date[]>();
    for (const d of slots) {
        const key = new Intl.DateTimeFormat("es-CO", {
            weekday: "long",
            day: "2-digit",
            month: "long",
            year: "numeric",
            timeZone: tz,
        }).format(d);
        byDay.set(key, [...(byDay.get(key) ?? []), d]);
    }

    const lines: string[] = [];
    let globalIdx = 1;

    for (const [dayLabel, arr] of byDay) {
        const am = arr.filter((d) => isMorning(d, tz)).slice(0, 2);
        const pm = arr.filter((d) => !isMorning(d, tz)).slice(0, 2);

        const label = dayLabel[0].toUpperCase() + dayLabel.slice(1);
        lines.push(`**${label}**`);
        for (const d of [...am, ...pm]) {
            lines.push(`${globalIdx}. ${new Intl.DateTimeFormat("es-CO", {
                hour: "2-digit",
                minute: "2-digit",
                timeZone: tz,
            }).format(d)}`);
            globalIdx++;
        }
    }

    return (
        `Aquí tienes opciones agrupadas por día (máx. 2 en la mañana y 2 en la tarde):\n` +
        lines.join("\n") +
        `\n\nResponde con el número de la opción o dime otra fecha.`
    );
}

/* ================= API para el agente ================= */

export async function apiFindSlots(
    ctx: EsteticaCtx,
    args: { serviceId?: number; serviceName?: string; fromISO?: string; max?: number }
): Promise<
    Ok<{
        durationMin: number;
        serviceName: string | null;
        slots: SlotLabel[];
        prettyList?: string;
    }>
> {
    const svc = await resolveService(ctx.empresaId, {
        serviceId: args.serviceId,
        name: args.serviceName,
    });
    const durationMin =
        svc?.durationMin ?? ctx.rules?.defaultServiceDurationMin ?? 60;

    // punto de arranque
    let hint = args.fromISO ? new Date(args.fromISO) : startOfTomorrowTZ(ctx.timezone);
    const sameDayNotAllowed = !(ctx.rules?.allowSameDay ?? false);
    const todayYmd = ymdInTZ(new Date(), ctx.timezone);
    if (sameDayNotAllowed && ymdInTZ(hint, ctx.timezone) === todayYmd) {
        hint = startOfTomorrowTZ(ctx.timezone);
    }

    // 1ª búsqueda
    let dates = await findSlotsCore({
        empresaId: ctx.empresaId,
        ctx,
        hint,
        durationMin,
        count: Math.min(8, Math.max(1, Number(args.max ?? 8))),
    });

    // Sanity: descartar pasado; si todo es pasado (p.ej. 2023), reintentar desde mañana
    const nowTZ = new Date();
    dates = dates.filter((d) => d.getTime() >= nowTZ.getTime());
    if (!dates.length) {
        const retryHint = startOfTomorrowTZ(ctx.timezone);
        dates = await findSlotsCore({
            empresaId: ctx.empresaId,
            ctx,
            hint: retryHint,
            durationMin,
            count: Math.min(8, Math.max(1, Number(args.max ?? 8))),
        });
        dates = dates.filter((d) => d.getTime() >= nowTZ.getTime());
    }

    // construir labels y lista bonita (2+2 por día)
    const labels: SlotLabel[] = dates.map((d, i) => ({
        idx: i + 1,
        startISO: d.toISOString(),
        startLabel: fmtLabel(d, ctx.timezone),
    }));

    // limitar las que el modelo verá (hasta 8 crudas) pero dar prettyList agrupado
    const prettyList = buildPrettyList(dates, ctx.timezone);

    return {
        ok: true,
        durationMin,
        serviceName: svc?.name ?? args.serviceName ?? null,
        slots: labels,
        prettyList,
    };
}

export async function apiBook(
    ctx: EsteticaCtx,
    args: {
        serviceId?: number;
        serviceName?: string;
        startISO: string;
        phone: string;
        fullName: string;
        notes?: string;
        durationMin?: number;
    },
    session?: { conversationId?: number }
): Promise<
    Ok<{
        data: {
            id: Id;
            startISO: string;
            startLabel: string;
            status?: string | null;
            serviceName: string | null;
        };
    }> | Fail<"INVALID_PHONE" | "SERVICE_NOT_FOUND" | "BOOK_FAILED">
> {
    const phoneE164 = normalizeToE164(args.phone || "");
    if (!phoneE164) return { ok: false, reason: "INVALID_PHONE" };

    const svc = await resolveService(ctx.empresaId, {
        serviceId: args.serviceId,
        name: args.serviceName,
    });
    if (!svc) {
        const suggestions = await prisma.esteticaProcedure.findMany({
            where: { empresaId: ctx.empresaId, enabled: true },
            select: { id: true, name: true, durationMin: true },
            take: 6,
        });
        return { ok: false, reason: "SERVICE_NOT_FOUND", error: JSON.stringify(suggestions) };
    }

    const durationMin =
        args.durationMin ?? svc.durationMin ?? ctx.rules?.defaultServiceDurationMin ?? 60;

    try {
        const appt = await bookCore(
            {
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
            },
            ctx
        );

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

export async function apiReschedule(
    ctx: EsteticaCtx,
    args: { appointmentId: number; newStartISO: string }
): Promise<
    Ok<{ data: { id: Id; startISO: string; startLabel: string; status?: string | null } }>
    | Fail<"RESCHEDULE_FAILED">
> {
    try {
        const updated = await rescheduleCore(
            {
                empresaId: ctx.empresaId,
                appointmentId: Number(args.appointmentId),
                newStartAt: new Date(args.newStartISO),
            },
            ctx
        );
        const start = updated.startAt as Date;
        return {
            ok: true,
            data: {
                id: updated.id,
                startISO: start.toISOString(),
                startLabel: fmtLabel(start, ctx.timezone),
                status: (updated as any).status ?? null,
            },
        };
    } catch (e: any) {
        return { ok: false, reason: "RESCHEDULE_FAILED", error: e?.message ?? "UNKNOWN" };
    }
}

export async function apiCancel(
    ctx: EsteticaCtx,
    args: { appointmentId: number }
): Promise<
    Ok<{ data: { id: Id; startISO: string; startLabel: string; status?: string | null } }>
    | Fail<"CANCEL_FAILED">
> {
    try {
        const deleted = await cancelCore({
            empresaId: ctx.empresaId,
            appointmentId: Number(args.appointmentId),
        });
        const d = new Date(deleted.startAt as any);
        return {
            ok: true,
            data: {
                id: deleted.id,
                startISO: d.toISOString(),
                startLabel: fmtLabel(d, ctx.timezone),
                status: (deleted as any).status ?? null,
            },
        };
    } catch (e: any) {
        return { ok: false, reason: "CANCEL_FAILED", error: e?.message ?? "UNKNOWN" };
    }
}

export async function apiCancelMany(
    ctx: EsteticaCtx,
    ids: number[]
): Promise<
    Ok<{ data: Array<{ id: Id; startISO: string; startLabel: string; serviceName: string | null }> }>
    | Fail<"CANCEL_MANY_FAILED">
> {
    try {
        const rows = await cancelManyCore({
            empresaId: ctx.empresaId,
            appointmentIds: ids,
        });
        const data = (rows as ApptRowLite[]).map((r) => {
            const d = new Date(r.startAt as any);
            return {
                id: r.id,
                startISO: d.toISOString(),
                startLabel: fmtLabel(d, ctx.timezone),
                serviceName: r.serviceName ?? null,
            };
        });
        return { ok: true, data };
    } catch (e: any) {
        return { ok: false, reason: "CANCEL_MANY_FAILED", error: e?.message ?? "UNKNOWN" };
    }
}

export async function apiListUpcomingByPhone(
    ctx: EsteticaCtx,
    phone: string,
    limit = 5
): Promise<
    Ok<{ items: Array<{ id: Id; startISO: string; startLabel: string; serviceName: string | null }> }>
    | Fail<"INVALID_PHONE">
> {
    const phoneE164 = normalizeToE164(phone || "");
    if (!phoneE164) return { ok: false, reason: "INVALID_PHONE" };

    const items = (await listUpcomingCore(ctx.empresaId, phoneE164)) as ApptRowLite[];

    const mapped = items.slice(0, Math.max(1, Number(limit))).map((r) => {
        const d = new Date(r.startAt as any);
        return {
            id: r.id,
            startISO: d.toISOString(),
            startLabel: fmtLabel(d, ctx.timezone),
            serviceName: r.serviceName ?? null,
        };
    });

    return { ok: true, items: mapped };
}

/* ================= OpenAI tools: specs + handlers ================= */

export const toolSpecs = [
    {
        type: "function",
        function: {
            name: "findSlots",
            description:
                "Busca horarios disponibles (retorna hasta 8 opciones). Respeta políticas: same-day, buffers, blackout. La tool devuelve 'prettyList' agrupada por día (máx. 2 mañana + 2 tarde). **Pega esa lista directamente en la respuesta.**",
            parameters: {
                type: "object",
                properties: {
                    serviceId: { type: "number", description: "ID interno del servicio" },
                    serviceName: { type: "string", description: "Nombre del servicio si no hay ID" },
                    fromISO: { type: "string", description: "ISO de fecha de inicio sugerida" },
                    max: { type: "number", description: "Máximo de opciones (1-8)" },
                },
                additionalProperties: false,
            },
        },
    },
    {
        type: "function",
        function: {
            name: "book",
            description:
                "Crea una reserva. Requiere servicio, horario ISO, nombre completo y teléfono.",
            parameters: {
                type: "object",
                properties: {
                    serviceId: { type: "number" },
                    serviceName: { type: "string" },
                    startISO: { type: "string" },
                    phone: { type: "string" },
                    fullName: { type: "string" },
                    notes: { type: "string" },
                    durationMin: { type: "number" },
                },
                required: ["startISO", "phone", "fullName"],
                additionalProperties: false,
            },
        },
    },
    {
        type: "function",
        function: {
            name: "reschedule",
            description: "Reagenda una reserva existente a un nuevo horario ISO.",
            parameters: {
                type: "object",
                properties: {
                    appointmentId: { type: "number" },
                    newStartISO: { type: "string" },
                },
                required: ["appointmentId", "newStartISO"],
                additionalProperties: false,
            },
        },
    },
    {
        type: "function",
        function: {
            name: "cancel",
            description: "Cancela una cita por ID.",
            parameters: {
                type: "object",
                properties: {
                    appointmentId: { type: "number" },
                },
                required: ["appointmentId"],
                additionalProperties: false,
            },
        },
    },
    {
        type: "function",
        function: {
            name: "cancelMany",
            description: "Cancela múltiples citas por IDs.",
            parameters: {
                type: "object",
                properties: {
                    ids: {
                        type: "array",
                        items: { type: "number" },
                        description: "IDs de citas",
                    },
                },
                required: ["ids"],
                additionalProperties: false,
            },
        },
    },
    {
        type: "function",
        function: {
            name: "listUpcomingApptsForPhone",
            description:
                "Lista próximas citas de un cliente a partir de su teléfono. Devuelve próximas N (por defecto 5).",
            parameters: {
                type: "object",
                properties: {
                    phone: { type: "string" },
                    limit: { type: "number" },
                },
                required: ["phone"],
                additionalProperties: false,
            },
        },
    },
] as const;

export function toolHandlers(ctx: EsteticaCtx, session?: { conversationId?: number }) {
    return {
        async findSlots(args: {
            serviceId?: number;
            serviceName?: string;
            fromISO?: string;
            max?: number;
        }) {
            return apiFindSlots(ctx, args);
        },
        async book(args: {
            serviceId?: number;
            serviceName?: string;
            startISO: string;
            phone: string;
            fullName: string;
            notes?: string;
            durationMin?: number;
        }) {
            return apiBook(ctx, args, session);
        },
        async reschedule(args: { appointmentId: number; newStartISO: string }) {
            return apiReschedule(ctx, args);
        },
        async cancel(args: { appointmentId: number }) {
            return apiCancel(ctx, args);
        },
        async cancelMany(args: { ids: number[] }) {
            return apiCancelMany(ctx, args.ids);
        },
        async listUpcomingApptsForPhone(args: { phone: string; limit?: number }) {
            return apiListUpcomingByPhone(ctx, args.phone, Number(args.limit ?? 5));
        },
    };
}
