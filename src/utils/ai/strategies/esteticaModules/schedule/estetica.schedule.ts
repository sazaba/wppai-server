// utils/ai/strategies/esteticaModules/schedule/estetica.schedule.ts
import prisma from "../../../../../lib/prisma";
import {
    addDays,
    addMinutes,
    endOfDay,
    max as dfMax,
    startOfDay,
} from "date-fns";
import {
    format as tzFormat,
    utcToZonedTime,
    zonedTimeToUtc,
} from "date-fns-tz";
import type {
    AppointmentSource,
    AppointmentStatus,
    AppointmentVertical,
    Weekday,
} from "@prisma/client";

/* ============================================================
   Tipos públicos (consumidos por estetica.strategy)
============================================================ */
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
    // reagendamiento
    rescheduleApptId?: number;
};

export type StateShape = {
    draft?: SchedulingDraft;
    lastIntent?: "info" | "price" | "schedule" | "reschedule" | "cancel" | "other";
    lastServiceId?: number | null;
    lastServiceName?: string | null;
    slotsCache?: {
        items: Array<{ startISO: string; endISO: string; label: string }>;
        expiresAt: string;
    };
    lastPhoneSeen?: string | null;
};

export type SchedulingCtx = {
    empresaId: number;
    kb: KBMinimal;
    granularityMin: number;
    daysHorizon: number;
    maxSlots: number;
    now?: Date;
    toCOP?: (v?: number | null) => string | null;
};

export type SchedulingResult = {
    handled: boolean;
    reply?: string;
    patch?: Partial<StateShape>;
    createOk?: boolean;
    needsHuman?: boolean;
    failMessage?: string;
};

/* ============================================================
   Utils de TZ y tiempo
============================================================ */
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
    // 0 dom ... 6 sáb
    const dow = dLocal.getDay();
    return (["sun", "mon", "tue", "wed", "thu", "fri", "sat"][dow] ||
        "mon") as Weekday;
}

function hhmmToUtc(dayLocalISO: string, hhmm: string, tz: string): Date {
    const [h, m] = hhmm.split(":").map((v) => parseInt(v, 10));
    const localBase = utcToZonedTime(zonedTimeToUtc(dayLocalISO, tz), tz);
    localBase.setHours(h, m, 0, 0);
    return zonedTimeToUtc(localBase, tz);
}

function roundUpToGranularity(date: Date, granMin: number): Date {
    const step = granMin * 60_000;
    return new Date(Math.ceil(date.getTime() / step) * step);
}

const iso = (d: Date) => new Date(d.getTime()).toISOString();
const intervalsOverlap = (aS: Date, aE: Date, bS: Date, bE: Date) =>
    aS < bE && bS < aE;

function formatAmPm(d: Date) {
    let h = d.getHours();
    const m = d.getMinutes();
    const ampm = h >= 12 ? "pm" : "am";
    h = h % 12;
    h = h ? h : 12;
    const mm = m.toString().padStart(2, "0");
    return `${h}:${mm} ${ampm}`;
}

function nowPlusMin(min: number) {
    return new Date(Date.now() + min * 60_000).toISOString();
}

/* ============================================================
   Construcción de ventanas (AppointmentHour + Exception)
============================================================ */
async function getOpenWindowsForDate(params: {
    empresaId: number;
    dateLocal: Date;
    tz: string;
}) {
    const { empresaId, dateLocal, tz } = params;
    const weekday = getWeekdayFromDate(dateLocal);

    const base = await prisma.appointmentHour.findUnique({
        where: { empresaId_day: { empresaId, day: weekday } },
    });

    // excepción del día (en rango 00:00–23:59 local)
    const dayISO = tzFormat(dateLocal, "yyyy-MM-dd'T'00:00:00", { timeZone: tz });
    const startLocal = utcToZonedTime(zonedTimeToUtc(dayISO, tz), tz);
    const endLocal = utcToZonedTime(
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
                gte: zonedTimeToUtc(startLocal, tz),
                lte: zonedTimeToUtc(endLocal, tz),
            },
        },
    });

    const open =
        exception?.isOpen === false
            ? []
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

    return open.map(({ start, end }) => {
        const s = hhmmToUtc(dayISO, start, tz);
        const e = hhmmToUtc(dayISO, end, tz);
        return { startUtc: s, endUtc: e };
    });
}

