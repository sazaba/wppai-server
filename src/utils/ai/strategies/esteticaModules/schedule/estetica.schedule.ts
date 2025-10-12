// utils/ai/strategies/esteticaModules/schedule/estetica.schedule.ts
import prisma from "../../../../../lib/prisma";
import { addMinutes } from "date-fns";
import { utcToZonedTime, format as tzFormat } from "date-fns-tz";
import type { AppointmentVertical } from "@prisma/client";

export type Slot = { startISO: string; endISO: string };
export type SlotsByDay = { dateISO: string; slots: Slot[] };

export type KBMinimal = {
    vertical: AppointmentVertical | "custom";
    timezone: string;
    bufferMin?: number | null;
    defaultServiceDurationMin?: number | null;
    procedures: Array<{
        id: number;
        name: string;
        durationMin?: number | null;
    }>;
};

export type DraftStage = "idle" | "offer" | "confirm";
export type SchedulingDraft = {
    name?: string;
    phone?: string;
    procedureId?: number;
    procedureName?: string;
    whenISO?: string;
    durationMin?: number;
    stage?: DraftStage;
};

export type StateShape = {
    draft?: SchedulingDraft;
    lastIntent?: "info" | "price" | "schedule" | "reschedule" | "cancel" | "other";
    lastServiceId?: number | null;
    lastServiceName?: string | null;
    slotsCache?: { items: Array<{ startISO: string; endISO: string; label: string }>; expiresAt: string };
};

export type SchedulingCtx = {
    empresaId: number;
    kb: KBMinimal;
    granularityMin: number;
    daysHorizon: number;
    maxSlots: number;
    now?: Date;
    toCOP?: (v?: number | null) => string | null; // opcional
};

export type SchedulingResult = {
    handled: boolean;
    reply?: string;
    patch?: Partial<StateShape>;
    createOk?: boolean;
    needsHuman?: boolean;
    failMessage?: string;
};

/* -------------------------------------------------------
   Helpers base de disponibilidad y creación de cita
   (ya existían; mantenemos firmas públicas)
------------------------------------------------------- */
export async function getNextAvailableSlots(
    env: { empresaId: number; timezone: string; vertical: AppointmentVertical | "custom"; bufferMin?: number | null; granularityMin: number },
    fromDateISO: string,
    durationMin: number,
    daysHorizon: number,
    maxPerDay: number
): Promise<SlotsByDay[]> {
    // 👉 Esta es tu implementación existente. Se deja como placeholder.
    // Debe devolver slots válidos por día.
    // Si ya la tienes implementada, conserva la tuya.
    return [];
}

export async function createAppointmentSafe(args: {
    empresaId: number;
    vertical: AppointmentVertical | "custom";
    timezone: string;
    procedureId?: number | null;
    serviceName: string;
    customerName: string;
    customerPhone: string;
    startISO: string;
    endISO: string;
    notes?: string;
    source?: "ai" | "web" | "manual";
}) {
    // 👉 Tu implementación real existente para crear citas con verificación de solapamientos.
    return { ok: true };
}

/* -------------------------------------------------------
   Utilidades internas del flujo
------------------------------------------------------- */
function nowPlusMin(min: number) {
    return new Date(Date.now() + min * 60_000).toISOString();
}

function labelSlotsForTZ(slots: Slot[], tz: string) {
    return slots.map((s) => {
        const d = new Date(s.startISO);
        const label = d.toLocaleString("es-CO", {
            weekday: "long",
            day: "2-digit",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
        });
        return { startISO: s.startISO, endISO: s.endISO, label };
    });
}

const NAME_RE = /(soy|me llamo)\s+([a-záéíóúñ\s]{2,40})/i;
const PHONE_RE = /(\+?57)?\s?(\d{10})\b/;
const HHMM_RE = /\b([01]?\d|2[0-3]):([0-5]\d)\b/;

function properCase(v?: string) {
    return (v || "")
        .trim()
        .replace(/\s+/g, " ")
        .replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}

