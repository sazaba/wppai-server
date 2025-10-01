// utils/ai/strategies/esteticaModules/assistant/ai.tools.ts
import prisma from "../../../../../lib/prisma";
import type { EsteticaCtx } from "../estetica.rag";
import { loadApptContext, confirmLatestPendingForPhone } from "../estetica.rag";
import {
    findSlots, book, reschedule, cancel, cancelMany, listUpcomingApptsForPhone
} from "../estetica.schedule";
import { AppointmentStatus } from "@prisma/client";

/* -------------------------------------------------------
   Helpers de validación / normalización
------------------------------------------------------- */
function clamp(n: number, min: number, max: number) {
    return Math.max(min, Math.min(n, max));
}
function parseISODateSafe(s: string): Date {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) throw new Error("Fecha/hora inválida");
    return d;
}
function normalizePhoneE164(raw: string): string {
    return String(raw || "").replace(/[^\d]/g, "");
}
async function ensureCtx(empresaId: number, ctx?: EsteticaCtx): Promise<EsteticaCtx> {
    if (ctx && ctx.timezone) return ctx;
    // carga de respaldo si el orquestador no adjuntó ctx
    return loadApptContext(empresaId, undefined);
}

/* -------------------------------------------------------
   Tipos que exporta el módulo (lo que el LLM puede pedir)
------------------------------------------------------- */
export type ToolInput =
    | { name: "find_slots"; args: { empresaId: number; durationMin?: number; count?: number; hintISO?: string | null; ctx?: EsteticaCtx } }
    | { name: "book_appt"; args: { empresaId: number; conversationId: number; phone: string; name?: string; serviceName: string; startISO: string; durationMin: number; timezone?: string; procedureId?: number; notes?: string; ctx?: EsteticaCtx } }
    | { name: "reschedule_appt"; args: { empresaId: number; apptId: number; newStartISO: string; ctx?: EsteticaCtx } }
    | { name: "cancel_appt"; args: { empresaId: number; apptId: number } }
    | { name: "cancel_many"; args: { empresaId: number; apptIds: number[] } }
    | { name: "list_upcoming"; args: { empresaId: number; phone: string } }
    | { name: "confirm_latest_pending"; args: { empresaId: number; phone: string } };

/** Respuesta estructurada (retrocompatible con tu orquestador). */
export type ToolOk<T> = { ok: true; data: T };
export type ToolErr = { ok: false; error: string };
export type ToolResp<T> = ToolOk<T> | ToolErr;

