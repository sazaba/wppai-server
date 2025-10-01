// utils/ai/strategies/esteticaModules/assistant/ai.agent.ts
import { openai } from "../../../../../lib/openai";
import type { EsteticaCtx } from "../estetica.rag";
import { toolSpecs, toolHandlers } from "../assistant/ai.tools";
import { systemPrompt } from "./ai.prompts";

const MODEL = process.env.ESTETICA_MODEL || "gpt-4o-mini";
const TEMPERATURE = Number(process.env.IA_TEMPERATURE ?? 0.35);

// En la PRIMER llamada, el SDK no permite role "tool"
export type ChatTurn = { role: "user" | "assistant"; content: string };

// Para la segunda vuelta sí vamos a mandar mensajes "tool"
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

/**
 * Orquesta conversación estética:
 * - Usa systemPrompt como cerebro
 * - Permite que el modelo decida usar tools o responder directo
 * - Nunca inventa servicios fuera de BD
 */
export async function runEsteticaAgent(
    ctx: EsteticaCtx,
    turns: ChatTurn[],
    _extras?: { phone?: string }
): Promise<string> {
    const sys = systemPrompt(ctx);

    // Filtra por seguridad cualquier "tool" que se haya colado
    const cleanTurns: ChatTurn[] = (turns || []).filter(
        (t): t is ChatTurn => t && (t.role === "user" || t.role === "assistant")
    );

    // -------- 1) Planificación / decisión de tool-calls --------
    const result = await openai.chat.completions.create({
        model: MODEL,
        temperature: TEMPERATURE,
        messages: [{ role: "system", content: sys }, ...cleanTurns] as any,
        tools: toolSpecs as any,
        tool_choice: "auto",
    } as any);

    const msg = (result.choices?.[0]?.message || {}) as AssistantMsg;

    // -------- 2) Si hay tool calls, ejecuta y hace follow-up --------
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
        const handlers = toolHandlers(ctx);
        const toolMsgs: ToolMsg[] = [];

        for (const call of msg.tool_calls) {
            const toolName = call.function.name as keyof ReturnType<typeof toolHandlers>;
            let args: any = {};
            try {
                args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
            } catch {
                args = {};
            }

            let toolResponse: unknown;
            try {
                // índice dinámico controlado
                toolResponse = await handlers[toolName](args);
            } catch (e: any) {
                toolResponse = { ok: false, error: e?.message || "TOOL_ERROR" };
            }

            toolMsgs.push({
                role: "tool",
                content: JSON.stringify(toolResponse ?? null),
                tool_call_id: call.id,
            });
        }

        // Segunda vuelta: redactar respuesta final con resultados de tools
        const follow = await openai.chat.completions.create({
            model: MODEL,
            temperature: TEMPERATURE,
            messages: [
                { role: "system", content: sys },
                ...cleanTurns,
                msg as any,   // assistant con tool_calls
                ...toolMsgs,  // respuestas de las tools
            ] as any,
        } as any);

        const out =
            follow.choices?.[0]?.message?.content?.trim() ||
            "¿Quieres que te muestre horarios o prefieres más información?";
        return out;
    }

    // -------- 3) No hubo tools → respuesta directa --------
    const direct =
        (msg.content || "").trim() ||
        "¿Quieres que te muestre horarios o prefieres más información?";
    return direct;
}
