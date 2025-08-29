// server/src/utils/handleIAReply.ts
import axios from 'axios'
import prisma from '../lib/prisma'
import { shouldEscalateChat } from './shouldEscalate'
import { openai } from '../lib/openai'
import { ConversationEstado, MediaType, MessageFrom } from '@prisma/client'
import { retrieveRelevantProducts } from './products.helper'

// ✅ services unificados
import {
    sendWhatsappMessage,
    sendWhatsappMedia,
} from '../services/whatsapp.service'

type IAReplyResult = {
    estado: ConversationEstado
    mensaje?: string
    motivo?: 'confianza_baja' | 'palabra_clave' | 'reintentos'
    messageId?: number
    wamid?: string
    media?: Array<{ productId: number; imageUrl: string; wamid?: string }>
}

/* ===== Config IA =====
   Texto: Claude 3.5 Sonnet (OpenRouter)
   Visión: GPT-4o-mini (cliente OpenAI)
*/
const RAW_MODEL =
    process.env.IA_TEXT_MODEL ||            // nuevo (prioritario)
    process.env.IA_MODEL ||                 // compatibilidad
    'anthropic/claude-3.5-sonnet'

const TEMPERATURE = Number(process.env.IA_TEMPERATURE ?? 0.3)
const MAX_COMPLETION_TOKENS = Number(process.env.IA_MAX_TOKENS ?? 350)

// OpenRouter
const OPENROUTER_BASE = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1'
const OPENROUTER_URL = `${OPENROUTER_BASE}/chat/completions`
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY || ''

// OpenAI (visión)
const VISION_MODEL = process.env.IA_VISION_MODEL || 'gpt-4o-mini'

// Ajustes catálogo
const MAX_PRODUCTS_TO_SEND = Number(process.env.MAX_PRODUCTS_TO_SEND || 3)

/* ========================= Utils ========================= */
function normalizeModelId(model: string): string {
    const m = (model || '').trim()
    if (m === 'google/gemini-2.0-flash-lite') return 'google/gemini-2.0-flash-lite-001'
    return m
}
function isOpenRouterModel(model: string): boolean { return model.includes('/') }
function fallbackModel(): string { return 'google/gemini-2.0-flash-lite-001' }

