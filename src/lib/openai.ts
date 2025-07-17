import { OpenAI } from 'openai'

export const openai = new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: 'https://openrouter.ai/api/v1',
    defaultHeaders: {
        'HTTP-Referer': 'http://localhost:3000', // o la URL de tu app en producción
        'X-Title': 'whatsapp-saas',
    },
})
