// src/services/transcription.service.ts
import axios from 'axios'
import fs from 'fs/promises'
import path from 'path'
import tmp from 'tmp'
import ffmpegPath from 'ffmpeg-static'
import ffmpeg from 'fluent-ffmpeg'

/**
 * Preparación ffmpeg:
 * - En Render funciona con ffmpeg-static. Si no está disponible, saltamos la conversión (tratamos de enviar directo).
 */
if (ffmpegPath) {
    ffmpeg.setFfmpegPath(ffmpegPath as string)
} else {
    console.warn('[STT] ffmpeg-static no encontrado; intentaré transcribir sin convertir.')
}

/** ================== Config ================== **/
const OPENROUTER_BASE = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1'
const OPENROUTER_URL = `${OPENROUTER_BASE}/chat/completions`
const OPENROUTER_API_KEY =
    process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY || '' // alias por si acaso

// Modelos candidatos (primero el que definas en .env)
const CANDIDATE_MODELS: string[] = [
    process.env.IA_TRANSCRIBE_MODEL || '',
    'openai/gpt-4o-mini-transcribe',
    'openai/gpt-4o-transcribe',
].filter(Boolean)

// Tamaños razonables (OpenRouter soporta ~25MB por input_audio base64)
const MAX_BASE64_MB = Number(process.env.STT_MAX_BASE64_MB || 24)

/** =========================================================
 * Transcribe un audio usando OpenRouter (input_audio en chat).
 * - Convierte a WAV 16 kHz mono cuando conviene (OGG/WEBM/M4A, etc.).
 * - Prueba varios modelos hasta que alguno responda con texto.
 * - Si no hay API key o todo falla, devuelve '' (placeholder).
 * - Mantiene la firma: (buf, originalName) => string (transcripción)
 * ========================================================= */
export async function transcribeAudioBuffer(
    buf: Buffer,
    originalName = 'audio.ogg'
): Promise<string> {
    if (!OPENROUTER_API_KEY) {
        console.warn('[STT] OPENROUTER_API_KEY/OPENAI_API_KEY no configurada. Devuelvo vacío.')
        return ''
    }

    // 1) Guardar buffer en archivo temporal con extensión acorde
    const srcExt = normalizeExt(path.extname(originalName) || '.ogg')
    const srcFile = tmp.fileSync({ postfix: srcExt })
    let cleanupFiles: string[] = []

    try {
        await fs.writeFile(srcFile.name, buf)

        // 2) Decidir si convertimos
        const needsConvert = shouldConvertToWav(srcExt)
        let outFile = srcFile.name
        let outFormat: 'wav' | 'mp3' | 'm4a' | 'ogg' | 'webm' = extToFormat(srcExt)

        if (needsConvert && ffmpegPath) {
            const wavFile = srcFile.name.replace(srcExt, '.wav')
            await convertToWav16kMono(srcFile.name, wavFile)
            outFile = wavFile
            outFormat = 'wav'
            cleanupFiles.push(wavFile)
        }

        // 3) Leer binario de salida y validar tamaño
        const audioData = await fs.readFile(outFile)
        const base64 = audioData.toString('base64')
        const approxMB = Math.ceil((base64.length * 3) / 4 / (1024 * 1024))
        if (approxMB > MAX_BASE64_MB) {
            console.warn(`[STT] Audio base64 ~${approxMB}MB excede límite de ${MAX_BASE64_MB}MB.`)
            // Intento de compresión a mono 16k si aún no lo hicimos
            if (outFormat !== 'wav' && ffmpegPath) {
                const wavFile = srcFile.name.replace(srcExt, '.wav')
                await convertToWav16kMono(srcFile.name, wavFile)
                const smaller = await fs.readFile(wavFile)
                const b64 = smaller.toString('base64')
                const mb2 = Math.ceil((b64.length * 3) / 4 / (1024 * 1024))
                if (mb2 <= MAX_BASE64_MB) {
                    return await tryOpenRouterModels(b64, 'wav')
                }
                cleanupFiles.push(wavFile)
            }
            // No hay forma segura: devolvemos vacío para no romper el flujo
            return ''
        }

        // 4) Intentar con modelos en orden
        return await tryOpenRouterModels(base64, outFormat)
    } catch (e: any) {
        console.warn('[STT] error general:', e?.message || e)
        return ''
    } finally {
        // limpiar temporales
        try {
            srcFile.removeCallback()
        } catch { }
        await Promise.all(
            cleanupFiles.map((f) =>
                fs.unlink(f).catch(() => {
                    /* ignore */
                })
            )
        )
    }
}

/* ====================== Helpers internas ====================== */

function normalizeExt(ext: string): string {
    const e = ext.toLowerCase()
    if (e === '.oga') return '.ogg'
    return e || '.ogg'
}

function extToFormat(ext: string): 'wav' | 'mp3' | 'm4a' | 'ogg' | 'webm' {
    switch (ext) {
        case '.wav':
            return 'wav'
        case '.mp3':
            return 'mp3'
        case '.m4a':
        case '.aac':
            return 'm4a'
        case '.webm':
            return 'webm'
        default:
            return 'ogg'
    }
}

/** Decidimos convertir a WAV 16k mono para formatos que suelen traer Opus/containers no estándar. */
function shouldConvertToWav(ext: string): boolean {
    // WAV/MP3 suelen pasar bien. OGG/WEBM/M4A conviene normalizar para mayor compatibilidad.
    return ext !== '.wav' && ext !== '.mp3'
}

async function convertToWav16kMono(inFile: string, outFile: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        ffmpeg(inFile)
            .audioCodec('pcm_s16le')
            .audioChannels(1)
            .audioFrequency(16000)
            .format('wav')
            .on('error', (err) => reject(err))
            .on('end', () => resolve())
            .save(outFile)
    })
}

/** Intenta llamar a OpenRouter con cada modelo. Devuelve la primera transcripción no vacía. */
async function tryOpenRouterModels(
    base64: string,
    outFormat: 'wav' | 'mp3' | 'm4a' | 'ogg' | 'webm'
): Promise<string> {
    for (const model of CANDIDATE_MODELS) {
        try {
            const payload = {
                model,
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: 'Transcribe exactamente este audio (mismo idioma). Solo el texto.' },
                            { type: 'input_audio', input_audio: { data: base64, format: outFormat } },
                        ],
                    },
                ],
            }

            const { data } = await axios.post(OPENROUTER_URL, payload, {
                headers: {
                    Authorization: `Bearer ${OPENROUTER_API_KEY}`,
                    'HTTP-Referer': process.env.OPENROUTER_REFERRER || 'http://localhost:3000',
                    'X-Title': process.env.OPENROUTER_APP_NAME || 'WPP AI SaaS',
                    'Content-Type': 'application/json',
                },
                timeout: Number(process.env.STT_HTTP_TIMEOUT_MS || 45000),
                // validateStatus: () => true, // si quieres manejar códigos no-2xx manualmente
            })

            const raw = data?.choices?.[0]?.message?.content
            let transcript = ''
            if (typeof raw === 'string') transcript = raw
            else if (Array.isArray(raw)) transcript = raw.map((c: any) => c?.text || '').join(' ')
            transcript = (transcript || '').trim()

            if (transcript) {
                console.log(`[STT] OK con modelo: ${model}`)
                return transcript
            }
        } catch (err: any) {
            const code = err?.response?.status
            const msg = err?.response?.data?.error?.message || err?.message
            console.warn(`[STT] fallo con ${model}:`, code, msg)
            // Probar siguiente en 401/403/404/422/429/timeouts, etc.
            continue
        }
    }
    return ''
}
