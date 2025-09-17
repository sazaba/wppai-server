"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.openai = void 0;
// src/lib/openai.ts
const openai_1 = __importDefault(require("openai"));
const apiKey = process.env.OPENROUTER_API_KEY || // OpenRouter (recomendado)
    process.env.OPENAI_API_KEY || ''; // fallback opcional
if (!apiKey) {
    console.warn('[openai] No hay OPENROUTER_API_KEY/OPENAI_API_KEY configurada');
}
exports.openai = new openai_1.default({
    apiKey,
    baseURL: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
    defaultHeaders: {
        'HTTP-Referer': process.env.OPENROUTER_REFERRER || 'http://localhost:3000',
        'X-Title': process.env.OPENROUTER_APP_NAME || 'whatsapp-saas',
    },
});
exports.default = exports.openai;
