// utils/ai/strategies/esteticaModules/assistant/ai.tools.ts
import prisma from "../../../../../lib/prisma";
import type { EsteticaCtx } from "../estetica.rag";
import {
    findSlots, book, reschedule, cancel, cancelMany,
    listUpcomingApptsForPhone
} from "../estetica.schedule";
import { confirmLatestPendingForPhone } from "../estetica.rag";
import { AppointmentStatus } from "@prisma/client";

// ==================== Tipos estandarizados ====================
// Respuesta estándar para que el orquestador pueda resumir sin romper.
export type ToolResp<T> = { ok: true; data: T } | { ok: false; error: string };

// Tipos de entrada para el orquestador
export type ToolInput =
    | { name: "find_slots"; args: { empresaId: number; durationMin?: number; count?: number; hintISO?: string | null; ctx: EsteticaCtx; serviceName?: string; procedureId?: number } }
    | { name: "book_appt"; args: { empresaId: number; conversationId: number; phone: string; name?: string; serviceName?: string; procedureId?: number; startISO: string; durationMin?: number; timezone: string; notes?: string; ctx: EsteticaCtx } }
    | { name: "reschedule_appt"; args: { empresaId: number; apptId: number; newStartISO: string; ctx: EsteticaCtx } }
    | { name: "cancel_appt"; args: { empresaId: number; apptId: number } }
    | { name: "cancel_many"; args: { empresaId: number; apptIds: number[] } }
    | { name: "list_upcoming"; args: { empresaId: number; phone: string } }
    | { name: "confirm_latest_pending"; args: { empresaId: number; phone: string } };

export type ToolName = "find_slots" | "book_appt" | "reschedule_appt" | "cancel_appt" | "cancel_many" | "list_upcoming" | "confirm_latest_pending";

