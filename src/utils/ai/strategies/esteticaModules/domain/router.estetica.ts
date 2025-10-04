// utils/ai/strategies/esteticaModules/domain/router.estetica.ts
import type { EsteticaCtx } from "./estetica.rag";
import { runEsteticaAgent, type ChatTurn } from "../assistant/ai.agent";

// 🧠 Bot determinístico de agenda (máquina de estados)
import {
    handleAgendaTurn,
    type SessionStore,
} from "../booking/booking.router";

// 🔒 Sticky agenda (para no perder el contexto en medio de una cita)
import { getBookingSession } from "../booking/session.store";

/**
 * Router híbrido:
 *   1) Si hay sesión activa de agenda → siempre pasa por el "full-bot" determinístico.
 *   2) Si no hay sesión, intenta agenda; si no aplica → agente (KB).
 *
 * Nota:
 *  - El store acá es in-memory simple (suficiente para una instancia). Si quieres
 *    persistencia multi-proceso, reemplázalo por Redis/DB manteniendo la misma interfaz.
 */

// ---- SessionStore in-memory (simple) ----
const memStore = new Map<string, any>();

const store: SessionStore = {
    async get(key: string) {
        return (memStore.get(key) as any) ?? null;
    },
    async set(key: string, s: any) {
        memStore.set(key, s);
    },
    async clear(key: string) {
        memStore.delete(key);
    },
};

// ---- Router principal ----
export async function routeEsteticaTurn(
    ctx: EsteticaCtx,
    conversationId: number,
    userText: string,
    extras?: { history?: ChatTurn[]; phone?: string; conversationId?: number }
): Promise<{ text: string }> {
    // Clave de sesión para el store del bot (string): usa teléfono si existe, si no el id de conversación
    const userKey = String(extras?.phone || conversationId);

    // 🟢 Sticky agenda:
    // getBookingSession usa NUMBER como clave → usamos el id de conversación numérico.
    const sessionKeyNum = Number(extras?.conversationId ?? conversationId);
    const activeSession = getBookingSession(sessionKeyNum);

    if (activeSession && activeSession.step && activeSession.step !== "idle") {
        const agendaReplySticky = await handleAgendaTurn(
            ctx,
            store,
            userKey, // el store propio del bot sí usa string
            userText,
            { phone: extras?.phone, conversationId: sessionKeyNum }
        );
        if (agendaReplySticky) return { text: agendaReplySticky };
    }

    // 🧠 Intento agenda (aunque no hubiera sesión activa)
    const agendaReply = await handleAgendaTurn(
        ctx,
        store,
        userKey,
        userText,
        { phone: extras?.phone, conversationId: sessionKeyNum }
    );
    if (agendaReply) return { text: agendaReply };

    // 🤖 Si no fue agenda → agente conversacional (KB, FAQs, general)
    const turns: ChatTurn[] = [
        ...(extras?.history ?? []),
        { role: "user", content: userText },
    ];

    const reply = await runEsteticaAgent(
        ctx as any,
        turns,
        { phone: extras?.phone, conversationId: sessionKeyNum }
    );

    return { text: reply };
}
