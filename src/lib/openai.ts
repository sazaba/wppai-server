// src/lib/openai.ts
import OpenAI from 'openai'

const apiKey =
    process.env.OPENROUTER_API_KEY || // OpenRouter (recomendado)
    process.env.OPENAI_API_KEY || ''  // fallback opcional

if (!apiKey) {
    console.warn('[openai] No hay OPENROUTER_API_KEY/OPENAI_API_KEY configurada')
}

export const openai = new OpenAI({
    apiKey,
    baseURL: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
    defaultHeaders: {
        'HTTP-Referer': process.env.OPENROUTER_REFERRER || 'http://localhost:3000',
        'X-Title': process.env.OPENROUTER_APP_NAME || 'whatsapp-saas',
    },
})

export default openai
