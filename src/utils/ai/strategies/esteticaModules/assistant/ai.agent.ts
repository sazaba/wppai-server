// utils/ai/strategies/esteticaModules/assistant/ai.agent.ts
import { openai } from "../../../../../lib/openai";
import type { EsteticaCtx } from "../estetica.rag";
import { toolSpecs, toolHandlers } from "./ai.tools";
import { systemPrompt } from "./ai.prompts";

const MODEL = process.env.ESTETICA_MODEL || "gpt-4o-mini";
const TEMPERATURE = Number(process.env.IA_TEMPERATURE ?? 0.35);

// Primera llamada no acepta role "tool"
export type ChatTurn = { role: "user" | "assistant"; content: string };

// Para la segunda vuelta sí mandamos "tool"
type ToolMsg = { role: "tool"; content: string; tool_call_id: string };

// Mensaje assistant con tool_calls
type AssistantMsg = {
    role: "assistant";
    content?: string | null;
    tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
    }>;
};

/* --- formatter corto + emoji (igual que tu core) --- */
const IA_MAX_LINES = Number(process.env.IA_MAX_LINES ?? 5);
const IA_MAX_CHARS = Number(process.env.IA_MAX_CHARS ?? 1000);
const IA_ALLOW_EMOJI = (process.env.IA_ALLOW_EMOJI ?? "1") === "1";

function clampConcise(text: string, maxLines = IA_MAX_LINES): string {
    let t = String(text || "").replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    if (!t) return t;
    const lines = t.split("\n").filter(Boolean);
    if (lines.length > maxLines) {
        t = lines.slice(0, maxLines).join("\n").trim();
        if (!/[.!?…]$/.test(t)) t += "…";
    }
    return t;
}
function closeNicely(raw: string) {
    let t = (raw || "").trim();
    if (!t) return t;
    if (/[.!?…]\s*$/.test(t)) return t;
    t = t.replace(/\s+[^\s]*$/, "").trim();
    return t ? `${t}…` : raw.trim();
}
function formatConcise(text: string, maxLines = IA_MAX_LINES, maxChars = IA_MAX_CHARS, allowEmoji = IA_ALLOW_EMOJI) {
    let t = String(text || "").trim();
    if (!t) return "Gracias por escribirnos. ¿Cómo puedo ayudarte?";
    t = t.replace(/^[•\-]\s*/gm, "").replace(/\s+\n/g, "\n").replace(/\n{2,}/g, "\n").trim();
    t = t.length > maxChars ? t.slice(0, maxChars - 1) + "…" : t;
    t = clampConcise(t, maxLines);
    if (allowEmoji && !/[^\w\s.,;:()¿?¡!…]/.test(t)) {
        const EMOJIS = ["🙂", "💡", "👌", "✅", "✨", "💬", "🫶"];
        t = `${t} ${EMOJIS[Math.floor(Math.random() * EMOJIS.length)]}`;
        t = clampConcise(t, maxLines);
    }
    return t;
}
const finalize = (s: string) => formatConcise(closeNicely(s));

/**
 * Orquesta la conversación con política TOOLS-FIRST.
 * - 1ª pasada: que el modelo decida qué tools llamar
 * - Ejecutamos handlers
 * - 2ª pasada: redacta respuesta final
 */
export async function runEsteticaAgent(
    ctx: EsteticaCtx,
    turns: ChatTurn[],
    _extras?: { phone?: string }
): Promise<string> {
    const sys = systemPrompt(ctx);

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
                // Índice dinámico controlado
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
                msg as any, // assistant con tool_calls
                ...toolMsgs, // respuestas de las tools
            ] as any,
        } as any);

        const out =
            follow.choices?.[0]?.message?.content?.trim() ||
            "¿Quieres que te muestre horarios o prefieres más información?";
        return finalize(out);
    }

    // -------- 3) No hubo tools → respuesta directa --------
    const direct =
        (msg.content || "").trim() ||
        "¿Quieres que te muestre horarios o prefieres más información?";
    return finalize(direct);
}
