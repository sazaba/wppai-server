// utils/ai/strategies/esteticaModules/assistant/ai.agent.ts
import { openai } from "../../../../../lib/openai";
import type { EsteticaCtx } from "../estetica.rag";
import { toolSpecs, toolHandlers } from "./ai.tools";
import { systemPrompt, buildFewshots, formatSlotList } from "./ai.prompts";

/* ================= Config ================= */
const MODEL = process.env.ESTETICA_MODEL || "gpt-4o-mini";
const TEMPERATURE = Number(process.env.IA_TEMPERATURE ?? 0.35);

/* ================ Tipos locales ================ */
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
    if (["?", "!", "…"].includes(last)) return ""; // ya cierra natural
    const pick = (idxSeed % ENDINGS.length + ENDINGS.length) % ENDINGS.length;
    return (base.endsWith(".") ? " " : ". ") + ENDINGS[pick];
}

function postProcessReply(reply: string, history: ChatTurn[]): string {
    const clean = dedupSentences(reply.trim());
    // Evitar repetir exacto el último mensaje del asistente
    const lastAssistant = [...history]
        .reverse()
        .find((h) => h.role === "assistant")?.content?.trim();
    if (lastAssistant && clean.toLowerCase() === lastAssistant.toLowerCase()) {
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

/* ================ Ejecución de herramientas con retry ================ */
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

async function executeToolWithRetry(
    ctx: EsteticaCtx,
    call: { id: string; name: string; args: any },
    conversationId?: number
): Promise<ToolMsg> {
    let result = await executeToolOnce(ctx, call.name, call.args, conversationId);
    if (!result || result.ok === false || (result as any).error) {
        // retry 1 vez
        result = await executeToolOnce(ctx, call.name, call.args, conversationId);
    }
    return {
        role: "tool",
        content: JSON.stringify(result ?? null),
        tool_call_id: call.id,
    };
}

/* ================ Renderizado determinista desde tools ================ */
function tryAutoReplyFromTools(
    calls: Array<{ id: string; name: string; args: any }>,
    toolMsgs: Array<{ role: "tool"; content: string; tool_call_id: string }>,
    ctx: EsteticaCtx
): string | null {
    const byId = new Map(toolMsgs.map((m) => [m.tool_call_id, m]));
    for (const c of calls) {
        const m = byId.get(c.id);
        if (!m) continue;
        let payload: any = null;
        try {
            payload = JSON.parse(m.content || "null");
        } catch { }
        if (!payload) continue;

        // findSlots → lista numerada con labels
        if (c.name === "findSlots") {
            if (payload.ok && Array.isArray(payload.labels) && payload.labels.length) {
                const compact = payload.labels.map((x: any) => ({
                    idx: x.idx,
                    startLabel: x.startLabel,
                }));
                return formatSlotList(compact, "Aquí tienes horarios disponibles:");
            }
            if (payload.ok && (!payload.labels || !payload.labels.length)) {
                return "No veo cupos en ese rango. ¿Busco otra fecha u horario?";
            }
            return "Tuve un problema técnico al consultar los horarios. ¿Intento con otra fecha u horario?";
        }

        // book → confirmación o manejo de errores comunes
        if (c.name === "book") {
            if (payload.ok && payload.data) {
                const label = payload.data.startLabel || "";
                const service = payload.data.serviceName || "tu servicio";
                const code = payload.data.id
                    ? `APT-${String(payload.data.id).padStart(4, "0")}`
                    : "sin-código";
                return `✅ Tu cita de **${service}** quedó confirmada para **${label}** (código ${code}). Te llegará un recordatorio.`;
            }
            if (payload?.reason === "SERVICE_NOT_FOUND") {
                const sug = Array.isArray(payload.suggestions) ? payload.suggestions : [];
                if (sug.length) {
                    const list = sug
                        .map(
                            (s: any, i: number) => `${i + 1}. ${s.name} (${s.durationMin ?? 60} min)`
                        )
                        .join("\n");
                    return `No identifiqué el servicio. Elige una opción:\n${list}\n\nResponde con el número.`;
                }
                return "No identifiqué el servicio. ¿Cómo se llama el procedimiento que quieres agendar?";
            }
            if (payload?.reason === "INVALID_NAME")
                return "Necesito el nombre completo para reservar. ¿A nombre de quién agendamos?";
            if (payload?.reason === "INVALID_PHONE")
                return "Necesito el número de teléfono para confirmar la reserva. ¿Cuál es?";
            if (payload?.reason === "INVALID_START")
                return "La fecha/hora no es válida. ¿Compartes nuevamente el horario que prefieres?";
            return "No pude completar la reserva por un error técnico. ¿Intento de nuevo?";
        }

        // listServices
        if (c.name === "listServices") {
            if (payload.ok && Array.isArray(payload.items) && payload.items.length) {
                const lines = payload.items
                    .map(
                        (s: any, i: number) => `${i + 1}. ${s.name} (${s.durationMin ?? 60} min)`
                    )
                    .join("\n");
                return `Estos son los servicios disponibles:\n${lines}\n\n¿Quieres agendar alguno?`;
            }
            return "No encontré servicios activos en el sistema ahora mismo.";
        }

        // listUpcomingApptsForPhone
        if (c.name === "listUpcomingApptsForPhone") {
            if (payload.ok && Array.isArray(payload.items) && payload.items.length) {
                const lines = payload.items
                    .map(
                        (x: any, i: number) =>
                            `${i + 1}. ${x.startLabel} — ${x.serviceName ?? "cita"}`
                    )
                    .join("\n");
                return `Tienes estas próximas citas:\n${lines}\n\n¿Quieres reagendar o cancelar alguna?`;
            }
            return "No veo citas próximas asociadas a ese número.";
        }

        // reschedule / cancel / cancelMany
        if (c.name === "reschedule" && payload.ok && payload.data) {
            return `🔄 Cita reagendada para **${payload.data.startLabel}**.`;
        }
        if (c.name === "cancel" && payload.ok && payload.data) {
            return `🗑️ Cita cancelada (${payload.data.startLabel}). ¿Quieres elegir otro horario?`;
        }
        if (c.name === "cancelMany" && payload.ok && Array.isArray(payload.data)) {
            return `🗑️ Cancelé ${payload.data.length} cita(s). ¿Buscamos nuevos horarios?`;
        }
    }
    return null;
}

/* ================ Orquestador principal ================ */
export async function runEsteticaAgent(
    ctx: EsteticaCtx & { __conversationId?: number }, // permitimos inyectar convId
    turns: ChatTurn[],
    extras?: { phone?: string; conversationId?: number }
): Promise<string> {
    const sys = systemPrompt(ctx);
    const fewshots = buildFewshots(ctx);

    const cleanTurns: ChatTurn[] = (turns || []).filter(
        (t): t is ChatTurn => !!t && (t.role === "user" || t.role === "assistant")
    );

    // 1) Planificación + tool calls (inyectamos fewshots ANTES del historial real)
    const result = await openai.chat.completions.create({
        model: MODEL,
        temperature: TEMPERATURE,
        messages: [{ role: "system", content: sys }, ...(fewshots as any), ...cleanTurns] as any,
        tools: toolSpecs as any,
        tool_choice: "auto",
    } as any);

    const msg = (result.choices?.[0]?.message || {}) as AssistantMsg;

    // 2) Si hay tool calls → ejecutar y responder determinísticamente
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
        const lastUser =
            [...cleanTurns].reverse().find((t) => t.role === "user")?.content || "";

        // Asegurar fromText para findSlots si el modelo no lo pasó
        const calls = msg.tool_calls.map((c) => {
            const parsed = safeParseArgs(c.function.arguments);
            if (c.function.name === "findSlots" && !parsed.fromISO && !parsed.fromText) {
                parsed.fromText = lastUser;
            }
            return { id: c.id, name: c.function.name, args: parsed };
        });

        const toolMsgs: ToolMsg[] = [];
        for (const call of calls) {
            const toolMsg = await executeToolWithRetry(
                ctx,
                call,
                extras?.conversationId ?? ctx.__conversationId
            );
            toolMsgs.push(toolMsg);
        }

        // <<< Respuesta determinista (evita que el LLM invente fechas)
        const autoReply = tryAutoReplyFromTools(calls, toolMsgs, ctx);
        if (autoReply) {
            return postProcessReply(autoReply, cleanTurns);
        }

        // 3) Segunda vuelta con resultados de tools (fallback)
        const follow = await openai.chat.completions.create({
            model: MODEL,
            temperature: TEMPERATURE,
            messages: [
                { role: "system", content: sys },
                ...(fewshots as any),
                ...cleanTurns,
                msg as any,
                ...toolMsgs,
            ] as any,
        } as any);

        const raw = follow.choices?.[0]?.message?.content?.trim() || "";
        return postProcessReply(
            raw || "¿Quieres que te comparta horarios desde mañana o prefieres más información?",
            cleanTurns
        );
    }

    // 4) Sin tools → respuesta directa (igual pasamos post-proc)
    const direct = (msg.content || "").trim();
    const finalText =
        direct ||
        "¿Quieres que te comparta horarios desde mañana o prefieres más información?";
    return postProcessReply(finalText, cleanTurns);
}