/* -------------------------------------------------------
   Flujo orquestado: todo el manejo de agenda
   - ofrece horarios
   - captura datos
   - confirma y crea
------------------------------------------------------- */
export async function handleSchedulingTurn(params: {
    text: string;
    state: StateShape;
    ctx: SchedulingCtx;
    serviceInContext?: { id: number; name: string; durationMin?: number | null } | null;
    intent: "price" | "schedule" | "reschedule" | "cancel" | "info" | "other";
}): Promise<SchedulingResult> {
    const { text, state, ctx, serviceInContext, intent } = params;
    const { kb, empresaId, granularityMin, daysHorizon, maxSlots } = ctx;
    const tz = kb.timezone;

    // 1) Si no es intención de agenda y no estamos en captura/confirmación → no manejado
    const inDraft = state.draft?.stage === "offer" || state.draft?.stage === "confirm";
    const isConfirm = /^confirmo\b/i.test(text.trim());
    const isCapture = NAME_RE.test(text) || PHONE_RE.test(text.replace(/[^\d+]/g, " ")) || HHMM_RE.test(text);
    if (!(intent === "schedule" || inDraft || isConfirm || isCapture)) {
        return { handled: false };
    }

    // 2) Si piden horarios pero no hay servicio en contexto → pedirlo
    if (intent === "schedule" && !serviceInContext && !state.draft?.procedureId) {
        const ejemplos = kb.procedures.slice(0, 3).map((s) => s.name).join(", ");
        return {
            handled: true,
            reply: `Para ver horarios necesito el procedimiento. ¿Cuál deseas? (Ej.: ${ejemplos})`,
            patch: { lastIntent: "schedule" },
        };
    }

    // Servicio definitivo y duración
    const svc =
        serviceInContext ||
        kb.procedures.find((p) => p.id === (state.draft?.procedureId ?? 0)) ||
        null;
    const duration = (svc?.durationMin ?? kb.defaultServiceDurationMin ?? 60) as number;

    // 3) Ofrecer slots (inicio del flujo)
    if (intent === "schedule" && svc) {
        const todayISO = tzFormat(utcToZonedTime(params.ctx.now ?? new Date(), tz), "yyyy-MM-dd", { timeZone: tz });
        const byDay = await getNextAvailableSlots(
            { empresaId, timezone: tz, vertical: kb.vertical, bufferMin: kb.bufferMin, granularityMin },
            todayISO,
            duration,
            daysHorizon,
            maxSlots
        );

        const flat = byDay.flatMap((d) => d.slots).slice(0, maxSlots);
        if (!flat.length) {
            return {
                handled: true,
                reply: "No veo cupos cercanos por ahora. ¿Quieres que te contacte un asesor para coordinar?",
                patch: { lastIntent: "schedule" },
            };
        }

        const labeled = labelSlotsForTZ(flat, tz);
        const bullets = labeled.map((l) => `• ${l.label}`).join("\n");
        const reply =
            `Disponibilidad cercana para *${svc.name}*:\n${bullets}\n\n` +
            `Elige una y dime tu *nombre* y *teléfono* para reservar.`;

        return {
            handled: true,
            reply,
            patch: {
                lastIntent: "schedule",
                lastServiceId: svc.id,
                lastServiceName: svc.name,
                draft: {
                    ...(state.draft ?? {}),
                    procedureId: svc.id,
                    procedureName: svc.name,
                    durationMin: duration,
                    stage: "offer",
                },
                slotsCache: { items: labeled, expiresAt: nowPlusMin(10) },
            },
        };
    }

    // 4) Captura de datos → pasar a confirmación
    if (state.draft?.stage === "offer" && (isCapture || svc)) {
        const currentCache = state.slotsCache;
        let chosen = currentCache?.items?.[0];
        const hhmm = HHMM_RE.exec(text);
        if (hhmm && currentCache?.items?.length) {
            const hh = `${hhmm[1].padStart(2, "0")}:${hhmm[2]}`;
            const hit = currentCache.items.find((s) => new Date(s.startISO).toISOString().slice(11, 16) === hh);
            if (hit) chosen = hit;
        }

        const nameMatch = NAME_RE.exec(text);
        const phoneMatch = PHONE_RE.exec(text.replace(/[^\d+]/g, " "));

        const nextDraft: SchedulingDraft = {
            ...(state.draft ?? {}),
            name: state.draft?.name ?? (nameMatch ? properCase(nameMatch[2]) : undefined),
            phone: state.draft?.phone ?? (phoneMatch ? phoneMatch[2] : undefined),
            whenISO: state.draft?.whenISO ?? chosen?.startISO,
            stage: "confirm",
            procedureName: state.draft?.procedureName ?? svc?.name,
            procedureId: state.draft?.procedureId ?? svc?.id,
            durationMin: state.draft?.durationMin ?? duration,
        };

        const local = nextDraft.whenISO ? new Date(nextDraft.whenISO) : null;
        const fecha = local
            ? local.toLocaleDateString("es-CO", { weekday: "long", year: "numeric", month: "long", day: "2-digit" })
            : "fecha por confirmar";
        const hora = local
            ? local.toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit", hour12: false })
            : "hora por confirmar";

        const resumen =
            `¿Confirmas la reserva?\n` +
            `• Procedimiento: ${nextDraft.procedureName ?? "—"}\n` +
            `• Fecha/Hora: ${fecha} ${local ? `a las ${hora}` : ""}\n` +
            `• Nombre: ${nextDraft.name ?? "—"}\n` +
            `• Teléfono: ${nextDraft.phone ?? "—"}\n\n` +
            `Responde *"confirmo"* y creo la cita.`;

        return {
            handled: true,
            reply: resumen,
            patch: { draft: nextDraft },
        };
    }

    // 5) Confirmación final → crear cita
    if (state.draft?.stage === "confirm" && isConfirm && state.draft.whenISO) {
        try {
            const serviceName =
                state.draft.procedureName ||
                (kb.procedures.find((p) => p.id === (state.draft?.procedureId ?? 0))?.name ?? "Procedimiento");
            const endISO = new Date(addMinutes(new Date(state.draft.whenISO), state.draft.durationMin ?? 60)).toISOString();

            await createAppointmentSafe({
                empresaId,
                vertical: kb.vertical,
                timezone: kb.timezone,
                procedureId: state.draft.procedureId ?? null,
                serviceName,
                customerName: state.draft.name || "Cliente",
                customerPhone: state.draft.phone || "",
                startISO: state.draft.whenISO,
                endISO,
                notes: "Agendado por IA",
                source: "ai",
            });

            return {
                handled: true,
                createOk: true,
                reply: "¡Hecho! Tu cita quedó confirmada ✅. Te enviaremos recordatorio antes de la fecha.",
                patch: { draft: { stage: "idle" } },
            };
        } catch (e) {
            return {
                handled: true,
                createOk: false,
                reply: "Ese horario acaba de ocuparse 😕. ¿Te comparto otras opciones cercanas?",
            };
        }
    }

    // Nada que hacer
    return { handled: false };
}
