import axios from 'axios'
import fs from 'fs/promises'
import path from 'path'
import tmp from 'tmp'
import ffmpegPath from 'ffmpeg-static'
import ffmpeg from 'fluent-ffmpeg'

ffmpeg.setFfmpegPath(ffmpegPath as string)

/** ================== Config ================== **/
const OPENROUTER_BASE = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1'
const OPENROUTER_URL = `${OPENROUTER_BASE}/chat/completions`
const OPENROUTER_API_KEY =
    process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY || '' // alias por si acaso

// Orden de prueba de modelos. Puedes añadir más si usas otro proveedor compatible.
const CANDIDATE_MODELS: string[] = [
    process.env.IA_TRANSCRIBE_MODEL || '',              // 1) el que pongas en .env (si existe)
    'openai/gpt-4o-mini-transcribe',                    // 2) común y barato
    'openai/gpt-4o-transcribe',                         // 3) alternativo
].filter(Boolean)

/** =========================================================
 * Transcribe un audio usando OpenRouter (input_audio en chat).
 * - Convierte OGG/OPUS a WAV 16 kHz mono automáticamente.
 * - Prueba con varios modelos hasta lograr respuesta.
 * - Si no hay API key o todo falla, devuelve '' (placeholder).
 * ========================================================= */
export async function transcribeAudioBuffer(
    buf: Buffer,
    originalName = 'audio.ogg'
): Promise<string> {
    if (!OPENROUTER_API_KEY) return '' // sin key → fallback silencioso

    // 1) Escribimos el buffer a un archivo temporal
    const srcExt = (path.extname(originalName) || '.ogg').toLowerCase()
    const srcFile = tmp.fileSync({ postfix: srcExt })

    try {
        await fs.writeFile(srcFile.name, buf)

        // 2) Convertimos a WAV 16k mono si no es wav/mp3
        let outFile = srcFile.name
        let outFormat: 'wav' | 'mp3' = 'wav'

        if (srcExt === '.mp3') {
            outFormat = 'mp3'
        } else if (srcExt !== '.wav') {
            const wavFile = srcFile.name.replace(srcExt, '.wav')
            await new Promise<void>((resolve, reject) => {
                ffmpeg(srcFile.name)
                    .audioCodec('pcm_s16le')
                    .audioChannels(1)
                    .audioFrequency(16000)
                    .format('wav')
                    .on('error', reject)
                    .on('end', () => resolve())
                    .save(wavFile)
            })
            outFile = wavFile
            outFormat = 'wav'
        }

        // 3) Empaquetamos como base64
        const audioData = await fs.readFile(outFile)
        const base64 = audioData.toString('base64')

        // 4) Intentamos con cada modelo en orden
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
                                    text: 'Transcribe exactamente este audio (mismo idioma). Responde solo con el texto.',
                                },
                                {
                                    type: 'input_audio',
                                    input_audio: { data: base64, format: outFormat },
                                },
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
                    timeout: 45_000,
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
                // si vino vacío, probamos el siguiente
            } catch (err: any) {
                const code = err?.response?.status
                const msg = err?.response?.data?.error?.message || err?.message
                console.warn(`[STT] fallo con ${model}:`, code, msg)
                // Errores típicos que ameritan probar el siguiente: 401/403/404/422/429
                continue
            }
        }

        // Ningún modelo funcionó
        return ''
    } catch (e) {
        console.warn('[STT] error general:', (e as any)?.message || e)
        return ''
    } finally {
        // limpiar temporales
        try { srcFile.removeCallback() } catch { }
        try {
            const wavCandidate = srcFile.name.replace(srcExt, '.wav')
            if (wavCandidate !== srcFile.name) await fs.unlink(wavCandidate).catch(() => { })
        } catch { }
    }
}
