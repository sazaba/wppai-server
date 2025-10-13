// utils/ai/strategies/esteticaModules/schedule/estetica.schedule.ts
import prisma from "../../../../../lib/prisma";
import {
    addMinutes,
    addDays,
    isBefore,
    max as dfMax,
    startOfDay,
    endOfDay,
} from "date-fns";
import {
    utcToZonedTime,
    zonedTimeToUtc,
    format as tzFormat,
} from "date-fns-tz";
import type {
    AppointmentStatus,
    AppointmentVertical,
    Weekday,
} from "@prisma/client";

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
    lastIntent?:
    | "info"
    | "price"
    | "schedule"
    | "reschedule"
    | "cancel"
    | "other";
    lastServiceId?: number | null;
    lastServiceName?: string | null;
    slotsCache?: {
        items: Array<{ startISO: string; endISO: string; label: string }>;
        expiresAt: string;
    };
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

/* ===================== Helpers TZ ===================== */

const WEEKDAY_ORDER: Record<Weekday, number> = {
    mon: 1,
    tue: 2,
    wed: 3,
    thu: 4,
    fri: 5,
    sat: 6,
    sun: 0,
};

function getWeekdayFromDate(dLocal: Date): Weekday {
    // getDay(): 0=Sunday ... 6=Saturday
    const dow = dLocal.getDay();
    return (["sun", "mon", "tue", "wed", "thu", "fri", "sat"][
        dow
    ] || "mon") as Weekday;
}

function hhmmToUtc(dateLocalISO: string, hhmm: string, tz: string): Date {
    // Construye Date en zona local y lo convierte a UTC
    const [h, m] = hhmm.split(":").map((v) => parseInt(v, 10));
    const local = utcToZonedTime(zonedTimeToUtc(dateLocalISO, tz), tz); // normaliza
    local.setHours(h, m, 0, 0);
    return zonedTimeToUtc(local, tz);
}

function roundUpToGranularity(date: Date, granMin: number): Date {
    const ms = date.getTime();
    const step = granMin * 60_000;
    const rounded = Math.ceil(ms / step) * step;
    return new Date(rounded);
}

function iso(d: Date): string {
    return new Date(d.getTime()).toISOString();
}

function intervalsOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date) {
    return aStart < bEnd && bStart < aEnd;
}

/* ========== Núcleo: construir ventanas abiertas del día ========== */

async function getOpenWindowsForDate(params: {
    empresaId: number;
    dateLocal: Date; // a medianoche local del día consultado
    tz: string;
}) {
    const { empresaId, dateLocal, tz } = params;

    // Semana base desde AppointmentHour (patrón)
    const weekday = getWeekdayFromDate(dateLocal);
    const base = await prisma.appointmentHour.findUnique({
        where: { empresaId_day: { empresaId, day: weekday } },
    });

    // Excepciones por fecha exacta (opcional)
    const startOfLocalDay = utcToZonedTime(
        zonedTimeToUtc(
            tzFormat(dateLocal, "yyyy-MM-dd'T'00:00:00", { timeZone: tz }),
            tz
        ),
        tz
    );
    const endOfLocalDay = utcToZonedTime(
        zonedTimeToUtc(
            tzFormat(dateLocal, "yyyy-MM-dd'T'23:59:59", { timeZone: tz }),
            tz
        ),
        tz
    );

    const exception = await prisma.appointmentException.findFirst({
        where: {
            empresaId,
            date: {
                gte: zonedTimeToUtc(startOfLocalDay, tz),
                lte: zonedTimeToUtc(endOfLocalDay, tz),
            },
        },
    });

    // Resolver ventanas: excepción (si existe) sobreescribe parcialmente
    const open =
        exception?.isOpen === false
            ? [] // cerrado por excepción
            : [
                {
                    start: exception?.start1 ?? base?.start1 ?? null,
                    end: exception?.end1 ?? base?.end1 ?? null,
                },
                {
                    start: exception?.start2 ?? base?.start2 ?? null,
                    end: exception?.end2 ?? base?.end2 ?? null,
                },
            ].filter((w) => w.start && w.end) as Array<{ start: string; end: string }>;

    // Convertir a UTC intervalos
    const windowsUtc = open.map(({ start, end }) => {
        const dayISO = tzFormat(dateLocal, "yyyy-MM-dd'T'00:00:00", {
            timeZone: tz,
        });
        const s = hhmmToUtc(dayISO, start, tz);
        const e = hhmmToUtc(dayISO, end, tz);
        return { startUtc: s, endUtc: e };
    });

    return windowsUtc;
}

