// server/src/utils/handleIAReply.ts
import axios from 'axios'
import prisma from '../lib/prisma'
import { openai } from '../lib/openai'
import { ConversationEstado, MediaType, MessageFrom } from '@prisma/client'
import { retrieveRelevantProducts } from './products.helper'

// ⚠️ Import en namespace para evitar discrepancias de tipos/exports
import * as Wam from '../services/whatsapp.service'
import { transcribeAudioBuffer } from '../services/transcription.service'

type IAReplyResult = {
    estado: ConversationEstado
    mensaje?: string
    motivo?: 'confianza_baja' | 'palabra_clave' | 'reintentos'
    messageId?: number
    wamid?: string
    media?: Array<{ productId: number; imageUrl: string; wamid?: string }>
}

/* ===== Config IA ===== */
const RAW_MODEL =
    process.env.IA_TEXT_MODEL ||
    process.env.IA_MODEL ||
    'anthropic/claude-3.5-sonnet'

const TEMPERATURE = Number(process.env.IA_TEMPERATURE ?? 0.6)
const MAX_COMPLETION_TOKENS = Number(process.env.IA_MAX_TOKENS ?? 420)

const OPENROUTER_BASE = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1'
const OPENROUTER_URL = `${OPENROUTER_BASE}/chat/completions`
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY || ''
const VISION_MODEL = process.env.IA_VISION_MODEL || 'gpt-4o-mini'

const MAX_PRODUCTS_TO_SEND = Number(process.env.MAX_PRODUCTS_TO_SEND || 3)

