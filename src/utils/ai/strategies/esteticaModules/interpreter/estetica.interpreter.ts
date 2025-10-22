// utils/ai/strategies/esteticaModules/interpreter/estetica.interpreter.ts
import type { AppointmentVertical } from "@prisma/client";
import {
    FIND_SLOTS,
    BOOK_APPOINTMENT,
    CANCEL_APPOINTMENT,
    RESCHEDULE_APPOINTMENT,
    type LabeledSlot,
} from "../interpreter/estetica.facade";

export type DayPeriod = "morning" | "afternoon" | "evening";

export type KBMinimal = {
    vertical: AppointmentVertical | "custom";
    timezone: string;
    bufferMin?: number | null;
    defaultServiceDurationMin?: number | null;
    procedures: Array<{ id: number; name: string; durationMin?: number | null }>;
};

export type ConversationState = {
    intent?: "ASK_SLOTS" | "BOOK" | "RESCHEDULE" | "CANCEL" | "INFO" | "GREET" | "UNSURE";
    serviceId?: number | null;
    serviceName?: string | null;

    // Datos capturados del cliente
    customerName?: string | null;
    customerPhone?: string | null;

    // Draft de operación
    appointmentId?: number | null;     // para reschedule/cancel
    chosenStartISO?: string | null;    // UTC
    durationMin?: number | null;

    // Cache de opciones
    slotPool?: LabeledSlot[] | null;   // última lista de opciones
    slotPoolPivotISO?: string | null;  // YYYY-MM-DD local
    slotPoolPeriod?: DayPeriod | null;

    // Meta
    lastMessageAt?: string;
};

export type TurnCtx = {
    empresaId: number;
    kb: KBMinimal;
    granularityMin: number;
    daysHorizon: number;
    maxSlots: number;
    now?: Date;
};

export type NLU = {
    intent:
    | "ASK_SLOTS"
    | "BOOK"
    | "CHOOSE"
    | "RESCHEDULE"
    | "CANCEL"
    | "INFO"
    | "GREET"
    | "UNSURE";
    confidence: number;
    missing?: Array<"date" | "time" | "service" | "name" | "phone">;
    slots: {
        date?: string | null;                  // YYYY-MM-DD local
        time?: string | null;                  // HH:mm local
        time_of_day?: DayPeriod | null;
        serviceId?: number | null;
        serviceName?: string | null;
        choice_index?: number | null;          // 1..n
        name?: string | null;
        phone?: string | null;
    };
};

const AMPM12 = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i;
const HHMM24 = /\b([01]?\d|2[0-3]):([0-5]\d)\b/;
const ACCEPT_RE = /\b(confirmo|listo|sí|si|ok(ay)?|perfecto|agendar|reservar|me sirve|voy con|tomo)\b/i;

function hhmmToMin(hhmm: string): number {
    const [h, m] = hhmm.split(":").map((n) => parseInt(n, 10));
    return h * 60 + m;
}

function formatLocal(tsISO: string, tz: string) {
    const d = new Date(tsISO);
    const z = new Intl.DateTimeFormat("es-CO", {
        timeZone: tz,
        weekday: "long",
        day: "2-digit",
        month: "long",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
    }).format(d);
    // Estilo “viernes, 24 de octubre de 2025, 9:00 a. m.”
    const [fecha, hora] = z.split(", ").length >= 3
        ? [z.split(", ").slice(0, 2).join(", "), z.split(", ").slice(2).join(", ")]
        : [z, ""];
    return { fecha, hora };
}

function hasAllBookingData(s: ConversationState) {
    return Boolean(s.customerName && s.customerPhone && s.chosenStartISO && s.durationMin);
}

function coalesceDuration(kb: KBMinimal, svc?: { durationMin?: number | null } | null) {
    return svc?.durationMin ?? kb.defaultServiceDurationMin ?? 60;
}

function pickService(kb: KBMinimal, nlu?: NLU | null, state?: ConversationState) {
    if (nlu?.slots.serviceId) {
        const hit = kb.procedures.find((p) => p.id === nlu.slots.serviceId);
        if (hit) return { id: hit.id, name: hit.name, durationMin: hit.durationMin ?? null };
    }
    if (nlu?.slots.serviceName) {
        const name = (nlu.slots.serviceName || "").trim().toLowerCase();
        const hit = kb.procedures.find((p) => p.name.toLowerCase() === name);
        if (hit) return { id: hit.id, name: hit.name, durationMin: hit.durationMin ?? null };
    }
    if (state?.serviceId) {
        const hit = kb.procedures.find((p) => p.id === state.serviceId);
        if (hit) return { id: hit.id, name: hit.name, durationMin: hit.durationMin ?? null };
    }
    return null;
}

