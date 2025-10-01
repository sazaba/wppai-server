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
   Pequeños helpers de fechas (TZ)
------------------------------------------- */
function ymdInTZ(d: Date, tz: string): string {
    const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    return f.format(d);
}
function makeZonedDate(ymd: string, hhmm: string, tz: string): Date {
    const [y, m, d] = ymd.split("-").map(Number);
    const [h, mi] = hhmm.split(":").map(Number);
    const guess = new Date(Date.UTC(y, m - 1, d, h, mi));
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).formatToParts(guess);
    const gotH = Number(parts.find(p => p.type === "hour")?.value ?? "0");
    const gotM = Number(parts.find(p => p.type === "minute")?.value ?? "0");
    const deltaMin = (h * 60 + mi) - (gotH * 60 + gotM);
    return new Date(guess.getTime() + deltaMin * 60000);
}
function startOfDayTZ(d: Date, tz: string): Date { return makeZonedDate(ymdInTZ(d, tz), "00:00", tz); }
function addDays(d: Date, days: number) { return new Date(d.getTime() + days * 86400000); }
function startOfTomorrowTZ(tz: string): Date { return startOfDayTZ(addDays(new Date(), 1), tz); }

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
            where: { empresaId, enabled: true, name: { contains: name, mode: "insensitive" } as any },
            select: { id: true, name: true, durationMin: true },
        });
        if (row1) return row1;

        // 2) Fallback: traigo algunos y comparo en memoria (case/acentos)
        const few = await prisma.esteticaProcedure.findMany({
            where: { empresaId, enabled: true },
            select: { id: true, name: true, durationMin: true },
            take: 25,
        });
        const norm = (s: string) => s
            .toLowerCase()
            .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        const target = norm(name);
        const found = few.find(p => norm(p.name).includes(target));
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
                    limit: { type: "number", description: "Cantidad máxima (default 6)" }
                },
                required: []
            }
        }
    },
    {
        type: "function",
        function: {
            name: "listUpcomingApptsForPhone",
            description: "Lista próximas citas de un número de teléfono (para mostrar, reagendar o cancelar).",
            parameters: {
                type: "object",
                properties: {
                    phone: { type: "string", description: "Número en formato E.164 o local" },
                    limit: { type: "number", description: "Máximo de citas a devolver (default 5)" }
                },
                required: ["phone"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "findSlots",
            description: "Busca horarios disponibles. Si hay servicio, usa su duración; si no, usa la duración por defecto del negocio. Nunca ofrece el mismo día.",
            parameters: {
                type: "object",
                properties: {
                    serviceId: { type: "number", description: "ID del servicio (si se conoce)" },
                    serviceName: { type: "string", description: "Nombre aproximado del servicio" },
                    fromISO: { type: "string", description: "Inicio sugerido del rango (ISO). Si no viene, se usa mañana 00:00 en TZ del negocio." },
                    max: { type: "number", description: "Máximo de opciones a mostrar (default 6)" }
                },
                required: []
            }
        }
    },
    {
        type: "function",
        function: {
            name: "book",
            description: "Crea una cita (solo si el servicio existe en BD). Valida conflictos y reglas.",
            parameters: {
                type: "object",
                properties: {
                    serviceId: { type: "number" },
                    serviceName: { type: "string" },
                    startISO: { type: "string", description: "Fecha/hora inicio en ISO" },
                    phone: { type: "string" },
                    fullName: { type: "string" },
                    notes: { type: "string" },
                    durationMin: { type: "number", description: "Duración en minutos (opcional)" }
                },
                required: ["startISO", "phone", "fullName"]
            }
        }
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
                    newStartISO: { type: "string" }
                },
                required: ["appointmentId", "newStartISO"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "cancel",
            description: "Cancela una cita específica.",
            parameters: {
                type: "object",
                properties: {
                    appointmentId: { type: "number" }
                },
                required: ["appointmentId"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "cancelMany",
            description: "Cancela varias citas por ID.",
            parameters: {
                type: "object",
                properties: {
                    appointmentIds: { type: "array", items: { type: "number" } }
                },
                required: ["appointmentIds"]
            }
        }
    }
] as const;

/* -------------------------------------------
   Handlers (conectan tools ↔ backend)
   Nota: pasamos también session (conversationId)
------------------------------------------- */
export const toolHandlers = (ctx: EsteticaCtx, session?: { conversationId?: number }) => ({
    async listServices(args: any) {
        const limit = Number(args?.limit ?? 6);
        const items = await prisma.esteticaProcedure.findMany({
            where: { empresaId: ctx.empresaId, enabled: true },
            select: { id: true, name: true, durationMin: true, priceMin: true, priceMax: true, requiresAssessment: true },
            take: limit,
            orderBy: { name: "asc" }
        });
        return { ok: true, items };
    },

    async listUpcomingApptsForPhone(args: any) {
        const { phone, limit = 5 } = args;
        const phoneE164 = normalizeToE164(phone || "");
        const items = await listUpcomingCore(ctx.empresaId, phoneE164);
        return { ok: true, items: items.slice(0, limit) };
    },

    async findSlots(args: any) {
        const { serviceId, serviceName, fromISO, max = 6 } = args;

        // 1) Resolver servicio (para durationMin)
        const svc = await resolveService(ctx.empresaId, { serviceId, name: serviceName });
        const durationMin = svc?.durationMin ?? ctx.rules?.defaultServiceDurationMin ?? 60;

        // 2) Si no llega pista temporal, arrancamos desde mañana 00:00 (TZ negocio)
        const hint = fromISO ? new Date(fromISO) : startOfTomorrowTZ(ctx.timezone);

        // 3) Buscar
        const dates = await findSlotsCore({
            empresaId: ctx.empresaId,
            ctx,
            hint,
            durationMin,
            count: max,
        });

        return { ok: true, slots: dates.map(d => d.toISOString()), durationMin, serviceName: svc?.name ?? serviceName ?? null };
    },

    async book(args: any) {
        const { serviceId, serviceName, startISO, phone, fullName, notes, durationMin: durationMinArg } = args;

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

        const appt = await bookCore(
            {
                empresaId: ctx.empresaId,
                conversationId,
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
            data: { id: appt.id, startAt: appt.startAt.toISOString(), status: appt.status, serviceName: appt.serviceName ?? svc.name }
        };
    },

    async reschedule(args: any) {
        const updated = await rescheduleCore(
            { empresaId: ctx.empresaId, appointmentId: Number(args.appointmentId), newStartAt: new Date(args.newStartISO) },
            ctx
        );
        return { ok: true, data: { id: updated.id, startAt: updated.startAt.toISOString(), status: updated.status } };
    },

    async cancel(args: any) {
        const deleted = await cancelCore({ empresaId: ctx.empresaId, appointmentId: Number(args.appointmentId) });
        return { ok: true, data: { id: deleted.id, startAt: deleted.startAt.toISOString(), status: deleted.status } };
    },

    async cancelMany(args: any) {
        const rows = await cancelManyCore({ empresaId: ctx.empresaId, appointmentIds: (args.appointmentIds || []).map(Number) });
        return { ok: true, data: rows.map(r => ({ id: r.id, startAt: r.startAt.toISOString(), serviceName: r.serviceName || null })) };
    },
});
