import type { EsteticaCtx } from "../domain/estetica.rag";
import { getBookingSession, setBookingSession, clearBookingSession, type BookingState } from "./session.store";
import { apiFindSlots, apiBook, resolveService } from "./booking.tools";

/* ====== helpers ====== */
const NUM_RE = /\b(\d{1,2})\b/;
const PHONE_RE = /(\+?\d[\d\s\-().]{6,})/;

function norm(t: string) {
    return String(t || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .trim();
}

/** Sinónimos locales → nombre normalizado */
const SERVICE_SYNONYMS: Record<string, string> = {
    "botox": "toxina botulínica",
    "boto x": "toxina botulínica",
    "bótox": "toxina botulínica",
    "toxina": "toxina botulínica",
    "toxinabotulinica": "toxina botulínica",
    "botulinica": "toxina botulínica",
    "botulínica": "toxina botulínica",
    "relleno": "rellenos dérmicos",
    "acido hialuronico": "rellenos dérmicos",
    "ácido hialurónico": "rellenos dérmicos",
    "peeling": "peeling químico",
    "limpieza": "limpieza facial",
};
function normalizeServiceName(raw: string) { const key = norm(raw); return SERVICE_SYNONYMS[key] ?? raw; }

/* ======== fechas “naturales” + fecha explícita “6 de octubre” ======== */
const MONTHS: Record<string, number> = {
    enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
    julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12
};

function fmtYMD(d: Date, tz: string) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
function makeZonedDate(tz: string, y: number, m: number, d: number, hh = 0, mm = 0) {
    const guess = new Date(Date.UTC(y, m - 1, d, hh, mm));
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(guess);
    const gotH = Number(parts.find(p => p.type === "hour")?.value ?? "0");
    const gotM = Number(parts.find(p => p.type === "minute")?.value ?? "0");
    const delta = (hh * 60 + mm) - (gotH * 60 + gotM);
    return new Date(guess.getTime() + delta * 60000);
}
function startOfDayTZ(d: Date, tz: string) {
    const [y, m, dd] = fmtYMD(d, tz).split("-").map(Number);
    return makeZonedDate(tz, y, m, dd, 0, 0);
}
function addDays(d: Date, days: number) { return new Date(d.getTime() + days * 86400000); }
function weekdayIdx(d: Date, tz: string) {
    const w = new Intl.DateTimeFormat("es-ES", { timeZone: tz, weekday: "long" }).format(d).toLowerCase();
    const map: any = { domingo: 0, lunes: 1, martes: 2, miércoles: 3, miercoles: 3, jueves: 4, viernes: 5, sábado: 6, sabado: 6 };
    return map[w] ?? 0;
}
function nextWeekday(from: Date, tz: string, targetDow: number) {
    let d = startOfDayTZ(from, tz);
    for (let i = 0; i < 14; i++) { if (weekdayIdx(d, tz) === targetDow) return d; d = addDays(d, 1); }
    return d;
}

/** Devuelve fromYMD (YYYY-MM-DD) en TZ si reconoce la fecha */
function parseWhenHint(text: string, tz: string): string | null {
    const t = norm(text);

    const today = startOfDayTZ(new Date(), tz);

    // relativos
    if (/\bhoy\b/.test(t)) return fmtYMD(today, tz);
    if (/\bmanana\b/.test(t)) return fmtYMD(addDays(today, 1), tz);
    if (/\bpasado\s+manana\b/.test(t)) return fmtYMD(addDays(today, 2), tz);
    if (/\b(otra|proxima|pr[oó]xima|siguiente)\s+semana\b/.test(t)) {
        const dow = weekdayIdx(today, tz);
        const daysToNextMonday = ((1 - dow + 7) % 7) || 7;
        return fmtYMD(addDays(today, daysToNextMonday), tz);
    }

    // explícita: “lunes 6 de octubre”, “6 de octubre”, “6/10/2025”
    const m1 = t.match(/\b(lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo)?\s*(\d{1,2})\s*de\s*(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)(?:\s*de\s*(\d{4}))?\b/);
    if (m1) {
        const day = Number(m1[2]);
        const month = MONTHS[m1[3] as keyof typeof MONTHS];
        const year = m1[4] ? Number(m1[4]) : Number(fmtYMD(today, tz).slice(0, 4));
        const d = makeZonedDate(tz, year, month, day, 0, 0);
        return fmtYMD(d, tz);
    }
    const m2 = t.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{4}))?\b/); // 6/10[/2025]
    if (m2) {
        const day = Number(m2[1]), month = Number(m2[2]), year = m2[3] ? Number(m2[3]) : Number(fmtYMD(today, tz).slice(0, 4));
        const d = makeZonedDate(tz, year, month, day, 0, 0);
        return fmtYMD(d, tz);
    }

    // “próximo lunes”, “este viernes”
    const wd = t.match(/\b(proximo|pr[oó]ximo|este)?\s*(lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo)\b/);
    if (wd) {
        const targetMap: any = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, miércoles: 3, jueves: 4, viernes: 5, sabado: 6, sábado: 6 };
        const target = targetMap[wd[2]];
        return fmtYMD(nextWeekday(addDays(today, 1), tz, target), tz);
    }

    return null;
}

function listToMessage(slots: { idx: number; startLabel: string }[]) {
    const l = slots.slice(0, 6).map(s => `${s.idx}) ${s.startLabel}`).join("\n");
    return `Disponibilidad:\n${l}\n\nResponde con el número (1–${slots.length}) o dime otra fecha.`;
}

