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
   Helpers
------------------------------------------- */

function normalizeToE164(n: string) {
    return String(n || "").replace(/[^\d]/g, "");
}

/** YYYY-MM-DD en la TZ del negocio */
function ymdInTZ(d: Date, tz: string): string {
    const f = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    });
    return f.format(d);
}

/** Construye Date UTC para YYYY-MM-DD HH:mm en TZ dada */
function makeZonedDate(ymd: string, hhmm: string, tz: string): Date {
    const [y, m, d] = ymd.split("-").map(Number);
    const [h, mi] = hhmm.split(":").map(Number);
    const utcGuess = new Date(Date.UTC(y, m - 1, d, h, mi));
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    }).formatToParts(utcGuess);
    const gotH = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
    const gotM = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
    const deltaMin = h * 60 + mi - (gotH * 60 + gotM);
    return new Date(utcGuess.getTime() + deltaMin * 60000);
}

/** Inicio de mañana (00:01) en TZ del negocio */
function startOfTomorrowTZ(tz: string): Date {
    const now = new Date();
    // suma 1 día en TZ de negocio
    const ymdTomorrow = ((): string => {
        const parts = new Intl.DateTimeFormat("en-CA", {
            timeZone: tz,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
        })
            .formatToParts(new Date(now.getTime() + 24 * 3600 * 1000))
            .reduce((acc: any, p) => ((acc[p.type] = p.value), acc), {});
        return `${parts.year}-${parts.month}-${parts.day}`;
    })();
    // 00:01 para evitar borde de medianoche
    return makeZonedDate(ymdTomorrow, "00:01", tz);
}

/**
 * Resuelve un servicio verificando que exista en la BD.
 * Devuelve: { id, name, durationMin } o null.
 *
 * ⚠️ Si tu schema usa `enabled` en vez de `isActive`, cambia el where.
 */
