// utils/ai/strategies/esteticaModules/booking/booking.machine.ts
import type { EsteticaCtx } from "../domain/estetica.rag";
import { buildPolicy } from "./booking.policy";
import { apiFindSlots, apiBook } from "./booking.tools";
import { formatSlotsPretty } from "./booking.presenter";
import { parseDatePref, validateService, normalizePhone, DayPart } from "./booking.validators";

export type BookingState =
    | "idle"
    | "need_service"
    | "need_date"
    | "show_slots"
    | "need_identity"
    | "confirm"
    | "done";

export type BookingSession = {
    state: BookingState;
    serviceId?: number;
    serviceName?: string;
    durationMin?: number;
    dayPart?: DayPart;
    slots?: { idx: number; startISO: string; startLabel: string }[];
    selectedIdx?: number;
    fullName?: string;
    phone?: string;
};

export function newSession(): BookingSession {
    return { state: "need_service" };
}

export async function stepBooking(
    ctx: EsteticaCtx,
    userText: string,
    session: BookingSession,
    extras?: { phone?: string; conversationId?: number }
): Promise<{ reply: string; session: BookingSession }> {
    const policy = buildPolicy(ctx);

    // 1) estado: need_service
    if (session.state === "need_service") {
        const svc = await validateService(ctx, { serviceId: session.serviceId, name: session.serviceName || userText });
        if (!svc) {
            return {
                session,
                reply: "¿Para cuál servicio deseas agendar? (por ej.: **Limpieza facial**, **Peeling suave**, **Toxina botulínica**)",
            };
        }
        session.serviceId = svc.id;
        session.serviceName = svc.name;
        session.durationMin = svc.durationMin;
        session.state = "need_date";
    }

    // 2) estado: need_date
    if (session.state === "need_date") {
        const pref = parseDatePref(userText, policy.tz);
        session.dayPart = pref.dayPart;
        // pedir slots
        const res = await apiFindSlots(ctx, {
            serviceId: session.serviceId,
            serviceName: session.serviceName,
            fromISO: pref.fromISO,
            max: 8,
        });
        const slots = res.ok ? res.slots : [];
        session.slots = slots;

        if (!slots.length) {
            return {
                session,
                reply: "No veo cupos en esa fecha/franja. ¿Te muestro otras opciones (por ejemplo **próxima semana** o **jueves en la tarde**)?",
            };
        }
        session.state = "show_slots";
    }

    // 3) estado: show_slots → leer número
    if (session.state === "show_slots") {
        // si el usuario ya había pedido slots, quizá ahora manda "2"
        const pick = Number(userText.trim());
        if (!Number.isFinite(pick) || !session.slots?.some(s => s.idx === pick)) {
            // presentar bonitos
            return {
                session,
                reply: formatSlotsPretty(session.slots!, policy.tz, `Opciones para **${session.serviceName}**:`),
            };
        }
        session.selectedIdx = pick;
        session.state = "need_identity";
    }

    // 4) estado: need_identity → nombre + teléfono
    if (session.state === "need_identity") {
        // intentar extraer teléfono si lo envía junto
        const phone = normalizePhone(userText) || extras?.phone || session.phone;
        const name = session.fullName || (userText.replace(/\d+/g, "").trim() || undefined);

        if (!session.fullName && name && name.length >= 2) session.fullName = name;
        if (!session.phone && phone) session.phone = phone;

        if (!session.fullName) {
            return {
                session,
                reply: "Antes de reservar necesito el **nombre completo** para la ficha. ¿A nombre de quién agendamos?",
            };
        }
        if (!session.phone) {
            return {
                session,
                reply: "Perfecto. Ahora necesito un **teléfono de contacto** (solo números).",
            };
        }

        session.state = "confirm";
    }

    // 5) estado: confirm → resumen
    if (session.state === "confirm") {
        const picked = session.slots!.find(s => s.idx === session.selectedIdx)!;
        const summary = `Para confirmar: **${session.serviceName}** el **${picked.startLabel}** a nombre de **${session.fullName}** (tel. ${session.phone}). ¿Confirmas?`;
        // si el usuario ya dijo "sí/ok" en este turno
        if (/\b(s[ií]|ok|dale|confirmo|perfecto|listo)\b/i.test(userText)) {
            // ejecutar book
            const out = await apiBook(ctx, {
                serviceId: session.serviceId,
                serviceName: session.serviceName,
                startISO: picked.startISO,
                fullName: session.fullName!,
                phone: session.phone!,
                durationMin: session.durationMin,
            }, { conversationId: extras?.conversationId });

            if (!out.ok) {
                return { session, reply: "Hubo un problema al reservar. ¿Intento con otro horario o lo dejo en manos de un agente humano?" };
            }
            session.state = "done";
            return {
                session,
                reply: `✅ Tu cita de **${session.serviceName}** quedó para **${out.data.startLabel}**. Te enviaremos recordatorio. ¿Necesitas algo más?`,
            };
        }
        return { session, reply: summary };
    }

    // 6) done
    return { session, reply: "Listo ✅" };
}
