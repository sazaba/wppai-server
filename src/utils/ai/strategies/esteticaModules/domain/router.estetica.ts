// utils/ai/strategies/esteticaModules/router.estetica.ts
import type { EsteticaCtx } from "./estetica.rag";
import { detectIntent, EsteticaIntent } from "./estetica.intents";
import { handleBookingTurn } from "../booking/booking.bot";
import { runEsteticaAgent, type ChatTurn } from "../assistant/ai.agent";

/**
 * Router híbrido:
 *  - BOOK / RESCHEDULE / CANCEL / LIST → bot determinista (agenda)
 *  - ASK_SERVICES / GENERAL_QA / otros → agente (full-agent)
 */
export async function routeEsteticaTurn(
    ctx: EsteticaCtx,
    conversationId: number,
    userText: string,
    extras?: { history?: ChatTurn[]; phone?: string; conversationId?: number }
): Promise<{ text: string }> {

    const intent = await detectIntent(userText, ctx);

    switch (intent.type) {
        case EsteticaIntent.BOOK:
        case EsteticaIntent.RESCHEDULE:
        case EsteticaIntent.CANCEL:
        case EsteticaIntent.LIST: {
            const { reply } = await handleBookingTurn(ctx, conversationId, userText, { conversationId });
            return { text: reply };
        }

        case EsteticaIntent.ASK_SERVICES:
        case EsteticaIntent.GENERAL_QA:
        default: {
            const turns: ChatTurn[] = [
                ...(extras?.history ?? []),
                { role: "user", content: userText }
            ];
            const reply = await runEsteticaAgent(ctx as any, turns, { phone: extras?.phone, conversationId });
            return { text: reply };
        }
    }
}
