"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.transcribeAudioBuffer = transcribeAudioBuffer;
// src/services/transcription.service.ts
const axios_1 = __importDefault(require("axios"));
const promises_1 = __importDefault(require("fs/promises"));
const path_1 = __importDefault(require("path"));
const tmp_1 = __importDefault(require("tmp"));
const ffmpeg_static_1 = __importDefault(require("ffmpeg-static"));
const fluent_ffmpeg_1 = __importDefault(require("fluent-ffmpeg"));
/**
 * Preparación ffmpeg:
 * - En Render funciona con ffmpeg-static. Si no está disponible, saltamos la conversión (tratamos de enviar directo).
 */
if (ffmpeg_static_1.default) {
    fluent_ffmpeg_1.default.setFfmpegPath(ffmpeg_static_1.default);
}
else {
    console.warn('[STT] ffmpeg-static no encontrado; intentaré transcribir sin convertir.');
}
/** ================== Config ================== **/
const OPENROUTER_BASE = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
const OPENROUTER_URL = `${OPENROUTER_BASE}/chat/completions`;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY || ''; // alias por si acaso
// arriba donde defines CANDIDATE_MODELS
const CANDIDATE_MODELS = [
    process.env.IA_TRANSCRIBE_MODEL || '', // 1) el que pongas en .env
    'google/gemini-2.0-flash-lite-001', // 2) recomendado (barato/rápido)
    'google/gemini-2.0-flash-001', // 3) alternativa
].filter(Boolean);
// Tamaños razonables (OpenRouter soporta ~25MB por input_audio base64)
const MAX_BASE64_MB = Number(process.env.STT_MAX_BASE64_MB || 24);
/** =========================================================
 * Transcribe un audio usando OpenRouter (input_audio en chat).
 * - Convierte a WAV 16 kHz mono cuando conviene (OGG/WEBM/M4A, etc.).
 * - Prueba varios modelos hasta que alguno responda con texto.
 * - Si no hay API key o todo falla, devuelve '' (placeholder).
 * - Mantiene la firma: (buf, originalName) => string (transcripción)
 * ========================================================= */