/* ====== Citas existentes del día (para cortar solapes) ====== */

async function getBusyIntervalsUTC(params: {
    empresaId: number;
    dayStartUtc: Date;
    dayEndUtc: Date;
}) {
    const { empresaId, dayStartUtc, dayEndUtc } = params;

    const blocking: AppointmentStatus[] = ["pending", "confirmed", "rescheduled"];

    const appts = await prisma.appointment.findMany({
        where: {
            empresaId,
            deletedAt: null,
            status: { in: blocking },
            // cualquier cita que toque el día
            OR: [
                {
                    startAt: { lt: dayEndUtc },
                    endAt: { gt: dayStartUtc },
                },
            ],
        },
        select: { startAt: true, endAt: true },
    });

    return appts.map((a) => ({
        startUtc: a.startAt,
        endUtc: a.endAt,
    }));
}

/* ========== Generación de slots ========== */

function carveSlotsFromWindows(params: {
    windowsUtc: Array<{ startUtc: Date; endUtc: Date }>;
    busyUtc: Array<{ startUtc: Date; endUtc: Date }>;
    durationMin: number;
    granMin: number;
    earliestAllowedUtc: Date; // respeta buffer y "ahora"
    maxPerDay: number;
}): Slot[] {
    const {
        windowsUtc,
        busyUtc,
        durationMin,
        granMin,
        earliestAllowedUtc,
        maxPerDay,
    } = params;

    const slots: Slot[] = [];
    for (const w of windowsUtc) {
        // empezar en el mayor entre inicio de ventana y earliestAllowed
        let cursor = dfMax([w.startUtc, earliestAllowedUtc]);
        // redondear a granularidad
        cursor = roundUpToGranularity(cursor, granMin);

        while (true) {
            const end = addMinutes(cursor, durationMin);
            if (end > w.endUtc) break;

            // solape con ocupados
            const overlaps = busyUtc.some((b) => intervalsOverlap(cursor, end, b.startUtc, b.endUtc));
            if (!overlaps) {
                slots.push({ startISO: iso(cursor), endISO: iso(end) });
                if (slots.length >= maxPerDay) break;
            }

            cursor = addMinutes(cursor, granMin);
            if (cursor >= w.endUtc) break;
        }

        if (slots.length >= maxPerDay) break;
    }
    return slots;
}

/* ============================================================
   API pública (usada desde estetica.strategy)
============================================================ */

export async function getNextAvailableSlots(
    env: {
        empresaId: number;
        timezone: string;
        vertical: AppointmentVertical | "custom";
        bufferMin?: number | null;
        granularityMin: number;
    },
    fromDateISO: string, // "yyyy-MM-dd" en TZ del negocio o ISO Date que tomamos como base
    durationMin: number,
    daysHorizon: number,
    maxPerDay: number
): Promise<SlotsByDay[]> {
    const { empresaId, timezone: tz, bufferMin, granularityMin } = env;

    // Punto de partida "local"
    const baseLocalDate = utcToZonedTime(new Date(fromDateISO + "T00:00:00Z"), tz);
    const results: SlotsByDay[] = [];

    const nowUtc = new Date();
    // Respeta buffer desde "ahora"
    const earliestAllowedUtc = addMinutes(nowUtc, Math.max(bufferMin ?? 0, 0));

    for (let i = 0; i < daysHorizon; i++) {
        const dayLocal = addDays(baseLocalDate, i);

        // Ventana UTC del día (para filtrar citas)
        const dayStartLocal = startOfDay(dayLocal);
        const dayEndLocal = endOfDay(dayLocal);
        const dayStartUtc = zonedTimeToUtc(dayStartLocal, tz);
        const dayEndUtc = zonedTimeToUtc(dayEndLocal, tz);

        const windowsUtc = await getOpenWindowsForDate({
            empresaId,
            dateLocal: dayLocal,
            tz,
        });

        if (!windowsUtc.length) {
            results.push({
                dateISO: tzFormat(dayLocal, "yyyy-MM-dd", { timeZone: tz }),
                slots: [],
            });
            continue;
        }

        const busyUtc = await getBusyIntervalsUTC({
            empresaId,
            dayStartUtc,
            dayEndUtc,
        });

        const slots = carveSlotsFromWindows({
            windowsUtc,
            busyUtc,
            durationMin,
            granMin: granularityMin,
            earliestAllowedUtc,
            maxPerDay,
        });

        results.push({
            dateISO: tzFormat(dayLocal, "yyyy-MM-dd", { timeZone: tz }),
            slots,
        });
    }

    return results;
}

