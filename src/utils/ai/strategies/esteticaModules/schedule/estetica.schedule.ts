/* =======================================================================
   Estética – SCHEDULE (Full Agent + conversation_state)
   - Conversational CRUD bridge contra BD (Prisma)
   - Cambio de opinión, lista de opciones y elección natural
   - Anáforas (“ese día”) y commit con nombre+teléfono
   - Export helpers + noop para integrarse con strategy
   - Holds (appointment_hold) para congelar cupos mientras pedimos identidad
   ======================================================================= */

import prisma from "../../../../../lib/prisma";
import type { AppointmentStatus, Weekday } from "@prisma/client";
import { loadEsteticaKB, type EsteticaKB } from "../domain/estetica.kb";
import {
    addMinutes, endOfDay, isBefore, isAfter, parseISO, formatISO, isEqual
} from "date-fns";
import { utcToZonedTime, zonedTimeToUtc, format as tzFormat } from "date-fns-tz";
import { es as esLocale } from "date-fns/locale";

/* ======================== Tipos públicos ======================== */
export type ISO = string;
export type Phone = string;
export type DayPeriod = "morning" | "afternoon" | "evening";
export type FlowIntent = "BOOK" | "RESCHEDULE" | "CANCEL" | "ASK_SLOTS" | "INFO";

/** Estado persistido */
export type ConversationState = {
    intent?: FlowIntent;
    serviceCandidate?: {
        id?: number | null;
        name?: string | null;
        durationMin?: number | null;
        priceMin?: number | null;
        requiresStaffIds?: number[] | null;
    };
    dateRequest?: {
        raw?: string | null;
        dateISO?: ISO | null;              // inicio del día (zona Bogotá)
        period?: DayPeriod | null;
        preferredHour?: number | null;
        preferredMinute?: number | null;
    };
    offeredSlots?: Array<{ id: string; startISO: ISO; endISO: ISO; staffId?: number | null; label: string }>;
    chosenSlotId?: string | null;

    proposedSlot?: { startISO?: ISO | null; endISO?: ISO | null; staffId?: number | null; reason?: string | null };

    identity?: { name?: string | null; phone?: Phone | null };
    commitTrace?: { lastAction?: "booked" | "rescheduled" | "canceled" | null; appointmentId?: number | null; at?: ISO | null };
    summaryText?: string | null;
    expireAt?: ISO | null;
};

/** Respuesta canal chat */
export type BotReply = {
    text: string;
    quickReplies?: string[];
    updatedState?: ConversationState;
    /** si true, el caller (strategy) continúa y no se envía texto al usuario */
    noop?: boolean;
};

/* ======================== Config ======================== */
const TZ = "America/Bogota";
const GRAN_MIN = 15;
const MEM_TTL_MIN = 15;
const SEARCH_HORIZON_DAYS = 21;
const MAX_OFFERS = 4;

/* ======================== Utils tiempo ======================== */
const toBogota = (iso: ISO) => utcToZonedTime(parseISO(iso), TZ);
const fromBogota = (d: Date) => formatISO(zonedTimeToUtc(d, TZ));
const fmtHuman = (iso: ISO) =>
    tzFormat(parseISO(iso), "EEE dd 'de' MMM, h:mm a", { timeZone: TZ, locale: esLocale }).replace(/\./g, "");
const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));
const between = (x: Date, a: Date, b: Date) =>
    (isAfter(x, a) || isEqual(x, a)) && (isBefore(x, b) || isEqual(x, b));
const toWeekday = (d: Date): Weekday =>
    (["sun", "mon", "tue", "wed", "thu", "fri", "sat"][d.getDay()] as Weekday);
const nowISO = () => new Date().toISOString();

function startOfDayBogotaFromISO(iso: ISO): ISO {
    const d = toBogota(iso);
    d.setHours(0, 0, 0, 0);
    return fromBogota(d);
}

/* ======================== Conversation State ======================== */
const expireIn = (min: number) => new Date(Date.now() + min * 60_000).toISOString();

async function loadConvState(conversationId: number): Promise<ConversationState> {
    const row = await prisma.conversationState.findUnique({ where: { conversationId }, select: { data: true } });
    const d = ((row?.data as any) || {}) as ConversationState;
    if (!d.expireAt || Date.now() > Date.parse(d.expireAt)) return { expireAt: expireIn(MEM_TTL_MIN) };
    return d;
}
async function saveConvState(conversationId: number, next: ConversationState) {
    const data = { ...next, expireAt: expireIn(MEM_TTL_MIN) };
    await prisma.conversationState.upsert({
        where: { conversationId },
        create: { conversationId, data: data as any },
        update: { data: data as any },
    });
}

/* ======= Helpers públicos para strategy (summary/estado) ======= */
export async function readConvState(conversationId: number) {
    return await loadConvState(conversationId);
}
export async function ensureScheduleSummary(conversationId: number) {
    const s = await loadConvState(conversationId);
    if (!s.summaryText) {
        s.summaryText = makeSummary(s);
        await saveConvState(conversationId, s);
    }
    return s.summaryText!;
}

/* ======================== Summary ======================== */
function makeSummary(state: ConversationState): string {
    const svc = state.serviceCandidate?.name ?? "servicio";
    const offered = state.offeredSlots?.length ? state.offeredSlots.map((s, i) => `${i + 1}) ${s.label}`).join(" | ") : null;
    const slot = state.proposedSlot?.startISO ? fmtHuman(state.proposedSlot.startISO) : null;
    const who = state.identity?.name ?? null;
    const act = state.commitTrace?.lastAction;

    if (act === "booked" && slot) return `Cita confirmada: ${svc} • ${slot}${who ? ` • ${who}` : ""}`;
    if (act === "rescheduled" && slot) return `Cita reagendada: ${svc} • ${slot}${who ? ` • ${who}` : ""}`;
    if (act === "canceled") return `Cita cancelada${who ? ` • ${who}` : ""}`;
    if (offered) return `Opciones: ${svc} • ${offered}`;
    if (slot) return `Propuesta: ${svc} • ${slot}${who ? ` • ${who}` : ""}`;
    if (state.dateRequest?.dateISO)
        return `Buscando: ${svc} • ${tzFormat(parseISO(state.dateRequest.dateISO), "EEE dd MMM", { timeZone: TZ, locale: esLocale })}`;
    return `Flujo ${state.intent ?? "ASK_SLOTS"} en curso para ${svc}`;
}