async function transcribeAudioBuffer(buf, originalName = 'audio.ogg') {
    if (!OPENROUTER_API_KEY) {
        console.warn('[STT] OPENROUTER_API_KEY/OPENAI_API_KEY no configurada. Devuelvo vacío.');
        return '';
    }
    // 1) Guardar buffer en archivo temporal con extensión acorde
    const srcExt = normalizeExt(path_1.default.extname(originalName) || '.ogg');
    const srcFile = tmp_1.default.fileSync({ postfix: srcExt });
    let cleanupFiles = [];
    try {
        await promises_1.default.writeFile(srcFile.name, buf);
        // 2) Decidir si convertimos
        const needsConvert = shouldConvertToWav(srcExt);
        let outFile = srcFile.name;
        let outFormat = extToFormat(srcExt);
        if (needsConvert && ffmpeg_static_1.default) {
            const wavFile = srcFile.name.replace(srcExt, '.wav');
            await convertToWav16kMono(srcFile.name, wavFile);
            outFile = wavFile;
            outFormat = 'wav';
            cleanupFiles.push(wavFile);
        }
        // 3) Leer binario de salida y validar tamaño
        const audioData = await promises_1.default.readFile(outFile);
        const base64 = audioData.toString('base64');
        const approxMB = Math.ceil((base64.length * 3) / 4 / (1024 * 1024));
        if (approxMB > MAX_BASE64_MB) {
            console.warn(`[STT] Audio base64 ~${approxMB}MB excede límite de ${MAX_BASE64_MB}MB.`);
            // Intento de compresión a mono 16k si aún no lo hicimos
            if (outFormat !== 'wav' && ffmpeg_static_1.default) {
                const wavFile = srcFile.name.replace(srcExt, '.wav');
                await convertToWav16kMono(srcFile.name, wavFile);
                const smaller = await promises_1.default.readFile(wavFile);
                const b64 = smaller.toString('base64');
                const mb2 = Math.ceil((b64.length * 3) / 4 / (1024 * 1024));
                if (mb2 <= MAX_BASE64_MB) {
                    return await tryOpenRouterModels(b64, 'wav');
                }
                cleanupFiles.push(wavFile);
            }
            // No hay forma segura: devolvemos vacío para no romper el flujo
            return '';
        }
        // 4) Intentar con modelos en orden
        return await tryOpenRouterModels(base64, outFormat);
    }
    catch (e) {
        console.warn('[STT] error general:', e?.message || e);
        return '';
    }
    finally {
        // limpiar temporales
        try {
            srcFile.removeCallback();
        }
        catch { }
        await Promise.all(cleanupFiles.map((f) => promises_1.default.unlink(f).catch(() => {
            /* ignore */
        })));
    }
}
/* ====================== Helpers internas ====================== */
function normalizeExt(ext) {
    const e = ext.toLowerCase();
    if (e === '.oga')
        return '.ogg';
    return e || '.ogg';
}
function extToFormat(ext) {
    switch (ext) {
        case '.wav':
            return 'wav';
        case '.mp3':
            return 'mp3';
        case '.m4a':
        case '.aac':
            return 'm4a';
        case '.webm':
            return 'webm';
        default:
            return 'ogg';
    }
}
/** Decidimos convertir a WAV 16k mono para formatos que suelen traer Opus/containers no estándar. */
function shouldConvertToWav(ext) {
    // WAV/MP3 suelen pasar bien. OGG/WEBM/M4A conviene normalizar para mayor compatibilidad.
    return ext !== '.wav' && ext !== '.mp3';
}
async function convertToWav16kMono(inFile, outFile) {
    await new Promise((resolve, reject) => {
        (0, fluent_ffmpeg_1.default)(inFile)
            .audioCodec('pcm_s16le')
            .audioChannels(1)
            .audioFrequency(16000)
            .format('wav')
            .on('error', (err) => reject(err))
            .on('end', () => resolve())
            .save(outFile);
    });
}
/** Intenta llamar a OpenRouter con cada modelo. Devuelve la primera transcripción no vacía. */
async function tryOpenRouterModels(base64, outFormat) {
    // valor configurable desde .env, con default de 120 tokens
    const MAX_TOKENS = Number(process.env.STT_MAX_TOKENS || 120);
    for (const model of CANDIDATE_MODELS) {
        try {
            const payload = {
                model,
                messages: [
                    {
                        role: 'user',
                        content: [
                            {
                                type: 'text',
                                text: 'Transcribe exactamente este audio (mismo idioma). Devuelve SOLO el texto, sin comillas.',
                            },
                            {
                                type: 'input_audio',
                                input_audio: { data: base64, format: outFormat },
                            },
                        ],
                    },
                ],
                temperature: 0,
                max_tokens: MAX_TOKENS,
                max_output_tokens: MAX_TOKENS,
            };
            const { data } = await axios_1.default.post(OPENROUTER_URL, payload, {
                headers: {
                    Authorization: `Bearer ${OPENROUTER_API_KEY}`,
                    'HTTP-Referer': process.env.OPENROUTER_REFERRER || 'http://localhost:3000',
                    'X-Title': process.env.OPENROUTER_APP_NAME || 'WPP AI SaaS',
                    'Content-Type': 'application/json',
                },
                timeout: Number(process.env.STT_HTTP_TIMEOUT_MS || 45000),
            });
            const raw = data?.choices?.[0]?.message?.content;
            let transcript = '';
            if (typeof raw === 'string')
                transcript = raw;
            else if (Array.isArray(raw))
                transcript = raw.map((c) => c?.text || '').join(' ');
            transcript = (transcript || '').trim();
            if (transcript) {
                console.log(`[STT] OK con modelo: ${model}`);
                return transcript;
            }
        }
        catch (err) {
            const code = err?.response?.status;
            const msg = err?.response?.data?.error?.message || err?.message;
            console.warn(`[STT] fallo con ${model}:`, code, msg);
            continue;
        }
    }
    return '';
}
