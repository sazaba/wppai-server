// utils/ai/strategies/esteticaModules/booking/booking.router.ts
import type { EsteticaCtx } from "../domain/estetica.rag";
import { newSession, stepBooking, type BookingSession } from "./booking.machine";

// Intención muy simple (puedes mejorarlo con tu `estetica.intents.ts`)
const AGENDA_PATTERNS = [
    /agendar|cita|agenda|reserv(ar|a)/i,
    /horarios|disponibles|cupos|agenda/i,
    /reagendar|cambiar cita|mover/i,
    /cancelar cita/i,
];

export function detectAgendaIntent(text: string) {
    return AGENDA_PATTERNS.some((r) => r.test(text));
}

export type SessionStore = {
    get: (key: string) => Promise<BookingSession | null>;
    set: (key: string, s: BookingSession) => Promise<void>;
    clear: (key: string) => Promise<void>;
};

// entrada principal del “bot de agenda”
export async function handleAgendaTurn(
    ctx: EsteticaCtx,
    store: SessionStore,
    userId: string,              // usa phone E164 o conversationId como key
    text: string,
    extras?: { phone?: string; conversationId?: number }
): Promise<string | null> {
    if (!detectAgendaIntent(text)) return null;

    let ses = (await store.get(userId)) || newSession();
    const { reply, session } = await stepBooking(ctx, text, ses, extras);
    await store.set(userId, session);
    if (session.state === "done") {
        await store.clear(userId);
    }
    return reply;
}
