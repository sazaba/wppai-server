/* =======================================================================
   Estética – SCHEDULE (Full Agent + conversation_state)
   - Unifica diálogo + verificación real en BD + commit
   - Sin interpreter/facade; FSM ligera y helpers deterministas
   - Prisma Appointment/Hour/Exception + KB
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
        preferredHour?: number | null;   // ⬅️ nueva pista: “4 pm”
        preferredMinute?: number | null; // ⬅️
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
    summaryText?: string | null;
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

/* ======================== Utilidades ======================== */
const toBogota = (iso: ISO) => utcToZonedTime(parseISO(iso), TZ);
const fromBogota = (d: Date) => formatISO(zonedTimeToUtc(d, TZ));
const fmtHuman = (iso: ISO) =>
    tzFormat(parseISO(iso), "EEE dd 'de' MMM, h:mm a", { timeZone: TZ, locale: esLocale })
        .replace(/\./g, "");
const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));
const between = (x: Date, a: Date, b: Date) =>
    (isAfter(x, a) || isEqual(x, a)) && (isBefore(x, b) || isEqual(x, b));
const toWeekday = (d: Date): Weekday => (["sun", "mon", "tue", "wed", "thu", "fri", "sat"][d.getDay()] as Weekday);
const nowISO = () => new Date().toISOString();

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

