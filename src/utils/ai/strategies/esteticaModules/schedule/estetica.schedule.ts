/* =======================================================================
   Estética – SCHEDULE (Full Agent + conversation_state)
   - Unifica diálogo operativo + verificación real en BD + commit
   - Sin interpreter/facade; FSM ligera y helpers deterministas
   - Integrado con Prisma Appointment/Hour/Exception y KB (EsteticaProcedure)
   ======================================================================= */

import prisma from "../../../../../lib/prisma";
import type { AppointmentStatus, Weekday } from "@prisma/client";
import { loadEsteticaKB, type EsteticaKB } from "../domain/estetica.kb";
import { addMinutes, endOfDay, isBefore, isAfter, parseISO, formatISO, isEqual } from "date-fns";
import { utcToZonedTime, zonedTimeToUtc, format as tzFormat } from "date-fns-tz";
import { es } from "date-fns/locale";

/* ======================== Tipos públicos ======================== */
export type ISO = string; // ISO-8601
export type Phone = string;
export type DayPeriod = "morning" | "afternoon" | "evening";
export type FlowIntent = "BOOK" | "RESCHEDULE" | "CANCEL" | "ASK_SLOTS" | "INFO";

/** Estado de la conversación persistido como JSON */
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
        dateISO?: ISO | null;
        period?: DayPeriod | null;
    };
    proposedSlot?: {
        startISO?: ISO | null;
        endISO?: ISO | null;
        staffId?: number | null;
        reason?: string | null; // "first_free_slot" | "user_requested_date" | "reschedule" | "validation_failed"
    };
    identity?: {
        name?: string | null;
        phone?: Phone | null;
    };
    commitTrace?: {
        lastAction?: "booked" | "rescheduled" | "canceled" | null;
        appointmentId?: number | null;
        at?: ISO | null;
    };
    summaryText?: string | null; // resumen operativo corto
    expireAt?: ISO | null;
};

/** Respuesta para el canal (ej. WhatsApp) */
export type BotReply = {
    text: string;
    quickReplies?: string[];
    updatedState?: ConversationState;
};

/* ======================== Config ======================== */
const TZ = "America/Bogota";
const GRAN_MIN = 15;
const MEM_TTL_MIN = 10;
const SEARCH_HORIZON_DAYS = 21;

/* ======================== Utilidades básicas ======================== */
const toBogota = (iso: ISO) => utcToZonedTime(parseISO(iso), TZ);
const fromBogota = (d: Date) => formatISO(zonedTimeToUtc(d, TZ));
const fmtHuman = (iso: ISO) =>
    tzFormat(parseISO(iso), "EEE d 'de' MMM, h:mm a", { timeZone: TZ, locale: es }).replace(/\./g, "");
const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));
const between = (x: Date, a: Date, b: Date) => (isAfter(x, a) || isEqual(x, a)) && (isBefore(x, b) || isEqual(x, b));
const toWeekday = (d: Date): Weekday => {
    const dow = d.getDay(); // 0 Sun .. 6 Sat
    return (["sun", "mon", "tue", "wed", "thu", "fri", "sat"][dow] as Weekday); // adapta si tu enum difiere
};
const nowISO = () => new Date().toISOString();

/* ======================== Conversation State ======================== */
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
const expireIn = (min: number) => new Date(Date.now() + min * 60_000).toISOString();

/* ======================== Resumen operativo ======================== */
function makeSummary(state: ConversationState): string {
    const svc = state.serviceCandidate?.name ?? "servicio";
    const slot = state.proposedSlot?.startISO ? fmtHuman(state.proposedSlot.startISO) : null;
    const who = state.identity?.name ?? null;
    const act = state.commitTrace?.lastAction;

    if (act === "booked" && slot) return `Cita confirmada: ${svc} • ${slot}${who ? ` • ${who}` : ""}`;
    if (act === "rescheduled" && slot) return `Cita reagendada: ${svc} • ${slot}${who ? ` • ${who}` : ""}`;
    if (act === "canceled") return `Cita cancelada${who ? ` • ${who}` : ""}`;

    if (slot) return `Propuesta: ${svc} • ${slot}${who ? ` • ${who}` : ""}`;
    if (state.dateRequest?.dateISO) return `Buscando: ${svc} • ${fmtHuman(state.dateRequest.dateISO)}`;
    return `Flujo ${state.intent ?? "ASK_SLOTS"} en curso para ${svc}`;
}

