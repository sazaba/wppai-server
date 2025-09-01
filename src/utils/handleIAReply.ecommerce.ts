// server/src/utils/handleIAReply.ecommerce.ts
import axios from 'axios'
import prisma from '../lib/prisma'
import { openai } from '../lib/openai'
import { ConversationEstado, MediaType, MessageFrom } from '@prisma/client'
import { retrieveRelevantProducts } from './products.helper'

// ⚠️ Import en namespace para evitar discrepancias de tipos/exports
import * as Wam from '../services/whatsapp.service'
import { transcribeAudioBuffer } from '../services/transcription.service'

export type IAReplyResult = {
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
        .replace(/[^\w\s%]/g, ' ')
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

/* ============ Intents rápidos ============ */
const wantsImages = (t: string) =>
    ['imagen', 'imagenes', 'imágenes', 'foto', 'fotos', 'ver foto', 'ver imagen', 'muestra foto', 'mandame fotos', 'envíame fotos', 'enviame fotos']
        .some(k => nrm(t).includes(nrm(k)))

const asksCatalogue = (t: string) =>
    ['lista de productos', 'productos disponibles', 'portafolio', 'catálogo', 'catalogo', 'que productos', 'cuáles tienes', 'cuales tienes']
        .some(k => nrm(t).includes(nrm(k)))

const wantsPrice = (t: string) =>
    ['precio', 'precios', 'cuánto vale', 'valor'].some(k => nrm(t).includes(nrm(k)))

const saysPaid = (t: string) =>
    ['ya pague', 'ya pagué', 'pago realizado', 'hice el pago', 'ya hice el pago', 'pagado', 'comprobante']
        .some(k => nrm(t).includes(nrm(k)))

/* ===== Prompt con reglas anti-alucinación ===== */
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

/* ==================== Wrappers WAM ==================== */
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

/* ======================== Index de productos (fuzzy) ======================== */
type IndexEntry = {
    id: number
    nombre: string
    slug: string
    precioDesde: any | null
    text: string   // texto normalizado concatenado
}

const indexCache: Map<number, { items: IndexEntry[]; at: number }> = new Map()
const PRODUCT_INDEX_TTL_MS = 1000 * 60 * 5 // 5 minutos

function tokensOf(s: string): string[] {
    return nrm(s).split(' ').filter(w => w.length >= 2)
}
function jaccard(a: Set<string>, b: Set<string>) {
    const inter = new Set([...a].filter(x => b.has(x))).size
    const uni = new Set([...a, ...b]).size || 1
    return inter / uni
}
function dice(a: Set<string>, b: Set<string>) {
    const inter = new Set([...a].filter(x => b.has(x))).size
    return (2 * inter) / ((a.size || 1) + (b.size || 1))
}
function containsAll(a: Set<string>, b: Set<string>) {
    for (const t of b) if (!a.has(t)) return false
    return true
}

async function buildProductIndex(empresaId: number): Promise<{ items: IndexEntry[], at: number }> {
    const now = Date.now()
    const cached = indexCache.get(empresaId)
    if (cached && now - cached.at < PRODUCT_INDEX_TTL_MS) return cached

    const rows = await prisma.product.findMany({
        where: { empresaId, disponible: true },
        orderBy: { id: 'asc' },
        select: {
            id: true, nombre: true, slug: true,
            descripcion: true, beneficios: true, caracteristicas: true,
            precioDesde: true, disponible: true
        }
    })

    const items: IndexEntry[] = rows.map(r => {
        const text = nrm([
            r.nombre,
            r.slug,
            r.descripcion,
            r.beneficios,
            r.caracteristicas
        ].join(' '))
        return { id: r.id, nombre: r.nombre, slug: r.slug, precioDesde: r.precioDesde, text }
    })

    const out = { items, at: now }
    indexCache.set(empresaId, out)
    return out
}

function synonymsBase(bizKeywords: string) {
    const base = new Map<string, string[]>([
        ['serum', ['serum', 'suerum', 'sérum', 'vit c', 'vitamina c', 'vitamin c', 'suero']],
        ['hialuronico', ['hialuronico', 'hialurónico', 'acido hialuronico', 'ácido hialurónico', 'gel hialuronico', 'gel acido']],
        ['hidratante', ['hidratante', 'crema', 'gel hidratante']],
    ])
    const extra = String(bizKeywords || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
    if (extra.length) base.set('extra', extra)
    return base
}

function scoreQueryAgainst(entry: IndexEntry, query: string, recentNames: string[]): number {
    const q = nrm(query)
    if (!q) return 0
    const qset = new Set(tokensOf(q))
    const tset = new Set(tokensOf(entry.text))

    // boosts por menciones recientes del nombre exacto
    let boost = recentNames.some(n => nrm(n) === nrm(entry.nombre)) ? 0.15 : 0

    // coincidencia exacta/substring
    if (entry.text.includes(q)) return 0.98 + boost
    if (entry.nombre && nrm(entry.nombre).includes(q)) return 0.95 + boost

    // similitudes de conjuntos
    const j = jaccard(qset, tset)
    const d = dice(qset, tset)

    // si todas las palabras clave de la consulta están en el producto, sube
    const hard = containsAll(tset, qset) ? 0.12 : 0

    return Math.max(j * 0.6 + d * 0.4 + hard + boost, 0)
}

async function inferBestProduct(
    empresaId: number,
    text: string,
    recentProductNames: string[],
    bizKeywords: string
): Promise<{ id: number, nombre: string } | null> {
    const { items } = await buildProductIndex(empresaId)
    const q = nrm(text)

    // aplicar sinónimos (expandir la consulta)
    const syn = synonymsBase(bizKeywords)
    let expanded = q
    for (const [, arr] of syn) {
        for (const k of arr) {
            if (q.includes(nrm(k))) { expanded += ' ' + nrm(k) }
        }
    }

    let best: IndexEntry | null = null
    let bestScore = 0
    for (const it of items) {
        const s = scoreQueryAgainst(it, expanded, recentProductNames)
        if (s > bestScore) { best = it; bestScore = s }
    }

    // umbral flexible
    return bestScore >= 0.62 ? { id: best!.id, nombre: best!.nombre } : null
}

/* ---------- helpers de catálogo ---------- */
type ProductListItem = { nombre: string; precioDesde: any | null }
function listProductsMessage(list: ProductListItem[]): string {
    const lines: string[] = []
    lines.push('Tenemos estas opciones disponibles ahora mismo:')
    for (const p of (list || []).slice(0, 6)) {
        const price = p?.precioDesde != null ? ` — desde ${formatMoney(p.precioDesde)}` : ''
        lines.push(`• *${p?.nombre || ''}*${price}`)
    }
    lines.push('¿Quieres *fotos* de alguno o prefieres que te pase el *precio* de un producto en particular?')
    return lines.join('\n').trim().split('\n').slice(0, 10).join('\n')
}

/* ---------- NUEVO: memoria de foco + resolución ---------- */
const focusMem = new Map<number, { productId: number; at: number }>()
const FOCUS_TTL = 30 * 60 * 1000 // 30 min
function setFocus(chatId: number, productId: number) {
    focusMem.set(chatId, { productId, at: Date.now() })
}
function getFocus(chatId: number): number | null {
    const it = focusMem.get(chatId)
    if (!it) return null
    if (Date.now() - it.at > FOCUS_TTL) { focusMem.delete(chatId); return null }
    return it.productId
}

// buscar nombre explícito dentro de un texto
async function explicitProductByName(empresaId: number, text: string): Promise<{ id: number; nombre: string } | null> {
    const q = nrm(text)
    if (!q) return null
    const rows = await prisma.product.findMany({
        where: { empresaId, disponible: true },
        select: { id: true, nombre: true }
    })
    const hit = rows.find(r => q.includes(nrm(r.nombre)))
    return hit ? { id: hit.id, nombre: hit.nombre } : null
}

async function resolveFocusProductId(opts: {
    empresaId: number,
    chatId: number,
    agent?: { images?: Array<{ productId: number }>, products?: Array<{ id: number, nombre: string }> },
    explicit?: { name?: string }
}): Promise<number | null> {
    const { empresaId, chatId, agent, explicit } = opts

    // 0) foco en memoria
    const current = getFocus(chatId)
    if (current) {
        const ok = await prisma.product.findUnique({ where: { id: current }, select: { id: true, empresaId: true, disponible: true } })
        if (ok && ok.empresaId === empresaId && ok.disponible) return ok.id
    }

    // 1) agente → ids de imágenes
    const firstFromImages = agent?.images?.find(i => i?.productId)?.productId
    if (firstFromImages) return firstFromImages

    // 2) un solo producto por agente
    if (agent?.products?.length === 1 && agent.products[0]?.id) {
        return agent.products[0].id
    }

    // 3) nombre explícito
    if (explicit?.name) {
        const e = await explicitProductByName(empresaId, explicit.name)
        if (e?.id) return e.id
    }

    // 4) deducir por captions de las últimas imágenes del bot
    const lastBotImgs = await prisma.message.findMany({
        where: { conversationId: chatId, from: 'bot', mediaType: MediaType.image },
        orderBy: { timestamp: 'desc' },
        take: 10,
        select: { caption: true }
    })
    const names = (await prisma.product.findMany({
        where: { empresaId, disponible: true },
        select: { id: true, nombre: true }
    })) || []
    const dict = new Map(names.map(p => [nrm(p.nombre), p.id]))
    for (const m of lastBotImgs) {
        const cap = nrm(m.caption || '')
        for (const [normName, pid] of dict) {
            if (cap.includes(normName)) return pid
        }
    }

    return null
}

/* ========================= Core ========================= */
export const handleEcommerceIAReply = async (
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

    const mensajeEscalamiento = 'Gracias por tu mensaje. ¿Podrías darme un poco más de contexto?'

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
            // Cambiar estado a venta_en_proceso (verificación manual) — ÚNICO cambio de estado
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
                sendTo: opts?.toPhone ?? conversacion.phone,
                phoneNumberId: opts?.phoneNumberId,
            })
            return { estado: ConversationEstado.venta_en_proceso, mensaje: savedR.texto, messageId: savedR.messageId, wamid: savedR.wamid, media: [] }
        }

        // Imagen SIN texto → preguntamos
        if (!mensaje && !caption) {
            const ask = 'Veo tu foto 😊 ¿Te ayudo con algo de esa imagen? (por ejemplo: precio, disponibilidad, alternativas o cómo usarlo)'
            const saved = await persistBotReply({
                conversationId: chatId, empresaId: conversacion.empresaId, texto: ask,
                nuevoEstado: conversacion.estado, // no cambiar estado
                sendTo: opts?.toPhone ?? conversacion.phone,
                phoneNumberId: opts?.phoneNumberId,
            })
            return { estado: conversacion.estado, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
        }
    }

    // 3) Historial (hasta 30 mensajes) y nombres mencionados
    const mensajesPrevios = await prisma.message.findMany({
        where: { conversationId: chatId },
        orderBy: { timestamp: 'asc' },
        take: 60,                              // traemos más y luego filtramos con contenido
        select: { from: true, contenido: true },
    })
    const historial = mensajesPrevios
        .filter(m => (m.contenido || '').trim().length > 0)
        .slice(-30)                            // ← ahora usa 30 mensajes
        .map(m => ({ role: m.from === 'client' ? 'user' : 'assistant', content: m.contenido } as const))

    const recentAssistant = historial.filter(h => h.role === 'assistant').map(h => h.content.toString()).join('\n')
    const recentProductNames: string[] = []
    try {
        const avail = await prisma.product.findMany({
            where: { empresaId: conversacion.empresaId, disponible: true },
            select: { nombre: true },
            take: 40
        })
        const body = nrm(recentAssistant)
        for (const p of avail) {
            const name = nrm(p.nombre)
            if (name && body.includes(name)) recentProductNames.push(p.nombre)
        }
    } catch { /* ignore */ }

    // 3.1) Traer productos relevantes (para el prompt) – fallback simple
    let productos: any[] = []
    try {
        productos = await retrieveRelevantProducts(conversacion.empresaId, mensaje || (ultimoCliente?.caption ?? ''), 5)
    } catch (e) {
        console.warn('[handleIAReply] retrieveRelevantProducts error:', (e as any)?.message || e)
        productos = []
    }
    if (!productos.length) {
        productos = await prisma.product.findMany({
            where: { empresaId: conversacion.empresaId, disponible: true },
            take: 5, orderBy: { id: 'asc' }
        })
    }

    // 4) Respuestas no-IA para catálogo
    if (asksCatalogue(mensaje)) {
        const list = await prisma.product.findMany({
            where: { empresaId: conversacion.empresaId, disponible: true },
            take: 6, orderBy: { id: 'asc' },
            select: { nombre: true, precioDesde: true }
        })
        const txt = listProductsMessage(list)
        const saved = await persistBotReply({
            conversationId: chatId, empresaId: conversacion.empresaId, texto: txt,
            nuevoEstado: ConversationEstado.respondido,
            sendTo: opts?.toPhone ?? conversacion.phone,
            phoneNumberId: opts?.phoneNumberId,
        })
        return { estado: ConversationEstado.respondido, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
    }

    // 4.1) PRECIOS usando “producto en foco” (explícito → foco → fuzzy)
    if (wantsPrice(mensaje)) {
        let focusId = await resolveFocusProductId({
            empresaId: conversacion.empresaId,
            chatId,
            explicit: { name: mensaje }
        })

        if (!focusId) {
            const inferred = await inferBestProduct(
                conversacion.empresaId,
                mensaje || caption,
                recentProductNames,
                String(cfg(config, 'palabrasClaveNegocio') || '')
            )
            focusId = inferred?.id ?? null
        }

        if (focusId) {
            setFocus(chatId, focusId)
            const p = await prisma.product.findUnique({
                where: { id: focusId },
                select: { nombre: true, precioDesde: true }
            })
            if (p) {
                const txt = `El precio de *${p.nombre}* ${p.precioDesde != null ? `es ${formatMoney(p.precioDesde)}` : `lo confirmo enseguida`}. ¿Te lo reservo?`
                const saved = await persistBotReply({
                    conversationId: chatId, empresaId: conversacion.empresaId, texto: txt,
                    nuevoEstado: ConversationEstado.respondido,
                    sendTo: opts?.toPhone ?? conversacion.phone,
                    phoneNumberId: opts?.phoneNumberId,
                })
                return { estado: ConversationEstado.respondido, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
            }
        }

        // sin foco → lista corta
        const list = await prisma.product.findMany({
            where: { empresaId: conversacion.empresaId, disponible: true },
            take: 5, orderBy: { id: 'asc' },
            select: { nombre: true, precioDesde: true }
        })
        const txt = listProductsMessage(list)
        const saved = await persistBotReply({
            conversationId: chatId, empresaId: conversacion.empresaId, texto: txt,
            nuevoEstado: ConversationEstado.respondido,
            sendTo: opts?.toPhone ?? conversacion.phone,
            phoneNumberId: opts?.phoneNumberId,
        })
        return { estado: ConversationEstado.respondido, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
    }

    // 4.2) FOTOS → resolver un único producto y enviar
    {
        const destination = (opts?.toPhone ?? conversacion.phone) // ✅ ya no depende de autoSend
        const hasDestination = Boolean(destination)

        if (wantsImages(mensaje) && hasDestination) {
            const CLEAN_WORDS = ['foto', 'fotos', 'imagen', 'imagenes', 'imágenes', 'mandame', 'enviame', 'envíame', 'muestra', 'mostrar', 'de', 'del']
            const CLEAN_RE = new RegExp(`\\b(?:${CLEAN_WORDS.join('|')})\\b`, 'g')
            const baseText = (mensaje || '').replace(CLEAN_RE, ' ').trim()

            let target: { id: number; nombre: string } | null = null

            // foco actual
            const fId = getFocus(chatId)
            if (fId) {
                const row = await prisma.product.findUnique({ where: { id: fId }, select: { id: true, nombre: true, disponible: true, empresaId: true } })
                if (row && row.disponible && row.empresaId === conversacion.empresaId) target = { id: row.id, nombre: row.nombre }
            }

            // nombre explícito
            if (!target) {
                const e = await explicitProductByName(conversacion.empresaId, baseText || caption)
                if (e) target = e
            }

            // fuzzy
            if (!target) {
                const inferred = await inferBestProduct(
                    conversacion.empresaId,
                    baseText || caption || mensaje,
                    recentProductNames,
                    String(cfg(config, 'palabrasClaveNegocio') || '')
                )
                if (inferred) target = inferred
            }

            // desambiguación (top2 por contains + similitud)
            if (!target) {
                const q = nrm(baseText || caption || mensaje)
                const prods = await prisma.product.findMany({
                    where: {
                        empresaId: conversacion.empresaId,
                        disponible: true,
                        OR: [
                            { nombre: { contains: q } },
                            { descripcion: { contains: q } },
                            { beneficios: { contains: q } },
                            { caracteristicas: { contains: q } },
                        ]
                    },
                    take: 6, orderBy: { id: 'asc' },
                    select: { id: true, nombre: true }
                })
                const scored = prods
                    .map(p => ({ p, s: jaccard(new Set(tokensOf(nrm(p.nombre))), new Set(tokensOf(q))) }))
                    .sort((a, b) => b.s - a.s)
                    .slice(0, 2)

                if (scored[0] && (scored.length === 1 || (scored[0].s - (scored[1]?.s ?? 0)) >= 0.15)) {
                    target = { id: scored[0].p.id, nombre: scored[0].p.nombre }
                } else if (scored.length === 2) {
                    const ask = `¿De cuál producto quieres *fotos*?\n1) *${scored[0].p.nombre}*\n2) *${scored[1].p.nombre}*`
                    const saved = await persistBotReply({
                        conversationId: chatId,
                        empresaId: conversacion.empresaId,
                        texto: ask,
                        nuevoEstado: conversacion.estado,
                        sendTo: destination,
                        phoneNumberId: opts?.phoneNumberId,
                    })
                    return { estado: conversacion.estado, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
                }
            }

            if (target) {
                setFocus(chatId, target.id)
                const mediaSent = await sendProductImages({
                    chatId,
                    conversacion: { empresaId: conversacion.empresaId, phone: destination },
                    productosRelevantes: [{ id: target.id, nombre: target.nombre }],
                    phoneNumberId: opts?.phoneNumberId,
                    toOverride: destination
                })

                const follow = `Te compartí fotos de *${target.nombre}*. ¿Quieres el *precio* o ver *alternativas*?`
                const saved = await persistBotReply({
                    conversationId: chatId,
                    empresaId: conversacion.empresaId,
                    texto: follow,
                    nuevoEstado: ConversationEstado.respondido,
                    sendTo: destination,
                    phoneNumberId: opts?.phoneNumberId,
                })
                return {
                    estado: ConversationEstado.respondido,
                    mensaje: saved.texto,
                    messageId: saved.messageId,
                    wamid: saved.wamid,
                    media: mediaSent
                }
            }

            // Sin foco claro → pedir precisión
            const names = (await prisma.product.findMany({
                where: { empresaId: conversacion.empresaId, disponible: true },
                take: 3,
                orderBy: { id: 'asc' },
                select: { nombre: true }
            })).map(p => `*${p.nombre}*`)
            const ask = `¿De cuál producto quieres fotos? ${names.length ? `Ej.: ${names.join(' / ')}` : ''}`
            const saved = await persistBotReply({
                conversationId: chatId,
                empresaId: conversacion.empresaId,
                texto: ask,
                nuevoEstado: conversacion.estado,
                sendTo: destination,
                phoneNumberId: opts?.phoneNumberId,
            })
            return { estado: conversacion.estado, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
        }
    }

    /* ===== 5) IA (anclada a BusinessConfig + productos, SIN flujo de compra; no cambia estado salvo pago) ===== */
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
                nuevoEstado: conversacion.estado,
                sendTo: opts?.toPhone ?? conversacion.phone,
                phoneNumberId: opts?.phoneNumberId,
            })
            return { estado: conversacion.estado, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid }
        }
    }

    respuesta = (respuesta || '').trim()
    if (!respuesta || esRespuestaInvalida(respuesta)) {
        const saved = await persistBotReply({
            conversationId: chatId,
            empresaId: conversacion.empresaId,
            texto: 'Puedo ayudarte con *precios*, *beneficios* o *fotos*. ¿Qué te comparto?',
            nuevoEstado: conversacion.estado,
            sendTo: opts?.toPhone ?? conversacion.phone,
            phoneNumberId: opts?.phoneNumberId,
        })
        return { estado: conversacion.estado, mensaje: saved.texto, motivo: 'confianza_baja', messageId: saved.messageId, wamid: saved.wamid }
    }

    const saved = await persistBotReply({
        conversationId: chatId,
        empresaId: conversacion.empresaId,
        texto: respuesta,
        nuevoEstado: ConversationEstado.respondido,
        sendTo: opts?.toPhone ?? conversacion.phone,
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
    // 👉 mantener estado habitual, salvo cuando explícitamente se pasa (pago)
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
