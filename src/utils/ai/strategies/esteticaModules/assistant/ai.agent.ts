// utils/ai/strategies/esteticaModules/assistant/ai.agent.ts
import { openai } from "../../../../../lib/openai";
import type { EsteticaCtx } from "../estetica.rag";
import { toolSpecs, toolHandlers } from "../assistant/ai.tools";
import { systemPrompt } from "./ai.prompts";

const MODEL = process.env.ESTETICA_MODEL || "gpt-4o-mini";
const TEMPERATURE = Number(process.env.IA_TEMPERATURE ?? 0.35);

// Primer turno (no se usa role "tool")
export type ChatTurn = { role: "user" | "assistant"; content: string };

// Para segunda vuelta sí enviamos mensajes "tool"
type ToolMsg = { role: "tool"; content: string; tool_call_id: string };

type AssistantMsg = {
    role: "assistant";
    content?: string | null;
    tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
    }>;
};

export async function runEsteticaAgent(
    ctx: EsteticaCtx & { __conversationId?: number }, // permitimos inyectar convId
    turns: ChatTurn[],
    extras?: { phone?: string; conversationId?: number }
): Promise<string> {
    const sys = systemPrompt(ctx);

    const cleanTurns: ChatTurn[] = (turns || []).filter(
        (t): t is ChatTurn => t && (t.role === "user" || t.role === "assistant")
    );

    // 1) Planificación + tool calls
    const result = await openai.chat.completions.create({
        model: MODEL,
        temperature: TEMPERATURE,
        messages: [{ role: "system", content: sys }, ...cleanTurns] as any,
        tools: toolSpecs as any,
        tool_choice: "auto",
    } as any);

    const msg = (result.choices?.[0]?.message || {}) as AssistantMsg;

    // 2) Si hay tool calls → ejecutar y hacer follow-up
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
        const handlers = toolHandlers(ctx, { conversationId: extras?.conversationId ?? ctx.__conversationId });
        const toolMsgs: ToolMsg[] = [];

        for (const call of msg.tool_calls) {
            const toolName = call.function.name as keyof ReturnType<typeof toolHandlers>;
            let args: any = {};
            try { args = call.function.arguments ? JSON.parse(call.function.arguments) : {}; } catch { args = {}; }

            let toolResponse: unknown;
            try {
                toolResponse = await (handlers as any)[toolName](args);
            } catch (e: any) {
                toolResponse = { ok: false, error: e?.message || "TOOL_ERROR" };
            }

            toolMsgs.push({
                role: "tool",
                content: JSON.stringify(toolResponse ?? null),
                tool_call_id: call.id,
            });
        }

        // 3) Segunda vuelta con resultados de tools (el prompt ya obliga a NO inventar horas)
        const follow = await openai.chat.completions.create({
            model: MODEL,
            temperature: TEMPERATURE,
            messages: [
                { role: "system", content: sys },
                ...cleanTurns,
                msg as any,
                ...toolMsgs,
            ] as any,
        } as any);

        const out = follow.choices?.[0]?.message?.content?.trim();
        return out || "¿Quieres que te comparta horarios desde mañana o prefieres más información?";
    }

    // 4) Sin tools → respuesta directa
    const direct = (msg.content || "").trim();
    return direct || "¿Quieres que te comparta horarios desde mañana o prefieres más información?";
}
