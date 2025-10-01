// utils/ai/strategies/esteticaModules/assistant/ai.tools.ts
import prisma from "../../../../../lib/prisma";
import type { EsteticaCtx } from "../estetica.rag";
import {
    findSlots as findSlotsCore,
    book as bookCore,
    reschedule as rescheduleCore,
    cancel as cancelCore,
    cancelMany as cancelManyCore,
    listUpcomingApptsForPhone as listUpcomingCore,
} from "../estetica.schedule";

/* -------------------------------------------
   Helpers de fechas (TZ)
------------------------------------------- */
function ymdInTZ(d: Date, tz: string): string {
    const f = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    });
    return f.format(d);
}
function makeZonedDate(ymd: string, hhmm: string, tz: string): Date {
    const [y, m, d] = ymd.split("-").map(Number);
    const [h, mi] = hhmm.split(":").map(Number);
    const guess = new Date(Date.UTC(y, m - 1, d, h, mi));
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
    const deltaMin = h * 60 + mi - (gotH * 60 + gotM);
    return new Date(guess.getTime() + deltaMin * 60000);
}
function startOfDayTZ(d: Date, tz: string): Date {
    return makeZonedDate(ymdInTZ(d, tz), "00:00", tz);
}
function endOfDayTZ(d: Date, tz: string): Date {
    return makeZonedDate(ymdInTZ(d, tz), "23:59", tz);
}
function addDays(d: Date, days: number) {
    return new Date(d.getTime() + days * 86400000);
}
function startOfTomorrowTZ(tz: string): Date {
    return startOfDayTZ(addDays(new Date(), 1), tz);
}
function formatLabel(d: Date, tz: string): string {
    return new Intl.DateTimeFormat("es-CO", {
        dateStyle: "full",
        timeStyle: "short",
        timeZone: tz,
    }).format(d);
}

function normalizeToE164(n: string) {
    return String(n || "").replace(/[^\d]/g, "");
}

/* -------------------------------------------
   Resolución robusta de servicio
------------------------------------------- */
async function resolveService(
    empresaId: number,
    q: { serviceId?: number; name?: string }
): Promise<{ id: number; name: string; durationMin: number | null } | null> {
    if (q.serviceId) {
        const row = await prisma.esteticaProcedure.findFirst({
            where: { id: q.serviceId, empresaId, enabled: true },
            select: { id: true, name: true, durationMin: true },
        });
        return row ?? null;
    }
    if (q.name && q.name.trim()) {
        const name = q.name.trim();

        // 1) Intento con mode: 'insensitive' (algunos proveedores no lo soportan; casteamos a any)
        const row1 = await prisma.esteticaProcedure.findFirst({
            where: {
                empresaId,
                enabled: true,
                name: { contains: name, mode: "insensitive" } as any,
            },
            select: { id: true, name: true, durationMin: true },
        });
        if (row1) return row1;

        // 2) Fallback: traigo algunos y comparo en memoria (case/acentos)
        const few = await prisma.esteticaProcedure.findMany({
            where: { empresaId, enabled: true },
            select: { id: true, name: true, durationMin: true },
            take: 25,
        });
        const norm = (s: string) =>
            s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        const target = norm(name);
        const found = few.find((p) => norm(p.name).includes(target));
        return found ?? null;
    }
    return null;
}

