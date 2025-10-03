// utils/ai/strategies/esteticaModules/assistant/ai.agent.ts
import { openai } from "../../../../../lib/openai";
import type { EsteticaCtx } from "../domain/estetica.rag";
import { toolSpecs, toolHandlers } from "../booking/booking.tools";
import { systemPrompt, buildFewshots } from "./ai.prompts";
import { DBG } from "../../esteticaModules/logger";

const log = DBG("AGENT");

/* ================= Config ================= */
const MODEL = process.env.ESTETICA_MODEL || "gpt-4o-mini";
const TEMPERATURE = Number(process.env.IA_TEMPERATURE ?? 0.35);

/* ================ Tipos locales ================ */
export type ChatTurn = { role: "user" | "assistant"; content: string };

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

/* ================ Utilidades de estilo (post-proc) ================ */
const SENTENCE_SPLIT = /(?<=\.)\s+|(?<=\?)\s+|(?<=\!)\s+/g;
const ENDINGS = ["¿Te parece?", "¿Confirmamos?", "¿Te va bien?"];

function dedupSentences(text: string): string {
    const parts = text
        .split(SENTENCE_SPLIT)
        .map((s) => s.trim())
        .filter(Boolean);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of parts) {
        const key = p.toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            out.push(p);
        }
    }
    return out.join(" ");
}

function rotateClosing(prev: string | undefined, idxSeed = 0): string {
    const base = prev?.trim() || "";
    if (!base) return "";
    const last = base[base.length - 1];
    if (["?", "!", "…"].includes(last)) return "";
    const pick = (idxSeed % ENDINGS.length + ENDINGS.length) % ENDINGS.length;
    return (base.endsWith(".") ? " " : ". ") + ENDINGS[pick];
}

function postProcessReply(reply: string, history: ChatTurn[]): string {
    const clean = dedupSentences(reply.trim());
    const lastAssistant = [...history].reverse().find((h) => h.role === "assistant")
        ?.content?.trim();
    if (
        lastAssistant &&
        clean.toLowerCase() === lastAssistant.toLowerCase()
    ) {
        return clean + rotateClosing(clean, Math.floor(Math.random() * 3) + 1);
    }
    return clean + rotateClosing(clean, history.length);
}

/* ================ Serialización segura de args ================ */
function safeParseArgs(raw?: string) {
    if (!raw) return {};
    try {
        return JSON.parse(raw);
    } catch {
        return {};
    }
}

/* ================ Política de reintentos ================ */
const NO_RETRY_TOOLS = new Set(["book", "reschedule", "cancel", "cancelMany"]);

async function executeToolOnce(
    ctx: EsteticaCtx,
    toolName: string,
    args: any,
    conversationId?: number
) {
    const handlers = toolHandlers(ctx, { conversationId });
    if (typeof (handlers as any)[toolName] !== "function") {
        return { ok: false, error: "TOOL_NOT_FOUND" };
    }
    try {
        const res = await (handlers as any)[toolName](args);
        return res ?? { ok: false, error: "NO_RESULT" };
    } catch (e: any) {
        return { ok: false, error: e?.message || "TOOL_ERROR" };
    }
}

async function executeToolWithPolicy(
    ctx: EsteticaCtx,
    call: { id: string; name: string; args: any },
    conversationId?: number
): Promise<ToolMsg> {
    let result = await executeToolOnce(ctx, call.name, call.args, conversationId);

    // Solo reintenta si es lectura y falló claramente
    if (
        !NO_RETRY_TOOLS.has(call.name) &&
        (!result || (result as any).ok === false || (result as any).error)
    ) {
        result = await executeToolOnce(ctx, call.name, call.args, conversationId);
    }

    const preview = JSON.stringify(result ?? null).slice(0, 300);
    log.info("tool.result", call.name, preview);
    return {
        role: "tool",
        content: JSON.stringify(result ?? null),
        tool_call_id: call.id,
    };
}

/* ================ Orquestador principal ================ */
export async function runEsteticaAgent(
    ctx: EsteticaCtx & { __conversationId?: number },
    turns: ChatTurn[],
    extras?: { phone?: string; conversationId?: number }
): Promise<string> {
    const sys = systemPrompt(ctx);
    const fewshots = buildFewshots(ctx);
    const kb = (await ctx.buildKbContext?.()) ?? "";

    const cleanTurns: ChatTurn[] = (turns || []).filter(
        (t): t is ChatTurn => !!t && (t.role === "user" || t.role === "assistant")
    );

    const baseMessages = [
        { role: "system", content: `${sys}\n\n### Conocimiento de la clínica\n${kb}` },
        ...(fewshots as any),
        ...cleanTurns,
    ] as any;

    log.info("prompt.meta", {
        sysLen: sys.length,
        kbLen: kb?.length ?? 0,
        fewshots: fewshots.length,
        turns: cleanTurns.length,
    });
    log.info(
        "last.user",
        cleanTurns.length > 0
            ? cleanTurns[cleanTurns.length - 1]?.content?.slice(0, 220)
            : null
    );

    // 1) Planificación + tool calls
    const result = await openai.chat.completions.create({
        model: MODEL,
        temperature: TEMPERATURE,
        messages: baseMessages,
        tools: toolSpecs as any,
        tool_choice: "auto",
    } as any);

    const msg = (result.choices?.[0]?.message || {}) as AssistantMsg;
    log.info(
        "tool_calls?",
        Array.isArray(msg.tool_calls)
            ? msg.tool_calls.map((c) => c.function?.name)
            : "none"
    );

    // 2) Si hay tools → ejecutar con política
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
        const calls = msg.tool_calls.map((c) => ({
            id: c.id,
            name: c.function.name,
            args: safeParseArgs(c.function.arguments),
        }));
        log.info("tool.args", calls.map((c) => ({ name: c.name, args: c.args })));

        const toolMsgs: ToolMsg[] = [];
        for (const call of calls) {
            const toolMsg = await executeToolWithPolicy(
                ctx,
                call,
                extras?.conversationId ?? ctx.__conversationId
            );
            toolMsgs.push(toolMsg);
        }

        // 3) Segunda vuelta con resultados
        const follow = await openai.chat.completions.create({
            model: MODEL,
            temperature: TEMPERATURE,
            messages: [
                { role: "system", content: `${sys}\n\n### Conocimiento de la clínica\n${kb}` },
                ...(fewshots as any),
                ...cleanTurns,
                msg as any,
                ...toolMsgs,
            ] as any,
        } as any);

        const raw = follow.choices?.[0]?.message?.content?.trim() || "";
        log.info("final.reply.preview", raw.slice(0, 240));
        return postProcessReply(
            raw || "¿Quieres que te comparta horarios desde mañana o prefieres más información?",
            cleanTurns
        );
    }

    // 4) Sin tools
    const direct = (msg.content || "").trim();
    log.info("no-tools.reply.preview", direct.slice(0, 240));
    const finalText =
        direct ||
        "¿Quieres que te comparta horarios desde mañana o prefieres más información?";
    return postProcessReply(finalText, cleanTurns);
}