// ==================== Helpers de matching ====================
const nrm = (s: string) =>
    String(s || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^\w\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

async function getEnabledProcedures(empresaId: number) {
    const rows = await prisma.esteticaProcedure.findMany({
        where: { empresaId, enabled: true },
        select: { id: true, name: true, durationMin: true, aliases: true }
    });
    return rows.map(r => ({
        id: r.id,
        name: r.name,
        durationMin: r.durationMin ?? undefined,
        aliases: Array.isArray(r.aliases) ? (r.aliases as any[]).filter(x => typeof x === "string") as string[] : []
    }));
}

function matchProcedureByNameOrAlias(list: Awaited<ReturnType<typeof getEnabledProcedures>>, q?: string) {
    if (!q) return null;
    const text = nrm(q);
    if (!text) return null;

    let best: { id: number; name: string; durationMin?: number } | null = null;
    let bestScore = 0;

    for (const p of list) {
        const nameScore = text.includes(nrm(p.name)) ? 1 : 0;
        let aliasScore = 0;
        for (const a of p.aliases) {
            if (text.includes(nrm(a))) aliasScore = Math.max(aliasScore, 0.8);
        }
        const score = Math.max(nameScore, aliasScore);
        if (score > bestScore) {
            bestScore = score;
            best = { id: p.id, name: p.name, durationMin: p.durationMin };
        }
    }
    return bestScore >= 0.6 ? best : null;
}

// ==================== Toolset (acceso real a DB) ====================
export const Toolset = {
    /** Encuentra horarios. Si viene procedureId o serviceName válido, usa su duration; si no, usa durationMin/ctx. */
    async find_slots(a: ToolInput & { name: "find_slots" }): Promise<ToolResp<{ slots: string[]; durationMin: number }>> {
        const { empresaId, ctx } = a.args;
        let { durationMin, count = 6, hintISO = null, serviceName, procedureId } = a.args;

        // Si llega un procedimiento, intenta aplicar su duración por defecto
        if (!durationMin && (procedureId || serviceName)) {
            const procs = await getEnabledProcedures(empresaId);
            let proc = null;
            if (procedureId) proc = procs.find(p => p.id === procedureId) || null;
            if (!proc && serviceName) proc = matchProcedureByNameOrAlias(procs, serviceName);
            if (proc?.durationMin) durationMin = proc.durationMin;
        }
        durationMin = durationMin || ctx.rules?.defaultServiceDurationMin || 60;

        const hint = hintISO ? new Date(hintISO) : null;
        const dates = await findSlots({ empresaId, ctx, hint, durationMin, count });
        return { ok: true, data: { slots: dates.map(d => d.toISOString()), durationMin } };
    },

    /** Agenda SOLO si el servicio existe y está habilitado en BD. Si no existe, devuelve error con alternativas. */
    async book_appt(a: ToolInput & { name: "book_appt" }): Promise<ToolResp<{ id: number; startAt: string; status: AppointmentStatus }>> {
        const { empresaId, conversationId, phone, name, serviceName, procedureId, startISO, timezone, notes, ctx } = a.args;
        let { durationMin } = a.args;

        const procs = await getEnabledProcedures(empresaId);

        // Resolver procedimiento
        let proc = null as null | { id: number; name: string; durationMin?: number };
        if (procedureId) proc = procs.find(p => p.id === procedureId) || null;
        if (!proc && serviceName) proc = matchProcedureByNameOrAlias(procs, serviceName);

        if (!proc) {
            // No existe en catálogo → NO agendar. Sugerimos opciones.
            const suggestions = procs.slice(0, 5).map(p => p.name);
            return {
                ok: false,
                error: `Servicio no disponible para agendar. Opciones habilitadas: ${suggestions.join(", ")}. También puedo agendar una valoración.`
            };
        }

        durationMin = durationMin || proc.durationMin || ctx.rules?.defaultServiceDurationMin || 60;

        const appt = await book({
            empresaId,
            conversationId,
            customerPhone: phone,
            customerName: name || undefined,
            serviceName: proc.name,
            startAt: new Date(startISO),
            durationMin,
            timezone,
            procedureId: proc.id,
            notes
        }, ctx);

        return { ok: true, data: { id: appt.id, startAt: appt.startAt.toISOString(), status: appt.status as AppointmentStatus } };
    },

    async reschedule_appt(a: ToolInput & { name: "reschedule_appt" }): Promise<ToolResp<{ id: number; startAt: string; status: AppointmentStatus }>> {
        const { empresaId, apptId, newStartISO, ctx } = a.args;
        const upd = await reschedule({ empresaId, appointmentId: apptId, newStartAt: new Date(newStartISO) }, ctx);
        return { ok: true, data: { id: upd.id, startAt: upd.startAt.toISOString(), status: upd.status as AppointmentStatus } };
    },

    async cancel_appt(a: ToolInput & { name: "cancel_appt" }): Promise<ToolResp<{ id: number; startAt: string; status: AppointmentStatus }>> {
        const { empresaId, apptId } = a.args;
        const upd = await cancel({ empresaId, appointmentId: apptId });
        return { ok: true, data: { id: upd.id, startAt: upd.startAt.toISOString(), status: upd.status as AppointmentStatus } };
    },

    async cancel_many(a: ToolInput & { name: "cancel_many" }): Promise<ToolResp<{ items: { id: number; startAt: string; serviceName: string | null }[] }>> {
        const { empresaId, apptIds } = a.args;
        const rows = await cancelMany({ empresaId, appointmentIds: apptIds });
        return { ok: true, data: { items: rows.map(r => ({ id: r.id, startAt: r.startAt.toISOString(), serviceName: r.serviceName || null })) } };
    },

    async list_upcoming(a: ToolInput & { name: "list_upcoming" }): Promise<ToolResp<{ items: { id: number; startAt: string; serviceName: string | null }[] }>> {
        const { empresaId, phone } = a.args;
        const list = await listUpcomingApptsForPhone(empresaId, phone);
        return { ok: true, data: { items: list.map(x => ({ id: x.id, startAt: x.startAt.toISOString(), serviceName: x.serviceName || null })) } };
    },

    async confirm_latest_pending(a: ToolInput & { name: "confirm_latest_pending" }): Promise<ToolResp<{ id: number; startAt: string; status: AppointmentStatus } | null>> {
        const { empresaId, phone } = a.args;
        const appt = await confirmLatestPendingForPhone(empresaId, phone);
        if (!appt) return { ok: true, data: null };
        return { ok: true, data: { id: appt.id, startAt: appt.startAt.toISOString(), status: appt.status as AppointmentStatus } };
    }
};

export function listToolSignatures() {
    // Lo que el LLM ve: descripción y shape esperado. (No incluir 'ctx' para no confundir al modelo.)
    return [
        {
            name: "find_slots",
            description: "Obtiene horarios disponibles (devuelve ISO strings). Úsalo ANTES de ofrecer horas.",
            schema: "{ empresaId:number, durationMin?:number, count?:number, hintISO?:string|null, serviceName?:string, procedureId?:number }"
        },
        {
            name: "book_appt",
            description: "Crea la cita SOLO si el servicio existe en BD. Si no existe, regresará error con sugerencias.",
            schema: "{ empresaId:number, conversationId:number, phone:string, name?:string, serviceName?:string, procedureId?:number, startISO:string, durationMin?:number, timezone:string, notes?:string }"
        },
        {
            name: "reschedule_appt",
            description: "Cambia fecha/hora de una cita existente por ID.",
            schema: "{ empresaId:number, apptId:number, newStartISO:string }"
        },
        {
            name: "cancel_appt",
            description: "Cancela (soft delete) una cita por ID.",
            schema: "{ empresaId:number, apptId:number }"
        },
        {
            name: "cancel_many",
            description: "Cancela varias citas por ID.",
            schema: "{ empresaId:number, apptIds:number[] }"
        },
        {
            name: "list_upcoming",
            description: "Lista próximas citas por teléfono (del cliente actual).",
            schema: "{ empresaId:number, phone:string }"
        },
        {
            name: "confirm_latest_pending",
            description: "Confirma la cita pendiente más reciente de ese teléfono.",
            schema: "{ empresaId:number, phone:string }"
        }
    ];
}