/* ============ Utils ============ */
const normId = (m: string) => (m?.trim() === 'google/gemini-2.0-flash-lite' ? 'google/gemini-2.0-flash-lite-001' : m?.trim())
const isOR = (m: string) => m.includes('/')
const fallbackModel = () => 'google/gemini-2.0-flash-lite-001'
const normalizeForOpenAI = (model: string) => model.replace(/^openai\//i, '').trim()

const nrm = (t: string) =>
    String(t || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()

const pick = <T,>(arr: T[]) => arr[Math.max(0, Math.floor(Math.random() * arr.length))] as T

const CTAS = [
    '¿Te comparto *precios* o prefieres *beneficios*?',
    '¿Quieres ver *fotos* o pasamos a *precios*?',
    'Puedo enviarte *precios*, *promos* o *fotos*. ¿Qué te sirve?',
    '¿Seguimos con *precio* o mejor *beneficios* primero?',
]

const NO_DECIR = ['soy una ia', 'modelo de lenguaje', 'inteligencia artificial'].map(nrm)
const esRespuestaInvalida = (r: string) => {
    const t = nrm(r || '')
    const email = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/.test(r)
    const link = /https?:\/\/|www\./i.test(r)
    const tel = /\+?\d[\d\s().-]{6,}/.test(r)
    return email || link || tel || NO_DECIR.some(p => t.includes(p))
}

/* ====== Lectura segura BusinessConfig ===== */
const cfg = (c: any, k: string) => {
    if (!c) return ''
    const map: Record<string, string[]> = {
        nombre: ['nombre'],
        descripcion: ['descripcion'],
        servicios: ['servicios'],
        horarios: ['horarios'],
        businessType: ['businessType'],
        enviosInfo: ['enviosInfo'],
        metodosPago: ['metodosPago'],
        tiendaFisica: ['tiendaFisica'],
        direccionTienda: ['direccionTienda'],
        politicasDevolucion: ['politicasDevolucion'],
        politicasGarantia: ['politicasGarantia', 'politicasGarantía'],
        promocionesInfo: ['promocionesInfo'],
        canalesAtencion: ['canalesAtencion'],
        extras: ['extras'],
        palabrasClaveNegocio: ['palabrasClaveNegocio'],
        faq: ['faq'],
        pagoLinkGenerico: ['pagoLinkGenerico'],
        pagoLinkProductoBase: ['pagoLinkProductoBase'],
        pagoNotas: ['pagoNotas'],
        bancoNombre: ['bancoNombre'],
        bancoTitular: ['bancoTitular'],
        bancoTipoCuenta: ['bancoTipoCuenta'],
        bancoNumeroCuenta: ['bancoNumeroCuenta'],
        bancoDocumento: ['bancoDocumento'],
        transferenciaQRUrl: ['transferenciaQRUrl'],
        envioTipo: ['envioTipo'],
        envioEntregaEstimado: ['envioEntregaEstimado'],
        envioCostoFijo: ['envioCostoFijo'],
        envioGratisDesde: ['envioGratisDesde'],
        facturaElectronicaInfo: ['facturaElectronicaInfo'],
        soporteDevolucionesInfo: ['soporteDevolucionesInfo'],
    }
    const keys = map[k] || [k]
    for (const key of keys) {
        if (c[key] !== undefined && c[key] !== null) return c[key]
    }
    return ''
}

/* ============ Intents ============ */
const wantsImages = (t: string) =>
    ['imagen', 'imagenes', 'imágenes', 'foto', 'fotos', 'ver foto', 'ver imagen', 'muestra foto'].some(k => nrm(t).includes(nrm(k)))

const asksCatalogue = (t: string) =>
    ['lista de productos', 'productos disponibles', 'portafolio', 'catálogo', 'catalogo'].some(k => nrm(t).includes(nrm(k)))

const saysPaid = (t: string) =>
    ['ya pague', 'ya pagué', 'pago realizado', 'hice el pago', 'ya hice el pago', 'pagado'].some(k => nrm(t).includes(nrm(k)))

/* ===== Detectar ciudad/dirección (sirve para contexto, no para checkout) ===== */
const CITY_LIST = [
    'bogota', 'bogotá', 'medellin', 'medellín', 'cali', 'barranquilla', 'cartagena',
    'manizales', 'pereira', 'bucaramanga', 'cucuta', 'cúcuta', 'ibague', 'ibagué',
    'soacha', 'santa marta', 'villavicencio', 'armenia', 'neiva', 'pasto'
].map(nrm)

/** ================== LÉXICO DINÁMICO POR EMPRESA (configurable) ================== **/
type BusinessLexicon = {
    genericTerms: Set<string>
    buckets: Record<string, string[]>          // sinónimos configurables por negocio
    genericRegex: RegExp | null
}
const LEX_CACHE = new Map<number, BusinessLexicon>()

function safeJSON<T = any>(v: any): T | null {
    try {
        if (!v) return null
        if (typeof v === 'object') return v as T
        if (typeof v === 'string') return JSON.parse(v) as T
    } catch { }
    return null
}
function escapeReg(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
const STOP = new Set([
    'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'de', 'del', 'al', 'a', 'en', 'con', 'para', 'por',
    'quiero', 'saber', 'acerca', 'sobre', 'producto', 'productos', 'me', 'interesa', 'informacion', 'info',
    'mas', 'precio', 'precios', 'tengo', 'hay', 'que', 'cual', 'cuál', 'ver', 'este', 'esa', 'ese', 'eso', 'si', 'sí'
])
function tokenizeForBiz(s: string): string[] {
    return String(s || '')
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w && w.length >= 3 && !STOP.has(w))
}

/** Carga léxico desde productos + buckets configurables */
async function loadBusinessLexicon(empresaId: number): Promise<BusinessLexicon> {
    if (LEX_CACHE.has(empresaId)) return LEX_CACHE.get(empresaId)!

    const [productos, conf] = await Promise.all([
        prisma.product.findMany({
            where: { empresaId, disponible: true },
            select: { id: true, nombre: true, descripcion: true, slug: true }
        }),
        prisma.businessConfig.findFirst({
            where: { empresaId },
            orderBy: { updatedAt: 'desc' },
            select: { extras: true, palabrasClaveNegocio: true }
        })
    ])

    // 1) buckets por negocio
    let buckets: Record<string, string[]> = {}
    const extrasObj = safeJSON(conf?.extras)
    const pknObj = safeJSON(conf?.palabrasClaveNegocio)
    if (extrasObj && extrasObj.keywordBuckets && typeof extrasObj.keywordBuckets === 'object') {
        buckets = extrasObj.keywordBuckets
    } else if (pknObj && pknObj.keywordBuckets && typeof pknObj.keywordBuckets === 'object') {
        buckets = pknObj.keywordBuckets
    } else if (process.env.IA_KEYWORD_BUCKETS_DEFAULT) {
        const envBuckets = safeJSON<Record<string, string[]>>(process.env.IA_KEYWORD_BUCKETS_DEFAULT)
        if (envBuckets) buckets = envBuckets
    }

    // 2) términos genéricos a partir de nombre/descripcion
    const generic = new Set<string>()
    for (const p of productos) {
        tokenizeForBiz(p.nombre).forEach(w => generic.add(w))
        tokenizeForBiz(p.descripcion || '').forEach(w => generic.add(w))
    }
    // también añade sinónimos de buckets para mejorar catálogo genérico
    for (const arr of Object.values(buckets)) {
        for (const syn of arr) tokenizeForBiz(syn).forEach(w => generic.add(w))
    }

    const genericRegex = generic.size
        ? new RegExp(`\\b(?:${Array.from(generic).map(escapeReg).join('|')})\\b`, 'i')
        : null

    const lex: BusinessLexicon = { genericTerms: generic, buckets, genericRegex }
    LEX_CACHE.set(empresaId, lex)
    return lex
}

function isGenericQueryForBiz(text: string, lex: BusinessLexicon): boolean {
    if (!text || !lex.genericRegex) return false
    return lex.genericRegex.test(text)
}

/* ===== Prompt anti-alucinación ===== */
function systemPrompt(c: any, prods: any[], msgEsc: string, empresaNombre?: string) {
    const marca = (cfg(c, 'nombre') || empresaNombre || 'la marca')

    const inventario = prods
        .map(p => `- ${p.nombre}${p.precioDesde != null ? ` — ${formatMoney(p.precioDesde)}` : ''}`)
        .join('\n')

    const info = `
[NEGOCIO]
- Nombre: ${marca}
- Descripción: ${cfg(c, 'descripcion')}
- Portafolio: usa EXCLUSIVAMENTE nombres y datos reales de productos de la base.
- Horarios: ${cfg(c, 'horarios')}

[PRODUCTOS DISPONIBLES (muestra parcial/relevante)]
${inventario || '- (sin coincidencias claras)'}
  `.trim()

    return `
Eres un **asesor de ${marca}**. Regla principal: **no inventes** nombres de productos. 
Si el cliente pide un producto que no está en la lista, responde que no lo encuentras y ofrece alternativas reales.
Respuestas cortas (2–5 líneas) y con CTA breve. No menciones ser IA ni compartas links externos.

Si llega una **imagen**:
- Analízala en el contexto del negocio.
- Si parece **comprobante** de pago o el cliente dice que pagó: agradece y aclara que el equipo verificará manualmente.
- Si es otra imagen, pregunta amablemente cómo ayudar con esa foto.

Si no puedes ayudar con certeza, usa: "${msgEsc}".

${info}
`.trim()
}

/* ==================== LLM call ==================== */
async function chatComplete({
    model, messages, temperature, maxTokens
}: {
    model: string
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: any }>
    temperature: number
    maxTokens: number
}): Promise<string> {
    const normalized = normId(model) || fallbackModel()
    const hasImage = messages.some(m => Array.isArray(m.content) && (m.content as any[]).some((p: any) => p?.type === 'image_url'))

    if (hasImage) {
        const resp = await openai.chat.completions.create({
            model: normalizeForOpenAI(VISION_MODEL),
            messages,
            temperature,
            max_completion_tokens: maxTokens as any,
            // @ts-ignore
            max_tokens: maxTokens,
        } as any)
        return resp?.choices?.[0]?.message?.content ?? ''
    }

    if (isOR(normalized)) {
        if (!OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY no configurada')
        const payload = { model: normalized, messages, temperature, max_tokens: maxTokens, max_output_tokens: maxTokens }
        const { data } = await axios.post(OPENROUTER_URL, payload, {
            headers: {
                Authorization: `Bearer ${OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': process.env.OPENROUTER_REFERRER || 'http://localhost:3000',
                'X-Title': process.env.OPENROUTER_APP_NAME || 'WPP AI SaaS',
            },
            timeout: Number(process.env.IA_HTTP_TIMEOUT_MS || 45000),
        })
        const content = data?.choices?.[0]?.message?.content
        return typeof content === 'string' ? content : Array.isArray(content) ? content.map((c: any) => c?.text || '').join(' ') : ''
    }

    const resp = await openai.chat.completions.create({
        model: normalizeForOpenAI(normalized),
        messages,
        temperature,
        max_completion_tokens: maxTokens as any,
        // @ts-ignore
        max_tokens: maxTokens,
    } as any)
    return resp?.choices?.[0]?.message?.content ?? ''
}

/* ==================== Wrappers seguros WAM ==================== */
type MaybeMediaInfo = string | { url?: string;[k: string]: any } | null | undefined

async function getWamMediaUrlSafe(input: string): Promise<string | null> {
    const mod: any = Wam as any
    const fn = mod?.getMediaUrl ?? mod?.getMediaURL ?? mod?.mediaUrl ?? mod?.getMedia ?? null
    if (typeof fn !== 'function') return null
    const res: MaybeMediaInfo = await fn(input)
    if (typeof res === 'string') return res
    return res?.url ?? null
}

async function downloadWamMediaToBufferSafe(url: string): Promise<Buffer | null> {
    const mod: any = Wam as any
    const fn = mod?.downloadMediaToBuffer ?? mod?.downloadBuffer ?? mod?.downloadFile ?? mod?.download ?? null
    if (typeof fn !== 'function') return null
    const out = await fn(url)
    return Buffer.isBuffer(out) ? out : out ? Buffer.from(out as any) : null
}

/* ======================== Matcher de productos (agnóstico + buckets) ======================== */
function tokensLite(s: string) { return tokenizeForBiz(s) }
function jaccard(a: string[], b: string[]): number { const A = new Set(a), B = new Set(b); let i = 0; for (const x of A) if (B.has(x)) i++; return A.size || B.size ? i / (A.size + B.size - i) : 0 }
function ngrams(s: string, n = 3) { const t = (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ''); if (t.length <= n) return [t]; const out: string[] = []; for (let i = 0; i <= t.length - n; i++) out.push(t.slice(i, i + n)); return out }
function jaroW(a: string, b: string) { const s1 = (a || '').toLowerCase(), s2 = (b || '').toLowerCase(); if (s1 === s2) return 1; const mDist = Math.floor(Math.max(s1.length, s2.length) / 2) - 1; let m = 0, t = 0; const s1M = new Array(s1.length).fill(false), s2M = new Array(s2.length).fill(false); for (let i = 0; i < s1.length; i++) { const st = Math.max(0, i - mDist), en = Math.min(i + mDist + 1, s2.length); for (let j = st; j < en; j++) { if (s2M[j] || s1[i] !== s2[j]) continue; s1M[i] = s2M[j] = true; m++; break; } } if (!m) return 0; let k = 0; for (let i = 0; i < s1.length; i++) { if (!s1M[i]) continue; while (!s2M[k]) k++; if (s1[i] !== s2[k]) t++; k++; } const mt = t / 2; const j = (m / s1.length + m / s2.length + (m - mt) / m) / 3; let l = 0; while (l < 4 && l < s1.length && l < s2.length && s1[l] === s2[l]) l++; return j + l * 0.1 * (1 - j) }

function bucketHits(text: string, buckets: Record<string, string[]>): string[] {
    const q = nrm(text)
    const hits: string[] = []
    for (const [bucket, arr] of Object.entries(buckets || {})) {
        if (arr.some(w => q.includes(nrm(w)))) hits.push(bucket)
    }
    return hits
}
function productMatchesBuckets(prod: { nombre: string; slug?: string | null; descripcion?: string | null }, hits: string[], buckets: Record<string, string[]>): boolean {
    const tgt = `${nrm(prod.nombre)} ${nrm(prod.slug || '')} ${nrm(prod.descripcion || '')}`
    return hits.every(b => (buckets[b] || []).some(w => tgt.includes(nrm(w))))
}

function scoreMatchBiz(p: { nombre: string, slug?: string | null, descripcion?: string | null }, q: string, hits: string[], buckets: Record<string, string[]>) {
    // base fuzzy
    const s1 = jaccard(tokensLite(p.nombre), tokensLite(q))
    const pN = new Set(ngrams(p.nombre, 3)), qN = new Set(ngrams(q, 3))
    let i = 0; for (const g of pN) if (qN.has(g)) i++
    const s2 = pN.size ? i / pN.size : 0
    const s3 = jaroW(p.nombre, q)
    const sSlug = p.slug ? jaroW(p.slug, q) * 0.2 : 0
    const sDesc = p.descripcion ? jaroW(p.descripcion, q) * 0.1 : 0

    // boost por buckets
    const boost = productMatchesBuckets(p, hits, buckets) ? 0.35 : 0

    return Math.min(1, 0.45 * s1 + 0.25 * s2 + 0.30 * s3 + sSlug + sDesc + boost)
}

async function findRequestedProduct(empresaId: number, text: string, lex: BusinessLexicon) {
    const q = (text || '').trim(); if (!q) return null
    const hits = bucketHits(q, lex.buckets)

    const prods = await prisma.product.findMany({
        where: { empresaId, disponible: true },
        select: { id: true, nombre: true, slug: true, descripcion: true, precioDesde: true }
    })

    // Si los buckets acotan a una sola opción, devuélvela directo
    if (hits.length) {
        const filtered = prods.filter(p => productMatchesBuckets(p, hits, lex.buckets))
        if (filtered.length === 1) return filtered[0]
    }

    // Scoring fuzzy + boost
    let best: any = null, bestScore = 0
    for (const p of prods) {
        const score = Math.max(
            scoreMatchBiz(p, q, hits, lex.buckets),
            p.slug ? scoreMatchBiz({ nombre: p.slug, slug: '', descripcion: '' }, q, hits, lex.buckets) : 0,
            p.descripcion ? scoreMatchBiz({ nombre: p.descripcion, slug: '', descripcion: '' }, q, hits, lex.buckets) : 0
        )
        if (score > bestScore) { best = p; bestScore = score }
    }
    if (bestScore >= 0.85) return best
    if (bestScore >= 0.72) return best // tolerante
    return null
}

function listProductsMessage(list: Array<{ nombre: string; precioDesde: any | null }>) {
    const lines: string[] = []
    lines.push('Tenemos estas opciones disponibles ahora mismo:')
    for (const p of list.slice(0, 6)) {
        const price = p.precioDesde != null ? ` — desde ${formatMoney(p.precioDesde)}` : ''
        lines.push(`• *${p.nombre}*${price}`)
    }
    lines.push('¿Quieres *fotos* de alguno o prefieres que te pase el *precio* de un producto en particular?')
    return short(lines.join('\n'))
}

/* ========================= Core ========================= */
export const handleIAReply = async (
    chatId: number,
    mensajeArg: string,
    opts?: { toPhone?: string; autoSend?: boolean; phoneNumberId?: string }
): Promise<IAReplyResult | null> => {
    // 0) Conversación
    const conversacion = await prisma.conversation.findUnique({
        where: { id: chatId },
        select: { id: true, estado: true, empresaId: true, phone: true, nombre: true },
    })
    if (!conversacion || conversacion.estado === 'cerrado') {
        console.warn(`[handleIAReply] 🔒 La conversación ${chatId} está cerrada.`)
        return null
    }

    // 1) Config del negocio
    const config = await prisma.businessConfig.findFirst({
        where: { empresaId: conversacion.empresaId },
        orderBy: { updatedAt: 'desc' },
    })
    const empresa = await prisma.empresa.findUnique({
        where: { id: conversacion.empresaId },
        select: { nombre: true }
    })
    const mensajeEscalamiento = 'Gracias por tu mensaje. En breve un compañero del equipo te contactará para ayudarte con más detalle.'

    if (!config) {
        const escalado = await persistBotReply({
            conversationId: chatId,
            empresaId: conversacion.empresaId,
            texto: mensajeEscalamiento,
            nuevoEstado: ConversationEstado.requiere_agente,
            sendTo: opts?.autoSend ? (opts?.toPhone || conversacion.phone) : undefined,
            phoneNumberId: opts?.phoneNumberId,
        })
        return { estado: ConversationEstado.requiere_agente, mensaje: mensajeEscalamiento, motivo: 'confianza_baja', messageId: escalado.messageId, wamid: escalado.wamid }
    }

    // 1.b) Cargar léxico dinámico del negocio (incluye keywordBuckets configurables)
    const lexicon = await loadBusinessLexicon(conversacion.empresaId)

    // 2) Último mensaje del cliente (voz → transcripción; imagen → visión/pagos)
    const ultimoCliente = await prisma.message.findFirst({
        where: { conversationId: chatId, from: 'client' },
        orderBy: { timestamp: 'desc' },
        select: { id: true, mediaType: true, mediaUrl: true, caption: true, isVoiceNote: true, transcription: true, contenido: true, mimeType: true }
    })

    let mensaje = (mensajeArg || '').trim()

    // 🔊 Voz → usar transcripción; si no hay, transcribir ahora
    if (!mensaje && ultimoCliente?.isVoiceNote) {
        let transcript = (ultimoCliente.transcription || '').trim()
        if (!transcript) {
            try {
                let audioBuf: Buffer | null = null

                if (ultimoCliente.mediaUrl && /^https?:\/\//i.test(String(ultimoCliente.mediaUrl))) {
                    const { data } = await axios.get(String(ultimoCliente.mediaUrl), { responseType: 'arraybuffer', timeout: 30000 })
                    audioBuf = Buffer.from(data)
                }

                if (!audioBuf && ultimoCliente?.mediaUrl) {
                    try {
                        const directUrl = await getWamMediaUrlSafe(String(ultimoCliente.mediaUrl))
                        if (directUrl) {
                            const buf = await downloadWamMediaToBufferSafe(directUrl)
                            if (buf) audioBuf = buf
                        }
                    } catch (e: any) {
                        console.warn('[voice] getMediaUrl/downloadMediaToBuffer fallo:', e?.message || e)
                    }
                }

                if (audioBuf && audioBuf.length) {
                    const guessedName =
                        ultimoCliente.mimeType?.includes('mpeg') ? 'audio.mp3' :
                            ultimoCliente.mimeType?.includes('wav') ? 'audio.wav' :
                                ultimoCliente.mimeType?.includes('m4a') ? 'audio.m4a' :
                                    ultimoCliente.mimeType?.includes('webm') ? 'audio.webm' : 'audio.ogg'

                    transcript = await transcribeAudioBuffer(audioBuf, guessedName)
                    if (transcript) {
                        await prisma.message.update({ where: { id: ultimoCliente.id }, data: { transcription: transcript } })
                        console.log('[voice] ✅ transcripción guardada:', transcript.slice(0, 140))
                    } else {
                        console.warn('[voice] ❗ transcripción vacía')
                    }
                } else {
                    console.warn('[voice] ❗ no se pudo obtener buffer de audio')
                }
            } catch (e: any) {
                console.warn('[voice] error transcribiendo:', e?.message || e)
            }
        }
        if (transcript) mensaje = transcript
    }

    const isImage = ultimoCliente?.mediaType === MediaType.image && !!ultimoCliente.mediaUrl
    const imageUrl = isImage ? String(ultimoCliente?.mediaUrl) : null
    const caption = (ultimoCliente?.caption || '').trim()

    // 2.1 Imagen → comprobante o consulta genérica
    if (isImage) {
        const maybePayment = /comprobante|pago|recibo|transferencia|voucher|dep[oó]sito|qr/i.test(
            (ultimoCliente?.caption || '') + ' ' + (ultimoCliente?.contenido || '')
        )
        if (maybePayment || saysPaid(mensaje)) {
            // Cambiar estado a venta_en_proceso (verificación manual)
            const texto = [
                '¡Gracias! Recibimos tu *comprobante* / confirmación de pago 🙌',
                'Nuestro equipo validará el pago y te confirmará por aquí.',
                cfg(config, 'envioEntregaEstimado') ? `Entrega estimada (una vez confirmado): ${cfg(config, 'envioEntregaEstimado')}.` : ''
            ].filter(Boolean).join('\n')

            const savedR = await persistBotReply({
                conversationId: chatId,
                empresaId: conversacion.empresaId,
                texto,
                nuevoEstado: ConversationEstado.venta_en_proceso,
                sendTo: opts?.autoSend ? (opts?.toPhone || conversacion.phone) : undefined,
                phoneNumberId: opts?.phoneNumberId,
            })
            return { estado: ConversationEstado.venta_en_proceso, mensaje: savedR.texto, messageId: savedR.messageId, wamid: savedR.wamid, media: [] }
        }

        // Imagen SIN texto → preguntamos
        if (!mensaje && !caption) {
            const ask = 'Veo tu foto 😊 ¿Te ayudo con algo de esa imagen? (por ejemplo: precio, disponibilidad, alternativas o cómo usarlo)'
            const saved = await persistBotReply({
                conversationId: chatId, empresaId: conversacion.empresaId, texto: ask,
                nuevoEstado: ConversationEstado.en_proceso,
                sendTo: opts?.autoSend ? (opts?.toPhone || conversacion.phone) : undefined,
                phoneNumberId: opts?.phoneNumberId,
            })
            return { estado: ConversationEstado.en_proceso, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
        }
    }

    // 3) Historial corto (últimos con contenido)
    const mensajesPrevios = await prisma.message.findMany({
        where: { conversationId: chatId },
        orderBy: { timestamp: 'asc' },
        take: 20,
        select: { from: true, contenido: true },
    })
    const historial = mensajesPrevios
        .filter(m => (m.contenido || '').trim().length > 0)
        .slice(-10)
        .map(m => ({ role: m.from === 'client' ? 'user' : 'assistant', content: m.contenido } as const))

    // 3.1) Traer productos relevantes
    let productos: any[] = []
    try {
        productos = await retrieveRelevantProducts(conversacion.empresaId, mensaje || (ultimoCliente?.caption ?? ''), 5)
    } catch (e) {
        console.warn('[handleIAReply] retrieveRelevantProducts error:', (e as any)?.message || e)
        productos = []
    }
    if (!productos.length && (mensaje || caption)) {
        const tokens = Array.from(new Set(nrm((mensaje || caption)).split(' ').filter(w => w.length >= 3)))
        if (tokens.length) {
            productos = await prisma.product.findMany({
                where: {
                    empresaId: conversacion.empresaId,
                    OR: [{ nombre: { contains: tokens[0] } }, { descripcion: { contains: tokens[0] } }]
                },
                take: 5, orderBy: { id: 'asc' }
            })
        }
        if (!productos.length) {
            productos = await prisma.product.findMany({
                where: { empresaId: conversacion.empresaId, disponible: true },
                take: 5, orderBy: { id: 'asc' }
            })
        }
    }

    // 4) Respuestas no-IA para catálogo (detecta consultas genéricas con el léxico)
    if (asksCatalogue(mensaje) || isGenericQueryForBiz(mensaje, lexicon)) {
        const list = await prisma.product.findMany({
            where: { empresaId: conversacion.empresaId, disponible: true },
            take: 6, orderBy: { id: 'asc' },
            select: { nombre: true, precioDesde: true }
        })
        const txt = listProductsMessage(list)
        const saved = await persistBotReply({
            conversationId: chatId, empresaId: conversacion.empresaId, texto: txt,
            nuevoEstado: ConversationEstado.respondido,
            sendTo: opts?.autoSend ? (opts?.toPhone || conversacion.phone) : undefined,
            phoneNumberId: opts?.phoneNumberId,
        })
        return { estado: ConversationEstado.respondido, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
    }

    // Si pide fotos → deducir producto con buckets + fuzzy
    if (wantsImages(mensaje) && opts?.autoSend && (opts?.toPhone || conversacion.phone)) {
        const requested = await findRequestedProduct(conversacion.empresaId, mensaje || caption, lexicon)
        if (requested) {
            const mediaSent = await sendProductImages({
                chatId,
                conversacion: { empresaId: conversacion.empresaId, phone: conversacion.phone },
                productosRelevantes: [requested],
                phoneNumberId: opts?.phoneNumberId,
                toOverride: opts?.toPhone
            })
            const follow = `Te compartí fotos de *${requested.nombre}*. ¿Deseas saber el *precio* o ver *alternativas*?`
            const saved = await persistBotReply({
                conversationId: chatId, empresaId: conversacion.empresaId, texto: follow,
                nuevoEstado: ConversationEstado.respondido,
                sendTo: opts?.autoSend ? (opts?.toPhone || conversacion.phone) : undefined,
                phoneNumberId: opts?.phoneNumberId,
            })
            return { estado: ConversationEstado.respondido, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: mediaSent }
        } else {
            const names = (await prisma.product.findMany({
                where: { empresaId: conversacion.empresaId, disponible: true },
                take: 3, orderBy: { id: 'asc' },
                select: { nombre: true }
            })).map(p => `*${p.nombre}*`)
            const ask = `¿De cuál producto quieres fotos? ${names.length ? `Ej.: ${names.join(' / ')}` : ''}`
            const saved = await persistBotReply({
                conversationId: chatId, empresaId: conversacion.empresaId, texto: ask,
                nuevoEstado: ConversationEstado.en_proceso,
                sendTo: opts?.autoSend ? (opts?.toPhone || conversacion.phone) : undefined,
                phoneNumberId: opts?.phoneNumberId,
            })
            return { estado: ConversationEstado.en_proceso, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
        }
    }

    /* ===== 5) IA (anclada a BusinessConfig + productos, SIN flujo de compra) ===== */
    const baseMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: any }> = [
        { role: 'system', content: systemPrompt(config, productos, mensajeEscalamiento, empresa?.nombre) },
        ...historial
    ]
    if (imageUrl) {
        baseMessages.push({
            role: 'user',
            content: [
                { type: 'text', text: (mensaje || caption || 'Analiza la imagen en el contexto del negocio y ayuda al cliente.') },
                { type: 'image_url', image_url: { url: imageUrl } }
            ]
        } as any)
    } else {
        baseMessages.push({ role: 'user', content: (mensaje || '').trim() })
    }

    let respuesta = ''
    try {
        respuesta = (await chatComplete({ model: imageUrl ? VISION_MODEL : RAW_MODEL, messages: baseMessages, temperature: TEMPERATURE, maxTokens: MAX_COMPLETION_TOKENS }))?.trim()
    } catch {
        try {
            respuesta = (await chatComplete({ model: fallbackModel(), messages: baseMessages, temperature: TEMPERATURE, maxTokens: MAX_COMPLETION_TOKENS }))?.trim()
        } catch {
            const saved = await persistBotReply({
                conversationId: chatId,
                empresaId: conversacion.empresaId,
                texto: pick(CTAS),
                nuevoEstado: ConversationEstado.en_proceso,
                sendTo: opts?.autoSend ? (opts?.toPhone || conversacion.phone) : undefined,
                phoneNumberId: opts?.phoneNumberId,
            })
            return { estado: ConversationEstado.en_proceso, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid }
        }
    }

    respuesta = (respuesta || '').trim()
    if (!respuesta || esRespuestaInvalida(respuesta)) {
        const saved = await persistBotReply({
            conversationId: chatId,
            empresaId: conversacion.empresaId,
            texto: 'No sabría decirte con certeza; debo consultarlo. Si quieres, lo escalo con un asesor humano.',
            nuevoEstado: ConversationEstado.requiere_agente,
            sendTo: opts?.autoSend ? (opts?.toPhone || conversacion.phone) : undefined,
            phoneNumberId: opts?.phoneNumberId,
        })
        return { estado: ConversationEstado.requiere_agente, mensaje: saved.texto, motivo: 'confianza_baja', messageId: saved.messageId, wamid: saved.wamid }
    }

    const saved = await persistBotReply({
        conversationId: chatId,
        empresaId: conversacion.empresaId,
        texto: respuesta,
        nuevoEstado: ConversationEstado.respondido,
        sendTo: opts?.autoSend ? (opts?.toPhone || conversacion.phone) : undefined,
        phoneNumberId: opts?.phoneNumberId,
    })

    return { estado: ConversationEstado.respondido, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
}

/* ===================== Persistencia & helpers ===================== */
function normalizeToE164(n: string) { return String(n || '').replace(/[^\d]/g, '') }

async function persistBotReply({ conversationId, empresaId, texto, nuevoEstado, sendTo, phoneNumberId }: {
    conversationId: number; empresaId: number; texto: string; nuevoEstado: ConversationEstado; sendTo?: string; phoneNumberId?: string;
}) {
    const msg = await prisma.message.create({
        data: { conversationId, from: MessageFrom.bot, contenido: texto, empresaId, mediaType: null, mediaUrl: null, mimeType: null, caption: null, isVoiceNote: false, transcription: null } as any,
    })
    await prisma.conversation.update({ where: { id: conversationId }, data: { estado: nuevoEstado } })

    let wamid: string | undefined
    if (sendTo && String(sendTo).trim()) {
        try {
            const resp = await Wam.sendWhatsappMessage({ empresaId, to: normalizeToE164(sendTo!), body: texto, phoneNumberIdHint: phoneNumberId })
            wamid = (resp as any)?.data?.messages?.[0]?.id || (resp as any)?.messages?.[0]?.id
            if (wamid) await prisma.message.update({ where: { id: msg.id }, data: { externalId: wamid } })
            console.log('[persistBotReply] ✅ WhatsApp enviado, wamid:', wamid)
        } catch (err: any) {
            console.error('[persistBotReply] ERROR WhatsApp:', err?.response?.data || err?.message || err)
        }
    }
    return { messageId: msg.id, texto, wamid }
}

function short(s: string) { return s.trim().split('\n').slice(0, 6).join('\n') }

function formatMoney(val: any) {
    try {
        const n = Number(val); if (Number.isNaN(n)) return String(val)
        return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n)
    } catch { return String(val) }
}

async function sendProductImages({ chatId, conversacion, productosRelevantes, phoneNumberId, toOverride }: {
    chatId: number; conversacion: { empresaId: number; phone: string }; productosRelevantes: any[]; phoneNumberId?: string; toOverride?: string;
}) {
    const phone = toOverride || conversacion.phone
    const imgs = await prisma.productImage.findMany({
        where: { productId: { in: productosRelevantes.map((p: any) => p.id).filter(Boolean) }, url: { not: '' } },
        orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }, { id: 'asc' }],
        take: MAX_PRODUCTS_TO_SEND
    })

    const media: Array<{ productId: number; imageUrl: string; wamid?: string }> = []
    for (const img of imgs) {
        const prod = productosRelevantes.find((p: any) => p.id === img.productId); if (!prod) continue
        const caption = buildProductCaption(prod)
        try {
            const resp = await Wam.sendWhatsappMedia({ empresaId: conversacion.empresaId, to: phone, url: img.url, type: 'image', caption, phoneNumberIdHint: phoneNumberId } as any)
            const wamid = (resp as any)?.data?.messages?.[0]?.id || (resp as any)?.messages?.[0]?.id || (resp as any)?.outboundId
            media.push({ productId: img.productId, imageUrl: img.url, wamid })
            await prisma.message.create({
                data: { conversationId: chatId, empresaId: conversacion.empresaId, from: MessageFrom.bot, mediaType: MediaType.image, mediaUrl: img.url, caption, externalId: wamid, contenido: '' }
            })
        } catch (err: any) { console.error('[sendWhatsappMedia] error:', err?.response?.data || err?.message || err) }
    }
    return media
}

function buildProductCaption(p: { nombre: string; beneficios?: string | null; caracteristicas?: string | null; precioDesde?: any | null; descripcion?: string | null; }) {
    const bullets = (txt?: string | null, max = 3) => String(txt || '').split('\n').map(s => s.trim()).filter(Boolean).slice(0, max)
    const emoji = ['✨', '🌿', '💧', '🛡️', '⚡', '👍', '🙌']
    const pe = (i: number) => emoji[i % emoji.length]
    const lines: string[] = []
    lines.push(`• *${p.nombre}*`)
    const bens = bullets(p.beneficios, 3), cars = bullets(p.caracteristicas, 2)
    if (bens.length) lines.push(...bens.map((b, i) => `${pe(i)} ${b}`))
    else if (cars.length) lines.push(...cars.map((c, i) => `${pe(i)} ${c}`))
    if (p.precioDesde != null) lines.push(`💵 Desde: ${formatMoney(p.precioDesde)}`)
    return lines.slice(0, 5).join('\n')
}
