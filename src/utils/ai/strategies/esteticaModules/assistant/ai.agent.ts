// utils/ai/strategies/esteticaModules/assistant/ai.agent.ts
import { openai } from "../../../../../lib/openai";
import prisma from "../../../../../lib/prisma";
import type { EsteticaCtx } from "../estetica.rag";
import { buildAssistantSystem, ASSISTANT_BEHAVIOR_RULES } from "./ai.prompts";
import { Toolset, listToolSignatures, ToolName, ToolResp } from "./ai.tools";

const MODEL = process.env.IA_TEXT_MODEL || process.env.IA_MODEL || "gpt-4o-mini";
const TEMPERATURE = Number(process.env.IA_TEMPERATURE ?? 0.3);

// -------- utilidades locales --------
type RoleMsg = { role: "system" | "user" | "assistant"; content: string };

function soft(s?: string | null, max = 320) {
    const t = (s || "").trim();
    if (!t) return "";
    return t.length <= max ? t : t.slice(0, max).replace(/\s+[^\s]*$/, "") + "…";
}

function isJustGreeting(text: string) {
    const t = text.toLowerCase().trim();
    return /^(hola|buen[oa]s|hey|qué tal|buen día|buenas tardes|buenas noches)[!. ]*$/i.test(t);
}

/** Hace una llamada con intención de JSON estricto y devuelve el objeto parseado o {} */
async function planJSON(messages: RoleMsg[], maxTokens = 220): Promise<any> {
    const r = await openai.chat.completions.create({
        model: MODEL,
        temperature: TEMPERATURE,
        messages,
        // En SDKs antiguos no existe tipado: usar `as any` evita error TS.
        response_format: { type: "json_object" } as any,
        max_tokens: maxTokens
    } as any);
    const content = r?.choices?.[0]?.message?.content || "{}";
    try { return JSON.parse(content); } catch { return {}; }
}

/** Formatea tool result para pasar al LLM de cierre sin exponer PII ni objetos enormes */
function summarizeToolResult(name: string, result: ToolResp<any>): string {
    if (!result) return `${name}: (sin respuesta)`;
    if ("ok" in result && !result.ok) return `${name}: ERROR: ${String(result.error || "desconocido")}`;
    const data = (result as any).data;
    try {
        return `${name}: ${JSON.stringify(data, (_, v) => (v instanceof Date ? v.toISOString() : v))}`;
    } catch {
        return `${name}: (ok)`;
    }
}