async function resolveService(
    empresaId: number,
    q: { serviceId?: number; name?: string }
): Promise<{ id: number; name: string; durationMin: number | null } | null> {
    if (q.serviceId) {
        const row = await prisma.esteticaProcedure.findFirst({
            where: { id: q.serviceId, empresaId, enabled: true }, // <- cámbialo a enabled: true si tu schema lo usa
            select: { id: true, name: true, durationMin: true },
        });
        return row ?? null;
    }
    if (q.name) {
        const row = await prisma.esteticaProcedure.findFirst({
            where: {
                empresaId,
                enabled: true, // <- cámbialo a enabled: true si aplica
                // sin `mode: 'insensitive'` para evitar error de tipado
                name: { contains: q.name },
            },
            select: { id: true, name: true, durationMin: true },
        });
        return row ?? null;
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
            name: "listUpcomingApptsForPhone",
            description:
                "Lista próximas citas de un número de teléfono (para mostrar, reagendar o cancelar).",
            parameters: {
                type: "object",
                properties: {
                    phone: { type: "string", description: "Número en formato E.164 o local" },
                    limit: {
                        type: "number",
                        description: "Máximo de citas a devolver (default 5)",
                    },
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
                "Busca horarios disponibles desde MAÑANA en adelante. Si hay servicio, usa su duración; si no, usa la duración por defecto del negocio.",
            parameters: {
                type: "object",
                properties: {
                    serviceId: { type: "number", description: "ID del servicio (si se conoce)" },
                    serviceName: { type: "string", description: "Nombre aproximado del servicio" },
                    fromISO: { type: "string", description: "Inicio sugerido del rango (ISO)" },
                    max: { type: "number", description: "Máximo de opciones a mostrar (default 8)" },
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
                    conversationId: {
                        type: "number",
                        description: "ID de la conversación para enlazar la cita",
                    },
                },
                required: ["startISO", "phone", "fullName", "conversationId"],
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
   Handlers (conectan las tools al backend real)
------------------------------------------- */

export const toolHandlers = (ctx: EsteticaCtx) => ({
    /** Lista próximas citas por teléfono */
    async listUpcomingApptsForPhone(args: any) {
        const { phone, limit = 5 } = args;
        const phoneE164 = normalizeToE164(phone || "");
        const items = await listUpcomingCore(ctx.empresaId, phoneE164);
        return { ok: true, items: items.slice(0, limit) };
    },

    /**
     * Encuentra slots usando la firma:
     * findSlotsCore({ empresaId, ctx, hint, durationMin, count })
     * - hint: desde mañana 00:01 (en TZ) o fromISO si es posterior; nunca hoy.
     */
    async findSlots(args: any) {
        const { serviceId, serviceName, fromISO, max = 8 } = args;

        // 1) Resolver servicio para obtener durationMin (si existe)
        const svc = await resolveService(ctx.empresaId, { serviceId, name: serviceName });
        const durationMin = svc?.durationMin ?? ctx.rules?.defaultServiceDurationMin ?? 60;

        // 2) Forzar que el hint sea >= mañana 00:01 en la TZ del negocio
        const minHint = startOfTomorrowTZ(ctx.timezone);
        const from = fromISO ? new Date(fromISO) : null;
        const hint = from && from > minHint ? from : minHint;

        // 3) Llamar a la función core (ella ya respeta blackout, caps, etc.)
        const dates = await findSlotsCore({
            empresaId: ctx.empresaId,
            ctx,
            hint,
            durationMin,
            count: Math.max(6, Number(max) || 8), // varias horas y varios días
        });

        return {
            ok: true,
            slots: dates.map((d) => d.toISOString()),
            durationMin,
            serviceId: svc?.id ?? null,
            serviceName: svc?.name ?? null,
        };
    },

    /** Agenda adaptando a bookCore(args, ctx) */
    async book(args: any) {
        const {
            serviceId,
            serviceName,
            startISO,
            phone,
            fullName,
            notes,
            durationMin: durationMinArg,
            conversationId,
        } = args;

        const svc = await resolveService(ctx.empresaId, { serviceId, name: serviceName });
        if (!svc) {
            const suggestions = await prisma.esteticaProcedure.findMany({
                where: { empresaId: ctx.empresaId, enabled: true }, // <- cambia a enabled si aplica
                select: { id: true, name: true, durationMin: true },
                take: 6,
            });
            return { ok: false, reason: "SERVICE_NOT_FOUND", suggestions };
        }

        const durationMin =
            durationMinArg ?? svc.durationMin ?? ctx.rules?.defaultServiceDurationMin ?? 60;

        const appt = await bookCore(
            {
                empresaId: ctx.empresaId,
                conversationId: Number(conversationId),
                customerPhone: normalizeToE164(phone),
                customerName: fullName,
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
                status: appt.status,
            },
        };
    },

    /** Reagendar usando rescheduleCore({ empresaId, appointmentId, newStartAt }) */
    async reschedule(args: any) {
        const updated = await rescheduleCore(
            { empresaId: ctx.empresaId, appointmentId: Number(args.appointmentId), newStartAt: new Date(args.newStartISO) },
            ctx
        );
        return {
            ok: true,
            data: {
                id: updated.id,
                startAt: updated.startAt.toISOString(),
                status: updated.status,
            },
        };
    },

    /** Cancelar una cita */
    async cancel(args: any) {
        const deleted = await cancelCore({ empresaId: ctx.empresaId, appointmentId: Number(args.appointmentId) });
        return {
            ok: true,
            data: {
                id: deleted.id,
                startAt: deleted.startAt.toISOString(),
                status: deleted.status,
            },
        };
    },

    /** Cancelar varias citas */
    async cancelMany(args: any) {
        const rows = await cancelManyCore({
            empresaId: ctx.empresaId,
            appointmentIds: (args.appointmentIds || []).map(Number),
        });
        return {
            ok: true,
            data: rows.map((r) => ({
                id: r.id,
                startAt: r.startAt.toISOString(),
                serviceName: r.serviceName || null,
            })),
        };
    },
});
