// utils/ai/strategies/esteticaModules/schedule/estetica.schedule.ts
import prisma from "../../../../../lib/prisma";
import {
    addDays,
    addMinutes,
    endOfDay,
    max as dfMax,
    startOfDay,
    isAfter,
    isSameDay,
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
export type LabeledSlot = { startISO: string; endISO: string; label: string };
export type SlotsByDay = { dateISO: string; slots: Slot[] };

export type KBMinimal = {
    vertical: AppointmentVertical | "custom";
    timezone: string;
    bufferMin?: number | null;
    defaultServiceDurationMin?: number | null;
    procedures: Array<{ id: number; name: string; durationMin?: number | null }>;
};

export type DraftStage = "idle" | "offer" | "confirm";
export type SchedulingDraft = {
    name?: string;
    phone?: string;
    procedureId?: number;
    procedureName?: string;
    whenISO?: string; // UTC ISO del inicio
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
    slotsCache?: { items: LabeledSlot[]; expiresAt: string };
    lastPhoneSeen?: string | null;
};

export type SchedulingCtx = {
    empresaId: number;
    kb: KBMinimal;
    granularityMin: number;
    daysHorizon: number;
    maxSlots: number;
    now?: Date; // Ideal: fijar en el orquestador y pasarlo siempre para estabilidad
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
   Constantes y utils de tiempo/TZ
============================================================ */
export type DayPeriod = "morning" | "afternoon" | "evening";

const DAY_WORDS: Record<string, Weekday> = {
    domingo: "sun",
    lunes: "mon",
    martes: "tue",
    miercoles: "wed",
    miércoles: "wed",
    jueves: "thu",
    viernes: "fri",
    sabado: "sat",
    sábado: "sat",
};

const MONTHS: Record<string, number> = {
    enero: 0,
    febrero: 1,
    marzo: 2,
    abril: 3,
    mayo: 4,
    junio: 5,
    julio: 6,
    agosto: 7,
    septiembre: 8,
    setiembre: 8,
    octubre: 9,
    noviembre: 10,
    diciembre: 11,
};

function getWeekdayFromDate(dLocal: Date): Weekday {
    const dow = dLocal.getDay(); // 0..6
    return (["sun", "mon", "tue", "wed", "thu", "fri", "sat"][dow] ||
        "mon") as Weekday;
}

function periodToLocalRange(
    period: DayPeriod
): { from: number; to: number } {
    if (period === "morning") return { from: 6 * 60, to: 12 * 60 };
    if (period === "afternoon") return { from: 12 * 60, to: 18 * 60 };
    return { from: 18 * 60, to: 21 * 60 };
}

export function parseDayPeriod(text: string): DayPeriod | null {
    const t = text.toLowerCase();
    if (/\b(mañana|manana|temprano|a primera hora)\b/.test(t)) return "morning";
    if (/\b(tarde|afternoon)\b/.test(t)) return "afternoon";
    if (/\b(noche|evening|tarde\s*noche)\b/.test(t)) return "evening";
    return null;
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

function formatAmPmLocal(d: Date) {
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

function cacheIsValid(expiresAt?: string | null) {
    if (!expiresAt) return false;
    return Date.now() < Date.parse(expiresAt);
}

function localDayISOFromSlot(slotISO: string, tz: string) {
    const d = utcToZonedTime(new Date(slotISO), tz);
    return tzFormat(d, "yyyy-MM-dd", { timeZone: tz });
}

/* ============================================================
   Ventanas (AppointmentHour + Exception)
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

    // excepción del día (00:00–23:59 local)
    const dayISO = tzFormat(dateLocal, "yyyy-MM-dd'T'00:00:00", {
        timeZone: tz,
    });
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
            : ([
                {
                    start: exception?.start1 ?? base?.start1 ?? null,
                    end: exception?.end1 ?? base?.end1 ?? null,
                },
                {
                    start: exception?.start2 ?? base?.start2 ?? null,
                    end: exception?.end2 ?? base?.end2 ?? null,
                },
            ].filter((w) => w.start && w.end) as Array<{ start: string; end: string }>);

    return open.map(({ start, end }) => {
        const s = hhmmToUtc(dayISO, start, tz);
        const e = hhmmToUtc(dayISO, end, tz);
        return { startUtc: s, endUtc: e };
    });
}

/* ============================================================
   Ocupados (appointments que bloquean)
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
   Generación de slots con filtro de franja
============================================================ */
function carveSlotsFromWindows(params: {
    windowsUtc: Array<{ startUtc: Date; endUtc: Date }>;
    busyUtc: Array<{ startUtc: Date; endUtc: Date }>;
    durationMin: number;
    granMin: number;
    earliestAllowedUtc: Date;
    maxPerDay: number;
    filter?: { fromLocalMin?: number; toLocalMin?: number; tz?: string };
}): Slot[] {
    const {
        windowsUtc,
        busyUtc,
        durationMin,
        granMin,
        earliestAllowedUtc,
        maxPerDay,
        filter,
    } = params;

    const withinPeriod = (d: Date) => {
        if (!filter?.fromLocalMin && !filter?.toLocalMin) return true;
        if (!filter?.tz) return true;
        const local = utcToZonedTime(d, filter.tz);
        const mm = local.getHours() * 60 + local.getMinutes();
        if (filter.fromLocalMin != null && mm < filter.fromLocalMin) return false;
        if (filter.toLocalMin != null && mm >= filter.toLocalMin) return false;
        return true;
    };

    const slots: Slot[] = [];
    for (const w of windowsUtc) {
        let cursor = roundUpToGranularity(
            dfMax([w.startUtc, earliestAllowedUtc]),
            granMin
        );
        while (true) {
            const end = addMinutes(cursor, durationMin);
            if (end > w.endUtc) break;
            if (!withinPeriod(cursor)) {
                cursor = addMinutes(cursor, granMin);
                if (cursor >= w.endUtc) break;
                continue;
            }
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
   NL → fecha/franja en TZ negocio
   Casos: "miércoles", "jueves de la próxima semana",
   "próxima disponible", "15 de octubre", "15/10", "jueves 15"
============================================================ */
type NaturalWhen =
    | { kind: "nearest"; period: DayPeriod | null }
    | {
        kind: "weekday";
        weekday: Weekday;
        which: "this_or_next" | "next_week";
        period: DayPeriod | null;
    }
    | { kind: "date"; localDateISO: string; period: DayPeriod | null };

export function interpretNaturalWhen(
    text: string,
    tz: string,
    now = new Date()
): NaturalWhen | null {
    const t = text.trim().toLowerCase();

    // "jueves de la próxima semana / semana que viene / la otra semana"
    const nextWeekWd = new RegExp(
        `(lunes|martes|mi[eé]rcoles|miercoles|jueves|viernes|s[áa]bado|sabado|domingo).{0,30}(pr[oó]xima\\s+semana|semana\\s+que\\s+viene|otra\\s+semana)`,
        "i"
    ).exec(t);
    if (nextWeekWd) {
        const wd =
            DAY_WORDS[
            nextWeekWd[1]
                .normalize("NFD")
                .replace(/\p{Diacritic}/gu, "")
                .toLowerCase()
            ];
        return {
            kind: "weekday",
            weekday: wd,
            which: "next_week",
            period: parseDayPeriod(t),
        };
    }

    // "miércoles", "este miércoles", "próximo miércoles"
    const wdWord = Object.keys(DAY_WORDS).find((w) =>
        new RegExp(`\\b${w}\\b`, "i").test(t)
    );
    if (wdWord) {
        const wd = DAY_WORDS[wdWord];
        const saysNext = /\bpr[oó]ximo\b/.test(t);
        return {
            kind: "weekday",
            weekday: wd,
            which: saysNext ? "next_week" : "this_or_next",
            period: parseDayPeriod(t),
        };
    }

    // “la más próxima / próxima disponible / lo más pronto” (NO confundir con “próxima semana”)
    if (
        /\b(la\s+m[aá]s\s+pr[oó]xima|m[aá]s\s+cercana|inmediata|lo\s+m[aá]s\s+pronto|pr[oó]xima\s+disponible)\b/.test(
            t
        )
    ) {
        return { kind: "nearest", period: parseDayPeriod(t) };
    }

    // "mañana" / "pasado mañana" / "hoy"
    if (/\bpasado\s*ma[ñn]ana\b/.test(t)) {
        const d = addDays(utcToZonedTime(now, tz), 2);
        return {
            kind: "date",
            localDateISO: tzFormat(d, "yyyy-MM-dd", { timeZone: tz }),
            period: parseDayPeriod(t),
        };
    }
    if (/\bma[ñn]ana\b/.test(t)) {
        const d = addDays(utcToZonedTime(now, tz), 1);
        return {
            kind: "date",
            localDateISO: tzFormat(d, "yyyy-MM-dd", { timeZone: tz }),
            period: parseDayPeriod(t),
        };
    }
    if (/\bhoy\b/.test(t)) {
        const d = utcToZonedTime(now, tz);
        return {
            kind: "date",
            localDateISO: tzFormat(d, "yyyy-MM-dd", { timeZone: tz }),
            period: parseDayPeriod(t),
        };
    }

    // Fechas explícitas: "15/10", "15-10", "15 de octubre"
    const dm =
        /(\b\d{1,2})\s*(?:\/|\-|de\s+)?\s*(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre|\d{1,2})/i.exec(
            t
        );
    if (dm) {
        const day = parseInt(dm[1], 10);
        const monthToken = dm[2].toLowerCase();
        const baseLocal = utcToZonedTime(now, tz);
        const year = baseLocal.getFullYear();
        const month = /\d{1,2}/.test(monthToken)
            ? Math.max(0, Math.min(11, parseInt(monthToken, 10) - 1))
            : MONTHS[monthToken];
        const candidate = new Date(year, month, day, 0, 0, 0, 0);
        const localCandidate = utcToZonedTime(zonedTimeToUtc(candidate, tz), tz);
        const finalLocal =
            isAfter(localCandidate, baseLocal) || isSameDay(localCandidate, baseLocal)
                ? localCandidate
                : new Date(year + 1, month, day, 0, 0, 0, 0);
        return {
            kind: "date",
            localDateISO: tzFormat(finalLocal, "yyyy-MM-dd", { timeZone: tz }),
            period: parseDayPeriod(t),
        };
    }

    // Día de semana + día del mes: "jueves 15", "miércoles 3 de noviembre"
    const wdDm =
        /(lunes|martes|mi[eé]rcoles|miercoles|jueves|viernes|s[áa]bado|sabado|domingo)\s+(\d{1,2})(?:\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre))?/i.exec(
            t
        );
    if (wdDm) {
        const wd =
            DAY_WORDS[
            wdDm[1].normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase()
            ];
        const day = parseInt(wdDm[2], 10);
        const baseLocal = utcToZonedTime(now, tz);
        const year = baseLocal.getFullYear();
        const month = wdDm[3] ? MONTHS[wdDm[3].toLowerCase()] : baseLocal.getMonth();
        let candidate = new Date(year, month, day, 0, 0, 0, 0);
        const localCandidate = utcToZonedTime(zonedTimeToUtc(candidate, tz), tz);
        if (!isAfter(localCandidate, baseLocal) && !isSameDay(localCandidate, baseLocal)) {
            const next = new Date(year, month + 1, day, 0, 0, 0, 0);
            candidate = next;
        }
        return {
            kind: "date",
            localDateISO: tzFormat(candidate, "yyyy-MM-dd", { timeZone: tz }),
            period: parseDayPeriod(t),
        };
    }

    return null;
}

/* ============================================================
   API pública: slots disponibles (con filtro por franja)
============================================================ */
export async function getNextAvailableSlots(
    env: {
        empresaId: number;
        timezone: string;
        vertical: AppointmentVertical | "custom";
        bufferMin?: number | null;
        granularityMin: number;
    },
    fromLocalDayISO: string, // YYYY-MM-DD en TZ negocio (pivote)
    durationMin: number,
    daysHorizon: number,
    maxPerDay: number,
    period?: DayPeriod | null
): Promise<SlotsByDay[]> {
    const { empresaId, timezone: tz, bufferMin, granularityMin } = env;

    const baseLocalDate = utcToZonedTime(
        zonedTimeToUtc(`${fromLocalDayISO}T00:00:00`, tz),
        tz
    );
    const earliestAllowedUtc = addMinutes(new Date(), Math.max(bufferMin ?? 0, 0));

    const periodRange = period ? periodToLocalRange(period) : null;

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
            filter: periodRange
                ? { fromLocalMin: periodRange.from, toLocalMin: periodRange.to, tz }
                : undefined,
        });

        results.push({
            dateISO: tzFormat(dayLocal, "yyyy-MM-dd", { timeZone: tz }),
            slots,
        });
    }

    return results;
}

/* ============================================================
   Crear cita segura (Prisma directo)
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
    source?: "ai" | "web" | "manual" | "client";
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
        timezone,
    } = args;

    const startAt = new Date(startISO);
    const endAt = new Date(endISO);

    // overlap rápido
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

    // fuente segura
    const SOURCE_MAP: Record<string, AppointmentSource> = {
        ai: "client" as AppointmentSource,
        web: "web" as AppointmentSource,
        manual: "manual" as AppointmentSource,
        client: "client" as AppointmentSource,
    };
    const safeSource: AppointmentSource = SOURCE_MAP[source || "client"];

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
            source: safeSource,
            notas: notes ?? null,
            timezone: timezone || "America/Bogota",
            customerDisplayName: customerName,
            serviceDurationMin: Math.max(
                1,
                Math.round((endAt.getTime() - startAt.getTime()) / 60000)
            ),
            locationNameCache: null,
        },
    });
    return { ok: true, id: created.id };
}

/* ============================================================
   UX helpers
============================================================ */
function labelSlotsForTZ(slots: Slot[], tz: string): LabeledSlot[] {
    return slots.map((s) => {
        const d = utcToZonedTime(new Date(s.startISO), tz);
        const dia = d.toLocaleDateString("es-CO", {
            weekday: "long",
            day: "2-digit",
            month: "short",
            timeZone: tz,
        });
        const label = `${dia}, ${formatAmPmLocal(d)}`; // ej: miércoles, 15 oct, 2:30 pm
        return { startISO: s.startISO, endISO: s.endISO, label };
    });
}

const NAME_RE = /(mi\s+nombre\s+es|soy|me\s+llamo)\s+([a-záéíóúñ\s]{2,60})/i;
const PHONE_ANY_RE = /(\+?57)?\D*?(\d{7,12})\b/; // 7–12 dígitos
const HHMM_RE = /\b([01]?\d|2[0-3]):([0-5]\d)\b/; // 24h
const AMPM_RE = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i; // 12h

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
function inPeriodLocal(d: Date, period: DayPeriod): boolean {
    const h = d.getHours();
    if (period === "morning") return h >= 6 && h < 12;
    if (period === "afternoon") return h >= 12 && h < 18;
    return h >= 18 && h <= 21;
}
function findSlotByLocalMinutes<T extends { startISO: string }>(
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

/* ============================================================
   Motor principal – flujo estandarizado
============================================================ */
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

function nextWeekPivot(localNow: Date): Date {
    // lunes de la próxima semana como pivote simple
    const dow = localNow.getDay(); // 0..6
    const daysToNextMonday = ((8 - dow) % 7) || 7;
    return addDays(startOfDay(localNow), daysToNextMonday);
}

export async function handleSchedulingTurn(params: {
    text: string;
    state: StateShape;
    ctx: SchedulingCtx;
    serviceInContext?: {
        id: number;
        name: string;
        durationMin?: number | null;
    } | null;
    intent: "price" | "schedule" | "reschedule" | "cancel" | "info" | "other";
}): Promise<SchedulingResult> {
    const { text, state: stateArg, ctx, serviceInContext, intent } = params;
    const { kb, empresaId, granularityMin, daysHorizon, maxSlots } = ctx;
    const tz = kb.timezone;

    // trabajar sobre copia de estado (y validar expiración de cache)
    const state: StateShape = { ...stateArg };
    if (state.slotsCache && !cacheIsValid(state.slotsCache.expiresAt)) {
        state.slotsCache = undefined;
    }

    // capturas
    const nameMatch = NAME_RE.exec(text);
    const phoneMatch = PHONE_ANY_RE.exec(text);
    const capturedName = nameMatch ? properCase(nameMatch[2]) : undefined;
    const capturedPhone = normalizePhone(phoneMatch?.[2]);

    const basePatch: Partial<StateShape> = {};
    if (capturedPhone) basePatch.lastPhoneSeen = capturedPhone;

    const svc =
        serviceInContext ||
        ctx.kb.procedures.find((p) => p.id === (state.draft?.procedureId ?? 0)) ||
        null;
    const duration = (svc?.durationMin ??
        ctx.kb.defaultServiceDurationMin ??
        60) as number;

    // === Cancelar / Reagendar (compatibilidad básica)
    const wantsCancel = /\b(cancelar|anular|no puedo ir|cancela|cancelemos)\b/i.test(
        text
    );
    if (intent === "cancel" || wantsCancel) {
        const phone = state.draft?.phone || capturedPhone || state.lastPhoneSeen;
        if (!phone)
            return {
                handled: true,
                reply:
                    "Para ubicar tu cita necesito tu *teléfono*. Escríbelo (solo números).",
                patch: basePatch,
            };
        const appt = await findUpcomingApptByPhone(empresaId, phone);
        if (!appt)
            return {
                handled: true,
                reply:
                    "No encuentro una cita próxima con ese teléfono. ¿Podrías verificar el número?",
                patch: basePatch,
            };
        await prisma.appointment.update({
            where: { id: appt.id },
            data: { status: "cancelled" },
        });
        return {
            handled: true,
            reply:
                "Listo, tu cita fue *cancelada*. Si deseas, te muestro nuevos horarios.",
            patch: { draft: { stage: "idle" }, lastIntent: "cancel", ...basePatch },
        };
    }

    // === Paso 1: si la intención es schedule y no hay procedimiento, pedirlo
    if (intent === "schedule" && !svc) {
        return {
            handled: true,
            reply:
                "¿Qué procedimiento deseas agendar? (por ej.: *Limpieza facial*, *Peeling*, *Toxina botulínica*)",
            patch: { lastIntent: "schedule", ...basePatch },
        };
    }

    // === Paso 2: preguntar si tiene un día en mente (si aún no lo dijo)
    const nl = interpretNaturalWhen(text, tz, ctx.now ?? new Date());
    const askedForDay =
        !!nl ||
        /\b(d[ií]a|fecha|hoy|mañana|manana|semana|pr[oó]xima)\b/i.test(text);
    if (intent === "schedule" && svc && !askedForDay && !state.slotsCache?.items?.length) {
        return {
            handled: true,
            reply: `¿Tienes *algún día* en mente para *${svc.name}*? (por ej.: *miércoles en la tarde*, *jueves de la próxima semana*, *mañana*, o *la más próxima disponible*)`,
            patch: {
                lastIntent: "schedule",
                draft: {
                    ...(state.draft ?? {}),
                    procedureId: svc.id,
                    procedureName: svc.name,
                    durationMin: duration,
                    stage: "offer",
                },
                ...basePatch,
            },
        };
    }

    // === Paso 3: generar propuestas según lo que pidió
    const localNow = utcToZonedTime(ctx.now ?? new Date(), tz);

    async function offerFromPivot(
        localPivotISO: string,
        period: DayPeriod | null,
        labelHint?: string
    ): Promise<{
        reply: string;
        labeledAll: LabeledSlot[];
        labeledDisplay: LabeledSlot[];
    }> {
        const byDay = await getNextAvailableSlots(
            {
                empresaId,
                timezone: tz,
                vertical: kb.vertical,
                bufferMin: kb.bufferMin,
                granularityMin,
            },
            localPivotISO,
            duration,
            daysHorizon,
            maxSlots,
            period ?? undefined
        );

        let flat = byDay.flatMap((d) => d.slots);

        // Si se pidió un weekday específico, filtramos a ese día.
        if (nl?.kind === "weekday") {
            flat = flat.filter(
                (s) =>
                    getWeekdayFromDate(utcToZonedTime(new Date(s.startISO), tz)) ===
                    nl.weekday
            );
        }

        // Filtrar por franja si aplica
        const periodAsked = period ?? parseDayPeriod(text);
        if (periodAsked)
            flat = flat.filter((s) =>
                inPeriodLocal(utcToZonedTime(new Date(s.startISO), tz), periodAsked)
            );

        flat = flat.slice(0, maxSlots);

        const labeledAll = labelSlotsForTZ(flat, tz);
        const labeledDisplay = labeledAll.slice(0, Math.min(3, labeledAll.length));

        if (!labeledAll.length) {
            return {
                reply: `No veo cupos cercanos ${labelHint ? `para ${labelHint}` : ""}. ¿Te muestro otras fechas o franja?`,
                labeledAll: [],
                labeledDisplay: [],
            };
        }
        const bullets = labeledDisplay.map((l) => `• ${l.label}`).join("\n");
        const reply =
            `Disponibilidad cercana para *${svc!.name}*${labelHint ? ` (${labelHint})` : ""}:\n${bullets}\n\n` +
            `Elige una y dime tu *nombre* y *teléfono* para reservar.`;
        return { reply, labeledAll, labeledDisplay };
    }

    // Si solo cambian la franja (mañana/tarde/noche), refrescar usando el mismo pivote del cache
    const periodOnly = !nl && !!parseDayPeriod(text);
    if (svc && periodOnly && state.slotsCache?.items?.length) {
        const pivotISO = localDayISOFromSlot(state.slotsCache.items[0].startISO, tz);
        const { reply, labeledAll } = await offerFromPivot(
            pivotISO,
            parseDayPeriod(text),
            "ajuste de franja"
        );
        return {
            handled: true,
            reply,
            patch: {
                lastIntent: "schedule",
                draft: {
                    ...(state.draft ?? {}),
                    procedureId: svc.id,
                    procedureName: svc.name,
                    durationMin: duration,
                    stage: "offer",
                },
                slotsCache: { items: labeledAll, expiresAt: nowPlusMin(10) },
                ...basePatch,
            },
        };
    }

    // === Si el usuario pide explícitamente una nueva ventana (nl) y HAY cache → invalidar y regenerar
    const askedNewRange = Boolean(nl);
    if (svc && askedNewRange && state.slotsCache?.items?.length) {
        let pivotISO = tzFormat(localNow, "yyyy-MM-dd", { timeZone: tz });
        let period = nl?.period ?? null;

        if (nl!.kind === "date") {
            pivotISO = nl!.localDateISO;
        } else if (nl!.kind === "weekday") {
            let pivot = nl!.which === "next_week" ? nextWeekPivot(localNow) : localNow;
            let tries = 0;
            while (getWeekdayFromDate(pivot) !== nl!.weekday && tries < 7) {
                pivot = addDays(pivot, 1);
                tries++;
            }
            pivotISO = tzFormat(pivot, "yyyy-MM-dd", { timeZone: tz });
        }

        const { reply, labeledAll } = await offerFromPivot(
            pivotISO,
            period,
            "ajuste de fecha"
        );
        return {
            handled: true,
            reply,
            patch: {
                lastIntent: "schedule",
                draft: {
                    ...(state.draft ?? {}),
                    procedureId: svc.id,
                    procedureName: svc.name,
                    durationMin: duration,
                    stage: "offer",
                },
                slotsCache: { items: labeledAll, expiresAt: nowPlusMin(10) },
                ...basePatch,
            },
        };
    }

    if (svc && nl) {
        if (nl.kind === "nearest") {
            const pivotISO = tzFormat(localNow, "yyyy-MM-dd", { timeZone: tz });
            const { reply, labeledAll } = await offerFromPivot(
                pivotISO,
                nl.period,
                "la más próxima"
            );
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
                    slotsCache: { items: labeledAll, expiresAt: nowPlusMin(10) },
                    ...basePatch,
                },
            };
        }

        if (nl.kind === "date") {
            const { reply, labeledAll } = await offerFromPivot(
                nl.localDateISO,
                nl.period,
                utcToZonedTime(zonedTimeToUtc(`${nl.localDateISO}T00:00:00`, tz), tz).toLocaleDateString(
                    "es-CO",
                    { weekday: "short", day: "numeric", month: "short", timeZone: tz }
                )
            );
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
                    slotsCache: { items: labeledAll, expiresAt: nowPlusMin(10) },
                    ...basePatch,
                },
            };
        }

        if (nl.kind === "weekday") {
            const todayWd = getWeekdayFromDate(localNow);
            let pivot = localNow;

            if (nl.which === "this_or_next") {
                const want = nl.weekday;
                if (want !== todayWd) {
                    let tries = 0;
                    while (getWeekdayFromDate(pivot) !== want && tries < 7) {
                        pivot = addDays(pivot, 1);
                        tries++;
                    }
                }
            } else {
                // next_week
                pivot = nextWeekPivot(localNow);
                let tries = 0;
                while (getWeekdayFromDate(pivot) !== nl.weekday && tries < 7) {
                    pivot = addDays(pivot, 1);
                    tries++;
                }
            }

            const pivotISO = tzFormat(pivot, "yyyy-MM-dd", { timeZone: tz });
            const label = `${tzFormat(pivot, "eeee", {
                timeZone: tz,
            })}${nl.which === "next_week" ? " (próx. semana)" : ""}${nl.period
                    ? ` – ${nl.period === "morning"
                        ? "mañana"
                        : nl.period === "afternoon"
                            ? "tarde"
                            : "noche"
                    }`
                    : ""
                }`;
            const { reply, labeledAll } = await offerFromPivot(pivotISO, nl.period, label);

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
                    slotsCache: { items: labeledAll, expiresAt: nowPlusMin(10) },
                    ...basePatch,
                },
            };
        }
    }

    // === Paso 4: Captura / cambio de idea → regenerar slotsCache automáticamente
    const isCapture =
        Boolean(capturedName || capturedPhone) ||
        HHMM_RE.test(text) ||
        AMPM_RE.test(text) ||
        /\b(mañana|manana|tarde|noche|lunes|martes|mi[eé]rcoles|miercoles|jueves|viernes|s[áa]bado|sabado|domingo|pr[oó]xima\s+semana|semana\s+que\s+viene|otra\s+semana|hoy)\b/i.test(
            text
        );

    if (svc && isCapture && !state.slotsCache?.items?.length) {
        const plan = nl
            ? nl.kind === "date"
                ? nl.localDateISO
                : tzFormat(localNow, "yyyy-MM-dd", { timeZone: tz })
            : tzFormat(localNow, "yyyy-MM-dd", { timeZone: tz });

        const { reply, labeledAll } = await offerFromPivot(plan, nl?.period ?? null);
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
                slotsCache: { items: labeledAll, expiresAt: nowPlusMin(10) },
                ...basePatch,
            },
        };
    }

    // === Paso 5: Con cache, permitir elegir y auto-confirmar al tener nombre+tel
    if (svc && state.slotsCache?.items?.length) {
        const wantedMin = extractLocalMinutesFromText(text);
        const periodAsked = parseDayPeriod(text);

        let chosen = state.slotsCache.items[0];
        if (wantedMin != null) {
            const hit = findSlotByLocalMinutes(state.slotsCache.items, tz, wantedMin);
            if (hit) chosen = hit;
        } else if (periodAsked) {
            const hit = state.slotsCache.items.find((s) =>
                inPeriodLocal(utcToZonedTime(new Date(s.startISO), tz), periodAsked)
            );
            if (hit) chosen = hit;
        }

        const nextDraft: SchedulingDraft = {
            ...(state.draft ?? {}),
            name: state.draft?.name ?? capturedName ?? undefined,
            phone:
                state.draft?.phone ?? (capturedPhone || state.lastPhoneSeen) ?? undefined,
            whenISO: state.draft?.whenISO ?? chosen?.startISO ?? undefined,
            stage: "confirm",
            procedureName: state.draft?.procedureName ?? svc.name,
            procedureId: state.draft?.procedureId ?? svc.id,
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
        const hora = local ? formatAmPmLocal(local) : "hora por confirmar";

        // Auto-insert
        const hasAll = Boolean(nextDraft.whenISO && nextDraft.name && nextDraft.phone);
        if (hasAll) {
            try {
                const endISO = addMinutes(
                    new Date(nextDraft.whenISO!),
                    nextDraft.durationMin ?? 60
                ).toISOString();

                if (nextDraft.rescheduleApptId) {
                    await prisma.appointment.update({
                        where: { id: nextDraft.rescheduleApptId },
                        data: {
                            startAt: new Date(nextDraft.whenISO!),
                            endAt: new Date(endISO),
                            status: "confirmed",
                        },
                    });
                    return {
                        handled: true,
                        createOk: true,
                        reply: `¡Hecho! Moví tu cita ✅. Quedó para ${fecha} a las ${hora}.`,
                        patch: { draft: { stage: "idle" } },
                    };
                }

                await createAppointmentSafe({
                    empresaId,
                    vertical: kb.vertical,
                    timezone: tz,
                    procedureId: nextDraft.procedureId ?? null,
                    serviceName: nextDraft.procedureName || svc.name,
                    customerName: nextDraft.name!,
                    customerPhone: nextDraft.phone || "",
                    startISO: nextDraft.whenISO!,
                    endISO,
                    notes: "Agendado por IA",
                    source: "ai",
                });

                return {
                    handled: true,
                    createOk: true,
                    reply: `¡Listo! Tu cita quedó confirmada ✅. ${fecha} a las ${hora}.`,
                    patch: { draft: { stage: "idle" } },
                };
            } catch {
                return {
                    handled: true,
                    createOk: false,
                    reply:
                        "Ese horario acaba de ocuparse 😕. ¿Te comparto otras opciones cercanas?",
                };
            }
        }

        // Falta nombre o teléfono → pedir lo que falta
        const missingPieces: string[] = [];
        if (!nextDraft.name) missingPieces.push("tu *nombre*");
        if (!nextDraft.phone) missingPieces.push("tu *teléfono*");
        const need = missingPieces.join(" y ");

        const resumen =
            `Perfecto. Te reservo *${svc.name}* para *${fecha} a las ${hora}*.\n` +
            (need ? `Para confirmar, por favor envíame ${need}.` : "¿Confirmo así?");

        return {
            handled: true,
            reply: resumen,
            patch: { draft: nextDraft, ...basePatch },
        };
    }

    // Nada más que hacer en este turno
    return { handled: false, patch: basePatch };
}