/* ======================== NLP determinista ======================== */
function detectIntent(text: string): FlowIntent | null {
    const t = (text || "").toLowerCase();
    if (/\b(cancelar|anular)\b/.test(t)) return "CANCEL";
    if (/\b(reagendar|reprogramar|mover|cambiar)\b/.test(t)) return "RESCHEDULE";
    if (/\b(agendar|reservar|programar|agenda|horarios|disponibilidad)\b/.test(t)) return "BOOK";
    if (/\b(info|informaci[oó]n|indicaciones|contraindicaciones|en qu[eé] consiste)\b/.test(t)) return "INFO";
    return null;
}
function wantsMostRecent(text: string): boolean {
    const t = (text || "").toLowerCase();
    return /\b(m[aá]s\s+pronto|m[aá]s\s+reciente|lo\s+m[aá]s\s+cerca|primer[oa]\s+disponible|lo\s+m[aá]s\s+pronto)\b/.test(t);
}

/** Distingue “en la mañana” (periodo) de “mañana” (día siguiente) y soporta “ese día” */
function parseDatePeriod(text: string): { dateISO?: ISO | null; period?: DayPeriod | null; keepSameDay?: boolean } {
    const t = (text || "").toLowerCase().trim();
    if (!t) return {};

    const keepSameDay = /\b(ese\s+d[ií]a|ese\s+mismo\s+d[ií]a)\b/.test(t);
    const saysMorningPhrase = /\ben\s+la\s+ma[nñ]ana\b/.test(t);

    let period: DayPeriod | null = null;
    if (saysMorningPhrase || /\b(ma[nñ]ana\b)(?!\s*es)/.test(t)) period = "morning";
    if (/\b(tarde)\b/.test(t)) period = "afternoon";
    if (/\b(noche)\b/.test(t)) period = "evening";
    if (/\b(8|9|10|11)\s*(:\d\d)?\s*(am|a\.m\.)\b/.test(t)) period = "morning";
    if (/\b(12|13|14|15|16|17)\b/.test(t)) period = "afternoon";
    if (/\b(18|19|20|21)\b/.test(t)) period = "evening";

    const today = new Date();
    const base = utcToZonedTime(today, TZ);
    base.setHours(0, 0, 0, 0);

    let delta = 0;
    const saysTomorrow = /\bma[nñ]ana\b/.test(t) && !saysMorningPhrase;
    if (/\bhoy\b/.test(t)) delta = 0;
    else if (saysTomorrow) delta = 1;
    else if (/\bpasad[o|a]\s*ma[nñ]ana\b/.test(t)) delta = 2;

    const wdMap: Record<string, number> = {
        lunes: 1, martes: 2, miercoles: 3, miércoles: 3, jueves: 4, viernes: 5, sabado: 6, sábado: 6, domingo: 0,
    };
    const wdMatch = t.match(/\b(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b/);

    let dateISO: ISO | null = null;
    if (wdMatch) {
        const target = wdMap[wdMatch[1]];
        const curr = base.getDay();
        let add = (target - curr + 7) % 7;
        if (add === 0 && /\bpr[oó]xim|siguiente\b/.test(t)) add = 7;
        const d = new Date(base);
        d.setDate(base.getDate() + add);
        dateISO = fromBogota(d);
    } else if (delta > 0 || /\bhoy\b/.test(t)) {
        const d = new Date(base);
        d.setDate(base.getDate() + delta);
        dateISO = fromBogota(d);
    }

    const ymd = t.match(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/);
    if (ymd) {
        const [_, y, m, d] = ymd;
        const dt = utcToZonedTime(new Date(Number(y), Number(m) - 1, Number(d)), TZ);
        dateISO = fromBogota(dt);
    }

    return { dateISO, period, keepSameDay };
}

function extractIdentity(text: string): { name?: string | null; phone?: Phone | null } {
    const t = (text || "").trim();
    const phone = (t.match(/(\+?\d[\d\s-]{7,}\d)/)?.[1] || "").replace(/[^\d+]/g, "");
    const name =
        t.match(/\b(mi\s+nombre\s+es|soy)\s+([A-Za-zÁÉÍÓÚáéíóúñÑ][\wÁÉÍÓÚáéíóúñÑ\s.'-]{2,})/i)?.[2]?.trim() ||
        undefined;
    return { name: name || undefined, phone: phone || undefined };
}

/* ======================== KB wrappers ======================== */
function getServiceCandidate(kb: EsteticaKB, text: string | undefined) {
    const t = (text || "").toLowerCase();
    const byAlias = kb.procedures.find(p =>
        [p.name.toLowerCase(), ...(p.aliases || []).map(a => a.toLowerCase())].some(a => t.includes(a))
    );
    const svc = byAlias || kb.procedures.find(p => p.enabled !== false) || null;
    return {
        id: svc?.id ?? null,
        name: svc?.name ?? null,
        durationMin: svc?.durationMin ?? kb.defaultServiceDurationMin ?? 60,
        priceMin: svc?.priceMin ?? null,
        requiresStaffIds: (svc?.requiredStaffIds as any) || null,
    };
}
function getRules(kb: EsteticaKB) {
    const morning = { start: "08:00", end: "12:00" };
    const afternoon = { start: "12:00", end: "17:00" };
    const evening = { start: "17:00", end: "20:00" };
    return {
        bufferMin: kb.bufferMin ?? 0,
        offerWindowDays: SEARCH_HORIZON_DAYS,
        morning, afternoon, evening,
    };
}

/* ======================== Disponibilidad (BD) ======================== */
type OpenWindow = { start: Date; end: Date };
type FreeSlot = { startISO: ISO; endISO: ISO; staffId?: number | null };

async function getOpenWindowsForDay(empresaId: number, dayStart: Date): Promise<OpenWindow[]> {
    const weekday = toWeekday(dayStart);
    const hours = await prisma.appointmentHour.findUnique({
        where: { empresaId_day: { empresaId, day: weekday } },
    });

    const ex = await prisma.appointmentException.findFirst({
        where: {
            empresaId,
            date: { gte: dayStart, lte: endOfDay(dayStart) },
        },
    });

    const mkDate = (base: Date, hhmm?: string | null) => {
        if (!hhmm) return null;
        const [hh, mm] = hhmm.split(":").map(Number);
        const d = new Date(base);
        d.setHours(hh, mm, 0, 0);
        return d;
    };

    const blocks: OpenWindow[] = [];

    if (ex) {
        if (ex.isOpen === false) return [];
        const s1 = mkDate(dayStart, ex.start1);
        const e1 = mkDate(dayStart, ex.end1);
        const s2 = mkDate(dayStart, ex.start2);
        const e2 = mkDate(dayStart, ex.end2);
        if (s1 && e1 && isBefore(s1, e1)) blocks.push({ start: s1, end: e1 });
        if (s2 && e2 && isBefore(s2, e2)) blocks.push({ start: s2, end: e2 });
    } else if (hours?.isOpen) {
        const s1 = mkDate(dayStart, hours.start1);
        const e1 = mkDate(dayStart, hours.end1);
        const s2 = mkDate(dayStart, hours.start2);
        const e2 = mkDate(dayStart, hours.end2);
        if (s1 && e1 && isBefore(s1, e1)) blocks.push({ start: s1, end: e1 });
        if (s2 && e2 && isBefore(s2, e2)) blocks.push({ start: s2, end: e2 });
    }

    return blocks;
}

async function findConflicts(empresaId: number, from: Date, to: Date, staffId?: number | null) {
    return prisma.appointment.findMany({
        where: {
            empresaId,
            deletedAt: null,
            status: { in: ["pending", "confirmed", "rescheduled"] as AppointmentStatus[] },
            ...(staffId ? { staffId } : {}),
            AND: [
                { startAt: { lt: to } },
                { endAt: { gt: from } },
            ],
        },
        select: { id: true, startAt: true, endAt: true, staffId: true },
    });
}

/** Genera el primer slot libre válido, respetando granulado, buffer y bloqueos */
async function findFirstFreeSlot(args: {
    empresaId: number;
    dateISO?: ISO | null;
    durationMin: number;
    bufferMin?: number | null;
    staffIdsPreferred?: number[] | null;
    period?: DayPeriod | null;
}): Promise<FreeSlot | null> {
    const { empresaId, dateISO, durationMin, bufferMin, staffIdsPreferred, period } = args;

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
            const apply = (p: DayPeriod) => {
                if (p === "morning") { copy.end.setHours(12, 0, 0, 0); }
                if (p === "afternoon") { copy.start.setHours(12, 0, 0, 0); copy.end.setHours(17, 0, 0, 0); }
                if (p === "evening") { copy.start.setHours(17, 0, 0, 0); copy.end.setHours(20, 0, 0, 0); }
            };
            apply(period);
            if (!isBefore(copy.start, copy.end)) return null;
            return copy;
        };

        for (const w of windows) {
            const block = periodFilter(w);
            if (!block) continue;

            let cursor = new Date(block.start);
            const today = utcToZonedTime(new Date(), TZ);
            if (cursor.toDateString() === today.toDateString()) {
                const nowPlus = addMinutes(today, clamp(safeBuffer, 0, 240));
                if (isAfter(nowPlus, cursor)) cursor = nowPlus;
            }

            for (
                ;
                isBefore(addMinutes(cursor, durationMin), block.end) ||
                isEqual(addMinutes(cursor, durationMin), block.end);
                cursor = addMinutes(cursor, GRAN_MIN)
            ) {
                const candidateStart = new Date(cursor);
                const candidateEnd = addMinutes(candidateStart, durationMin);

                const staffList = staffIdsPreferred && staffIdsPreferred.length ? staffIdsPreferred : [null];
                for (const st of staffList) {
                    const conflicts = await findConflicts(
                        empresaId,
                        zonedTimeToUtc(candidateStart, TZ),
                        zonedTimeToUtc(candidateEnd, TZ),
                        st ?? undefined
                    );
                    if (conflicts.length) continue;

                    return {
                        startISO: fromBogota(candidateStart),
                        endISO: fromBogota(candidateEnd),
                        staffId: st ?? null,
                    };
                }
            }
        }
    }
    return null;
}

/** Encuentra varias opciones consecutivas (hasta `limit`) */
async function findNextSlots(args: {
    empresaId: number;
    startFromISO: ISO | null; // si null, desde hoy
    durationMin: number;
    bufferMin?: number | null;
    staffIdsPreferred?: number[] | null;
    period?: DayPeriod | null;
    limit?: number;
}): Promise<FreeSlot[]> {
    const out: FreeSlot[] = [];
    let cursorISO = args.startFromISO;

    for (let i = 0; i < (args.limit ?? 3); i++) {
        const slot = await findFirstFreeSlot({
            empresaId: args.empresaId,
            dateISO: cursorISO,
            durationMin: args.durationMin,
            bufferMin: args.bufferMin ?? 0,
            staffIdsPreferred: args.staffIdsPreferred ?? null,
            period: args.period ?? null,
        });
        if (!slot) break;
        out.push(slot);
        const nextStartLocal = toBogota(slot.startISO);
        nextStartLocal.setMinutes(nextStartLocal.getMinutes() + 1);
        cursorISO = fromBogota(nextStartLocal);
    }
    return out;
}

/** Valida que un rango esté dentro de ventanas abiertas + sin choques */
async function validateAvailability(args: {
    empresaId: number;
    startISO: ISO;
    endISO: ISO;
    staffId?: number | null;
}): Promise<{ ok: boolean; reason?: string | null }> {
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

/* ======================== CRUD de citas (BD) ======================== */
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

    const startAt = parseISO(startISO);
    const endAt = parseISO(endISO);

    const created = await prisma.appointment.create({
        data: {
            empresaId,
            source: source as any,
            status: "confirmed",
            customerName,
            customerPhone,
            serviceName,
            serviceDurationMin: serviceDurationMin ?? undefined,
            startAt,
            endAt,
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
            empresaId,
            customerPhone: phone,
            deletedAt: null,
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

async function reschedule(args: {
    empresaId: number;
    appointmentId: number;
    nextStartISO: ISO;
    nextEndISO: ISO;
    nextStaffId?: number | null;
}) {
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

/* ======================== Motor principal (FSM) ======================== */
export async function handleScheduleTurn(
    args: {
        empresaId: number;
        conversationId: number;
        userText: string;
    }
): Promise<BotReply> {
    const { empresaId, conversationId, userText } = args;

    const kbOrNull = await loadEsteticaKB({ empresaId });
    if (!kbOrNull) {
        return { text: "Por ahora no tengo la configuración de la clínica para ofrecer horarios. Te puedo pasar con un asesor humano o intentar más tarde." };
    }

    const kb: EsteticaKB = kbOrNull;
    let state = await loadConvState(conversationId);

    // Reset suave si el usuario inicia con un saludo simple
    const isGreeting = /^\s*(hola|buen[oa]s|hello|hi)\b/i.test(userText);
    if (isGreeting && (state.intent || state.proposedSlot || state.summaryText)) {
        state = { expireAt: expireIn(MEM_TTL_MIN) };
        state.summaryText = makeSummary(state);
        await saveConvState(conversationId, state);
    }

    const rules = getRules(kb);

    const intent: FlowIntent =
        detectIntent(userText) ??
        state.intent ??
        (wantsMostRecent(userText) ? "BOOK" : "ASK_SLOTS");

    // Resolver servicio si no está seteado
    const service =
        state.serviceCandidate ??
        getServiceCandidate(kb, userText);

    const durationMin = service.durationMin ?? kb.defaultServiceDurationMin ?? 60;

    if (intent === "CANCEL") {
        return await flowCancel({ empresaId, conversationId, userText, state });
    }
    if (intent === "RESCHEDULE") {
        return await flowReschedule({ empresaId, conversationId, userText, state, durationMin });
    }
    // BOOK / ASK_SLOTS / INFO
    return await flowBooking({
        empresaId, conversationId, userText,
        state, service, durationMin, rules,
    });
}

/* ======================== Booking Flow ======================== */
async function flowBooking(args: {
    empresaId: number;
    conversationId: number;
    userText: string;
    state: ConversationState;
    service: NonNullable<ConversationState["serviceCandidate"]>;
    durationMin: number;
    rules: ReturnType<typeof getRules>;
}): Promise<BotReply> {
    const { empresaId, conversationId, userText, state, service, durationMin, rules } = args;

    const parsed = parseDatePeriod(userText);
    const nearest = wantsMostRecent(userText);

    // Respetar “ese día” (si ya había date en estado)
    const baseDateISO = state.dateRequest?.dateISO ?? null;
    const dateISO = parsed.keepSameDay ? (baseDateISO ?? parsed.dateISO ?? null) : (parsed.dateISO ?? baseDateISO);
    const period = parsed.period ?? state.dateRequest?.period ?? null;

    // Opción “otras opciones”
    const wantsMore = /\b(otra|otras|m[aá]s\s+opciones|otro\s+horario)\b/i.test(userText);

    // Si no hay fecha y tampoco “lo más pronto”, preguntamos
    if (!dateISO && !nearest) {
        const next: ConversationState = {
            ...state,
            intent: "BOOK",
            serviceCandidate: service,
        };
        next.summaryText = makeSummary(next);
        await saveConvState(conversationId, next);
        return {
            text: `¿Tienes un día en mente para *${service.name ?? "el servicio"}*? Puedo revisar disponibilidad. Si prefieres, te propongo *lo más pronto posible*.`,
            quickReplies: ["Hoy en la tarde", "Mañana", "Este sábado", "Lo más pronto"],
            updatedState: next,
        };
    }

    if (wantsMore) {
        const options = await findNextSlots({
            empresaId,
            startFromISO: nearest ? null : (dateISO ?? null),
            durationMin,
            bufferMin: rules.bufferMin,
            staffIdsPreferred: service.requiresStaffIds ?? null,
            period,
            limit: 3,
        });
        if (options.length) {
            const lines = options.map((s, i) => `${i + 1}. ${fmtHuman(s.startISO)}`).join("\n");
            const ns: ConversationState = {
                ...state,
                intent: "BOOK",
                serviceCandidate: service,
                dateRequest: { raw: userText, dateISO: dateISO ?? null, period: period ?? null },
                proposedSlot: { startISO: options[0].startISO, endISO: options[0].endISO, staffId: options[0].staffId ?? null, reason: "user_requested_date" },
            };
            ns.summaryText = makeSummary(ns);
            await saveConvState(conversationId, ns);
            return {
                text: `Tengo estas opciones:\n${lines}\n\n¿Te funciona alguna? Si te va bien la #1, dime tu *nombre* y *teléfono* para confirmar.`,
                quickReplies: ["La #1", "La #2", "La #3", "Otro día"],
                updatedState: ns,
            };
        }
    }

    // Buscar slot (fecha dada o el primero libre)
    const slot = await findFirstFreeSlot({
        empresaId,
        dateISO: nearest ? null : dateISO,
        durationMin,
        bufferMin: rules.bufferMin,
        staffIdsPreferred: service.requiresStaffIds ?? null,
        period: period ?? null,
    });

    const nextBase: ConversationState = {
        ...state,
        intent: "BOOK",
        serviceCandidate: service,
        dateRequest: { raw: userText ?? state.dateRequest?.raw ?? null, dateISO, period: period ?? null },
    };

    if (!slot) {
        const next: ConversationState = {
            ...nextBase,
            proposedSlot: { startISO: null, endISO: null, staffId: null, reason: nearest ? "first_free_slot" : "user_requested_date" }
        };
        next.summaryText = makeSummary(next);
        await saveConvState(conversationId, next);
        return {
            text: `No veo cupos para esa fecha/franja. ¿Quieres que proponga *lo más pronto* o prefieres otro día?`,
            quickReplies: ["Lo más pronto", "Este jueves", "La próxima semana"],
            updatedState: next,
        };
    }

    const valid = await validateAvailability({
        empresaId,
        startISO: slot.startISO,
        endISO: slot.endISO,
        staffId: slot.staffId ?? undefined
    });
    if (!valid.ok) {
        const next: ConversationState = { ...nextBase, proposedSlot: { startISO: null, endISO: null, staffId: null, reason: "validation_failed" } };
        next.summaryText = makeSummary(next);
        await saveConvState(conversationId, next);
        return {
            text: `Se liberó un horario pero ya no cumple reglas internas. ¿Probamos con otra opción cercana o *lo más pronto*?`,
            quickReplies: ["Lo más pronto", "Mañana", "Tarde", "Noche"],
            updatedState: next,
        };
    }

    // Guardamos propuesta y pedimos identidad si no vino
    const proposed: ConversationState = {
        ...nextBase,
        proposedSlot: {
            startISO: slot.startISO,
            endISO: slot.endISO,
            staffId: slot.staffId ?? null,
            reason: nearest ? "first_free_slot" : "user_requested_date"
        },
    };
    proposed.summaryText = makeSummary(proposed);
    await saveConvState(conversationId, proposed);

    // ¿Vino nombre y teléfono en este turno?
    const idt = extractIdentity(userText);
    if (idt.name && idt.phone) {
        const commit = await book({
            empresaId,
            serviceId: service.id ?? null,
            serviceName: service.name ?? "Servicio",
            serviceDurationMin: durationMin,
            startISO: slot.startISO,
            endISO: slot.endISO,
            customerName: idt.name,
            customerPhone: idt.phone,
            staffId: slot.staffId ?? null,
            source: "chat",
        });

        if (commit.ok) {
            const done: ConversationState = {
                ...proposed,
                identity: { name: idt.name, phone: idt.phone },
                commitTrace: { lastAction: "booked", appointmentId: commit.appointmentId, at: nowISO() },
            };
            done.summaryText = makeSummary(done);
            await saveConvState(conversationId, done);

            const priceLabel = service.priceMin ? ` (Desde ${formatCOP(service.priceMin)} COP)` : "";
            return {
                text: `¡Listo! Agendé *${service.name ?? "tu servicio"}${priceLabel}* para *${fmtHuman(slot.startISO)}*. ¿Deseas agregar notas o preferencias?`,
                updatedState: done,
            };
        }
    }

    return {
        text: `Puedo reservar *${service.name ?? "el servicio"}* el *${fmtHuman(slot.startISO)}*. Si te funciona, por favor dime *nombre* y *teléfono* para confirmar.`,
        quickReplies: ["Sí, agendar", "Otro horario"],
        updatedState: proposed,
    };
}

/* ======================== Reschedule Flow ======================== */
async function flowReschedule(args: {
    empresaId: number;
    conversationId: number;
    userText: string;
    state: ConversationState;
    durationMin: number;
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
    if (!active) {
        return { text: `No encuentro una cita activa vinculada a *${phone}*. ¿Deseas buscar por otro número?` };
    }

    const parsed = parseDatePeriod(userText);
    if (!parsed.dateISO && !wantsMostRecent(userText)) {
        const ns: ConversationState = {
            ...state,
            intent: "RESCHEDULE",
            identity: { ...(state.identity ?? {}), phone },
            commitTrace: { ...state.commitTrace, appointmentId: active.id, lastAction: null, at: null },
        };
        ns.summaryText = makeSummary(ns);
        await saveConvState(conversationId, ns);
        return {
            text: `¿Para qué día te gustaría moverla? Puedo proponerte la opción más próxima disponible.`,
            quickReplies: ["Lo más pronto", "Mañana", "Jueves en la tarde"],
            updatedState: ns,
        };
    }

    const slot = await findFirstFreeSlot({
        empresaId,
        dateISO: wantsMostRecent(userText) ? null : parsed.dateISO ?? null,
        durationMin,
        bufferMin: 0,
        staffIdsPreferred: null,
        period: parsed.period ?? null,
    });
    if (!slot) return { text: `No encuentro disponibilidad para esa fecha/franja. ¿Probamos otra fecha o “lo más pronto”?` };

    const ok = await validateAvailability({
        empresaId,
        startISO: slot.startISO,
        endISO: slot.endISO,
        staffId: slot.staffId ?? undefined
    });
    if (!ok.ok) return { text: `Ese horario ya no cumple reglas internas. ¿Probamos otra opción cercana?` };

    const upd = await reschedule({
        empresaId,
        appointmentId: active.id,
        nextStartISO: slot.startISO,
        nextEndISO: slot.endISO,
        nextStaffId: slot.staffId ?? null,
    });
    if (!upd.ok) return { text: `Ocurrió un problema al reagendar. ¿Intentamos con otro horario?` };

    const ns: ConversationState = {
        ...state,
        intent: "RESCHEDULE",
        identity: { ...(state.identity ?? {}), phone },
        proposedSlot: { ...slot, reason: "reschedule" },
        commitTrace: { lastAction: "rescheduled", appointmentId: active.id, at: nowISO() },
    };
    ns.summaryText = makeSummary(ns);
    await saveConvState(conversationId, ns);

    return { text: `¡Hecho! Tu cita quedó para *${fmtHuman(slot.startISO)}*. ¿Necesitas algo más?`, updatedState: ns };
}

/* ======================== Cancel Flow ======================== */
async function flowCancel(args: {
    empresaId: number;
    conversationId: number;
    userText: string;
    state: ConversationState;
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
    };
    ns.summaryText = makeSummary(ns);
    await saveConvState(conversationId, ns);

    return { text: `Listo, cancelé tu cita. Si quieres, puedo proponerte nueva fecha.`, updatedState: ns };
}

/* ======================== Helpers UI/Precio ======================== */
function formatCOP(value?: number | null): string | null {
    if (value == null || isNaN(Number(value))) return null;
    return new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(Number(value));
}
