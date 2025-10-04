// utils/ai/strategies/esteticaModules/booking/booking.router.ts
import type { EsteticaCtx } from "../domain/estetica.rag";
import { detectIntent, EsteticaIntent } from "../domain/estetica.intents";
import { getBookingSession } from "./session.store";
import { handleBookingTurn } from "./booking.bot";

/** Interfaz de SessionStore para compatibilidad con tu router híbrido */
export type SessionStore = {
    get: (key: string) => Promise<any | null>;
    set: (key: string, state: any) => Promise<void>;
    clear: (key: string) => Promise<void>;
};

/**
 * handleAgendaTurn:
 * - Si ya hay sesión activa de agenda → continúa en la máquina de estados.
 * - Si no hay sesión: usa detectIntent; si es BOOK/RESCHEDULE/CANCEL/LIST → entra al bot.
 * - Si no es agenda → devuelve null para que el router envíe al agente general.
 */
export async function handleAgendaTurn(
    ctx: EsteticaCtx,
    store: SessionStore,                // (no lo usamos, pero mantenemos la firma)
    userKey: string,                   // (no lo usamos; la sesión real la maneja session.store.ts)
    userText: string,
    extras: { phone?: string; conversationId: number }
): Promise<string | null> {

    // 1) Sticky: si ya hay sesión de booking, continúa allí
    const active = getBookingSession(extras.conversationId);
    if (active && active.step && active.step !== "idle") {
        const out = await handleBookingTurn(ctx, extras.conversationId, userText, extras);
        return out.reply;
    }

    // 2) Detectar intención para decidir si esto es agenda
    const intent = await detectIntent(userText, ctx);

    const isAgenda =
        intent.type === EsteticaIntent.BOOK ||
        intent.type === EsteticaIntent.RESCHEDULE ||
        intent.type === EsteticaIntent.CANCEL ||
        intent.type === EsteticaIntent.LIST ||
        intent.type === EsteticaIntent.CONFIRM;

    if (!isAgenda) {
        return null; // → no es agenda, que lo atienda el agente general
    }

    // 3) Agenda: pasar por la máquina determinística
    const out = await handleBookingTurn(ctx, extras.conversationId, userText, extras);
    return out.reply;
}