/* ============================================================
   Ocupados del día (Appointment en estados que bloquean)
============================================================ */
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
            OR: [{ startAt: { lt: dayEndUtc }, endAt: { gt: dayStartUtc } }],
        },
        select: { startAt: true, endAt: true },
    });
    return appts.map((a) => ({ startUtc: a.startAt, endUtc: a.endAt }));
}

/* ============================================================
   Generación de slots a partir de ventanas y ocupados
============================================================ */
function carveSlotsFromWindows(params: {
    windowsUtc: Array<{ startUtc: Date; endUtc: Date }>;
    busyUtc: Array<{ startUtc: Date; endUtc: Date }>;
    durationMin: number;
    granMin: number;
    earliestAllowedUtc: Date;
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
        let cursor = roundUpToGranularity(
            dfMax([w.startUtc, earliestAllowedUtc]),
            granMin
        );
        while (true) {
            const end = addMinutes(cursor, durationMin);
            if (end > w.endUtc) break;

            const overlaps = busyUtc.some((b) =>
                intervalsOverlap(cursor, end, b.startUtc, b.endUtc)
            );
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
   API pública: slots disponibles
============================================================ */
export async function getNextAvailableSlots(
    env: {
        empresaId: number;
        timezone: string;
        vertical: AppointmentVertical | "custom";
        bufferMin?: number | null;
        granularityMin: number;
    },
    fromDateISO: string,
    durationMin: number,
    daysHorizon: number,
    maxPerDay: number
): Promise<SlotsByDay[]> {
    const { empresaId, timezone: tz, bufferMin, granularityMin } = env;

    const baseLocalDate = utcToZonedTime(new Date(fromDateISO + "T00:00:00Z"), tz);
    const earliestAllowedUtc = addMinutes(new Date(), Math.max(bufferMin ?? 0, 0));

    const results: SlotsByDay[] = [];
    for (let i = 0; i < daysHorizon; i++) {
        const dayLocal = addDays(baseLocalDate, i);
        const dayStartUtc = zonedTimeToUtc(startOfDay(dayLocal), tz);
        const dayEndUtc = zonedTimeToUtc(endOfDay(dayLocal), tz);

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

/* ============================================================
   Crear cita segura (directo con Prisma)
============================================================ */
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
    if (overlap) throw new Error("OVERLAP");

    const created = await prisma.appointment.create({
        data: {
            empresaId,
            procedureId: procedureId ?? null,
            serviceName,
            customerName,
            customerPhone,
            startAt,
            endAt,
            status: "confirmed",
            source: (source ?? "ai") as AppointmentSource, // enum correcto
            notas: notes ?? null,
            timezone: args.timezone || "America/Bogota",
            customerDisplayName: customerName,
            serviceDurationMin: Math.round(
                (endAt.getTime() - startAt.getTime()) / 60000
            ),
            locationNameCache: null,
        },
    });

    return { ok: true, id: created.id };
}

/* ============================================================
   Helpers de UX (labels y parsing de hora)
============================================================ */
function labelSlotsForTZ(slots: Slot[], tz: string) {
    return slots.map((s) => {
        const d = utcToZonedTime(new Date(s.startISO), tz);
        const dia = d.toLocaleDateString("es-CO", {
            weekday: "long",
            day: "2-digit",
            month: "short",
            timeZone: tz,
        });
        const label = `${dia}, ${formatAmPm(d)}`; // ej: lunes, 13 oct, 2:30 pm
        return { startISO: s.startISO, endISO: s.endISO, label };
    });
}

// Capturas
const NAME_RE = /(mi\s+nombre\s+es|soy|me\s+llamo)\s+([a-záéíóúñ\s]{2,60})/i;
// 7–12 dígitos; nos quedamos con los últimos 10 si hay más
const PHONE_ANY_RE = /(\+?57)?\D*?(\d{7,12})\b/;
// 24h
const HHMM_RE = /\b([01]?\d|2[0-3]):([0-5]\d)\b/;
// 12h con am/pm (2 pm, 2:30 pm)
const AMPM_RE = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i;

function properCase(v?: string) {
    return (v || "")
        .trim()
        .replace(/\s+/g, " ")
        // @ts-ignore: Unicode property escapes
        .replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}

function normalizePhone(raw?: string): string | undefined {
    if (!raw) return undefined;
    const digits = raw.replace(/\D+/g, "");
    if (!digits) return undefined;
    return digits.length >= 10 ? digits.slice(-10) : digits;
}

/** Extrae de texto una hora local en minutos desde 00:00 (acepta 14:30 o 2:30 pm). */
function extractLocalMinutesFromText(text: string): number | null {
    const m12 = AMPM_RE.exec(text);
    if (m12) {
        let h = parseInt(m12[1], 10);
        const minutes = m12[2] ? parseInt(m12[2], 10) : 0;
        const ampm = m12[3].toLowerCase();
        if (h === 12) h = 0;
        if (ampm === "pm") h += 12;
        return h * 60 + minutes;
    }
    const m24 = HHMM_RE.exec(text);
    if (m24) {
        const h = parseInt(m24[1], 10);
        const minutes = parseInt(m24[2], 10);
        return h * 60 + minutes;
    }
    return null;
}

/** Busca en slotsCache un slot cuyo inicio (hora local) coincida con los minutos dados. */
// ✅ Genérico para que respete el tipo de los elementos (con o sin label)
function findSlotByLocalMinutes<T extends { startISO: string; endISO: string }>(
    items: T[],
    tz: string,
    targetMin: number
): T | undefined {
    return items.find((s) => {
        const d = utcToZonedTime(new Date(s.startISO), tz);
        const mm = d.getHours() * 60 + d.getMinutes();
        return mm === targetMin;
    });
}

async function findUpcomingApptByPhone(empresaId: number, phone: string) {
    const blocking: AppointmentStatus[] = ["pending", "confirmed", "rescheduled"];
    return prisma.appointment.findFirst({
        where: {
            empresaId,
            customerPhone: { contains: phone },
            status: { in: blocking },
            startAt: { gte: new Date() },
        },
        orderBy: { startAt: "asc" },
    });
}

/* ============================================================
   Orquestador de turno (schedule + cancel + reschedule)
============================================================ */
export async function handleSchedulingTurn(params: {
    text: string;
    state: StateShape;
    ctx: SchedulingCtx;
    serviceInContext?:
    | { id: number; name: string; durationMin?: number | null }
    | null;
    intent: "price" | "schedule" | "reschedule" | "cancel" | "info" | "other";
}): Promise<SchedulingResult> {
    const { text, state, ctx, serviceInContext, intent } = params;
    const { kb, empresaId, granularityMin, daysHorizon, maxSlots } = ctx;
    const tz = kb.timezone;

    // señales de intención
    const wantsCancel = /\b(cancelar|anular|no puedo ir|cancela|cancelemos)\b/i.test(
        text
    );
    const wantsReschedule =
        /\b(reagendar|reprogramar|cambiar\s+hora|otro\s+horario|mover\s+cita)\b/i.test(
            text
        );

    // Capturas de nombre/teléfono
    const nameMatch = NAME_RE.exec(text);
    const phoneMatch = PHONE_ANY_RE.exec(text);
    const capturedName = nameMatch ? properCase(nameMatch[2]) : undefined;
    const capturedPhone = normalizePhone(phoneMatch?.[2]);

    // memoria corta de teléfono
    const basePatch: Partial<StateShape> = {};
    if (capturedPhone) basePatch.lastPhoneSeen = capturedPhone;

    const inDraft =
        state.draft?.stage === "offer" || state.draft?.stage === "confirm";
    const isConfirm = /^confirmo\b/i.test(text.trim());

    // === Cancelación por teléfono
    if (intent === "cancel" || wantsCancel) {
        const phone = state.draft?.phone || capturedPhone || state.lastPhoneSeen;
        if (!phone) {
            return {
                handled: true,
                reply:
                    "Para ubicar tu cita necesito tu *teléfono*. Escríbelo (solo números).",
                patch: basePatch,
            };
        }
        const appt = await findUpcomingApptByPhone(empresaId, phone);
        if (!appt) {
            return {
                handled: true,
                reply:
                    "No encuentro una cita próxima con ese teléfono. ¿Podrías verificar el número?",
                patch: basePatch,
            };
        }
        await prisma.appointment.update({
            where: { id: appt.id },
            data: { status: "cancelled" },
        });
        return {
            handled: true,
            reply:
                "Listo, tu cita fue *cancelada*. Si deseas, puedo ofrecerte nuevos horarios para agendar nuevamente.",
            patch: { draft: { stage: "idle" }, lastIntent: "cancel", ...basePatch },
        };
    }

    // === Reagendar por teléfono
    if (intent === "reschedule" || wantsReschedule) {
        const phone = state.draft?.phone || capturedPhone || state.lastPhoneSeen;
        if (!phone) {
            return {
                handled: true,
                reply:
                    "Para ubicar tu cita necesito tu *teléfono*. Escríbelo (solo números).",
                patch: basePatch,
            };
        }
        const appt = await findUpcomingApptByPhone(empresaId, phone);
        if (!appt) {
            return {
                handled: true,
                reply:
                    "No encuentro una cita próxima con ese teléfono. ¿Podrías verificar el número?",
                patch: basePatch,
            };
        }

        const duration = Math.max(
            15,
            Math.round((appt.endAt.getTime() - appt.startAt.getTime()) / 60000)
        );

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
                    "No veo cupos cercanos para reagendar. ¿Quieres que te contacte un asesor?",
                patch: basePatch,
            };
        }

        const labeled = labelSlotsForTZ(flat, tz).slice(0, Math.min(3, flat.length));
        const bullets = labeled.map((l) => `• ${l.label}`).join("\n");

        return {
            handled: true,
            reply:
                `Puedo mover tu cita. Horarios cercanos:\n${bullets}\n\n` +
                `Elige uno y escribe la hora (ej.: *2:30 pm* o *14:30*).`,
            patch: {
                lastIntent: "reschedule",
                draft: {
                    stage: "offer",
                    name: appt.customerName ?? undefined,
                    phone,
                    procedureName: appt.serviceName,
                    durationMin: duration,
                    rescheduleApptId: appt.id,
                },
                slotsCache: { items: labeled, expiresAt: nowPlusMin(10) },
                ...basePatch,
            },
        };
    }

    // === Si no es agenda y no estamos en captura/confirmación → no manejado
    const isCapture =
        Boolean(capturedName || capturedPhone) ||
        HHMM_RE.test(text) ||
        AMPM_RE.test(text);
    if (!(intent === "schedule" || inDraft || isConfirm || isCapture)) {
        return { handled: false, patch: basePatch };
    }

    // === Si piden horarios pero no hay servicio → pedirlo
    if (intent === "schedule" && !serviceInContext && !state.draft?.procedureId) {
        const ejemplos = ctx.kb.procedures.slice(0, 3).map((s) => s.name).join(", ");
        return {
            handled: true,
            reply: `Para ver horarios necesito el procedimiento. ¿Cuál deseas? (Ej.: ${ejemplos})`,
            patch: { lastIntent: "schedule", ...basePatch },
        };
    }

    // Servicio y duración
    const svc =
        serviceInContext ||
        ctx.kb.procedures.find((p) => p.id === (state.draft?.procedureId ?? 0)) ||
        null;
    const duration = (svc?.durationMin ??
        ctx.kb.defaultServiceDurationMin ??
        60) as number;

    // === Ofrecer slots (inicio de flujo)
    if (intent === "schedule" && svc) {
        const todayISO = tzFormat(
            utcToZonedTime(params.ctx.now ?? new Date(), tz),
            "yyyy-MM-dd",
            { timeZone: tz }
        );

        const byDay = await getNextAvailableSlots(
            {
                empresaId,
                timezone: tz,
                vertical: ctx.kb.vertical,
                bufferMin: ctx.kb.bufferMin,
                granularityMin,
            },
            todayISO,
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
                patch: { lastIntent: "schedule", ...basePatch },
            };
        }

        const labeled = labelSlotsForTZ(flat, tz).slice(0, Math.min(3, flat.length));
        const bullets = labeled.map((l) => `• ${l.label}`).join("\n");

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
                ...basePatch,
            },
        };
    }

    // === Captura de datos → Confirmación (sirve para schedule y reschedule)
    if (state.draft?.stage === "offer" && (isCapture || svc)) {
        const currentCache = state.slotsCache;

        // Intento de match con hora local (admite 2:30 pm o 14:30)
        let chosen = currentCache?.items?.[0];
        const wantedMin = extractLocalMinutesFromText(text);
        if (wantedMin != null && currentCache?.items?.length) {
            const hit = findSlotByLocalMinutes(currentCache.items, tz, wantedMin);
            if (hit) chosen = hit;
        }

        const nextDraft: SchedulingDraft = {
            ...(state.draft ?? {}),
            name: state.draft?.name ?? capturedName ?? undefined,
            phone: state.draft?.phone ?? (capturedPhone || state.lastPhoneSeen) ?? undefined,
            whenISO: state.draft?.whenISO ?? chosen?.startISO ?? undefined,
            stage: "confirm",
            procedureName: state.draft?.procedureName ?? (svc ? svc.name : undefined),
            procedureId: state.draft?.procedureId ?? (svc ? svc.id : undefined),
            durationMin: state.draft?.durationMin ?? duration,
            rescheduleApptId: state.draft?.rescheduleApptId,
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
        const hora = local ? formatAmPm(local) : "hora por confirmar";

        const resumen =
            `¿Confirmas la ${nextDraft.rescheduleApptId ? "reprogramación" : "reserva"}?\n` +
            `• Procedimiento: ${nextDraft.procedureName ?? "—"}\n` +
            `• Fecha/Hora: ${fecha} ${local ? `a las ${hora}` : ""}\n` +
            `• Nombre: ${nextDraft.name ?? "—"}\n` +
            `• Teléfono: ${nextDraft.phone ?? "—"}\n\n` +
            `Responde *"confirmo"* y ${nextDraft.rescheduleApptId ? "muevo" : "creo"} la cita.`;

        return { handled: true, reply: resumen, patch: { draft: nextDraft, ...basePatch } };
    }

    // === Confirmación final → crear o actualizar
    if (state.draft?.stage === "confirm" && isConfirm && state.draft.whenISO) {
        try {
            const endISO = addMinutes(
                new Date(state.draft.whenISO),
                state.draft.durationMin ?? 60
            ).toISOString();

            // Reagendar
            if (state.draft.rescheduleApptId) {
                await prisma.appointment.update({
                    where: { id: state.draft.rescheduleApptId },
                    data: {
                        startAt: new Date(state.draft.whenISO),
                        endAt: new Date(endISO),
                        status: "confirmed",
                    },
                });
                return {
                    handled: true,
                    createOk: true,
                    reply:
                        "¡Hecho! Tu cita fue reprogramada ✅. Te enviaremos recordatorio antes de la fecha.",
                    patch: { draft: { stage: "idle" } },
                };
            }

            // Crear nueva
            const serviceName =
                state.draft.procedureName ||
                (ctx.kb.procedures.find((p) => p.id === (state.draft?.procedureId ?? 0))
                    ?.name ?? "Procedimiento");

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
        } catch (_e) {
            return {
                handled: true,
                createOk: false,
                reply:
                    "Ese horario acaba de ocuparse 😕. ¿Te comparto otras opciones cercanas?",
            };
        }
    }

    // Nada más que hacer
    return { handled: false, patch: basePatch };
}
