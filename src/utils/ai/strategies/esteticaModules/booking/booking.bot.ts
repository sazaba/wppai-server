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
function normalizeServiceName(raw: string) {
    const key = norm(raw);
    return SERVICE_SYNONYMS[key] ?? raw;
}

function parseWhenHint(text: string, tz: string): string | null {
    // Devuelve fromISO (00:00 del día elegido en TZ) o null
    const t = norm(text);

    const fmtYMD = (d: Date) =>
        new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

    const makeZonedDate = (ymd: string, hhmm: string): Date => {
        const [y, m, dd] = ymd.split("-").map(Number);
        const [h, mi] = hhmm.split(":").map(Number);
        const guess = new Date(Date.UTC(y, m - 1, dd, h, mi));
        const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(guess);
        const gotH = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
        const gotM = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
        const delta = h * 60 + mi - (gotH * 60 + gotM);
        return new Date(guess.getTime() + delta * 60000);
    };

    const today = makeZonedDate(fmtYMD(new Date()), "00:00");
    const addDays = (d: Date, days: number) => new Date(d.getTime() + days * 86400000);

    if (/\bhoy\b/.test(t)) return fmtYMD(today);
    if (/\bmanana|mañana\b/.test(t)) return fmtYMD(addDays(today, 1));
    if (/\bpasado\s+manana|pasado\s+mañana\b/.test(t)) return fmtYMD(addDays(today, 2));

    if (/\b(proxima|pr[oó]xima|siguiente)\s+semana\b/.test(t)) {
        // siguiente lunes
        const dow = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).formatToParts(today)
            .find((p) => p.type === "weekday")?.value?.toLowerCase();
        const map: any = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
        const cur = map[String(dow).slice(0, 3)] ?? 0;
        const daysToNextMon = ((1 - cur + 7) % 7) || 7;
        return fmtYMD(addDays(today, daysToNextMon));
    }

    return null;
}

