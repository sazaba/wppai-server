// utils/ai/strategies/esteticaModules/domain/router.estetica.ts
import type { EsteticaCtx } from "./estetica.rag";
import { runEsteticaAgent, type ChatTurn } from "../assistant/ai.agent";

// 🧠 Bot determinístico de agenda (máquina de estados)
import {
    handleAgendaTurn,
    type SessionStore,
} from "../booking/booking.router";

/**
 * Router híbrido:
 *   1) Primero intenta manejar la INTENCIÓN DE AGENDA con el "full-bot" determinístico.
 *   2) Si no aplica agenda, delega al "full-agent" para conversación/KB.
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
    // 1) Agenda determinística primero
    //    Usamos como clave de sesión el teléfono si lo tenemos, si no el id de conversación.
    const userKey = String(extras?.phone || conversationId);

    const agendaReply = await handleAgendaTurn(
        ctx,
        store,
        userKey,
        userText,
        { phone: extras?.phone, conversationId: extras?.conversationId ?? conversationId }
    );

    if (agendaReply) {
        return { text: agendaReply };
    }

    // 2) Si no fue agenda → agente conversacional (KB, FAQs, etc.)
    const turns: ChatTurn[] = [
        ...(extras?.history ?? []),
        { role: "user", content: userText },
    ];

    const reply = await runEsteticaAgent(
        ctx as any,
        turns,
        { phone: extras?.phone, conversationId }
    );

    return { text: reply };
}