/* ======================== NLP determinista ======================== */
function detectIntent(text: string): FlowIntent | null {
    const t = (text || "").toLowerCase();
    if (/\b(cancelar|anular)\b/.test(t)) return "CANCEL";
    if (/\b(reagendar|reprogramar|mover|cambiar)\b/.test(t)) return "RESCHEDULE";
    if (/\b(agendar|reservar|programar|agenda|horarios|disponibilidad|quiero|podemos)\b/.test(t)) return "BOOK";
    if (/\b(info|informaci[oó]n|indicaciones|contraindicaciones|en qu[eé] consiste)\b/.test(t)) return "INFO";
    return null;
}
function wantsMostRecent(text: string): boolean {
    const t = (text || "").toLowerCase();
    return /\b(m[aá]s\s+pronto|m[aá]s\s+reciente|lo\s+m[aá]s\s+cerca|primer[oa]\s+disponible|lo\s+m[aá]s\s+pronto)\b/.test(t);
}
function isAffirm(text: string): boolean {
    const t = (text || "").toLowerCase();
    return /\b(s[ií]|ok|vale|listo|me sirve|confirmo|de acuerdo|hagamos|perfecto)\b/.test(t);
}
function parseDatePeriod(text: string): {
    dateISO?: ISO | null; period?: DayPeriod | null; preferredHour?: number | null; preferredMinute?: number | null; anaphoraSameDay?: boolean;
} {
    const t = (text || "").toLowerCase().trim();
    if (!t) return {};

    // anáfora “ese día”
    const anaphoraSameDay = /\b(ese\s+mismo\s+d[ií]a|ese\s+d[ií]a|el\s+mismo\s+d[ií]a)\b/.test(t);

    // periodo
    let period: DayPeriod | null = null;
    if (/\b(mañana|ma[nñ]ana)\b/.test(t)) period = "morning";
    if (/\b(tarde)\b/.test(t)) period = "afternoon";
    if (/\b(noche)\b/.test(t)) period = "evening";

    // hora explícita
    let preferredHour: number | null = null;
    let preferredMinute: number | null = 0;
    const hm1 = t.match(/\b(\d{1,2})\s*(:\s*(\d{2}))?\s*(h|hrs|pm|p\.m\.|am|a\.m\.)?\b/);
    if (hm1) {
        let h = Number(hm1[1]);
        const m = hm1[3] ? Number(hm1[3]) : 0;
        const suffix = hm1[4]?.toLowerCase();
        if (suffix?.includes("pm") && h < 12) h += 12;
        if (suffix?.includes("am") && h === 12) h = 0;
        if (h >= 0 && h <= 23) { preferredHour = h; preferredMinute = m; }
    }

    // relativos
    const base = utcToZonedTime(new Date(), TZ); base.setHours(0, 0, 0, 0);
    let delta = 0;
    if (/\bhoy\b/.test(t)) delta = 0;
    else if (/\bma[nñ]ana\b/.test(t)) delta = 1;
    else if (/\bpasad[oa]\s+ma[nñ]ana\b/.test(t)) delta = 2;

    const wdMap: Record<string, number> =
        { lunes: 1, martes: 2, miercoles: 3, miércoles: 3, jueves: 4, viernes: 5, sabado: 6, sábado: 6, domingo: 0 };
    const wdMatch = t.match(/\b(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b/);
    let dateISO: ISO | null = null;

    if (wdMatch) {
        const target = wdMap[wdMatch[1]];
        const curr = base.getDay();
        let add = (target - curr + 7) % 7;
        if (add === 0 && /\bpr[oó]xim|siguiente\b/.test(t)) add = 7;
        const d = new Date(base); d.setDate(base.getDate() + add);
        dateISO = fromBogota(d);
    } else if (/\bhoy\b/.test(t) || /\bma[nñ]ana\b/.test(t) || /\bpasad[oa]\s+ma[nñ]ana\b/.test(t)) {
        const d = new Date(base); d.setDate(base.getDate() + delta);
        dateISO = fromBogota(d);
    }

    const ymd = t.match(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/);
    if (ymd) {
        const [_, y, m, d] = ymd;
        const dt = utcToZonedTime(new Date(Number(y), Number(m) - 1, Number(d)), TZ);
        dateISO = fromBogota(dt);
    }

    return { dateISO, period, preferredHour, preferredMinute, anaphoraSameDay };
}
function extractIdentity(text: string): { name?: string | null; phone?: Phone | null } {
    const t = (text || "").trim();
    const phone = (t.match(/(\+?\d[\d\s-]{7,}\d)/)?.[1] || "").replace(/[^\d+]/g, "");
    const name =
        t.match(/\b(mi\s+nombre\s+es|soy)\s+([A-Za-zÁÉÍÓÚáéíóúñÑ][\wÁÉÍÓÚáéíóúñÑ\s.'-]{2,})/i)?.[2]?.trim()
        || (t.split(/\n/).map(s => s.trim()).find(s => /^[A-Za-zÁÉÍÓÚáéíóúñÑ][\wÁÉÍÓÚáéíóúñÑ\s.'-]{2,}$/.test(s)) ?? undefined);
    return { name: name || undefined, phone: phone || undefined };
}

/* ======================== KB wrappers ======================== */
// ➤ Importante: si NO se menciona servicio, no hacemos fallback al primero.
function getServiceCandidate(kb: EsteticaKB, text: string | undefined) {
    const t = (text || "").toLowerCase();
    const svc = kb.procedures.find(p =>
        [p.name.toLowerCase(), ...(p.aliases || []).map(a => a.toLowerCase())].some(a => t.includes(a))
    ) || null;

    return {
        id: svc?.id ?? null,
        name: svc?.name ?? null,
        durationMin: (svc?.durationMin ?? kb.defaultServiceDurationMin ?? 60),
        priceMin: svc?.priceMin ?? null,
        requiresStaffIds: (svc?.requiredStaffIds as any) || null,
    };
}
function getRules(kb: EsteticaKB) {
    const morning = { start: "08:00", end: "12:00" };
    const afternoon = { start: "12:00", end: "17:00" };
    const evening = { start: "17:00", end: "20:00" };
    return { bufferMin: typeof kb.bufferMin === "number" ? kb.bufferMin : 0, offerWindowDays: SEARCH_HORIZON_DAYS, morning, afternoon, evening };
}

/* ======================== Disponibilidad ======================== */
type OpenWindow = { start: Date; end: Date };
type FreeSlot = { startISO: ISO; endISO: ISO; staffId?: number | null };

async function getOpenWindowsForDay(empresaId: number, dayStart: Date): Promise<OpenWindow[]> {
    const weekday = toWeekday(dayStart);
    const hours = await prisma.appointmentHour.findUnique({ where: { empresaId_day: { empresaId, day: weekday } } });

    const ex = await prisma.appointmentException.findFirst({
        where: { empresaId, date: { gte: dayStart, lte: endOfDay(dayStart) } },
    });

    const mkDate = (base: Date, hhmm?: string | null) => {
        if (!hhmm) return null;
        const [hh, mm] = hhmm.split(":").map(Number);
        const d = new Date(base); d.setHours(hh, mm, 0, 0);
        return d;
    };

    const blocks: OpenWindow[] = [];
    if (ex) {
        if (ex.isOpen === false) return [];
        const s1 = mkDate(dayStart, ex.start1), e1 = mkDate(dayStart, ex.end1);
        const s2 = mkDate(dayStart, ex.start2), e2 = mkDate(dayStart, ex.end2);
        if (s1 && e1 && isBefore(s1, e1)) blocks.push({ start: s1, end: e1 });
        if (s2 && e2 && isBefore(s2, e2)) blocks.push({ start: s2, end: e2 });
    } else if (hours?.isOpen) {
        const s1 = mkDate(dayStart, hours.start1), e1 = mkDate(dayStart, hours.end1);
        const s2 = mkDate(dayStart, hours.start2), e2 = mkDate(dayStart, hours.end2);
        if (s1 && e1 && isBefore(s1, e1)) blocks.push({ start: s1, end: e1 });
        if (s2 && e2 && isBefore(s2, e2)) blocks.push({ start: s2, end: e2 });
    }

    return blocks;
}

/* ======================== Holds (congelar cupos) ======================== */
const HOLD_TTL_MIN = 7;

async function purgeExpiredHolds(empresaId: number) {
    await prisma.appointmentHold.deleteMany({
        where: { empresaId, expiresAt: { lt: new Date() } },
    });
}

async function createHold(args: {
    empresaId: number;
    startISO: ISO;
    endISO: ISO;
    staffId?: number | null;
    conversationId: number;
    ttlMin?: number;
}): Promise<{ ok: true } | { ok: false; reason: "conflict" | "db_error" }> {
    const { empresaId, startISO, endISO, staffId = null, conversationId, ttlMin = HOLD_TTL_MIN } = args;
    try {
        await prisma.appointmentHold.create({
            data: {
                empresaId,
                startAt: parseISO(startISO),
                endAt: parseISO(endISO),
                staffId: staffId ?? undefined,
                conversationId,
                expiresAt: new Date(Date.now() + ttlMin * 60_000),
            },
        });
        return { ok: true };
    } catch (e: any) {
        // Para MySQL/MariaDB será un error de unique igualmente
        return { ok: false, reason: "db_error" };
    }
}

async function releaseHold(args: { empresaId: number; startISO: ISO; endISO: ISO; staffId?: number | null }) {
    const { empresaId, startISO, endISO, staffId = null } = args;
    await prisma.appointmentHold.deleteMany({
        where: {
            empresaId,
            startAt: parseISO(startISO),
            endAt: parseISO(endISO),
            staffId: staffId ?? undefined,
        },
    });
}

async function findConflicts(empresaId: number, from: Date, to: Date, staffId?: number | null) {
    await purgeExpiredHolds(empresaId);

    const [apps, holds] = await Promise.all([
        prisma.appointment.findMany({
            where: {
                empresaId,
                deletedAt: null,
                status: { in: ["pending", "confirmed", "rescheduled"] as AppointmentStatus[] },
                ...(staffId ? { staffId } : {}),
                AND: [{ startAt: { lt: to } }, { endAt: { gt: from } }],
            },
            select: { id: true, startAt: true, endAt: true, staffId: true },
        }),
        prisma.appointmentHold.findMany({
            where: {
                empresaId,
                expiresAt: { gt: new Date() },
                ...(staffId ? { staffId } : {}),
                AND: [{ startAt: { lt: to } }, { endAt: { gt: from } }],
            },
            select: { id: true, startAt: true, endAt: true, staffId: true },
        }),
    ]);

    return [...apps, ...holds];
}

/** Colecciona N slots libres cumpliendo reglas */
async function collectFreeSlots(args: {
    empresaId: number;
    dateISO?: ISO | null;
    durationMin: number;
    bufferMin?: number | null;
    staffIdsPreferred?: number[] | null;
    period?: DayPeriod | null;
    preferredHour?: number | null;
    preferredMinute?: number | null;
    max?: number;
}): Promise<FreeSlot[]> {
    const {
        empresaId, dateISO, durationMin,
        bufferMin, staffIdsPreferred, period,
        preferredHour, preferredMinute, max = MAX_OFFERS
    } = args;

    const out: FreeSlot[] = [];
    const startDate = dateISO ? toBogota(dateISO) : utcToZonedTime(new Date(), TZ);
    startDate.setHours(0, 0, 0, 0);

    const horizonEnd = new Date(startDate);
    horizonEnd.setDate(horizonEnd.getDate() + SEARCH_HORIZON_DAYS);
    const safeBuffer = typeof bufferMin === "number" ? bufferMin : 0;

    for (let day = new Date(startDate); isBefore(day, horizonEnd); day.setDate(day.getDate() + 1)) {
        const windows = await getOpenWindowsForDay(empresaId, day);
        if (!windows.length) continue;

        const periodFilter = (w: OpenWindow): OpenWindow | null => {
            if (!period) return w;
            const copy: OpenWindow = { start: new Date(w.start), end: new Date(w.end) };
            if (period === "morning") copy.end.setHours(12, 0, 0, 0);
            if (period === "afternoon") { copy.start.setHours(12, 0, 0, 0); copy.end.setHours(17, 0, 0, 0); }
            if (period === "evening") { copy.start.setHours(17, 0, 0, 0); copy.end.setHours(20, 0, 0, 0); }
            if (!isBefore(copy.start, copy.end)) return null;
            return copy;
        };

        for (const w of windows) {
            const block = periodFilter(w);
            if (!block) continue;

            // cursor inicial
            let cursor = new Date(block.start);

            // “tarde” sin hora → arrancar cerca de 14:00 para dar variedad útil
            if (period === "afternoon" && typeof preferredHour !== "number") {
                const pivot = new Date(day); pivot.setHours(14, 0, 0, 0);
                if (isAfter(pivot, block.start) && isBefore(pivot, block.end)) cursor = pivot;
            }

            // hora preferida dentro del bloque
            if (typeof preferredHour === "number") {
                const pref = new Date(day);
                pref.setHours(preferredHour, preferredMinute ?? 0, 0, 0);
                if (isAfter(pref, block.start) && isBefore(pref, block.end)) cursor = new Date(pref);
            }

            // si es hoy: ahora + buffer
            const today = utcToZonedTime(new Date(), TZ);
            if (cursor.toDateString() === today.toDateString()) {
                const nowPlus = addMinutes(today, clamp(safeBuffer, 0, 240));
                if (isAfter(nowPlus, cursor)) cursor = nowPlus;
            }

            // generar slots; el fin no puede pasar del fin del bloque
            for (; ;) {
                const start = new Date(cursor);
                const end = addMinutes(start, durationMin);
                if (isAfter(end, block.end)) break;

                const staffList = staffIdsPreferred && staffIdsPreferred.length ? staffIdsPreferred : [null];
                for (const st of staffList) {
                    const conflicts = await findConflicts(
                        empresaId,
                        zonedTimeToUtc(start, TZ),
                        zonedTimeToUtc(end, TZ),
                        st ?? undefined
                    );
                    if (conflicts.length) continue;

                    out.push({ startISO: fromBogota(start), endISO: fromBogota(end), staffId: st ?? null });
                    if (out.length >= max) return out;
                }
                cursor = addMinutes(cursor, GRAN_MIN);
            }
        }
    }
    return out;
}

async function validateAvailability(args: { empresaId: number; startISO: ISO; endISO: ISO; staffId?: number | null; }): Promise<{ ok: boolean; reason?: string | null }> {
    const { empresaId, startISO, endISO, staffId } = args;
    const startBo = toBogota(startISO);
    const endBo = toBogota(endISO);
    const day = new Date(startBo); day.setHours(0, 0, 0, 0);

    const windows = await getOpenWindowsForDay(empresaId, day);
    const inside = windows.some(w => between(startBo, w.start, w.end) && between(endBo, w.start, w.end));
    if (!inside) return { ok: false, reason: "outside_business_hours" };

    const conflicts = await findConflicts(
        empresaId,
        zonedTimeToUtc(startBo, TZ),
        zonedTimeToUtc(endBo, TZ),
        staffId ?? undefined
    );
    if (conflicts.length) return { ok: false, reason: "conflict" };
    return { ok: true };
}

/* ======================== CRUD citas ======================== */
async function book(args: {
    empresaId: number;
    serviceId?: number | null;
    serviceName: string;
    serviceDurationMin?: number | null;
    startISO: ISO;
    endISO: ISO;
    customerName: string;
    customerPhone: Phone;
    staffId?: number | null;
    source?: "whatsapp" | "chat" | "manual";
}) {
    const {
        empresaId, serviceId = null, serviceName, serviceDurationMin = null,
        startISO, endISO, customerName, customerPhone, staffId = null, source = "chat",
    } = args;

    const created = await prisma.appointment.create({
        data: {
            empresaId,
            source: source as any,
            status: "confirmed",
            customerName,
            customerPhone,
            serviceName,
            serviceDurationMin: serviceDurationMin ?? undefined,
            startAt: parseISO(startISO),
            endAt: parseISO(endISO),
            timezone: TZ,
            procedureId: serviceId ?? undefined,
            staffId: staffId ?? undefined,
        },
    });
    return { ok: true as const, appointmentId: created.id };
}

async function findActiveByPhone(empresaId: number, phone: Phone) {
    const now = new Date();
    const appt = await prisma.appointment.findFirst({
        where: {
            empresaId, customerPhone: phone, deletedAt: null,
            status: { in: ["pending", "confirmed", "rescheduled"] as AppointmentStatus[] },
            endAt: { gt: now },
        },
        orderBy: { startAt: "asc" },
        select: { id: true, startAt: true, endAt: true, staffId: true },
    });
    return appt
        ? { id: appt.id, startISO: appt.startAt.toISOString(), endISO: appt.endAt.toISOString(), staffId: appt.staffId ?? null }
        : null;
}

async function reschedule(args: { empresaId: number; appointmentId: number; nextStartISO: ISO; nextEndISO: ISO; nextStaffId?: number | null; }) {
    const { appointmentId, nextStartISO, nextEndISO, nextStaffId = null } = args;
    const upd = await prisma.appointment.update({
        where: { id: appointmentId },
        data: {
            startAt: parseISO(nextStartISO),
            endAt: parseISO(nextEndISO),
            staffId: nextStaffId ?? undefined,
            status: "rescheduled",
            updatedAt: new Date(),
        },
        select: { id: true },
    });
    return upd ? { ok: true as const } : { ok: false as const, error: "not_found" };
}

async function cancel(args: { empresaId: number; appointmentId: number }) {
    const { appointmentId } = args;
    await prisma.appointment.update({
        where: { id: appointmentId },
        data: { status: "cancelled", deletedAt: new Date() },
    });
    return { ok: true as const };
}

/* ======================== Elección humana sobre offeredSlots ======================== */
function pickOfferedByUtterance(utterance: string, offered: ConversationState["offeredSlots"]): string | null {
    if (!offered?.length) return null;
    const t = (utterance || "").toLowerCase();

    // “la segunda / la 2 / opción 2”
    const ord = t.match(/\b(primera|segunda|tercera|cuarta|quinta|sexta|1|2|3|4|5|6)\b/);
    if (ord) {
        const map: Record<string, number> = { primera: 1, segunda: 2, tercera: 3, cuarta: 4, quinta: 5, sexta: 6 };
        const n = isNaN(Number(ord[0])) ? map[ord[0]] : Number(ord[0]);
        if (n && n >= 1 && n <= offered.length) return offered[n - 1].id;
    }

    // “la de las 5 / 17:30”
    const hm = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(pm|p\.m\.|am|a\.m\.)?\b/);
    if (hm) {
        let h = Number(hm[1]);
        const m = hm[2] ? Number(hm[2]) : 0;
        const suf = hm[3]?.toLowerCase();
        if (suf?.includes("pm") && h < 12) h += 12;
        if (suf?.includes("am") && h === 12) h = 0;

        // elegir el slot más cercano a esa hora
        const best = offered.reduce<{ id: string; diff: number } | null>((acc, s) => {
            const d = toBogota(s.startISO);
            const diff = Math.abs(d.getHours() * 60 + d.getMinutes() - (h * 60 + m));
            if (!acc || diff < acc.diff) return { id: s.id, diff };
            return acc;
        }, null);
        if (best && best.diff <= 25) return best.id;
    }

    return null;
}

/* ======================== Motor principal (public) ======================== */
export async function handleScheduleTurn(args: { empresaId: number; conversationId: number; userText: string; }): Promise<BotReply> {
    const { empresaId, conversationId, userText } = args;

    const kbOrNull = await loadEsteticaKB({ empresaId });
    if (!kbOrNull) return { text: "Por ahora no tengo la configuración de la clínica para ofrecer horarios. ¿Te paso con un asesor humano?" };

    const kb = kbOrNull as EsteticaKB;
    const rules = getRules(kb);
    const prev = await loadConvState(conversationId);

    // —— Router no-op: SOLO entrar a agenda si hay intención clara o ya veníamos en agenda
    const parsed0 = parseDatePeriod(userText);
    const explicitIntent = detectIntent(userText); // BOOK / RESCHEDULE / CANCEL / INFO | null
    const prevInSchedule = prev.intent === "BOOK" || prev.intent === "ASK_SLOTS" || prev.intent === "RESCHEDULE";

    const hasBookingSignals =
        explicitIntent === "BOOK" ||
        explicitIntent === "RESCHEDULE" ||
        explicitIntent === "CANCEL" ||
        wantsMostRecent(userText) ||
        (prevInSchedule && (!!parsed0.dateISO || !!parsed0.period || !!parsed0.preferredHour));

    if (!hasBookingSignals) {
        if (!prev.summaryText) { prev.summaryText = makeSummary(prev); await saveConvState(conversationId, prev); }
        return { text: "", noop: true, updatedState: prev };
    }

    // 1) Intent y servicio (permitir cambio de opinión)
    const intentNow = explicitIntent ?? prev.intent ?? (wantsMostRecent(userText) ? "BOOK" : "ASK_SLOTS");

    const svcFromText = getServiceCandidate(kb, userText);
    const serviceChanged = !!svcFromText.name && svcFromText.name !== prev.serviceCandidate?.name;
    const service = serviceChanged ? svcFromText : (prev.serviceCandidate ?? svcFromText);

    // Si NO hay servicio aún → pedirlo (no proponemos por defecto)
    if (!service?.name && (intentNow === "BOOK" || intentNow === "ASK_SLOTS")) {
        const next: ConversationState = { ...prev, intent: "BOOK", serviceCandidate: service };
        next.summaryText = makeSummary(next);
        await saveConvState(conversationId, next);
        const qrs = kb.procedures.slice(0, 4).map(p => p.name);
        return { text: "¿Qué servicio te gustaría agendar?", quickReplies: qrs, updatedState: next };
    }

    // Reset si cambió el servicio
    const baseState: ConversationState = serviceChanged
        ? { ...prev, serviceCandidate: service, proposedSlot: {}, offeredSlots: [], chosenSlotId: null }
        : { ...prev, serviceCandidate: service };

    if (intentNow === "CANCEL") return await flowCancel({ empresaId, conversationId, userText, state: baseState });
    if (intentNow === "RESCHEDULE") {
        return await flowReschedule({ empresaId, conversationId, userText, state: baseState, durationMin: service.durationMin ?? 60 });
    }

    return await flowBooking({ empresaId, conversationId, userText, state: baseState, service, durationMin: service.durationMin ?? 60, rules });
}

/* ======================== Booking Flow ======================== */
async function flowBooking(args: {
    empresaId: number; conversationId: number; userText: string; state: ConversationState;
    service: NonNullable<ConversationState["serviceCandidate"]>; durationMin: number;
    rules: ReturnType<typeof getRules>;
}): Promise<BotReply> {
    const { empresaId, conversationId, userText, state, service, durationMin, rules } = args;

    const parsed = parseDatePeriod(userText);
    const nearest = wantsMostRecent(userText);

    // anáfora “ese día”
    let dateISO = parsed.dateISO ?? state.dateRequest?.dateISO ?? null;
    if (parsed.anaphoraSameDay && !parsed.dateISO) {
        const fromOffered = state.offeredSlots?.[0]?.startISO ? startOfDayBogotaFromISO(state.offeredSlots[0].startISO) : null;
        dateISO = dateISO ?? fromOffered ?? null;
    }
    const period = parsed.period ?? state.dateRequest?.period ?? null;

    // Si el usuario cambió explícitamente la fecha o la franja, limpiamos ofertas previas
    const periodChanged = parsed.period && parsed.period !== state?.dateRequest?.period;
    const dateChanged =
        parsed.dateISO &&
        startOfDayBogotaFromISO(parsed.dateISO) !== (state?.dateRequest?.dateISO ? startOfDayBogotaFromISO(state.dateRequest.dateISO) : null);

    let offered = (periodChanged || dateChanged) ? [] : (state.offeredSlots ?? []);
    let chosenSlotId = pickOfferedByUtterance(userText, offered);

    // si ya eligió y da afirmación/identidad → commit
    if (chosenSlotId && (isAffirm(userText) || extractIdentity(userText).phone || extractIdentity(userText).name)) {
        const chosen = offered.find(s => s.id === chosenSlotId)!;
        return await tryCommitBooking({ empresaId, conversationId, state, service, slot: chosen, userText });
    }

    // si no hay fecha ni “lo más pronto”, preguntar fecha/franja
    if (!dateISO && !nearest && !offered.length) {
        const next: ConversationState = {
            ...state, intent: "BOOK", serviceCandidate: service,
            dateRequest: { ...(state.dateRequest ?? {}), raw: userText ?? state.dateRequest?.raw ?? null }
        };
        next.summaryText = makeSummary(next);
        await saveConvState(conversationId, next);
        return {
            text: `¿Tienes un día en mente para *${service.name}*? Si prefieres, te propongo *lo más pronto posible*.`,
            quickReplies: ["Hoy en la tarde", "Mañana", "Viernes en la mañana", "Lo más pronto"],
            updatedState: next,
        };
    }

    // buscar opciones
    const slots = await collectFreeSlots({
        empresaId,
        dateISO: nearest ? null : (dateISO ? startOfDayBogotaFromISO(dateISO) : null),
        durationMin,
        bufferMin: rules.bufferMin,
        staffIdsPreferred: service.requiresStaffIds ?? null,
        period: period ?? null,
        preferredHour: parsed.preferredHour ?? state.dateRequest?.preferredHour ?? null,
        preferredMinute: parsed.preferredMinute ?? state.dateRequest?.preferredMinute ?? null,
        max: MAX_OFFERS,
    });

    if (!slots.length) {
        const next: ConversationState = {
            ...state, intent: "BOOK", serviceCandidate: service,
            dateRequest: {
                raw: userText ?? state.dateRequest?.raw ?? null,
                dateISO: dateISO ?? null,
                period: period ?? null,
                preferredHour: parsed.preferredHour ?? state.dateRequest?.preferredHour ?? null,
                preferredMinute: parsed.preferredMinute ?? state.dateRequest?.preferredMinute ?? null,
            },
            offeredSlots: [], chosenSlotId: null, proposedSlot: {},
        };
        next.summaryText = makeSummary(next);
        await saveConvState(conversationId, next);
        return {
            text: `No veo cupos para esa fecha/franja. ¿Quieres *lo más pronto* o prefieres otro día?`,
            quickReplies: ["Lo más pronto", "Este jueves", "La próxima semana"],
            updatedState: next
        };
    }

    // validar y filtrar
    const valid = await Promise.all(
        slots.map(s => validateAvailability({ empresaId, startISO: s.startISO, endISO: s.endISO, staffId: s.staffId ?? undefined }))
    );
    const validSlots = slots.filter((_, i) => valid[i].ok);
    if (!validSlots.length) {
        const next = { ...state, offeredSlots: [], chosenSlotId: null, proposedSlot: {} } as ConversationState;
        next.summaryText = makeSummary(next);
        await saveConvState(conversationId, next);
        return { text: "Los cupos cambiaron mientras reservábamos. ¿Intentamos con *otras opciones* o *lo más pronto*?", updatedState: next };
    }

    // construir lista
    offered = validSlots.slice(0, MAX_OFFERS).map((s, i) => {
        const a = toBogota(s.startISO);
        const label = `${tzFormat(a, "EEE dd MMM", { timeZone: TZ, locale: esLocale })} • ${tzFormat(a, "h:mm a", { timeZone: TZ, locale: esLocale })}`;
        return { id: `opt_${i}_${s.startISO}`, startISO: s.startISO, endISO: s.endISO, staffId: s.staffId ?? null, label };
    });

    // estado base actualizado
    const nextBase: ConversationState = {
        ...state,
        intent: "BOOK",
        serviceCandidate: service,
        dateRequest: {
            raw: userText ?? state.dateRequest?.raw ?? null,
            dateISO: dateISO ?? null,
            period: period ?? null,
            preferredHour: parsed.preferredHour ?? state.dateRequest?.preferredHour ?? null,
            preferredMinute: parsed.preferredMinute ?? state.dateRequest?.preferredMinute ?? null,
        },
        offeredSlots: offered,
        proposedSlot: {},
        chosenSlotId: chosenSlotId ?? null,
    };
    nextBase.summaryText = makeSummary(nextBase);
    await saveConvState(conversationId, nextBase);

    // si dijo “9:45” y no hizo match por ID, elegir el más cercano ahora
    if (!chosenSlotId && (parsed.preferredHour != null)) {
        chosenSlotId = pickOfferedByUtterance(userText, offered);
    }
    if (chosenSlotId) {
        const slot = offered.find(x => x.id === chosenSlotId)!;
        return await tryCommitBooking({ empresaId, conversationId, state: nextBase, service, slot, userText });
    }

    // ofrecer opciones
    const priceLabel = service.priceMin ? ` (Desde ${formatCOP(service.priceMin)} COP)` : "";
    const lines = offered.map((s, i) => `${i + 1}) *${s.label}*`).join("\n");
    return {
        text: `Para *${service.name}*${priceLabel} te propongo:\n${lines}\n\nDime “la 2” o “10:30”.`,
        quickReplies: offered.slice(0, 3).map((s, i) => `${i + 1}) ${s.label}`),
        updatedState: nextBase,
    };
}

/* ---------- Commit con slot elegido + identidad ---------- */
async function tryCommitBooking(args: {
    empresaId: number; conversationId: number; state: ConversationState;
    service: NonNullable<ConversationState["serviceCandidate"]>;
    slot: { startISO: ISO; endISO: ISO; staffId?: number | null; label?: string };
    userText: string;
}): Promise<BotReply> {
    const { empresaId, conversationId, state, service, slot, userText } = args;

    const idt = extractIdentity(userText);
    const name = idt.name ?? state.identity?.name ?? null;
    const phone = idt.phone ?? state.identity?.phone ?? null;

    if (!name || !phone) {
        // congela el cupo mientras pedimos identidad
        const held = await createHold({
            empresaId,
            startISO: slot.startISO,
            endISO: slot.endISO,
            staffId: slot.staffId ?? null,
            conversationId,
        });
        if (!held.ok) {
            const ns = { ...state, offeredSlots: [], chosenSlotId: null } as ConversationState;
            ns.summaryText = makeSummary(ns);
            await saveConvState(conversationId, ns);
            return { text: `Ese horario se ocupó justo ahora. Te propongo otras opciones.`, updatedState: ns };
        }

        const ns: ConversationState = {
            ...state,
            chosenSlotId: state.chosenSlotId ?? state.offeredSlots?.find(s => s.startISO === slot.startISO)?.id ?? null,
            identity: { name: name ?? null, phone: phone ?? null },
        };
        ns.summaryText = makeSummary(ns);
        await saveConvState(conversationId, ns);
        return { text: `Perfecto. Para confirmar *${fmtHuman(slot.startISO)}*, ¿me compartes *nombre* y *teléfono*?`, updatedState: ns };
    }

    // commit transaccional + liberación de hold
    try {
        const result = await prisma.$transaction(async (tx) => {
            const start = parseISO(slot.startISO);
            const end = parseISO(slot.endISO);

            const [apptConflict, holdConflict] = await Promise.all([
                tx.appointment.findFirst({
                    where: {
                        empresaId,
                        deletedAt: null,
                        status: { in: ["pending", "confirmed", "rescheduled"] as AppointmentStatus[] },
                        ...(slot.staffId ? { staffId: slot.staffId } : {}),
                        AND: [{ startAt: { lt: end } }, { endAt: { gt: start } }],
                    },
                    select: { id: true },
                }),
                tx.appointmentHold.findFirst({
                    where: {
                        empresaId,
                        expiresAt: { gt: new Date() },
                        ...(slot.staffId ? { staffId: slot.staffId } : {}),
                        AND: [{ startAt: { lt: end } }, { endAt: { gt: start } }],
                    },
                    select: { id: true },
                }),
            ]);
            if (apptConflict || holdConflict) return { ok: false as const };

            const created = await tx.appointment.create({
                data: {
                    empresaId,
                    source: "chat" as any,
                    status: "confirmed",
                    customerName: name!,
                    customerPhone: phone!,
                    serviceName: service.name ?? "Servicio",
                    serviceDurationMin: service.durationMin ?? 60,
                    startAt: start,
                    endAt: end,
                    timezone: TZ,
                    procedureId: service.id ?? undefined,
                    staffId: slot.staffId ?? undefined,
                },
                select: { id: true },
            });

            await tx.appointmentHold.deleteMany({
                where: { empresaId, startAt: start, endAt: end, staffId: slot.staffId ?? undefined },
            });

            return { ok: true as const, id: created.id };
        });

        if (!result.ok) {
            const ns = { ...state, offeredSlots: [], chosenSlotId: null } as ConversationState;
            ns.summaryText = makeSummary(ns);
            await saveConvState(conversationId, ns);
            return { text: `Ese horario acaba de ocuparse. Te propongo otras opciones cercanas.`, updatedState: ns };
        }

        const done: ConversationState = {
            ...state,
            identity: { name, phone },
            commitTrace: { lastAction: "booked", appointmentId: (result as any).id, at: nowISO() },
            proposedSlot: { startISO: slot.startISO, endISO: slot.endISO, staffId: slot.staffId ?? null, reason: "user_choice" },
            offeredSlots: [],
            chosenSlotId: null,
        };
        done.summaryText = makeSummary(done);
        await saveConvState(conversationId, done);

        const priceLabel = service.priceMin ? ` (Desde ${formatCOP(service.priceMin)} COP)` : "";
        return { text: `¡Listo **${name}**! Agendé *${service.name}${priceLabel}* para *${fmtHuman(slot.startISO)}*.`, updatedState: done };

    } catch {
        const ns = { ...state, offeredSlots: [], chosenSlotId: null } as ConversationState;
        ns.summaryText = makeSummary(ns);
        await saveConvState(conversationId, ns);
        return { text: `Tuve un problema al confirmar. Intentemos con otro horario, ¿te parece?`, updatedState: ns };
    }
}

/* ======================== Reschedule Flow ======================== */
async function flowReschedule(args: {
    empresaId: number; conversationId: number; userText: string; state: ConversationState; durationMin: number;
}): Promise<BotReply> {
    const { empresaId, conversationId, userText, state, durationMin } = args;

    const idt = state.identity ?? extractIdentity(userText);
    const phone = idt.phone ?? null;
    if (!phone) {
        const ns: ConversationState = { ...state, intent: "RESCHEDULE" };
        ns.summaryText = makeSummary(ns);
        await saveConvState(conversationId, ns);
        return { text: `Para reagendar, ¿me confirmas tu *teléfono* asociado a la cita?`, updatedState: ns };
    }

    const active = await findActiveByPhone(empresaId, phone);
    if (!active) return { text: `No encuentro una cita activa vinculada a *${phone}*. ¿Deseas buscar por otro número?` };

    const parsed = parseDatePeriod(userText);
    if (!parsed.dateISO && !wantsMostRecent(userText)) {
        const ns: ConversationState = {
            ...state, intent: "RESCHEDULE", identity: { ...(state.identity ?? {}), phone },
            commitTrace: { ...state.commitTrace, appointmentId: active.id, lastAction: null, at: null },
        };
        ns.summaryText = makeSummary(ns);
        await saveConvState(conversationId, ns);
        return { text: `¿Para qué día te gustaría moverla? Puedo proponerte la opción más próxima disponible.`, quickReplies: ["Lo más pronto", "Mañana", "Jueves en la tarde"], updatedState: ns };
    }

    const slots = await collectFreeSlots({
        empresaId,
        dateISO: wantsMostRecent(userText) ? null : parsed.dateISO ?? null,
        durationMin,
        bufferMin: 0,
        staffIdsPreferred: null,
        period: parsed.period ?? null,
        preferredHour: parsed.preferredHour ?? null,
        preferredMinute: parsed.preferredMinute ?? null,
        max: 1,
    });
    if (!slots.length) return { text: `No encuentro disponibilidad para esa fecha/franja. ¿Probamos otra fecha o “lo más pronto”?` };

    const s = slots[0];
    const ok = await validateAvailability({ empresaId, startISO: s.startISO, endISO: s.endISO, staffId: s.staffId ?? undefined });
    if (!ok.ok) return { text: `Ese horario ya no cumple reglas internas. ¿Probamos otra opción cercana?` };

    const upd = await reschedule({ empresaId, appointmentId: active.id, nextStartISO: s.startISO, nextEndISO: s.endISO, nextStaffId: s.staffId ?? null });
    if (!upd.ok) return { text: `Ocurrió un problema al reagendar. ¿Intentamos con otro horario?` };

    const ns: ConversationState = {
        ...state,
        intent: "RESCHEDULE",
        identity: { ...(state.identity ?? {}), phone },
        proposedSlot: { ...s, reason: "reschedule" },
        commitTrace: { lastAction: "rescheduled", appointmentId: active.id, at: nowISO() },
        offeredSlots: [],
        chosenSlotId: null
    };
    ns.summaryText = makeSummary(ns);
    await saveConvState(conversationId, ns);

    return { text: `¡Hecho! Tu cita quedó para *${fmtHuman(s.startISO)}*. ¿Necesitas algo más?`, updatedState: ns };
}

/* ======================== Cancel Flow ======================== */
async function flowCancel(args: {
    empresaId: number; conversationId: number; userText: string; state: ConversationState;
}): Promise<BotReply> {
    const { empresaId, conversationId, userText, state } = args;
    const idt = state.identity ?? extractIdentity(userText);
    const phone = idt.phone ?? null;

    if (!phone) {
        const ns: ConversationState = { ...state, intent: "CANCEL" };
        ns.summaryText = makeSummary(ns);
        await saveConvState(conversationId, ns);
        return { text: `Para cancelar, ¿me confirmas el *teléfono* asociado a la cita?`, updatedState: ns };
    }

    const active = await findActiveByPhone(empresaId, phone);
    if (!active) return { text: `No encuentro una cita activa vinculada a *${phone}*. ¿Deseas revisar con otro número?` };

    const cx = await cancel({ empresaId, appointmentId: active.id });
    if (!cx.ok) return { text: `No pude cancelar tu cita. ¿Probamos de nuevo o prefieres reagendar?` };

    const ns: ConversationState = {
        ...state,
        intent: "CANCEL",
        identity: { ...(state.identity ?? {}), phone },
        commitTrace: { lastAction: "canceled", appointmentId: active.id, at: nowISO() },
        offeredSlots: [],
        chosenSlotId: null
    };
    ns.summaryText = makeSummary(ns);
    await saveConvState(conversationId, ns);

    return { text: `Listo, cancelé tu cita. Si quieres, puedo proponerte nueva fecha.`, updatedState: ns };
}

/* ======================== Helpers precio ======================== */
function formatCOP(value?: number | null): string | null {
    if (value == null || isNaN(Number(value))) return null;
    return new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(Number(value));
}