/* ===== presentación con emojis ===== */
const NUM_EMOJI = ["0️⃣", "1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
function listToMessage(slots: { idx: number; startLabel: string }[]) {
    const lines = slots.slice(0, 6).map(s => `${NUM_EMOJI[s.idx] || s.idx}. ${s.startLabel}`);
    return `Estas son las opciones disponibles:\n${lines.join("\n")}\n\nResponde con el número (1–${slots.length}) o dime otra fecha/hora.`;
}

/** Fallback: si la primera búsqueda no trae cupos, intenta sin fromISO (servidor decide) */
type FindSlotsPayload = Parameters<typeof apiFindSlots>[1];

async function findWithFallback(
    ctx: EsteticaCtx,
    args: { serviceId: number; serviceName: string; fromISO?: string | null }
) {
    const firstArgs: FindSlotsPayload =
        args.fromISO && typeof args.fromISO === "string"
            ? { serviceId: args.serviceId, serviceName: args.serviceName, fromISO: args.fromISO }
            : { serviceId: args.serviceId, serviceName: args.serviceName };

    const first = await apiFindSlots(ctx, firstArgs);
    if (first.ok && first.slots.length > 0) return first;

    const second = await apiFindSlots(ctx, {
        serviceId: args.serviceId,
        serviceName: args.serviceName,
    });

    if (second.ok && second.slots.length > 0) return second;

    return first.ok ? first : second;
}

export async function handleBookingTurn(
    ctx: EsteticaCtx,
    conversationId: number,
    userText: string,
    _extras?: { conversationId?: number }
): Promise<{ reply: string; done?: boolean }> {
    let state: BookingState = getBookingSession(conversationId);
    const t = norm(userText);

    // Salidas rápidas
    if (/\b(cancelar|anular|\bstop\b|salir)\b/.test(t)) {
        clearBookingSession(conversationId);
        return { reply: "Sin problema, cancelé el proceso de agendamiento. ¿Deseas ver servicios o resolver alguna duda?" };
    }

    // ====== Step machine ======
    if (state.step === "idle") {
        // intentar detectar servicio + fecha desde el primer mensaje
        const serviceHint = normalizeServiceName(userText);
        const guessSvc = await resolveService(ctx.empresaId, { name: serviceHint });
        const whenYMD = parseWhenHint(userText, ctx.timezone);

        state = {
            step: guessSvc ? (whenYMD ? "await_slot" : "await_when") : "await_service",
            serviceId: guessSvc?.id ?? null,
            serviceName: guessSvc?.name ?? null,
            durationMin: guessSvc?.durationMin ?? ctx.rules?.defaultServiceDurationMin ?? 60,
            fromISO: whenYMD ? `${whenYMD}T00:00:00` : null,
        };
        setBookingSession(conversationId, state);

        if (!guessSvc) {
            return { reply: "¿Para cuál servicio deseas agendar? (por ej.: **Limpieza facial**, **Peeling suave**, **Toxina botulínica**)" };
        }
        if (!whenYMD) {
            return { reply: `Perfecto, **${state.serviceName}**. ¿Para qué fecha te gustaría? Puedes decir “mañana”, “pasado mañana” o “la próxima semana”.` };
        }

        // ya tenemos ambos → buscar slots (con fallback)
        const found = await findWithFallback(ctx, { serviceId: state.serviceId!, serviceName: state.serviceName!, fromISO: state.fromISO! });
        if (!found.ok || !found.slots.length) {
            return { reply: "Por ahora no veo cupos en esa franja. ¿Busco otras fechas u otro horario cercano?" };
        }
        state.slots = found.slots;
        setBookingSession(conversationId, state);
        return { reply: listToMessage(found.slots) };
    }

    if (state.step === "await_service") {
        const serviceHint = normalizeServiceName(userText);
        const svc = await resolveService(ctx.empresaId, { name: serviceHint });
        if (!svc) {
            return { reply: "No encontré ese servicio. Dime el nombre como aparece en el catálogo (p. ej., **Limpieza facial**)." };
        }
        state.serviceId = svc.id;
        state.serviceName = svc.name;
        state.durationMin = svc.durationMin ?? ctx.rules?.defaultServiceDurationMin ?? 60;
        state.step = "await_when";
        setBookingSession(conversationId, state);
        return { reply: `Perfecto, **${svc.name}**. ¿Para qué fecha te gustaría? (“mañana”, “pasado mañana” o “la próxima semana”).` };
    }

    if (state.step === "await_when") {
        const whenYMD = parseWhenHint(userText, ctx.timezone) ?? null;
        state.fromISO = whenYMD ? `${whenYMD}T00:00:00` : undefined;

        const found = await findWithFallback({
            ...ctx,
        } as EsteticaCtx, {
            serviceId: state.serviceId!,
            serviceName: state.serviceName!,
            fromISO: state.fromISO ?? undefined
        });

        if (!found.ok || !found.slots.length) {
            return { reply: "No veo cupos disponibles en esa franja. ¿Intentamos con otra fecha?" };
        }
        state.slots = found.slots;
        state.step = "await_slot";
        setBookingSession(conversationId, state);
        return { reply: listToMessage(found.slots) };
    }

    if (state.step === "await_slot") {
        const pick = Number(userText.match(NUM_RE)?.[1] ?? NaN);
        const chosen = state.slots?.find(s => s.idx === pick);
        if (!chosen) {
            return { reply: "Por favor responde con el número de la opción (por ejemplo, 1️⃣ o 2️⃣). Si prefieres otra fecha, dímela." };
        }
        state.chosenIdx = chosen.idx;
        state.step = "await_name_phone";
        setBookingSession(conversationId, state);
        return { reply: `Anotado: **${chosen.startLabel}**. Ahora necesito el **nombre completo** y el **teléfono** para confirmar (puedes enviarlos en una sola línea).` };
    }

    if (state.step === "await_name_phone") {
        const phone = (userText.match(PHONE_RE)?.[1] || "").trim();
        const name = userText.replace(PHONE_RE, "").trim();
        if (!name || name.length < 2 || !phone) {
            return { reply: "Necesito ambos datos: **nombre completo** y **teléfono**. Ejemplo: Ana Pérez 3001234567" };
        }

        const chosen = state.slots?.find(s => s.idx === state.chosenIdx);
        if (!chosen) {
            state.step = "await_slot";
            setBookingSession(conversationId, state);
            return { reply: "Perdí la selección del horario. Elige de nuevo con el número de opción, por favor." };
        }

        const booked = await apiBook(ctx, {
            serviceId: state.serviceId!, serviceName: state.serviceName!,
            startISO: chosen.startISO, phone, fullName: name, durationMin: state.durationMin ?? undefined
        }, { conversationId });

        if (!booked.ok) {
            return { reply: "No pude completar la reserva por un error técnico. ¿Intento de nuevo?" };
        }

        clearBookingSession(conversationId);
        const code = `APT-${String(booked.data.id).padStart(4, "0")}`;
        return {
            reply: `✅ Tu cita de **${booked.data.serviceName}** quedó confirmada para **${booked.data.startLabel}** (código ${code}). Te llegará un recordatorio automático.`,
            done: true
        };
    }

    // fallback
    return { reply: "¿Deseas agendar una cita? Puedo ayudarte paso a paso." };
}