/* -------------------------------------------
   Tool specs (lo que “ve” el modelo)
------------------------------------------- */
export const toolSpecs = [
    {
        type: "function",
        function: {
            name: "listServices",
            description: "Obtiene el catálogo activo de procedimientos de la clínica.",
            parameters: {
                type: "object",
                properties: {
                    limit: { type: "number", description: "Cantidad máxima (default 6)" },
                },
                required: [],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "listUpcomingApptsForPhone",
            description:
                "Lista próximas citas de un número de teléfono (para mostrar, reagendar o cancelar).",
            parameters: {
                type: "object",
                properties: {
                    phone: { type: "string", description: "Número en formato E.164 o local" },
                    limit: { type: "number", description: "Máximo de citas a devolver (default 5)" },
                },
                required: ["phone"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "findSlots",
            description:
                "Busca horarios disponibles. Si hay servicio, usa su duración; si no, usa la duración por defecto del negocio. Nunca ofrece el mismo día (a menos que el negocio lo permita).",
            parameters: {
                type: "object",
                properties: {
                    serviceId: { type: "number", description: "ID del servicio (si se conoce)" },
                    serviceName: { type: "string", description: "Nombre aproximado del servicio" },
                    fromISO: {
                        type: "string",
                        description:
                            "Inicio sugerido del rango (ISO). Si no viene, se usa mañana 00:00 en TZ del negocio.",
                    },
                    max: { type: "number", description: "Máximo de opciones a mostrar (default 6)" },
                },
                required: [],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "book",
            description:
                "Crea una cita (solo si el servicio existe en BD). Valida conflictos y reglas.",
            parameters: {
                type: "object",
                properties: {
                    serviceId: { type: "number" },
                    serviceName: { type: "string" },
                    startISO: { type: "string", description: "Fecha/hora inicio en ISO" },
                    phone: { type: "string" },
                    fullName: { type: "string" },
                    notes: { type: "string" },
                    durationMin: { type: "number", description: "Duración en minutos (opcional)" },
                },
                required: ["startISO", "phone", "fullName"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "reschedule",
            description: "Mueve una cita existente a un nuevo horario.",
            parameters: {
                type: "object",
                properties: {
                    appointmentId: { type: "number" },
                    newStartISO: { type: "string" },
                },
                required: ["appointmentId", "newStartISO"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "cancel",
            description: "Cancela una cita específica.",
            parameters: {
                type: "object",
                properties: {
                    appointmentId: { type: "number" },
                },
                required: ["appointmentId"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "cancelMany",
            description: "Cancela varias citas por ID.",
            parameters: {
                type: "object",
                properties: {
                    appointmentIds: { type: "array", items: { type: "number" } },
                },
                required: ["appointmentIds"],
            },
        },
    },
] as const;

/* -------------------------------------------
   Handlers (conectan tools ↔ backend)
   Nota: pasamos también session (conversationId)
------------------------------------------- */
export const toolHandlers = (ctx: EsteticaCtx, session?: { conversationId?: number }) => ({
    async listServices(args: any) {
        const limit = Math.max(1, Number(args?.limit ?? 6));
        const items = await prisma.esteticaProcedure.findMany({
            where: { empresaId: ctx.empresaId, enabled: true },
            select: {
                id: true,
                name: true,
                durationMin: true,
                priceMin: true,
                priceMax: true,
                requiresAssessment: true,
            },
            take: limit,
            orderBy: { name: "asc" },
        });
        return { ok: true, items };
    },

    async listUpcomingApptsForPhone(args: any) {
        const { phone, limit = 5 } = args ?? {};
        const phoneE164 = normalizeToE164(phone || "");
        if (!phoneE164) return { ok: false, reason: "INVALID_PHONE" };

        const items = await listUpcomingCore(ctx.empresaId, phoneE164);
        const sliced = items.slice(0, Math.max(1, Number(limit)));
        const mapped = sliced.map((r) => ({
            ...r,
            startISO: r.startAt.toISOString?.() ?? new Date(r.startAt as any).toISOString(),
            startLabel: formatLabel(new Date(r.startAt as any), ctx.timezone),
        }));
        return { ok: true, items: mapped };
    },

    async findSlots(args: any) {
        const { serviceId, serviceName, fromISO, max = 6 } = args ?? {};

        // 1) Resolver servicio (para durationMin)
        const svc = await resolveService(ctx.empresaId, { serviceId, name: serviceName });
        const durationMin = svc?.durationMin ?? ctx.rules?.defaultServiceDurationMin ?? 60;

        // 2) Punto de inicio: mañana 00:00 (o fromISO si viene),
        //    respetando política de "no mismo día" si aplica.
        let hint = fromISO ? new Date(fromISO) : startOfTomorrowTZ(ctx.timezone);
        const sameDayNotAllowed = !(ctx.rules?.allowSameDay ?? false);
        const now = new Date();
        const todayYmd = ymdInTZ(now, ctx.timezone);
        const hintYmd = ymdInTZ(hint, ctx.timezone);
        if (sameDayNotAllowed && hintYmd === todayYmd) {
            hint = startOfTomorrowTZ(ctx.timezone);
        }

        // 3) Buscar slots
        const dates = await findSlotsCore({
            empresaId: ctx.empresaId,
            ctx,
            hint,
            durationMin,
            count: Math.min(6, Math.max(1, Number(max))),
        });

        // 4) Preparar salida con labels amigables
        const slotsISO = dates.map((d) => d.toISOString());
        const slotLabels = dates.map((d, i) => ({
            idx: i + 1,
            startISO: d.toISOString(),
            startLabel: formatLabel(d, ctx.timezone),
        }));

        return {
            ok: true,
            durationMin,
            serviceName: svc?.name ?? serviceName ?? null,
            slots: slotsISO,
            labels: slotLabels, // útil para usar con formatSlotList() del prompt
        };
    },

    async book(args: any) {
        const { serviceId, serviceName, startISO, phone, fullName, notes, durationMin: durationMinArg } = args ?? {};

        const phoneE164 = normalizeToE164(phone || "");
        if (!phoneE164) return { ok: false, reason: "INVALID_PHONE" };
        if (!startISO) return { ok: false, reason: "INVALID_START" };
        if (!fullName || String(fullName).trim().length < 2) return { ok: false, reason: "INVALID_NAME" };

        const svc = await resolveService(ctx.empresaId, { serviceId, name: serviceName });
        if (!svc) {
            const suggestions = await prisma.esteticaProcedure.findMany({
                where: { empresaId: ctx.empresaId, enabled: true },
                select: { id: true, name: true, durationMin: true },
                take: 6,
            });
            return { ok: false, reason: "SERVICE_NOT_FOUND", suggestions };
        }

        const durationMin = durationMinArg ?? svc.durationMin ?? ctx.rules?.defaultServiceDurationMin ?? 60;
        const conversationId = Number(session?.conversationId ?? 0); // inyección desde el agente

        try {
            const appt = await bookCore(
                {
                    empresaId: ctx.empresaId,
                    conversationId,
                    customerPhone: phoneE164,
                    customerName: String(fullName).trim(),
                    serviceName: svc.name,
                    startAt: new Date(startISO),
                    durationMin,
                    timezone: ctx.timezone,
                    procedureId: svc.id,
                    notes: notes || undefined,
                },
                ctx
            );

            return {
                ok: true,
                data: {
                    id: appt.id,
                    startAt: appt.startAt.toISOString(),
                    startLabel: formatLabel(appt.startAt, ctx.timezone),
                    status: appt.status,
                    serviceName: appt.serviceName ?? svc.name,
                },
            };
        } catch (e: any) {
            return { ok: false, reason: "BOOK_FAILED", error: e?.message ?? "UNKNOWN" };
        }
    },

    async reschedule(args: any) {
        if (!args?.appointmentId || !args?.newStartISO) {
            return { ok: false, reason: "INVALID_INPUT" };
        }
        try {
            const updated = await rescheduleCore(
                { empresaId: ctx.empresaId, appointmentId: Number(args.appointmentId), newStartAt: new Date(args.newStartISO) },
                ctx
            );
            return {
                ok: true,
                data: {
                    id: updated.id,
                    startAt: updated.startAt.toISOString(),
                    startLabel: formatLabel(updated.startAt, ctx.timezone),
                    status: updated.status,
                },
            };
        } catch (e: any) {
            return { ok: false, reason: "RESCHEDULE_FAILED", error: e?.message ?? "UNKNOWN" };
        }
    },

    async cancel(args: any) {
        if (!args?.appointmentId) return { ok: false, reason: "INVALID_INPUT" };
        try {
            const deleted = await cancelCore({ empresaId: ctx.empresaId, appointmentId: Number(args.appointmentId) });
            return {
                ok: true,
                data: {
                    id: deleted.id,
                    startAt: deleted.startAt.toISOString(),
                    startLabel: formatLabel(deleted.startAt, ctx.timezone),
                    status: deleted.status,
                },
            };
        } catch (e: any) {
            return { ok: false, reason: "CANCEL_FAILED", error: e?.message ?? "UNKNOWN" };
        }
    },

    async cancelMany(args: any) {
        const ids: number[] = (args?.appointmentIds || []).map(Number).filter((n: number) => Number.isFinite(n));
        if (!ids.length) return { ok: false, reason: "INVALID_INPUT" };
        try {
            const rows = await cancelManyCore({ empresaId: ctx.empresaId, appointmentIds: ids });
            const mapped = rows.map((r) => ({
                id: r.id,
                startAt: (r.startAt as any as Date).toISOString?.() ?? new Date(r.startAt as any).toISOString(),
                startLabel: formatLabel(new Date(r.startAt as any), ctx.timezone),
                serviceName: r.serviceName || null,
            }));
            return { ok: true, data: mapped };
        } catch (e: any) {
            return { ok: false, reason: "CANCEL_MANY_FAILED", error: e?.message ?? "UNKNOWN" };
        }
    },
});