/* ======================== Summary ======================== */
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
function isAffirm(text: string): boolean {
    const t = (text || "").toLowerCase();
    return /\b(s[ií]|ok|vale|listo|me sirve|confirmo|de acuerdo)\b/.test(t);
}
function parseDatePeriod(text: string): {
    dateISO?: ISO | null; period?: DayPeriod | null; preferredHour?: number | null; preferredMinute?: number | null;
} {
    const t = (text || "").toLowerCase().trim();
    if (!t) return {};

    // periodo
    let period: DayPeriod | null = null;
    if (/\b(ma[nñ]ana|mañana)\b/.test(t) || /\b(8|9|10|11)\s*(:\d\d)?\s*(am|a\.m\.)\b/.test(t)) period = "morning";
    if (/\b(tarde)\b/.test(t) || /\b(12|13|14|15|16|17)\b/.test(t)) period = "afternoon";
    if (/\b(noche)\b/.test(t) || /\b(18|19|20|21)\b/.test(t)) period = "evening";

    // hora explícita: “4 pm”, “16:30”, “a las 5”
    let preferredHour: number | null = null;
    let preferredMinute: number | null = 0;
    const hm1 = t.match(/\b(\d{1,2})\s*(:\s*(\d{2}))?\s*(h|hrs|pm|a\.m\.|p\.m\.|am)?\b/);
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
    else if (/\bpasad[o|a]\s*ma[nñ]ana\b/.test(t)) delta = 2;

    const wdMap: Record<string, number> = { lunes: 1, martes: 2, miercoles: 3, miércoles: 3, jueves: 4, viernes: 5, sabado: 6, sábado: 6, domingo: 0 };
    const wdMatch = t.match(/\b(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b/);
    let dateISO: ISO | null = null;

    if (wdMatch) {
        const target = wdMap[wdMatch[1]];
        const curr = base.getDay();
        let add = (target - curr + 7) % 7;
        if (add === 0 && /\bpr[oó]xim|siguiente\b/.test(t)) add = 7;
        const d = new Date(base); d.setDate(base.getDate() + add);
        dateISO = fromBogota(d);
    } else if (delta > 0 || /\bhoy\b/.test(t)) {
        const d = new Date(base); d.setDate(base.getDate() + delta);
        dateISO = fromBogota(d);
    }

    const ymd = t.match(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/);
    if (ymd) {
        const [_, y, m, d] = ymd;
        const dt = utcToZonedTime(new Date(Number(y), Number(m) - 1, Number(d)), TZ);
        dateISO = fromBogota(dt);
    }

    return { dateISO, period, preferredHour, preferredMinute };
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
        bufferMin: typeof kb.bufferMin === "number" ? kb.bufferMin : 0,
        offerWindowDays: SEARCH_HORIZON_DAYS,
        morning, afternoon, evening,
    };
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

async function findConflicts(empresaId: number, from: Date, to: Date, staffId?: number | null) {
    return prisma.appointment.findMany({
        where: {
            empresaId,
            deletedAt: null,
            status: { in: ["pending", "confirmed", "rescheduled"] as AppointmentStatus[] },
            ...(staffId ? { staffId } : {}),
            AND: [{ startAt: { lt: to } }, { endAt: { gt: from } }],
        },
        select: { id: true, startAt: true, endAt: true, staffId: true },
    });
}

/** Primer slot libre válido, respetando granulado/buffer/periodo/hora preferida */
async function findFirstFreeSlot(args: {
    empresaId: number;
    dateISO?: ISO | null;
    durationMin: number;
    bufferMin?: number | null;
    staffIdsPreferred?: number[] | null;
    period?: DayPeriod | null;
    preferredHour?: number | null;
    preferredMinute?: number | null;
}): Promise<FreeSlot | null> {
    const {
        empresaId, dateISO, durationMin,
        bufferMin, staffIdsPreferred, period,
        preferredHour, preferredMinute
    } = args;

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

            // preferencia de hora dentro del día
            if (typeof preferredHour === "number") {
                const pref = new Date(day);
                pref.setHours(preferredHour, preferredMinute ?? 0, 0, 0);
                if (isAfter(pref, block.start) && isBefore(pref, block.end)) {
                    cursor = new Date(pref);
                }
            }

            // si es hoy, ahora+buffer
            const today = utcToZonedTime(new Date(), TZ);
            if (cursor.toDateString() === today.toDateString()) {
                const nowPlus = addMinutes(today, clamp(safeBuffer, 0, 240));
                if (isAfter(nowPlus, cursor)) cursor = nowPlus;
            }

            for (; isBefore(addMinutes(cursor, durationMin), block.end) || isEqual(addMinutes(cursor, durationMin), block.end); cursor = addMinutes(cursor, GRAN_MIN)) {
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

/** Validación de disponibilidad real */
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

/* ======================== Motor principal ======================== */
export async function handleScheduleTurn(
    args: { empresaId: number; conversationId: number; userText: string; }
): Promise<BotReply> {
    const { empresaId, conversationId, userText } = args;

    const kbOrNull = await loadEsteticaKB({ empresaId });
    if (!kbOrNull) {
        return { text: "Por ahora no tengo la configuración de la clínica para ofrecer horarios. Puedo pasarte con un asesor humano." };
    }

    const kb: EsteticaKB = kbOrNull;
    const state = await loadConvState(conversationId);
    const rules = getRules(kb);

    const intent: FlowIntent =
        detectIntent(userText) ?? state.intent ?? (wantsMostRecent(userText) ? "BOOK" : "ASK_SLOTS");

    const service = state.serviceCandidate ?? getServiceCandidate(kb, userText);
    const durationMin = service.durationMin ?? kb.defaultServiceDurationMin ?? 60;

    if (intent === "CANCEL") return await flowCancel({ empresaId, conversationId, userText, state });
    if (intent === "RESCHEDULE") return await flowReschedule({ empresaId, conversationId, userText, state, durationMin });

    return await flowBooking({ empresaId, conversationId, userText, state, service, durationMin, rules });
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
    const dateISO = parsed.dateISO ?? state.dateRequest?.dateISO ?? null;
    const period = parsed.period ?? state.dateRequest?.period ?? null;

    // 🔁 CONFIRMAR SLOT YA PROPUESTO: si hay propuesta en state y llega identidad/afirmación
    if (state.proposedSlot?.startISO && !/otro|otra|cambiar|m[aá]s tarde|m[aá]s temprano/i.test(userText)) {
        const idtNow = extractIdentity(userText);
        const name = idtNow.name ?? state.identity?.name ?? null;
        const phone = idtNow.phone ?? state.identity?.phone ?? null;

        if (name || phone || isAffirm(userText)) {
            if (!name || !phone) {
                const ns: ConversationState = {
                    ...state,
                    intent: "BOOK",
                    identity: { name: name ?? null, phone: phone ?? null },
                };
                ns.summaryText = makeSummary(ns);
                await saveConvState(conversationId, ns);
                return { text: `Perfecto. Para confirmar *${fmtHuman(state.proposedSlot.startISO)}*, ¿me compartes *nombre* y *teléfono*?`, updatedState: ns };
            }

            // commit usando el slot ya propuesto
            const commit = await book({
                empresaId,
                serviceId: service.id ?? null,
                serviceName: service.name ?? "Servicio",
                serviceDurationMin: durationMin,
                startISO: state.proposedSlot.startISO!,
                endISO: state.proposedSlot.endISO!,
                customerName: name,
                customerPhone: phone,
                staffId: state.proposedSlot.staffId ?? null,
                source: "chat",
            });

            if (commit.ok) {
                const done: ConversationState = {
                    ...state,
                    identity: { name, phone },
                    commitTrace: { lastAction: "booked", appointmentId: commit.appointmentId, at: nowISO() },
                };
                done.summaryText = makeSummary(done);
                await saveConvState(conversationId, done);

                const priceLabel = service.priceMin ? ` (Desde ${formatCOP(service.priceMin)} COP)` : "";
                return { text: `¡Listo! Agendé *${service.name ?? "tu servicio"}${priceLabel}* para *${fmtHuman(state.proposedSlot.startISO)}*. ¿Deseas agregar notas?`, updatedState: done };
            }
        }
    }

    // Si no hay fecha y tampoco “lo más pronto”, preguntar
    if (!dateISO && !nearest) {
        const next: ConversationState = { ...state, intent: "BOOK", serviceCandidate: service };
        next.summaryText = makeSummary(next);
        await saveConvState(conversationId, next);
        return {
            text: `¿Tienes un día en mente para *${service.name ?? "el servicio"}*? Puedo revisar disponibilidad. Si prefieres, te propongo *lo más pronto posible*.`,
            quickReplies: ["Hoy en la tarde", "Mañana", "Este sábado", "Lo más pronto"],
            updatedState: next,
        };
    }

    // Buscar slot
    const slot = await findFirstFreeSlot({
        empresaId,
        dateISO: nearest ? null : dateISO,
        durationMin,
        bufferMin: rules.bufferMin,
        staffIdsPreferred: service.requiresStaffIds ?? null,
        period: period ?? null,
        preferredHour: parsed.preferredHour ?? state.dateRequest?.preferredHour ?? null,
        preferredMinute: parsed.preferredMinute ?? state.dateRequest?.preferredMinute ?? null,
    });

    const nextBase: ConversationState = {
        ...state,
        intent: "BOOK",
        serviceCandidate: service,
        dateRequest: {
            raw: userText ?? state.dateRequest?.raw ?? null,
            dateISO,
            period: period ?? null,
            preferredHour: parsed.preferredHour ?? state.dateRequest?.preferredHour ?? null,
            preferredMinute: parsed.preferredMinute ?? state.dateRequest?.preferredMinute ?? null,
        },
    };

    if (!slot) {
        const next: ConversationState = {
            ...nextBase,
            proposedSlot: { startISO: null, endISO: null, staffId: null, reason: nearest ? "first_free_slot" : "user_requested_date" },
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

    // Guardar propuesta
    const proposed: ConversationState = {
        ...nextBase,
        proposedSlot: {
            startISO: slot.startISO,
            endISO: slot.endISO,
            staffId: slot.staffId ?? null,
            reason: nearest ? "first_free_slot" : "user_requested_date",
        },
    };
    proposed.summaryText = makeSummary(proposed);
    await saveConvState(conversationId, proposed);

    // Intentar commit si en este turno ya llegaron datos
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
            return { text: `¡Listo! Agendé *${service.name ?? "tu servicio"}${priceLabel}* para *${fmtHuman(slot.startISO)}*.`, updatedState: done };
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
    if (!active) return { text: `No encuentro una cita activa vinculada a *${phone}*. ¿Deseas buscar por otro número?` };

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
        preferredHour: parsed.preferredHour ?? null,
        preferredMinute: parsed.preferredMinute ?? null,
    });
    if (!slot) return { text: `No encuentro disponibilidad para esa fecha/franja. ¿Probamos otra fecha o “lo más pronto”?` };

    const ok = await validateAvailability({ empresaId, startISO: slot.startISO, endISO: slot.endISO, staffId: slot.staffId ?? undefined });
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

/* ======================== Helpers precio ======================== */
function formatCOP(value?: number | null): string | null {
    if (value == null || isNaN(Number(value))) return null;
    return new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(Number(value));
}
