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
import OpenAI from "openai";

/**
 * Este wrapper soporta tanto OpenRouter como OpenAI puro.
 * - Si usas OpenRouter, agrega headers y mapea el nombre del modelo:
 *   "gpt-4o-mini"  -> "openai/gpt-4o-mini"
 *   "gpt-4o"       -> "openai/gpt-4o"
 *   etc.
 */

const apiKey =
    process.env.OPENROUTER_API_KEY ||
    process.env.OPENAI_API_KEY ||
    "";

if (!apiKey) {
    console.warn("[openai] No hay OPENROUTER_API_KEY ni OPENAI_API_KEY configurada");
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
 * Úsalo antes de enviar el modelo al SDK.
 */
export function resolveModelName(model: string) {
    if (!model) return model;
    if (!isOpenRouter) return model;
    // Si ya viene con slash (ej. "openai/gpt-4o-mini"), lo respetamos
    if (model.includes("/")) return model;
    // Para modelos OpenAI en OpenRouter, anteponer "openai/"
    return `openai/${model}`;
}

export default openai;