// ————— Orquestador: planifica → ejecuta tools → redacta respuesta final —————
export async function runAssistantOrchestrated(args: {
    empresaId: number;
    conversationId: number;
    userText: string;
    ctx: EsteticaCtx;
}): Promise<{ texto: string }> {
    const { empresaId, conversationId, userText, ctx } = args;

    // 1) Historia breve, sin ruido
    const last = await prisma.message.findMany({
        where: { conversationId },
        orderBy: { timestamp: "desc" },
        take: 8,
        select: { from: true, contenido: true }
    });
    const chatHistory: RoleMsg[] = last.reverse().map(m => ({
        role: m.from === "client" ? "user" : "assistant",
        content: soft(m.contenido, 300)
    }));

    // 2) “Anti-saludo”: si el mensaje es solo “hola”, evita párrafos y pregunta directo
    if (isJustGreeting(userText)) {
        // CTA ultra breve para llevarlo a acción
        return { texto: "¡Hola! ¿Agendamos, consultamos servicios o revisamos tus citas? Responde: *1 Agendar* · *2 Servicios* · *3 Mis citas*." };
    }

    // 3) Construimos contexto + catálogo de herramientas
    const system = buildAssistantSystem(ctx);
    const toolSigs = listToolSignatures();
    const toolsPreamble =
        [
            "Herramientas disponibles (usa solo si hace falta y nunca inventes resultados):",
            ...toolSigs.map(t => `- ${t.name}: ${t.description}  args: ${t.schema}`),
            "Cuando uses una herramienta, primero planea y devuelve un JSON válido.",
            ...ASSISTANT_BEHAVIOR_RULES
        ].join("\n");

    // 4) Paso de 'plan': el modelo decide si usa herramienta o contesta directo
    const planningObj = await planJSON(
        [
            { role: "system", content: system },
            { role: "system", content: toolsPreamble },
            ...chatHistory,
            { role: "user", content: userText },
            {
                role: "system",
                content:
                    "Piensa en 1 línea: ¿necesitas usar una herramienta? Devuelve SOLO un JSON válido con {action:'tool'|'talk', tool?:string, args?:object, reply?:string}. " +
                    "Elige tool exacto entre: " + toolSigs.map(t => t.name).join(", ") + "."
            }
        ],
        220
    );

    let action: "tool" | "talk" = (planningObj.action === "tool" ? "tool" : "talk");
    let tool: ToolName | undefined = planningObj.tool as ToolName | undefined;
    let argsAny: any = planningObj.args || {};
    let replyFallback: string = planningObj.reply || "";

    // 5) Ejecutamos herramienta si aplica
    let toolResult: ToolResp<any> | null = null;
    if (action === "tool" && tool && (Toolset as any)[tool]) {
        // Defaults críticos para evitar errores si el LLM olvida parámetros
        argsAny = { ...(argsAny || {}) };
        if (tool === "find_slots") {
            argsAny.empresaId ??= empresaId;
            argsAny.count ??= 6;
            argsAny.ctx ??= ctx;
        }
        if (tool === "book_appt") {
            argsAny.empresaId ??= empresaId;
            argsAny.conversationId ??= conversationId;
            argsAny.ctx ??= ctx;
        }
        if (tool === "reschedule_appt") {
            argsAny.empresaId ??= empresaId;
            argsAny.ctx ??= ctx;
        }
        if (tool === "list_upcoming" || tool === "confirm_latest_pending" || tool === "cancel_appt" || tool === "cancel_many") {
            argsAny.empresaId ??= empresaId;
        }

        try {
            toolResult = await (Toolset as any)[tool]({ name: tool, args: argsAny });
        } catch (e: any) {
            // Error duro de ejecución -> respondemos breve y segura
            const err = String(e?.message || e || "Error al ejecutar la acción");
            return { texto: `Lo siento, falló la acción (${err}). ¿Quieres que lo intente con otro horario o lo haga manualmente?` };
        }
    }

    // 6) Redacción FINAL corta (1–4 líneas) con el resultado (o fallback)
    //    Forzamos concisión y CTA claro.
    const final = await openai.chat.completions.create({
        model: MODEL,
        temperature: TEMPERATURE,
        messages: [
            { role: "system", content: system },
            {
                role: "system",
                content:
                    "Redacta la respuesta FINAL en 1–4 líneas, sin prosa de saludo, directa y clara. Ofrece el siguiente paso en una oración. " +
                    "Evita repetir contexto, no inventes datos. Si hay horarios, preséntalos con números (1–6) y pide el número de la opción."
            },
            ...(tool && toolResult
                ? [{ role: "system", content: `Resultado de herramienta (${tool}):\n${summarizeToolResult(tool, toolResult)}` } as RoleMsg]
                : [{ role: "system", content: "No se usó herramienta. Responde útil y concreta." } as RoleMsg]),
            { role: "user", content: userText }
        ],
        max_tokens: 180
    } as any);

    let texto = (final.choices?.[0]?.message?.content || "").trim();

    // 7) Si el modelo se queda mudo, usa el fallback del 'plan'
    if (!texto) {
        texto = (replyFallback || "¿Te ayudo a ver horarios, conocer servicios o revisar tus citas?").trim();
    }

    // 8) Micro-anti-saludo: borra encabezados tipo “¡Hola!” si el modelo los coló
    texto = texto.replace(/^(hola|buen[oa]s|hey)[^a-zA-Záéíóúñ]*[,:\-–—]?\s*/i, "");

    return { texto };
}
