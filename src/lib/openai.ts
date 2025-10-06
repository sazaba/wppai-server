// // src/lib/openai.ts
// import OpenAI from 'openai'

// const apiKey =
//     process.env.OPENROUTER_API_KEY || // OpenRouter (recomendado)
//     process.env.OPENAI_API_KEY || ''  // fallback opcional

// if (!apiKey) {
//     console.warn('[openai] No hay OPENROUTER_API_KEY/OPENAI_API_KEY configurada')
// }

// export const openai = new OpenAI({
//     apiKey,
//     baseURL: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
//     defaultHeaders: {
//         'HTTP-Referer': process.env.OPENROUTER_REFERRER || 'http://localhost:3000',
//         'X-Title': process.env.OPENROUTER_APP_NAME || 'whatsapp-saas',
//     },
// })

// export default openai
///



// src/lib/openai.ts

// server/src/utils/lib/openai.ts
import OpenAI from "openai";

/**
 * Wrapper unificado para OpenAI u OpenRouter.
 * - Si usas OpenRouter, agrega headers y corrige el nombre de modelo automáticamente.
 * - Si usas OpenAI directo (API oficial), funciona igual.
 */

const apiKey =
    process.env.OPENROUTER_API_KEY ||
    process.env.OPENAI_API_KEY ||
    "";

if (!apiKey) {
    console.warn("[openai] ⚠️ No hay OPENROUTER_API_KEY ni OPENAI_API_KEY configurada");
}

const isOpenRouter = !!process.env.OPENROUTER_API_KEY;
const baseURL = process.env.OPENROUTER_BASE_URL || (isOpenRouter ? "https://openrouter.ai/api/v1" : undefined);

export const openai = new OpenAI({
    apiKey,
    baseURL,
    defaultHeaders: isOpenRouter
        ? {
            "HTTP-Referer": process.env.OPENROUTER_REFERRER || "http://localhost:3000",
            "X-Title": process.env.OPENROUTER_APP_NAME || "whatsapp-saas",
        }
        : undefined,
});

/**
 * Normaliza el nombre del modelo según el proveedor real.
 * - En OpenRouter, convierte “gpt-4o-mini” → “openai/gpt-4o-mini”.
 * - Si ya viene con prefijo (openai/, anthropic/, mistral/), no cambia.
 * - Si usas OpenAI puro, no toca el nombre.
 */
export function resolveModelName(model: string) {
    if (!model) return model;
    if (!isOpenRouter) return model;

    // si ya tiene prefijo (ej. openai/gpt-4o-mini)
    if (model.includes("/")) return model;

    // si es uno de los modelos OpenAI
    if (model.startsWith("gpt-")) return `openai/${model}`;

    // si es modelo de Anthropic o Mistral en OpenRouter
    if (model.startsWith("claude")) return `anthropic/${model}`;
    if (model.startsWith("mistral")) return `mistralai/${model}`;

    return model;
}

/**
 * Helper opcional: crea mensajes listos para usar con `chat.completions.create()`
 */
export function buildMessages(system: string, turns: Array<{ role: string; content: string }>) {
    return [{ role: "system", content: system }, ...turns];
}

export default openai;