type FindSlotsPayload = Parameters<typeof apiFindSlots>[1];
async function findWithFallback(ctx: EsteticaCtx, args: { serviceId: number; serviceName: string; fromISO?: string | null }) {
    const firstArgs: FindSlotsPayload = args.fromISO ? { serviceId: args.serviceId, serviceName: args.serviceName, fromISO: args.fromISO } : { serviceId: args.serviceId, serviceName: args.serviceName };
    const first = await apiFindSlots(ctx, firstArgs);
    if (first.ok && first.slots.length > 0) return first;
    const second = await apiFindSlots(ctx, { serviceId: args.serviceId, serviceName: args.serviceName });
    if (second.ok && second.slots.length > 0) return second;
    return first.ok ? first : second;
}

/* ===================== STATE MACHINE ===================== */
export async function handleBookingTurn(
    ctx: EsteticaCtx,
    conversationId: number,
    userText: string,
): Promise<{ reply: string; done?: boolean }> {
    let state: BookingState = getBookingSession(conversationId);
    const t = norm(userText);

    // abortar flujo
    if (/\b(cancelar|anular|\bstop\b|salir)\b/.test(t)) {
        clearBookingSession(conversationId);
        return { reply: "Listo, cancelé el proceso. Si quieres, te muestro servicios o cupos disponibles." };
    }

    if (state.step === "idle") {
        const serviceHint = normalizeServiceName(userText);
        const guessSvc = await resolveService(ctx.empresaId, { name: serviceHint });
        const ymd = parseWhenHint(userText, ctx.timezone);

        state = {
            step: guessSvc ? (ymd ? "await_slot" : "await_when") : "await_service",
            serviceId: guessSvc?.id ?? null,
            serviceName: guessSvc?.name ?? null,
            durationMin: guessSvc?.durationMin ?? ctx.rules?.defaultServiceDurationMin ?? 60,
            fromISO: ymd ? `${ymd}T00:00:00` : null,
        };
        setBookingSession(conversationId, state);

        if (!guessSvc) return { reply: "¿Para cuál servicio deseas agendar? (p. ej.: Limpieza facial, Peeling, Toxina botulínica)" };
        if (!ymd) return { reply: `Perfecto, **${guessSvc.name}**. ¿Para qué fecha te gustaría? (“mañana”, “próxima semana” o dime una fecha: 6 de octubre).` };

        const found = await findWithFallback(ctx, { serviceId: state.serviceId!, serviceName: state.serviceName!, fromISO: state.fromISO! });
        if (!found.ok || !found.slots.length) return { reply: "No veo cupos en esa franja. ¿Busco cerca de esa fecha u otra?" };
        state.slots = found.slots; setBookingSession(conversationId, state);
        return { reply: listToMessage(found.slots) };
    }

    if (state.step === "await_service") {
        const svc = await resolveService(ctx.empresaId, { name: normalizeServiceName(userText) });
        if (!svc) return { reply: "No identifiqué ese servicio. Dime el nombre como en el catálogo (p. ej., Limpieza facial)." };
        state.serviceId = svc.id; state.serviceName = svc.name;
        state.durationMin = svc.durationMin ?? ctx.rules?.defaultServiceDurationMin ?? 60;
        state.step = "await_when"; setBookingSession(conversationId, state);
        return { reply: `Súper. ¿Para qué fecha te gustaría **${svc.name}**? (“mañana”, “próxima semana” o una fecha exacta).` };
    }

    if (state.step === "await_when") {
        const ymd = parseWhenHint(userText, ctx.timezone);
        state.fromISO = ymd ? `${ymd}T00:00:00` : undefined;

        const found = await findWithFallback(ctx, { serviceId: state.serviceId!, serviceName: state.serviceName!, fromISO: state.fromISO ?? undefined });
        if (!found.ok || !found.slots.length) return { reply: "No hay cupos justo ahí. ¿Te muestro opciones cercanas?" };
        state.slots = found.slots; state.step = "await_slot"; setBookingSession(conversationId, state);
        return { reply: listToMessage(found.slots) };
    }

    if (state.step === "await_slot") {
        const pick = Number(userText.match(NUM_RE)?.[1] ?? NaN);
        const chosen = state.slots?.find(s => s.idx === pick);
        if (!chosen) return { reply: "Responde con el número de la opción (1–6), o dime otra fecha." };
        state.chosenIdx = chosen.idx; state.step = "await_name_phone"; setBookingSession(conversationId, state);
        return { reply: `Anotado: **${chosen.startLabel}**. Ahora necesito **nombre completo** y **teléfono** para confirmar (puedes enviarlos juntos).` };
    }

    if (state.step === "await_name_phone") {
        const phone = (userText.match(PHONE_RE)?.[1] || "").trim();
        const name = userText.replace(PHONE_RE, "").trim();
        if (!name || !phone) return { reply: "Me faltan ambos datos: **nombre completo** y **teléfono** (ej.: Ana Pérez 3001234567)." };

        const chosen = state.slots?.find(s => s.idx === state.chosenIdx);
        if (!chosen) { state.step = "await_slot"; setBookingSession(conversationId, state); return { reply: "Perdí el número elegido. ¿Me dices 1–6 de nuevo?" }; }

        const booked = await apiBook(ctx, { serviceId: state.serviceId!, serviceName: state.serviceName!, startISO: chosen.startISO, phone, fullName: name, durationMin: state.durationMin ?? undefined }, { conversationId });
        if (!booked.ok) return { reply: "No pude completar la reserva por un tema técnico. ¿Intento otra vez?" };

        clearBookingSession(conversationId);
        const code = `APT-${String(booked.data.id).padStart(4, "0")}`;
        return { reply: `✅ Cita de **${booked.data.serviceName}** confirmada para **${booked.data.startLabel}** (código ${code}). Te enviamos recordatorio. ¿Algo más?`, done: true };
    }

    return { reply: "¿Agendamos una cita? Te muestro cupos y lo dejamos listo." };
}