export async function createAppointmentSafe(args: {
    empresaId: number;
    vertical: AppointmentVertical | "custom";
    timezone: string;
    procedureId?: number | null;
    serviceName: string;
    customerName: string;
    customerPhone: string;
    startISO: string; // UTC ISO
    endISO: string; // UTC ISO
    notes?: string;
    source?: "ai" | "web" | "manual";
}) {
    const {
        empresaId,
        procedureId,
        serviceName,
        customerName,
        customerPhone,
        startISO,
        endISO,
        notes,
        source,
    } = args;

    const startAt = new Date(startISO);
    const endAt = new Date(endISO);

    // Chequeo de solapamiento atómico
    const blocking: AppointmentStatus[] = ["pending", "confirmed", "rescheduled"];
    const overlap = await prisma.appointment.findFirst({
        where: {
            empresaId,
            deletedAt: null,
            status: { in: blocking },
            OR: [{ startAt: { lt: endAt }, endAt: { gt: startAt } }],
        },
        select: { id: true },
    });

    if (overlap) {
        throw new Error("OVERLAP");
    }

    const created = await prisma.appointment.create({
        data: {
            empresaId,
            procedureId: procedureId ?? undefined,
            serviceName,
            customerName,
            customerPhone,
            startAt,
            endAt,
            status: "confirmed", // o "pending" si prefieres doble confirmación
            source: source === "ai" ? "ai" : "client",
            notas: notes ?? null,
            timezone: "America/Bogota", // puedes tomarlo dinámico si quieres reflejarlo
        },
    });

    return { ok: true, id: created.id };
}

/* ================== Utilidades de flujo (existentes) ================== */

function nowPlusMin(min: number) {
    return new Date(Date.now() + min * 60_000).toISOString();
}