/* -------------------------------------------------------
   Implementación “premium” de herramientas
   - Validaciones
   - Defaults
   - Normalización
   - Sin PII en errores
------------------------------------------------------- */
export const Toolset = {
    /** Horarios disponibles (ISO strings). */
    async find_slots(input: Extract<ToolInput, { name: "find_slots" }>): Promise<ToolResp<string[]>> {
        try {
            const { empresaId } = input.args;
            const durationMin = clamp(input.args.durationMin ?? 60, 15, 240);
            const count = clamp(input.args.count ?? 6, 1, 12);
            const hint = input.args.hintISO ? parseISODateSafe(input.args.hintISO) : null;
            const ctx = await ensureCtx(empresaId, input.args.ctx);

            const dates = await findSlots({ empresaId, ctx, hint, durationMin, count });
            return { ok: true, data: dates.map(d => d.toISOString()) };
        } catch (e: any) {
            return { ok: false, error: String(e?.message || e || "Error al buscar horarios") };
        }
    },

    /** Confirmar y crear cita. */
    async book_appt(input: Extract<ToolInput, { name: "book_appt" }>): Promise<ToolResp<{ id: number; startAt: string; status: AppointmentStatus }>> {
        try {
            const {
                empresaId, conversationId, phone, name, serviceName,
                startISO, durationMin, timezone, procedureId, notes, ctx: maybeCtx
            } = input.args;

            const ctx = await ensureCtx(empresaId, maybeCtx);
            const startAt = parseISODateSafe(startISO);
            const dur = clamp(durationMin, 15, 240);
            const phoneNorm = normalizePhoneE164(phone);
            const tz = (timezone || ctx.timezone || "America/Bogota").trim();

            const appt = await book({
                empresaId,
                conversationId,
                customerPhone: phoneNorm,
                customerName: name || undefined,
                serviceName: serviceName.trim(),
                startAt,
                durationMin: dur,
                timezone: tz,
                procedureId,
                notes
            }, ctx);

            return { ok: true, data: { id: appt.id, startAt: appt.startAt.toISOString(), status: appt.status as AppointmentStatus } };
        } catch (e: any) {
            return { ok: false, error: String(e?.message || e || "No se pudo agendar") };
        }
    },

    /** Reagendar cita. */
    async reschedule_appt(input: Extract<ToolInput, { name: "reschedule_appt" }>): Promise<ToolResp<{ id: number; startAt: string; status: AppointmentStatus }>> {
        try {
            const { empresaId, apptId, newStartISO, ctx: maybeCtx } = input.args;
            const ctx = await ensureCtx(empresaId, maybeCtx);
            const newStartAt = parseISODateSafe(newStartISO);

            const upd = await reschedule({ empresaId, appointmentId: apptId, newStartAt }, ctx);
            return { ok: true, data: { id: upd.id, startAt: upd.startAt.toISOString(), status: upd.status as AppointmentStatus } };
        } catch (e: any) {
            return { ok: false, error: String(e?.message || e || "No se pudo reagendar") };
        }
    },

    /** Cancelar (soft delete) una cita. */
    async cancel_appt(input: Extract<ToolInput, { name: "cancel_appt" }>): Promise<ToolResp<{ id: number; startAt: string; status: AppointmentStatus }>> {
        try {
            const { empresaId, apptId } = input.args;
            const upd = await cancel({ empresaId, appointmentId: apptId });
            return { ok: true, data: { id: upd.id, startAt: upd.startAt.toISOString(), status: upd.status as AppointmentStatus } };
        } catch (e: any) {
            return { ok: false, error: String(e?.message || e || "No se pudo cancelar") };
        }
    },

    /** Cancelar varias. */
    async cancel_many(input: Extract<ToolInput, { name: "cancel_many" }>): Promise<ToolResp<{ id: number; startAt: string; serviceName: string | null }[]>> {
        try {
            const { empresaId, apptIds } = input.args;
            if (!Array.isArray(apptIds) || apptIds.length === 0) throw new Error("Sin IDs para cancelar");
            const rows = await cancelMany({ empresaId, appointmentIds: apptIds });
            const data = rows.map(r => ({ id: r.id, startAt: r.startAt.toISOString(), serviceName: r.serviceName ?? null }));
            return { ok: true, data };
        } catch (e: any) {
            return { ok: false, error: String(e?.message || e || "No se pudo cancelar") };
        }
    },

    /** Próximas citas por teléfono. */
    async list_upcoming(input: Extract<ToolInput, { name: "list_upcoming" }>): Promise<ToolResp<{ id: number; startAt: string; serviceName: string | null }[]>> {
        try {
            const { empresaId, phone } = input.args;
            const phoneNorm = normalizePhoneE164(phone);
            const list = await listUpcomingApptsForPhone(empresaId, phoneNorm);
            const data = list.map(x => ({ id: x.id, startAt: x.startAt.toISOString(), serviceName: x.serviceName ?? null }));
            return { ok: true, data };
        } catch (e: any) {
            return { ok: false, error: String(e?.message || e || "No se pudo listar") };
        }
    },

    /** Confirmar la cita pendiente más reciente. */
    async confirm_latest_pending(input: Extract<ToolInput, { name: "confirm_latest_pending" }>): Promise<ToolResp<{ id: number; startAt: string; status: AppointmentStatus } | null>> {
        try {
            const { empresaId, phone } = input.args;
            const phoneNorm = normalizePhoneE164(phone);
            const appt = await confirmLatestPendingForPhone(empresaId, phoneNorm);
            if (!appt) return { ok: true, data: null };
            return { ok: true, data: { id: appt.id, startAt: appt.startAt.toISOString(), status: appt.status as AppointmentStatus } };
        } catch (e: any) {
            return { ok: false, error: String(e?.message || e || "No se pudo confirmar") };
        }
    },
};

export type ToolName = keyof typeof Toolset;

/* -------------------------------------------------------
   Signaturas (lo que ve el LLM). Breves y prescriptivas.
------------------------------------------------------- */
export function listToolSignatures() {
    return [
        {
            name: "find_slots",
            description:
                "Busca horarios disponibles reales respetando reglas de agenda (TZ, buffer, excepciones). ÚSALA ANTES de ofrecer horas. Siempre pide 4–6 opciones.",
            schema: "{ empresaId:number, durationMin?:number (15-240), count?:number (1-12), hintISO?:string|null }"
        },
        {
            name: "book_appt",
            description:
                "Crea una cita confirmada o pendiente según reglas. Usa SOLO tras elegir un horario exacto. No inventes horas.",
            schema:
                "{ empresaId:number, conversationId:number, phone:string, name?:string, serviceName:string, startISO:string, durationMin:number, timezone?:string, procedureId?:number, notes?:string }"
        },
        {
            name: "reschedule_appt",
            description:
                "Cambia fecha/hora de una cita por ID. Primero sugiere nuevos slots con find_slots.",
            schema: "{ empresaId:number, apptId:number, newStartISO:string }"
        },
        {
            name: "cancel_appt",
            description:
                "Cancela una cita por ID (soft delete). Pide confirmación breve al usuario si hay dudas.",
            schema: "{ empresaId:number, apptId:number }"
        },
        {
            name: "cancel_many",
            description:
                "Cancela varias por ID. Úsala solo si el usuario dice 'todas' o da múltiples números.",
            schema: "{ empresaId:number, apptIds:number[] }"
        },
        {
            name: "list_upcoming",
            description:
                "Lista próximas citas del teléfono actual (ordenadas asc). Útil para '¿qué tengo agendado?'.",
            schema: "{ empresaId:number, phone:string }"
        },
        {
            name: "confirm_latest_pending",
            description:
                "Confirma la cita PENDIENTE más reciente para ese teléfono, si existe.",
            schema: "{ empresaId:number, phone:string }"
        }
    ];
}
