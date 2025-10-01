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

/**
 * Resuelve un servicio verificando que exista en la BD.
 * - Si llega serviceId, busca por id.
 * - Si llega name, hace contains (case-insensitive cuando el proveedor lo soporta).
 * Devuelve: { id, name, durationMin } o null.
 */
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
    if (q.name) {
        // NOTA: algunos proveedores (p.ej. SQLite) no soportan `mode: 'insensitive'` en el cliente de Prisma.
        // Para evitar el error de tipado, no usamos `mode`; hacemos un contains estándar.
        const row = await prisma.esteticaProcedure.findFirst({
            where: {
                empresaId,
                enabled: true,
                name: { contains: q.name }, // <- sin `mode` para compatibilidad total
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
                "Busca horarios disponibles. Si hay servicio, usa su duración; si no, usa la duración por defecto del negocio.",
            parameters: {
                type: "object",
                properties: {
                    serviceId: { type: "number", description: "ID del servicio (si se conoce)" },
                    serviceName: { type: "string", description: "Nombre aproximado del servicio" },
                    fromISO: { type: "string", description: "Inicio sugerido del rango (ISO)" },
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
    /** Lista próximas citas por teléfono (adapta a tu firma real) */
    async listUpcomingApptsForPhone(args: any) {
        const { phone, limit = 5 } = args;
        const phoneE164 = normalizeToE164(phone || "");
        const items = await listUpcomingCore(ctx.empresaId, phoneE164);
        return { ok: true, items: items.slice(0, limit) };
    },

    /** Encuentra slots usando la firma de findSlots({ empresaId, ctx, hint, durationMin, count }) */
    async findSlots(args: any) {
        const { serviceId, serviceName, fromISO, max = 6 } = args;

        // 1) Resolver servicio para obtener durationMin (si existe)
        const svc = await resolveService(ctx.empresaId, { serviceId, name: serviceName });
        const durationMin =
            svc?.durationMin ?? ctx.rules?.defaultServiceDurationMin ?? 60;

        // 2) Calcular hint
        const hint = fromISO ? new Date(fromISO) : null;

        // 3) Llamar a la función core
        const dates = await findSlotsCore({
            empresaId: ctx.empresaId,
            ctx,
            hint,
            durationMin,
            count: max,
        });

        return { ok: true, slots: dates.map((d) => d.toISOString()), durationMin };
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
        // Si no existe en catálogo → NO agendar. Sugerir alternativas.
        if (!svc) {
            const suggestions = await prisma.esteticaProcedure.findMany({
                where: { empresaId: ctx.empresaId, enabled: true },
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
        const rows = await cancelManyCore({ empresaId: ctx.empresaId, appointmentIds: (args.appointmentIds || []).map(Number) });
        return {
            ok: true,
            data: rows.map((r) => ({ id: r.id, startAt: r.startAt.toISOString(), serviceName: r.serviceName || null })),
        };
    },
});