// Para el cliente OpenAI: si por error ponen "openai/gpt-4o-mini" lo normalizamos.
function normalizeForOpenAI(model: string): string {
    return model.replace(/^openai\//i, '').trim()
}

function normalizarTexto(texto: string): string {
    return (texto || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
}

function pick<T>(arr: T[]): T {
    return arr[Math.max(0, Math.floor(Math.random() * arr.length))] as T
}

// 🔥 CTAs aleatorias para sonar menos robótico
const CTAS = [
    '¿Te comparto *beneficios*, *precio* o *disponibilidad*? 🙂',
    '¿Prefieres ver *precios* o conocer *beneficios* primero? ✨',
    'Puedo enviarte *fotos*, *precio* o *promos* vigentes. ¿Qué te sirve más? 📸💸',
    '¿Te confirmo *stock* o te cuento *ventajas*? 😉',
]

// 🚫 Mucho más corta: solo lo crítico
const FRASES_PROHIBIDAS = [
    'soy una ia', 'modelo de lenguaje', 'inteligencia artificial'
].map(normalizarTexto)

function esRespuestaInvalida(respuesta: string): boolean {
    const r = normalizarTexto(respuesta || '')
    const tieneEmail = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/.test(respuesta)
    const tieneLink = /https?:\/\/|www\./i.test(respuesta)
    const tieneTel = /\+?\d[\d\s().-]{6,}/.test(respuesta)
    const contiene = FRASES_PROHIBIDAS.some(p => r.includes(p))
    return tieneEmail || tieneLink || tieneTel || contiene
}

/* ============ Topic shift relajado ============ */
function detectTopicShift(userText: string, negocioKeywords: string[]): boolean {
    const t = (userText || '').toLowerCase()
    if (!t) return false
    const onTopic = negocioKeywords.some(k => k && t.includes(k.toLowerCase()))
    return !onTopic
}

/* ============ Intents ============ */
function isProductIntent(text: string): boolean {
    const t = normalizarTexto(text)
    const keys = ['producto', 'productos', 'catalogo', 'catalogo', 'precio', 'precios', 'foto', 'fotos', 'imagen', 'imagenes', 'mostrar', 'ver', 'presentacion', 'beneficio', 'beneficios', 'caracteristica', 'caracteristicas', 'promocion', 'promoción', 'oferta', 'disponibilidad']
    return keys.some(k => t.includes(k))
}
function isPriceQuestion(text: string): boolean {
    const t = normalizarTexto(text)
    const keys = ['precio', 'cuesta', 'vale', 'costo', 'cuanto', 'cuánto', 'valor', 'exactamente']
    return keys.some(k => t.includes(k))
}
function isImageAsk(text: string): boolean {
    const t = normalizarTexto(text)
    const keys = ['imagen', 'imagenes', 'imágenes', 'foto', 'fotos', 'ver foto', 'ver imagen', 'muestra foto']
    return keys.some(k => t.includes(k))
}

/* ====== Intents negocio (desde BusinessConfig) ====== */
const Q_ENVIO = ['envio', 'enviar', 'envíos', 'envios', 'domicilio']
const Q_PAGO = ['pago', 'pagos', 'metodos de pago', 'tarjeta', 'transferencia', 'contraentrega', 'contra entrega']
const Q_HORARIO = ['horario', 'atienden', 'abren', 'cierran']
const Q_TIENDA = ['tienda fisica', 'tienda física', 'direccion', 'dirección', 'donde quedan', 'ubicacion', 'ubicación']
const Q_DEV = ['devolucion', 'devolución', 'cambio', 'cambios', 'reembolso']
const Q_GARANTIA = ['garantia', 'garantía']
const Q_PROMOS = ['promocion', 'promoción', 'promos', 'descuento', 'descuentos', 'oferta', 'ofertas']
const Q_CANALES = ['canal', 'contacto', 'atencion', 'soporte', 'hablar', 'comunicar']

function textIncludesAny(t: string, arr: string[]) {
    const n = normalizarTexto(t)
    return arr.some(k => n.includes(normalizarTexto(k)))
}

function isBusinessInfoQuestion(t: string) {
    const flags = {
        envios: textIncludesAny(t, Q_ENVIO),
        pagos: textIncludesAny(t, Q_PAGO),
        horario: textIncludesAny(t, Q_HORARIO),
        tienda: textIncludesAny(t, Q_TIENDA),
        devol: textIncludesAny(t, Q_DEV),
        garantia: textIncludesAny(t, Q_GARANTIA),
        promos: textIncludesAny(t, Q_PROMOS),
        canales: textIncludesAny(t, Q_CANALES),
        faq: /p:\s*|faq/i.test(t)
    }
    const any = Object.values(flags).some(Boolean)
    return { any, flags }
}

function shortReply(s: string) {
    // normaliza a 2–4 líneas como máximo
    return s.trim().split('\n').slice(0, 4).join('\n')
}

/* ====== FAQ helpers ====== */
function parseFAQ(faqText?: string) {
    const text = String(faqText || '').trim()
    if (!text) return []
    const pairs: Array<{ q: string; a: string }> = []
    const chunks = text.split(/P:\s*/i).map(s => s.trim()).filter(Boolean)
    for (const ch of chunks) {
        const [q, rest] = ch.split(/R:\s*/i)
        if (q && rest) {
            const qClean = q.replace(/\s+/g, ' ').trim()
            const aClean = rest.replace(/\s+/g, ' ').replace(/(?:^\.|^\s*-\s*)/g, '').trim()
            pairs.push({ q: qClean, a: aClean })
        }
    }
    return pairs
}

/* ====== Build deterministic business answers ====== */
function buildBusinessAnswer(config: any, flags: ReturnType<typeof isBusinessInfoQuestion>['flags']): string | null {
    const parts: string[] = []
    const em = { box: '📦', money: '💳', clock: '⏰', pin: '📍', refresh: '🔄', shield: '🛡️', tag: '🏷️', chat: '💬' }

    if (flags.envios && (config?.enviosInfo || '').trim()) parts.push(`${em.box} *Envíos:* ${config.enviosInfo.trim()}`)
    if (flags.pagos && (config?.metodosPago || '').trim()) parts.push(`${em.money} *Pagos:* ${config.metodosPago.trim()}`)
    if (flags.horario && (config?.horarios || '').trim()) parts.push(`${em.clock} *Horario:* ${config.horarios.trim()}`)
    if (flags.tienda && (config?.tiendaFisica || config?.direccionTienda)) {
        const dir = config?.tiendaFisica ? (config?.direccionTienda || 'Tienda física disponible') : 'Por ahora solo atendemos online'
        parts.push(`${em.pin} *Tienda:* ${config?.tiendaFisica ? 'Sí' : 'No'}. ${dir}`)
    }
    if (flags.devol && (config?.politicasDevolucion || '').trim()) parts.push(`${em.refresh} *Devoluciones:* ${config.politicasDevolucion.trim()}`)
    if (flags.garantia && (config?.politicasGarantia || '').trim()) parts.push(`${em.shield} *Garantía:* ${config.politicasGarantia.trim()}`)
    if (flags.promos && (config?.promocionesInfo || '').trim()) parts.push(`${em.tag} *Promos:* ${config.promocionesInfo.trim()}`)
    if (flags.canales && (config?.canalesAtencion || '').trim()) parts.push(`${em.chat} *Atención:* ${config.canalesAtencion.trim()}`)

    if (!parts.length) return null
    return shortReply(parts.join('\n'))
}

/* ====== Facts for LLM (tono humano y ventas) ====== */
function buildSystemPrompt(config: any, productos: any[], mensajeEscalamiento: string, empresaNombre?: string): string {
    const marca = (config?.nombre || empresaNombre || 'la marca')

    const catHeader =
        Array.isArray(productos) && productos.length > 0
            ? `\n[CATÁLOGO AUTORIZADO]\n${productos.map((p) => `- ${p.nombre}
  Descripción: ${p.descripcion ?? ''}
  Beneficios: ${p.beneficios ?? ''}
  Características: ${p.caracteristicas ?? ''}
  ${p?.precioDesde != null ? `Precio desde: ${p.precioDesde}` : ''}`).join('\n\n')}\n`
            : ''

    const infoNegocio = `
[NEGOCIO]
- Nombre: ${marca}
- Descripción: ${config?.descripcion ?? ''}
- Tipo: ${config?.businessType ?? ''}
- Horarios: ${config?.horarios ?? ''}

[OPERACIÓN]
- Envíos: ${config?.enviosInfo ?? ''}
- Métodos de pago: ${config?.metodosPago ?? ''}
- Tienda física: ${config?.tiendaFisica ? 'Sí' : 'No'}${config?.tiendaFisica && config?.direccionTienda ? ` (Dirección: ${config?.direccionTienda})` : ''}
- Devoluciones: ${config?.politicasDevolucion ?? ''}
- Garantía: ${config?.politicasGarantia ?? ''}
- Promociones: ${config?.promocionesInfo ?? ''}
- Canales de atención: ${config?.canalesAtencion ?? ''}
- Extras: ${config?.extras ?? ''}

[FAQs]
${config?.faq ?? ''}

${catHeader}
  `.trim()

    const reglas = `
[REGLAS – ORIENTADAS A VENTAS]
1) Prioriza la información de [NEGOCIO]/[OPERACIÓN]/[CATÁLOGO AUTORIZADO]/[FAQs]. Si falta un dato, dilo breve y ofrece alternativas útiles.
2) No inventes teléfonos, correos, links, precios o stock si no están arriba.
3) Mantén conversación humana y cordial. Puedes hacer small-talk en 1 línea y pivotar a compra.
4) Máx 2–4 líneas por respuesta. Usa viñetas cuando aporte claridad.
5) No menciones que eres IA.
6) Si el usuario insiste en algo fuera de contexto del negocio, reconduce con cortesía. Solo usa el mensaje de escalamiento como último recurso:
   "${mensajeEscalamiento}"
${config?.disclaimers ? `7) Disclaimers del negocio:\n${config.disclaimers}` : ''}
${config?.palabrasClaveNegocio ? `8) Palabras clave del negocio: ${config.palabrasClaveNegocio}` : ''}
  `.trim()

    return `Eres un asesor humano de "${marca}" con estilo cercano y experto en marketing conversacional.
Saluda de forma breve y empática cuando corresponda, presenta la marca en 1 frase y guía con CTA claras hacia precio, beneficios o disponibilidad.

${infoNegocio}

${reglas}

[FORMATO]
- Respuestas concisas (2–4 líneas).
- Sé específico: usa los datos del negocio y catálogo.
- Cierra con una micro-CTA contextual (p.ej., precio/beneficios/disponibilidad).`
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
    const normalized = normalizeModelId(model) || fallbackModel()
    const hasImage = messages.some(m =>
        Array.isArray(m.content) && m.content.some((p: any) => p?.type === 'image_url')
    )

    // 🔎 Si hay imagen -> siempre OpenAI visión (GPT-4o-mini)
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

    // 🔎 Texto: si el modelo contiene "proveedor/modelo" -> OpenRouter (Claude, Gemini, etc.)
    if (isOpenRouterModel(normalized)) {
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
        return typeof content === 'string'
            ? content
            : Array.isArray(content)
                ? content.map((c: any) => c?.text || '').join(' ')
                : ''
    }

    // 🔎 Texto con cliente OpenAI (por si pones un modelo OpenAI aquí)
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

/* ========================= Core ========================= */
export const handleIAReply = async (
    chatId: number,
    mensajeArg: string,
    opts?: { toPhone?: string; autoSend?: boolean; phoneNumberId?: string }
): Promise<IAReplyResult | null> => {

    // 0) Conversación
    const conversacion = await prisma.conversation.findUnique({
        where: { id: chatId },
        select: { id: true, estado: true, empresaId: true, phone: true },
    })
    if (!conversacion || conversacion.estado === 'cerrado') {
        console.warn(`[handleIAReply] 🔒 La conversación ${chatId} está cerrada. No se procesará.`)
        return null
    }

    // 1) Config del negocio
    const config = await prisma.businessConfig.findFirst({
        where: { empresaId: conversacion.empresaId },
        orderBy: { updatedAt: 'desc' },
    })
    const empresa = await prisma.empresa.findUnique({ where: { id: conversacion.empresaId }, select: { nombre: true } })
    const marca = (config?.nombre || empresa?.nombre || 'nuestra marca')

    const mensajeEscalamiento =
        'Gracias por tu mensaje. En breve un compañero del equipo te contactará para ayudarte con más detalle.'

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

    // 2) Último mensaje del cliente (voz/imagen)
    const ultimoCliente = await prisma.message.findFirst({
        where: { conversationId: chatId, from: 'client' },
        orderBy: { timestamp: 'desc' },
        select: {
            mediaType: true, mediaUrl: true, mimeType: true, caption: true,
            isVoiceNote: true, transcription: true, contenido: true, timestamp: true
        }
    })

    let mensaje = (mensajeArg || '').trim()
    // 🔊 voz → usamos transcripción si ya existe (este archivo NO transcribe)
    if (!mensaje && ultimoCliente?.isVoiceNote && (ultimoCliente.transcription || '').trim()) {
        mensaje = String(ultimoCliente.transcription).trim()
    }
    const isImage = ultimoCliente?.mediaType === MediaType.image && !!ultimoCliente.mediaUrl
    const imageUrl = isImage ? String(ultimoCliente?.mediaUrl) : null

    // 3) Historial breve
    const mensajesPrevios = await prisma.message.findMany({
        where: { conversationId: chatId },
        orderBy: { timestamp: 'asc' },
        take: 12,
        select: { from: true, contenido: true },
    })
    const historial = mensajesPrevios
        .filter(m => (m.contenido || '').trim().length > 0)
        .map(m => ({ role: m.from === 'client' ? 'user' : 'assistant', content: m.contenido } as const))

    // 3.1) Productos relevantes
    let productosRelevantes: any[] = []
    try {
        productosRelevantes = await retrieveRelevantProducts(conversacion.empresaId, mensaje || (ultimoCliente?.caption ?? ''), 5)
    } catch (err) {
        console.warn('[handleIAReply] retrieveRelevantProducts error:', (err as any)?.message || err)
        productosRelevantes = []
    }
    // 3.2) Fallback simple por texto
    if (!productosRelevantes.length && mensaje) {
        const tokens = Array.from(new Set(normalizarTexto(mensaje).split(' ').filter(w => w.length >= 3)))
        if (tokens.length) {
            productosRelevantes = await prisma.product.findMany({
                where: {
                    empresaId: conversacion.empresaId,
                    OR: [{ nombre: { contains: tokens[0] } }, { descripcion: { contains: tokens[0] } }]
                },
                take: 5, orderBy: { id: 'asc' }
            })
        }
        if (!productosRelevantes.length) {
            productosRelevantes = await prisma.product.findMany({
                where: { empresaId: conversacion.empresaId, disponible: true },
                take: 3, orderBy: { id: 'asc' }
            })
        }
    }

    /* ===== 4) Rutas determinísticas ANTES del LLM ===== */

    // 4.0 “¿Qué es [marca]?” — saludo humano usando descripción si existe
    const askedWhatIsBrand =
        /que\s+es\s+|qué\s+es\s+/i.test(mensaje) &&
        new RegExp((config?.nombre || empresa?.nombre || ''), 'i').test(mensaje || '')

    if (askedWhatIsBrand) {
        const desc = (config?.descripcion || '').trim()
        const cta = pick(CTAS)
        const texto = desc
            ? `¡Hola! Soy del equipo de *${marca}*. ${desc}\n${cta}`
            : `¡Hola! Soy del equipo de *${marca}*. Te guío con catálogo, promos y envíos.\n${cta}`

        const saved = await persistBotReply({
            conversationId: chatId, empresaId: conversacion.empresaId, texto,
            nuevoEstado: ConversationEstado.respondido,
            sendTo: opts?.autoSend ? (opts?.toPhone || conversacion.phone) : undefined,
            phoneNumberId: opts?.phoneNumberId,
        })
        return { estado: ConversationEstado.respondido, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
    }

    // 4.1 Precio directo
    if (isPriceQuestion(mensaje) && productosRelevantes.length) {
        const p = productosRelevantes[0]
        const precio = p?.precioDesde != null ? formatMoney(p.precioDesde) : null
        const texto = precio
            ? `*${p.nombre}*: desde ${precio}. ¿Te confirmo disponibilidad o prefieres conocer beneficios?`
            : `No tengo registrado el precio de *${p.nombre}*. ¿Quieres que te comparta beneficios o disponibilidad?`
        const saved = await persistBotReply({
            conversationId: chatId, empresaId: conversacion.empresaId, texto,
            nuevoEstado: ConversationEstado.respondido,
            sendTo: opts?.autoSend ? (opts?.toPhone || conversacion.phone) : undefined,
            phoneNumberId: opts?.phoneNumberId,
        })
        return { estado: ConversationEstado.respondido, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
    }

    // 4.2 Imagen directa
    if (isImageAsk(mensaje) && productosRelevantes.length && opts?.autoSend) {
        const phone = opts?.toPhone || conversacion.phone
        const imgs = await prisma.productImage.findMany({
            where: { productId: { in: productosRelevantes.map((p: any) => p.id).filter(Boolean) }, url: { not: '' } },
            orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }, { id: 'asc' }],
            take: MAX_PRODUCTS_TO_SEND
        })

        const mediaSent: Array<{ productId: number; imageUrl: string; wamid?: string }> = []
        for (const img of imgs) {
            const prod = productosRelevantes.find((p: any) => p.id === img.productId)
            if (!prod) continue
            const caption = buildProductCaption(prod)
            try {
                const resp = await sendWhatsappMedia({
                    empresaId: conversacion.empresaId,
                    to: phone,
                    url: img.url,
                    type: 'image',
                    caption,
                    phoneNumberIdHint: opts?.phoneNumberId,
                } as any)
                const wamid =
                    (resp as any)?.data?.messages?.[0]?.id ||
                    (resp as any)?.messages?.[0]?.id ||
                    (resp as any)?.outboundId || undefined

                mediaSent.push({ productId: img.productId, imageUrl: img.url, wamid })
                await prisma.message.create({
                    data: {
                        conversationId: chatId,
                        empresaId: conversacion.empresaId,
                        from: MessageFrom.bot,
                        mediaType: MediaType.image,
                        mediaUrl: img.url,
                        caption,
                        externalId: wamid,
                        contenido: '',
                    }
                })
            } catch (err: any) {
                console.error('[sendWhatsappMedia] error:', err?.response?.data || err?.message || err)
            }
        }

        const texto = mediaSent.length
            ? 'Te compartí imágenes del catálogo. ¿Quieres saber precios o disponibilidad?'
            : 'No encontré imágenes ahora. ¿Te comparto beneficios o precio?'
        const saved = await persistBotReply({
            conversationId: chatId, empresaId: conversacion.empresaId, texto,
            nuevoEstado: ConversationEstado.respondido,
            sendTo: opts?.autoSend ? (opts?.toPhone || conversacion.phone) : undefined,
            phoneNumberId: opts?.phoneNumberId,
        })
        return { estado: ConversationEstado.respondido, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: mediaSent }
    }

    // 4.3 Preguntas del negocio → responder desde BusinessConfig sin LLM
    const bi = isBusinessInfoQuestion(mensaje || ultimoCliente?.caption || '')
    if (bi.any) {
        const ans = buildBusinessAnswer(config, bi.flags)
        if (ans) {
            const saved = await persistBotReply({
                conversationId: chatId,
                empresaId: conversacion.empresaId,
                texto: ans,
                nuevoEstado: ConversationEstado.respondido,
                sendTo: opts?.autoSend ? (opts?.toPhone || conversacion.phone) : undefined,
                phoneNumberId: opts?.phoneNumberId,
            })
            return { estado: ConversationEstado.respondido, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
        }
    }

    /* ===== 5) Prompt y topic shift (LLM) ===== */
    const systemPrompt = buildSystemPrompt(config, productosRelevantes, mensajeEscalamiento, empresa?.nombre)
    const negocioKeywords: string[] = [
        marca,
        ...(productosRelevantes?.map((p: any) => p?.nombre).filter(Boolean) ?? []),
        ...(String(config?.servicios || '').split(/\W+/).slice(0, 6))
    ].filter(Boolean)

    const baseMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: any }> = [
        { role: 'system', content: systemPrompt },
        ...historial
    ]
    if (imageUrl) {
        baseMessages.push({
            role: 'user',
            content: [
                { type: 'text', text: (mensaje || ultimoCliente?.caption || 'Analiza esta imagen dentro del contexto del negocio y ayuda al cliente.') },
                { type: 'image_url', image_url: { url: imageUrl } },
            ],
        } as any)
    } else {
        baseMessages.push({ role: 'user', content: (mensaje || '').trim() })
    }

    // 6) LLM
    let respuestaIA = ''
    try {
        respuestaIA = (await chatComplete({
            model: imageUrl ? VISION_MODEL : RAW_MODEL,
            messages: baseMessages,
            temperature: TEMPERATURE,
            maxTokens: MAX_COMPLETION_TOKENS,
        }))?.trim()
    } catch (e: any) {
        console.error('[IA] error:', e?.message || e)
        try {
            respuestaIA = (await chatComplete({
                model: fallbackModel(),
                messages: baseMessages,
                temperature: TEMPERATURE,
                maxTokens: MAX_COMPLETION_TOKENS,
            }))?.trim()
        } catch (e2: any) {
            console.error('[IA] fallback error:', e2?.message || e2)
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

    respuestaIA = (respuestaIA || '').replace(/\s+$/g, '').trim()
    console.log('🧠 Respuesta generada por IA:', respuestaIA)

    // 7) Validaciones y reconducción — topic shift más permisivo
    const topicShift = detectTopicShift(mensaje || ultimoCliente?.caption || '', negocioKeywords)
    const onProductOrBiz = isProductIntent(mensaje || '') || bi.any

    let debeEscalar =
        !respuestaIA ||
        respuestaIA === mensajeEscalamiento ||
        normalizarTexto(respuestaIA) === normalizarTexto(mensajeEscalamiento) ||
        esRespuestaInvalida(respuestaIA)

    if (topicShift && !onProductOrBiz && !debeEscalar) {
        // Small reconduce, pero humano
        const reconduce = pick([
            `Estoy para ayudarte con *${marca}*. ${pick(CTAS)}`,
            `Te guío con nuestro catálogo, promos y envíos. ${pick(CTAS)}`,
        ])
        respuestaIA = reconduce
    }

    // 8) Reglas finales de escalamiento (solo último recurso)
    const iaConfianzaBaja =
        respuestaIA.length < 8 ||
        /no estoy seguro|no tengo certeza|no cuento con esa info/i.test(respuestaIA)

    const motivoFinal = shouldEscalateChat({
        mensaje: mensaje || ultimoCliente?.caption || '',
        config,
        iaConfianzaBaja,
        intentosFallidos: Math.max(0, (config?.escalarPorReintentos ?? 0) - 1),
    })

    if (debeEscalar || motivoFinal === 'palabra_clave') {
        const saved = await persistBotReply({
            conversationId: chatId,
            empresaId: conversacion.empresaId,
            texto: mensajeEscalamiento,
            nuevoEstado: ConversationEstado.requiere_agente,
            sendTo: opts?.autoSend ? (opts?.toPhone || conversacion.phone) : undefined,
            phoneNumberId: opts?.phoneNumberId,
        })
        return { estado: ConversationEstado.requiere_agente, mensaje: saved.texto, motivo: motivoFinal || 'confianza_baja', messageId: saved.messageId, wamid: saved.wamid }
    }

    // 9) Guardar respuesta texto OK
    const saved = await persistBotReply({
        conversationId: chatId,
        empresaId: conversacion.empresaId,
        texto: respuestaIA,
        nuevoEstado: ConversationEstado.respondido,
        sendTo: opts?.autoSend ? (opts?.toPhone || conversacion.phone) : undefined,
        phoneNumberId: opts?.phoneNumberId,
    })

    // 10) Envío proactivo de imágenes si el usuario pidió productos
    let mediaSent: Array<{ productId: number; imageUrl: string; wamid?: string }> = []
    const wantsProducts = isProductIntent(mensaje || ultimoCliente?.caption || '')
    if (wantsProducts && opts?.autoSend && (opts?.toPhone || conversacion.phone) && productosRelevantes.length) {
        const phone = opts?.toPhone || conversacion.phone
        const productIds = productosRelevantes.slice(0, MAX_PRODUCTS_TO_SEND).map((p: any) => p.id).filter(Boolean)

        if (productIds.length) {
            const imgs = await prisma.productImage.findMany({
                where: { productId: { in: productIds }, url: { not: '' } },
                orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }, { id: 'asc' }],
                select: { id: true, productId: true, url: true, alt: true, isPrimary: true }
            })

            const mapByProduct = new Map<number, { url: string; alt: string }>()
            for (const pid of productIds) {
                const img = imgs.find(i => i.productId === pid)
                if (img) mapByProduct.set(pid, { url: img.url, alt: img.alt || '' })
            }

            for (const pid of productIds) {
                const prod = productosRelevantes.find((p: any) => p.id === pid)
                const img = mapByProduct.get(pid)
                if (!prod || !img) continue

                const caption = buildProductCaption(prod)
                try {
                    const resp = await sendWhatsappMedia({
                        empresaId: conversacion.empresaId,
                        to: phone,
                        url: img.url,
                        type: 'image',
                        caption,
                        phoneNumberIdHint: opts?.phoneNumberId,
                    } as any)

                    const wamid =
                        (resp as any)?.data?.messages?.[0]?.id ||
                        (resp as any)?.messages?.[0]?.id ||
                        (resp as any)?.outboundId || undefined

                    mediaSent.push({ productId: pid, imageUrl: img.url, wamid })
                    await prisma.message.create({
                        data: {
                            conversationId: chatId,
                            empresaId: conversacion.empresaId,
                            from: MessageFrom.bot,
                            mediaType: MediaType.image,
                            mediaUrl: img.url,
                            caption,
                            externalId: wamid,
                            contenido: '',
                        }
                    })
                } catch (err: any) {
                    console.error('[sendWhatsappMedia] error:', err?.response?.data || err?.message || err)
                }
            }
        }
    }

    return {
        estado: ConversationEstado.respondido,
        mensaje: saved.texto,
        messageId: saved.messageId,
        wamid: saved.wamid,
        media: mediaSent
    }
}

/* ===================== Persistencia común ===================== */
function normalizeToE164(n: string) { return String(n || '').replace(/[^\d]/g, '') }

async function persistBotReply({
    conversationId, empresaId, texto, nuevoEstado, sendTo, phoneNumberId,
}: {
    conversationId: number
    empresaId: number
    texto: string
    nuevoEstado: ConversationEstado
    sendTo?: string
    phoneNumberId?: string
}) {
    const msg = await prisma.message.create({
        data: {
            conversationId,
            from: MessageFrom.bot,
            contenido: texto,
            empresaId,
            mediaType: null,
            mediaUrl: null,
            mimeType: null,
            caption: null,
            isVoiceNote: false,
            transcription: null,
        } as any,
    })

    await prisma.conversation.update({
        where: { id: conversationId },
        data: { estado: nuevoEstado },
    })

    const willSend = Boolean(sendTo && String(sendTo).trim().length > 0)
    let wamid: string | undefined
    if (willSend) {
        const toNorm = normalizeToE164(sendTo!)
        try {
            const resp = await sendWhatsappMessage({
                empresaId,
                to: toNorm,
                body: texto,
                phoneNumberIdHint: phoneNumberId,
            })
            const idFromAxios = (resp as any)?.data?.messages?.[0]?.id
            const idDirect = (resp as any)?.messages?.[0]?.id
            wamid = idFromAxios || idDirect
            if (wamid) {
                await prisma.message.update({ where: { id: msg.id }, data: { externalId: wamid } })
            }
        } catch (err: any) {
            console.error('[persistBotReply] ERROR enviando a WhatsApp:', err?.response?.data || err?.message || err)
        }
    }

    return { messageId: msg.id, texto, wamid }
}

/* ===================== Helpers de producto ===================== */
function buildProductCaption(p: {
    nombre: string
    beneficios?: string | null
    caracteristicas?: string | null
    precioDesde?: any | null
    descripcion?: string | null
}) {
    const bullets = (txt?: string | null, max = 3) =>
        String(txt || '')
            .split('\n')
            .map(s => s.trim())
            .filter(Boolean)
            .slice(0, max)

    const emojiBenefit = ['✨', '🌿', '💧', '🛡️', '⚡', '👍', '🙌']
    const pickEmoji = (i: number) => emojiBenefit[i % emojiBenefit.length]

    const lines: string[] = []
    lines.push(`• *${p.nombre}*`)
    const bens = bullets(p.beneficios, 3)
    const cars = bullets(p.caracteristicas, 2)
    if (bens.length) lines.push(...bens.map((b, i) => `${pickEmoji(i)} ${b}`))
    else if (cars.length) lines.push(...cars.map((c, i) => `${pickEmoji(i)} ${c}`))

    if (p.precioDesde != null) {
        lines.push(`💵 Desde: ${formatMoney(p.precioDesde)}`)
    }
    return lines.slice(0, 5).join('\n')
}

function formatMoney(val: any) {
    try {
        const n = Number(val)
        if (Number.isNaN(n)) return String(val)
        return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n)
    } catch {
        return String(val)
    }
}
