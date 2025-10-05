// utils/ai/strategies/esteticaModules/domain/router.estetica.ts
// Router minimal para el full-agent unificado.
// Delegamos la respuesta al agente y devolvemos solo el texto.

import { runEsteticaAgent, type ChatTurn } from "./estetica.agent"
import type { EsteticaCtx } from "./estetica.rag"

export async function routeEsteticaTurn(
    ctx: EsteticaCtx,
    conversationId: number,
    userText: string,
    extras?: { history?: ChatTurn[]; phone?: string }
): Promise<{ text: string }> {
    const turns: ChatTurn[] = [
        ...(extras?.history ?? []),
        { role: "user", content: userText },
    ]

    const text = await runEsteticaAgent(
        { ...ctx, __conversationId: conversationId },
        turns
    )

    return { text }
}