function labelSlotsForTZ(slots: Slot[], tz: string) {
    return slots.map((s) => {
        const d = utcToZonedTime(new Date(s.startISO), tz);
        const label = d.toLocaleString("es-CO", {
            weekday: "long",
            day: "2-digit",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
            timeZone: tz,
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
        // @ts-ignore - u flag para unicode
        .replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}

/* ================== Orquestador de turno (sin cambios fuertes) ================== */

export async function handleSchedulingTurn(params: {
    text: string;
    state: StateShape;
    ctx: SchedulingCtx;
    serviceInContext?:
    | { id: number; name: string; durationMin?: number | null }
    | null;
    intent: "price" | "schedule" | "reschedule" | "cancel" | "info" | "other";
}): Promise<{
    handled: boolean;
    reply?: string;
    patch?: Partial<StateShape>;
    createOk?: boolean;
    needsHuman?: boolean;
    failMessage?: string;
}> {
    const { text, state, ctx, serviceInContext, intent } = params;
    const { kb, empresaId, granularityMin, daysHorizon, maxSlots } = ctx;
    const tz = kb.timezone;

    const inDraft =
        state.draft?.stage === "offer" || state.draft?.stage === "confirm";
    const isConfirm = /^confirmo\b/i.test(text.trim());
    const isCapture =
        NAME_RE.test(text) ||
        PHONE_RE.test(text.replace(/[^\d+]/g, " ")) ||
        HHMM_RE.test(text);

    if (!(intent === "schedule" || inDraft || isConfirm || isCapture)) {
        return { handled: false };
    }

    if (intent === "schedule" && !serviceInContext && !state.draft?.procedureId) {
        const ejemplos = kb.procedures
            .filter((p) => p)
            .slice(0, 3)
            .map((s) => s.name)
            .join(", ");
        return {
            handled: true,
            reply: `Para ver horarios necesito el procedimiento. ¿Cuál deseas? (Ej.: ${ejemplos})`,
            patch: { lastIntent: "schedule" },
        };
    }

    const svc =
        serviceInContext ||
        kb.procedures.find((p) => p.id === (state.draft?.procedureId ?? 0)) ||
        null;
    const duration = (svc?.durationMin ??
        kb.defaultServiceDurationMin ??
        60) as number;

    // 1) Ofrecer slots (2–5 cercanos, limitados por maxSlots)
    if (intent === "schedule" && svc) {
        const todayLocalISO = tzFormat(
            utcToZonedTime(params.ctx.now ?? new Date(), tz),
            "yyyy-MM-dd",
            { timeZone: tz }
        );

        const byDay = await getNextAvailableSlots(
            {
                empresaId,
                timezone: tz,
                vertical: kb.vertical,
                bufferMin: kb.bufferMin,
                granularityMin,
            },
            todayLocalISO,
            duration,
            daysHorizon,
            maxSlots
        );

        const flat = byDay.flatMap((d) => d.slots).slice(0, maxSlots);
        if (!flat.length) {
            return {
                handled: true,
                reply:
                    "No veo cupos cercanos por ahora. ¿Quieres que te contacte un asesor para coordinar?",
                patch: { lastIntent: "schedule" },
            };
        }

        const labeled = labelSlotsForTZ(flat, tz);
        // Ofrecer sólo 3 por UX
        const shortlist = labeled.slice(0, Math.min(3, labeled.length));
        const bullets = shortlist.map((l) => `• ${l.label}`).join("\n");
        const reply =
            `Disponibilidad cercana para *${svc.name}*:\n${bullets}\n\n` +
            `Elige una y dime tu *nombre* y *teléfono* para reservar.\n` +
            `Si prefieres otra fecha, dime el día (ej.: “jueves” o “20/10”).`;

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

    // 2) Captura -> confirmación
    if (state.draft?.stage === "offer" && (isCapture || svc)) {
        const currentCache = state.slotsCache;
        let chosen = currentCache?.items?.[0];

        const hhmm = HHMM_RE.exec(text);
        if (hhmm && currentCache?.items?.length) {
            const hh = `${hhmm[1].padStart(2, "0")}:${hhmm[2]}`;
            const hit = currentCache.items.find(
                (s) =>
                    utcToZonedTime(new Date(s.startISO), tz)
                        .toISOString()
                        .slice(11, 16) === hh
            );
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

        const local = nextDraft.whenISO
            ? utcToZonedTime(new Date(nextDraft.whenISO), tz)
            : null;
        const fecha = local
            ? local.toLocaleDateString("es-CO", {
                weekday: "long",
                year: "numeric",
                month: "long",
                day: "2-digit",
                timeZone: tz,
            })
            : "fecha por confirmar";
        const hora = local
            ? local.toLocaleTimeString("es-CO", {
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
                timeZone: tz,
            })
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

    // 3) Confirmación -> crear cita
    if (state.draft?.stage === "confirm" && isConfirm && state.draft.whenISO) {
        try {
            const serviceName =
                state.draft.procedureName ||
                (ctx.kb.procedures.find((p) => p.id === (state.draft?.procedureId ?? 0))
                    ?.name ?? "Procedimiento");
            const endISO = addMinutes(
                new Date(state.draft.whenISO),
                state.draft.durationMin ?? 60
            ).toISOString();

            await createAppointmentSafe({
                empresaId,
                vertical: ctx.kb.vertical,
                timezone: ctx.kb.timezone,
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
                reply:
                    "¡Hecho! Tu cita quedó confirmada ✅. Te enviaremos recordatorio antes de la fecha.",
                patch: { draft: { stage: "idle" } },
            };
        } catch (e) {
            return {
                handled: true,
                createOk: false,
                reply:
                    "Ese horario acaba de ocuparse 😕. ¿Te comparto otras opciones cercanas?",
            };
        }
    }

    return { handled: false };
}