export type InterpreterResult = {
    reply: string;
    patch: Partial<ConversationState>;
    // Señales para el orquestador (opcional)
    created?: boolean;
    rescheduled?: boolean;
    cancelled?: boolean;
};

/**
 * Intérprete natural (decide) → llama façade (ejecuta)
 */
export async function runInterpreterTurn(args: {
    text: string;
    state: ConversationState;
    ctx: TurnCtx;
    nlu?: NLU;
}): Promise<InterpreterResult> {
    const { text, state: prev, ctx, nlu } = args;
    const tz = ctx.kb.timezone;

    // === 1) Resolver intención de alto nivel ===
    const intent =
        nlu?.intent ??
        (/\bcancel(ar|a)?\b/i.test(text) ? "CANCEL"
            : /\b(reagendar|mover|cambiar)\b/i.test(text) ? "RESCHEDULE"
                : /\b(precio|vale|cuánto)\b/i.test(text) ? "INFO"
                    : /\b(hola|buen[oa]s)\b/i.test(text) ? "GREET"
                        : "BOOK");

    // === 2) Resolver servicio en contexto ===
    const svc = pickService(ctx.kb, nlu || null, prev);
    if ((intent === "BOOK" || intent === "ASK_SLOTS" || intent === "RESCHEDULE") && !svc) {
        return {
            reply:
                "¿Qué procedimiento deseas agendar? (p. ej.: *Limpieza facial*, *Peeling*, *Toxina botulínica*)",
            patch: { intent: "BOOK" },
        };
    }

    // === 3) Cancelación es terminal ===
    if (intent === "CANCEL") {
        const phone = nlu?.slots.phone?.replace(/\D+/g, "") || prev.customerPhone || "";
        if (!phone) {
            return {
                reply: "Para ubicar tu cita necesito tu *teléfono*. Escríbelo (solo números).",
                patch: { intent: "CANCEL" },
            };
        }
        const res = await CANCEL_APPOINTMENT({ empresaId: ctx.empresaId, phone });
        if (!res.ok) {
            return {
                reply: "No encuentro una cita próxima con ese teléfono. ¿Deseas que te muestre horarios para agendar una nueva?",
                patch: { intent: "CANCEL" },
            };
        }
        return {
            reply:
                "Listo, tu cita fue *cancelada*. ¿Quieres que te comparta horarios para reprogramar?",
            patch: {
                intent: "CANCEL",
                appointmentId: null,
                chosenStartISO: null,
                slotPool: null,
            },
            cancelled: true,
        };
    }

    // === 4) Reagendar → preparar y pedir rango ===
    if (intent === "RESCHEDULE") {
        const phone = nlu?.slots.phone?.replace(/\D+/g, "") || prev.customerPhone || "";
        if (!phone) {
            return {
                reply: "Para ubicar tu cita a reagendar necesito tu *teléfono*. Escríbelo (solo números).",
                patch: { intent: "RESCHEDULE" },
            };
        }
        // El façade de reprogramación necesita el id; lo normal es que lo resuelvas desde el orquestador.
        // Aquí pedimos nueva fecha/franja.
        return {
            reply:
                `Perfecto. ¿Para qué *día/franja* quieres mover tu cita de *${svc!.name}*? (ej.: *jueves en la tarde*, *mañana*, *la más próxima*)`,
            patch: {
                intent: "RESCHEDULE",
                customerPhone: phone,
                chosenStartISO: null,
                slotPool: null,
            },
        };
    }

    // === 5) Generación de opciones (no auto-book) ===
    const wantPeriod = nlu?.slots.time_of_day ?? null;
    const wantDateISO = nlu?.slots.date ?? null;
    const wantTimeLocal = nlu?.slots.time ?? null;
    const choiceIdx = nlu?.slots.choice_index ?? null;

    const durationMin = coalesceDuration(ctx.kb, svc);
    const pivotLocal =
        wantDateISO ??
        prev.slotPoolPivotISO ??
        new Intl.DateTimeFormat("sv-SE", {
            timeZone: tz,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
        })
            .format(new Date())
            .replace(/\./g, "-"); // ✅ compatible ES2018+


    // (A) Si tenemos pool y el usuario elige (hora / ordinal / aceptar)
    if (prev.slotPool?.length) {
        let picked: LabeledSlot | null = null;

        if (wantTimeLocal) {
            const target = hhmmToMin(wantTimeLocal);
            picked = prev.slotPool.find((s) => {
                const d = new Date(s.startISO);
                const mm = d.getUTCHours() * 60 + d.getUTCMinutes(); // aprox (TZ ya está en label)
                // no convertimos exacto a tz para ahorrar dependencias aquí: pool viene del mismo tz
                return mm % 60 === target % 60 && Math.floor(mm / 60) % 24 === Math.floor(target / 60) % 24;
            }) || null;
        } else if (choiceIdx && choiceIdx > 0 && choiceIdx <= prev.slotPool.length) {
            picked = prev.slotPool[choiceIdx - 1];
        } else if (ACCEPT_RE.test(text)) {
            picked = prev.slotPool[0];
        }

        if (picked) {
            // gating: no ejecutamos hasta tener nombre+teléfono y “aceptación”
            const name = nlu?.slots.name || prev.customerName || null;
            const phone = (nlu?.slots.phone || prev.customerPhone || "").replace(/\D+/g, "") || null;

            const { fecha, hora } = formatLocal(picked.startISO, tz);

            if (name && phone && (ACCEPT_RE.test(text) || choiceIdx || wantTimeLocal)) {
                // Crear cita
                const created = await BOOK_APPOINTMENT({
                    empresaId: ctx.empresaId,
                    timezone: tz,
                    vertical: ctx.kb.vertical,
                    bufferMin: ctx.kb.bufferMin ?? 0,
                    procedureId: svc!.id,
                    serviceName: svc!.name,
                    customerName: name!,
                    customerPhone: phone!,
                    startISO: picked.startISO,
                    durationMin,
                    notes: "Agendado por IA",
                });

                if ((created as any).ok) {
                    return {
                        reply: `¡Listo! Tu cita quedó confirmada ✅. *${fecha}, ${hora}*.`,
                        patch: {
                            intent: "BOOK",
                            customerName: name,
                            customerPhone: phone,
                            chosenStartISO: picked.startISO,
                            durationMin,
                            slotPool: null,
                        },
                        created: true,
                    };
                }

                return {
                    reply:
                        "Ese horario se acaba de ocupar o está fuera del horario de atención. ¿Te muestro otras opciones cercanas?",
                    patch: { slotPool: null, chosenStartISO: null },
                };
            }

            const missing: string[] = [];
            if (!name) missing.push("tu *nombre*");
            if (!phone) missing.push("tu *teléfono*");

            return {
                reply:
                    `Perfecto. Te reservo *${svc!.name}* para *${fecha}, ${hora}*.\n` +
                    (missing.length ? `Para confirmar, por favor envíame ${missing.join(" y ")}.` : "¿Confirmo así?"),
                patch: {
                    intent: "BOOK",
                    customerName: name,
                    customerPhone: phone,
                    chosenStartISO: picked.startISO,
                    durationMin,
                },
            };
        }

        // Cambió la franja → regeneramos
        if (wantPeriod) {
            // cae abajo a generar pool nuevo con la franja
        } else {
            // sin elección clara: re-prompt con bullets
            const bullets = prev.slotPool.slice(0, 3).map((s, i) => `• *${i + 1}.* ${s.label}`).join("\n");
            return {
                reply:
                    `Disponibilidad cercana para *${svc!.name}*:\n${bullets}\n\n` +
                    `Elige una opción (1, 2, 3) o dime una hora (p. ej. *3:00 pm*).`,
                patch: { intent: "ASK_SLOTS" },
            };
        }
    }

    // (B) No hay pool o el usuario pidió otra fecha/franja → generamos opciones
    const pool = await FIND_SLOTS({
        empresaId: ctx.empresaId,
        timezone: tz,
        vertical: ctx.kb.vertical,
        bufferMin: ctx.kb.bufferMin ?? 0,
        granularityMin: ctx.granularityMin,
        pivotLocalDateISO: pivotLocal,
        durationMin,
        daysHorizon: ctx.daysHorizon,
        maxSlots: ctx.maxSlots,
        period: wantPeriod ?? null,
    });

    if (!pool.length) {
        return {
            reply:
                "No veo cupos cercanos en ese rango. ¿Te muestro otras fechas o prefieres *mañana*, *tarde* o *noche*?",
            patch: { intent: "ASK_SLOTS", slotPool: null, slotPoolPivotISO: pivotLocal, slotPoolPeriod: wantPeriod ?? null },
        };
    }

    const bullets = pool.slice(0, 3).map((s, i) => `• *${i + 1}.* ${s.label}`).join("\n");
    const hint = wantPeriod ? ` (${wantPeriod === "morning" ? "mañana" : wantPeriod === "afternoon" ? "tarde" : "noche"})` : "";

    return {
        reply:
            `Disponibilidad cercana para *${svc!.name}*${hint}:\n${bullets}\n\n` +
            `Elige una opción (1, 2, 3) o dime una hora (p. ej. *3:00 pm*). ` +
            `Para confirmar necesito tu *nombre* y *teléfono*.`,
        patch: {
            intent: "ASK_SLOTS",
            serviceId: svc!.id,
            serviceName: svc!.name,
            durationMin,
            slotPool: pool,
            slotPoolPivotISO: pivotLocal,
            slotPoolPeriod: wantPeriod ?? null,
        },
    };
}
