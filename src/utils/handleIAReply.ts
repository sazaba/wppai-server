// server/src/utils/handleIAReply.ts
import axios from 'axios'
import prisma from '../lib/prisma'
import { openai } from '../lib/openai'
import { ConversationEstado, MediaType, MessageFrom } from '@prisma/client'
import { retrieveRelevantProducts } from './products.helper'
import { sendWhatsappMessage, sendWhatsappMedia } from '../services/whatsapp.service'

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
    'anthropic/claude-3.5-sonnet' // fallback razonable

const TEMPERATURE = Number(process.env.IA_TEMPERATURE ?? 0.7)
const MAX_COMPLETION_TOKENS = Number(process.env.IA_MAX_TOKENS ?? 650)

const OPENROUTER_BASE =
    process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1'
const OPENROUTER_URL = `${OPENROUTER_BASE}/chat/completions`
const OPENROUTER_API_KEY =
    process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY || ''

const VISION_MODEL = process.env.IA_VISION_MODEL || 'gpt-4o-mini'

const MAX_PRODUCTS_TO_SEND = Number(process.env.MAX_PRODUCTS_TO_SEND || 3)
const HTTP_TIMEOUT = Number(process.env.IA_HTTP_TIMEOUT_MS || 45000)

/* ============ Utils ============ */
const normId = (m: string) =>
    m?.trim() === 'google/gemini-2.0-flash-lite'
        ? 'google/gemini-2.0-flash-lite-001'
        : m?.trim()
const isOR = (m: string) => m.includes('/') // vendor/model => OpenRouter
const fallbackModel = () => 'google/gemini-2.0-flash-lite-001'
const normalizeForOpenAI = (model: string) =>
    model.replace(/^openai\//i, '').trim()

const nrm = (t: string) =>
    String(t || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()

const pick = <T,>(arr: T[]) =>
    arr[Math.max(0, Math.floor(Math.random() * arr.length))] as T

const CTAS = [
    '¿Te confirmo *stock*, *precio* o te cuento *beneficios*?',
    '¿Prefieres ver *imágenes* o saber *precios*?',
    'Puedo pasarte *promos*, *precio* o *disponibilidad*. ¿Qué te sirve?',
    '¿Seguimos con *precio* o prefieres *beneficios* primero?',
]

// Antispam de contenido
const NO_DECIR = ['soy una ia', 'modelo de lenguaje', 'inteligencia artificial'].map(nrm)
const esRespuestaInvalida = (r: string) => {
    const t = nrm(r || '')
    const email = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/.test(r)
    const link = /https?:\/\/|www\./i.test(r)
    const tel = /\+?\d[\d\s().-]{6,}/.test(r)
    return email || link || tel || NO_DECIR.some((p) => t.includes(p))
}

// Lectura robusta de BusinessConfig
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
        disclaimers: ['disclaimers'],

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

/* ====== Intents ====== */
const isProductIntent = (t: string) =>
    [
        'producto',
        'productos',
        'catalogo',
        'catálogo',
        'precio',
        'precios',
        'foto',
        'fotos',
        'imagen',
        'imagenes',
        'mostrar',
        'ver',
        'presentacion',
        'beneficio',
        'beneficios',
        'caracteristica',
        'caracteristicas',
        'promocion',
        'promoción',
        'oferta',
        'ofertas',
        'disponibilidad',
        'stock',
    ].some((k) => nrm(t).includes(nrm(k)))

const wantsCatalog = (t: string) =>
    [
        'catalogo',
        'catálogo',
        'que productos',
        'qué productos',
        'productos vendes',
        'lista de productos',
        'ver productos',
        'mostrar productos',
    ].some((k) => nrm(t).includes(nrm(k)))

const isPrice = (t: string) =>
    ['precio', 'cuesta', 'vale', 'costo', 'cuanto', 'cuánto', 'valor', 'exactamente'].some(
        (k) => nrm(t).includes(nrm(k))
    )

const wantsImages = (t: string) =>
    ['imagen', 'imagenes', 'imágenes', 'foto', 'fotos', 'ver foto', 'ver imagen', 'muestra foto'].some(
        (k) => nrm(t).includes(nrm(k))
    )

const isAffirmative = (t: string) =>
    ['si', 'sí', 'dale', 'ok', 'listo', 'va', 'claro', 'perfecto', 'de una', 'me interesa', 'quiero', 'comprar', 'lo quiero', 'lo compro'].some(
        (k) => nrm(t).includes(k)
    )

const wantsToBuy = (t: string) =>
    ['comprar', 'lo compro', 'lo quiero', 'quiero comprar', 'me lo llevo', 'cerrar compra', 'finalizar compra', 'hacer pedido', 'ordenar', 'pedido'].some(
        (k) => nrm(t).includes(nrm(k))
    )

const askPaymentLink = (t: string) =>
    ['link de pago', 'enlace de pago', 'pagar con tarjeta', 'pse', 'nequi', 'daviplata', 'stripe', 'mercado pago', 'pagos online', 'pago online'].some(
        (k) => nrm(t).includes(nrm(k))
    )

const askTransfer = (t: string) =>
    ['transferencia', 'bancaria', 'datos bancarios', 'cuenta', 'consignacion', 'consignación', 'ban', 'bancolombia', 'qr', 'nequi', 'daviplata'].some(
        (k) => nrm(t).includes(nrm(k))
    )

// Estas dos solo se usan dentro del flujo de checkout
const providesAddress = (t: string) =>
    ['direccion', 'dirección', 'dir', 'calle', 'cra', 'carrera', 'av', 'avenida', 'barrio', 'manzana', 'mz', 'casa', 'apto'].some(
        (k) => nrm(t).includes(nrm(k))
    )
const providesCity = (t: string) =>
    [
        'ciudad',
        'municipio',
        'poblacion',
        'población',
        'localidad',
        'bogota',
        'bogotá',
        'medellin',
        'cali',
        'barranquilla',
        'cartagena',
        'manizales',
        'pereira',
        'bucaramanga',
    ].some((k) => nrm(t).includes(nrm(k)))

/* ====== Memoria de CTA ====== */
type LastCTA = 'precio' | 'beneficios' | 'disponibilidad' | 'fotos' | null
const lastBotCTA = (hist: Array<{ from: MessageFrom; contenido: string }>): LastCTA => {
    for (let i = hist.length - 1; i >= 0; i--) {
        const m = hist[i]
        if (m.from !== 'bot') continue
        const t = nrm(m.contenido || '')
        if (/precio|precios|vale|cuesta|costo|valor/.test(t)) return 'precio'
        if (/beneficio|ventaja|caracteristica/.test(t)) return 'beneficios'
        if (/disponibilidad|stock/.test(t)) return 'disponibilidad'
        if (/foto|imagen|imagenes|fotos|ver foto/.test(t)) return 'fotos'
    }
    return null
}

const short = (s: string) => s.trim().split('\n').slice(0, 5).join('\n')

/* ====== System prompt ====== */
function systemPrompt(c: any, prods: any[], msgEsc: string, empresaNombre?: string, slots?: any) {
    const marca = (cfg(c, 'nombre') || empresaNombre || 'la marca') as string

    const cat =
        Array.isArray(prods) && prods.length
            ? `\n[CATÁLOGO]\n${prods
                .map(
                    (p) => `- ${p.nombre}
  Descripción: ${p.descripcion ?? ''}
  Beneficios: ${p.beneficios ?? ''}
  Características: ${p.caracteristicas ?? ''}
  ${p?.precioDesde != null ? `Precio desde: ${p.precioDesde}` : ''}`
                )
                .join('\n\n')}\n`
            : ''

    const envioCostoFijo = Number(cfg(c, 'envioCostoFijo') || 0) || 0
    const envioGratisDesde = Number(cfg(c, 'envioGratisDesde') || 0) || 0

    const info = `
[NEGOCIO]
- Nombre: ${marca}
- Descripción: ${cfg(c, 'descripcion')}
- Tipo: ${cfg(c, 'businessType')}
- Servicios:
${cfg(c, 'servicios') || '- (no especificado)'}
- Horarios: ${cfg(c, 'horarios')}

[OPERACIÓN]
- Envíos: ${cfg(c, 'enviosInfo')}
- Envío (costos):
  - Costo fijo: ${envioCostoFijo ? formatMoney(envioCostoFijo) : '—'}
  - Gratis desde: ${envioGratisDesde ? formatMoney(envioGratisDesde) : '—'}
- Métodos de pago: ${cfg(c, 'metodosPago')}
- Tienda física: ${cfg(c, 'tiendaFisica') ? 'Sí' : 'No'}${cfg(c, 'tiendaFisica') && cfg(c, 'direccionTienda') ? ` (Dirección: ${cfg(c, 'direccionTienda')})` : ''
        }
- Devoluciones: ${cfg(c, 'politicasDevolucion')}
- Garantía: ${cfg(c, 'politicasGarantia')}
- Promos: ${cfg(c, 'promocionesInfo')}
- Canales de atención: ${cfg(c, 'canalesAtencion')}

[POST-VENTA]
- Factura electrónica: ${cfg(c, 'facturaElectronicaInfo')}
- Soporte devoluciones: ${cfg(c, 'soporteDevolucionesInfo')}

[FAQs]
${cfg(c, 'faq')}

${cat}
  `.trim()

    const reglas = `
[REGLAS]
1) Guía como asesor humano y comercial. Evita repetir preguntas.
2) Usa lo ya dicho por el cliente (ciudad/dirección si existen).
3) Si preguntan fuera del negocio y no hay datos: "${msgEsc}" y ofrece escalar.
4) No inventes links ni montos: usa los provistos por el sistema.
  `.trim()

    return `Eres asesor de "${marca}". Objetivo: cerrar venta con empatía.

[SLOTS]
- producto_elegido: ${slots?.productName || '—'}
- cantidad: ${slots?.qty || '—'}
- ciudad: ${slots?.city || '—'}
- direccion: ${slots?.address || '—'}

${info}

${reglas}

[FORMATO]
- Máx 4 líneas, con bullets si suma. Cierra con micro-CTA contextual.
- Si el usuario pide catálogo, sugiere 3–6 items con "desde" y CTA.`
}

/* ==================== LLM ==================== */
async function chatComplete({
    model,
    messages,
    temperature,
    maxTokens,
}: {
    model: string
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: any }>
    temperature: number
    maxTokens: number
}): Promise<string> {
    const normalized = normId(model) || fallbackModel()
    const hasImage = messages.some(
        (m) => Array.isArray(m.content) && m.content.some((p: any) => p?.type === 'image_url')
    )

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
            timeout: HTTP_TIMEOUT,
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

/* ========================= Core ========================= */
export const handleIAReply = async (
    chatId: number,
    mensajeArg: string,
    opts?: { toPhone?: string; autoSend?: boolean; phoneNumberId?: string }
): Promise<IAReplyResult | null> => {
    // Conversación
    const conversacion = await prisma.conversation.findUnique({
        where: { id: chatId },
        select: { id: true, estado: true, empresaId: true, phone: true, nombre: true },
    })
    if (!conversacion || conversacion.estado === 'cerrado') {
        console.warn(`[handleIAReply] 🔒 La conversación ${chatId} está cerrada.`)
        return null
    }

    // Config & empresa
    const config = await prisma.businessConfig.findFirst({
        where: { empresaId: conversacion.empresaId },
        orderBy: { updatedAt: 'desc' },
    })
    const empresa = await prisma.empresa.findUnique({
        where: { id: conversacion.empresaId },
        select: { nombre: true },
    })
    const marca = (cfg(config, 'nombre') || empresa?.nombre || 'nuestra marca') as string
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

    // Último mensaje del cliente
    const ultimoCliente = await prisma.message.findFirst({
        where: { conversationId: chatId, from: 'client' },
        orderBy: { timestamp: 'desc' },
        select: {
            id: true,
            mediaType: true,
            mediaUrl: true,
            caption: true,
            isVoiceNote: true,
            transcription: true,
            contenido: true,
            timestamp: true,
        },
    })

    let mensaje = (mensajeArg || '').trim()
    if (!mensaje && ultimoCliente?.isVoiceNote && (ultimoCliente.transcription || '').trim()) {
        mensaje = String(ultimoCliente.transcription).trim()
    }
    const isImage = ultimoCliente?.mediaType === MediaType.image && !!ultimoCliente.mediaUrl
    const imageUrl = isImage ? String(ultimoCliente?.mediaUrl) : null

    /* ========== 1) Imagen: ¿comprobante de pago? ========== */
    if (isImage) {
        const maybePayment = /comprobante|pago|recibo|transferencia|soporte|consignacion|consignación|voucher|dep[oó]sito|qr/i.test(
            (ultimoCliente?.caption || '') + ' ' + (ultimoCliente?.contenido || '')
        )
        if (maybePayment) {
            const order = await ensureDraftOrder(conversacion, config)
            // marca orden como pendiente de validación de pago
            if (order.status !== 'pending_payment') {
                await prisma.order.update({ where: { id: order.id }, data: { status: 'pending_payment' } })
            }
            try {
                await prisma.paymentReceipt.create({
                    data: {
                        orderId: order.id,
                        messageId: ultimoCliente.id,
                        imageUrl: imageUrl!,
                        method: inferMethodFromConfig(config) || 'transfer|link',
                        isVerified: false,
                        rawOcrText: '', // OCR futuro
                    },
                })
            } catch (e) {
                console.warn('[handleIAReply] paymentReceipt create error:', (e as any)?.message || e)
            }
            const texto = [
                '¡Gracias! Recibimos tu *comprobante* 🙌',
                'Lo revisamos y te confirmamos por aquí.',
                cfg(config, 'envioEntregaEstimado') ? `Entrega estimada: ${cfg(config, 'envioEntregaEstimado')}.` : '',
            ]
                .filter(Boolean)
                .join('\n')
            const savedR = await persistBotReply({
                conversationId: chatId,
                empresaId: conversacion.empresaId,
                texto,
                nuevoEstado: ConversationEstado.venta_en_proceso, // empresa valida y podrá marcar como completada
                sendTo: opts?.autoSend ? (opts?.toPhone || conversacion.phone) : undefined,
                phoneNumberId: opts?.phoneNumberId,
            })
            return { estado: ConversationEstado.venta_en_proceso, mensaje: savedR.texto, messageId: savedR.messageId, wamid: savedR.wamid, media: [] }
        }
    }

    /* ====== 2) Historial para memoria ====== */
    const mensajesPrevios = await prisma.message.findMany({
        where: { conversationId: chatId },
        orderBy: { timestamp: 'asc' },
        take: 18,
        select: { from: true, contenido: true, timestamp: true },
    })
    const historial = mensajesPrevios
        .filter((m) => (m.contenido || '').trim().length > 0)
        .map((m) => ({ role: m.from === 'client' ? 'user' : 'assistant', content: m.contenido }) as const)

    /* ====== 3) Productos relevantes ====== */
    let productos: any[] = []
    try {
        productos = await retrieveRelevantProducts(conversacion.empresaId, mensaje || (ultimoCliente?.caption ?? ''), 5)
    } catch (e) {
        console.warn('[handleIAReply] retrieveRelevantProducts error:', (e as any)?.message || e)
        productos = []
    }
    if (!productos.length && mensaje) {
        const tokens = Array.from(new Set(nrm(mensaje).split(' ').filter((w) => w.length >= 3)))
        if (tokens.length) {
            productos = await prisma.product.findMany({
                where: { empresaId: conversacion.empresaId, OR: [{ nombre: { contains: tokens[0] } }, { descripcion: { contains: tokens[0] } }] },
                take: 5,
                orderBy: { id: 'asc' },
            })
        }
        if (!productos.length) {
            productos = await prisma.product.findMany({
                where: { empresaId: conversacion.empresaId, disponible: true },
                take: 3,
                orderBy: { id: 'asc' },
            })
        }
    }

    /* ====== 3.1 Catálogo cuando lo piden ====== */
    if (wantsCatalog(mensaje)) {
        const texto = await catalogReply(conversacion.empresaId)
        const saved = await persistBotReply({
            conversationId: chatId, empresaId: conversacion.empresaId, texto,
            nuevoEstado: ConversationEstado.respondido,
            sendTo: opts?.autoSend ? (opts?.toPhone || conversacion.phone) : undefined,
            phoneNumberId: opts?.phoneNumberId,
        })
        return { estado: ConversationEstado.respondido, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
    }

    /* ====== 4) Bienvenida humana temprana ====== */
    const isEarly = mensajesPrevios.filter((m) => m.from === 'bot' || m.from === 'client').length < 3
    if (isEarly && /hola|buenas|buenos dias|buenas tardes|buenas noches/i.test(mensaje)) {
        const desc = String(cfg(config, 'descripcion') || '').trim()
        const linea = desc ? `¡Hola! Soy del equipo de *${marca}*. ${desc}` : `¡Hola! Soy del equipo de *${marca}*. Te ayudo con catálogo, promos y envíos.`
        const texto = `${linea}\n${pick(CTAS)}`
        const saved = await persistBotReply({
            conversationId: chatId, empresaId: conversacion.empresaId, texto,
            nuevoEstado: ConversationEstado.respondido,
            sendTo: opts?.autoSend ? (opts?.toPhone || conversacion.phone) : undefined,
            phoneNumberId: opts?.phoneNumberId,
        })
        return { estado: ConversationEstado.respondido, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
    }

    /* ====== 5) Flujo de compra / link / transferencia / dirección ====== */
    const startedCheckout =
        wantsToBuy(mensaje) || askPaymentLink(mensaje) || askTransfer(mensaje) || providesAddress(mensaje) || providesCity(mensaje)

    if (startedCheckout) {
        const draft = await ensureDraftOrder(conversacion, config)

        // Parse y guarda city/address si aparece
        const parsed = parseAddressCity(mensaje)
        if (parsed.city && !draft.city) await prisma.order.update({ where: { id: draft.id }, data: { city: parsed.city } })
        if (parsed.address && !draft.address) await prisma.order.update({ where: { id: draft.id }, data: { address: parsed.address } })

        // Si hay producto relevante, agregar (default 1 ud) y recalcular totales
        if (productos.length) {
            await upsertFirstItem(draft.id, productos[0])
        }
        await recalcOrderTotals(draft.id, config)
        const freshOrder = await prisma.order.findUnique({ where: { id: draft.id } })

        // Link de pago con total
        if (askPaymentLink(mensaje)) {
            const txt = composePaymentLinkMessage(config, productos[0], freshOrder!)
            const saved = await persistBotReply({
                conversationId: chatId, empresaId: conversacion.empresaId, texto: txt,
                nuevoEstado: ConversationEstado.venta_en_proceso,
                sendTo: opts?.autoSend ? (opts?.toPhone || conversacion.phone) : undefined,
                phoneNumberId: opts?.phoneNumberId,
            })
            return { estado: ConversationEstado.venta_en_proceso, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
        }

        // Transferencia con total
        if (askTransfer(mensaje)) {
            const txt = composeBankTransferMessage(config, productos[0], freshOrder!)
            const saved = await persistBotReply({
                conversationId: chatId, empresaId: conversacion.empresaId, texto: txt,
                nuevoEstado: ConversationEstado.venta_en_proceso,
                sendTo: opts?.autoSend ? (opts?.toPhone || conversacion.phone) : undefined,
                phoneNumberId: opts?.phoneNumberId,
            })
            return { estado: ConversationEstado.venta_en_proceso, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
        }

        // Pedir solo lo que falta
        if (!freshOrder?.city || !freshOrder?.address) {
            const ask = !freshOrder?.city && freshOrder?.address
                ? '¿En qué *ciudad* recibes el pedido?'
                : !freshOrder?.address && freshOrder?.city
                    ? '¿Cuál es la *dirección* de entrega (calle, número, barrio)?'
                    : 'Para coordinar el envío, ¿me compartes *ciudad* y *dirección* de entrega?'
            const saved = await persistBotReply({
                conversationId: chatId, empresaId: conversacion.empresaId, texto: ask,
                nuevoEstado: ConversationEstado.venta_en_proceso,
                sendTo: opts?.autoSend ? (opts?.toPhone || conversacion.phone) : undefined,
                phoneNumberId: opts?.phoneNumberId,
            })
            return { estado: ConversationEstado.venta_en_proceso, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
        }

        // Si ya tenemos ciudad+dirección → ofrece opciones (incluye total)
        const checkoutTxt = composeCheckoutOptions(config, productos[0], freshOrder!)
        const saved = await persistBotReply({
            conversationId: chatId, empresaId: conversacion.empresaId, texto: checkoutTxt,
            nuevoEstado: ConversationEstado.venta_en_proceso,
            sendTo: opts?.autoSend ? (opts?.toPhone || conversacion.phone) : undefined,
            phoneNumberId: opts?.phoneNumberId,
        })
        return { estado: ConversationEstado.venta_en_proceso, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
    }

    /* ====== 6) Imagen de producto ajeno (no hay match) ====== */
    if (isImage && !productos.length) {
        const disponibles = await prisma.product.findMany({
            where: { empresaId: conversacion.empresaId, disponible: true },
            take: 5,
            orderBy: { id: 'asc' },
        })
        const lista = disponibles.length ? disponibles.map((p) => `• ${p.nombre}`).join('\n') : '• (aún no tenemos productos cargados)'
        const texto =
            `Gracias por la foto. *No trabajamos ese tipo de producto* en ${marca}.\n` +
            `Para ayudarte, tenemos:\n${lista}\n` +
            `¿Te interesa alguno? Te envío *imágenes* y *precio*.`
        const saved = await persistBotReply({
            conversationId: chatId, empresaId: conversacion.empresaId, texto,
            nuevoEstado: ConversationEstado.respondido,
            sendTo: opts?.autoSend ? (opts?.toPhone || conversacion.phone) : undefined,
            phoneNumberId: opts?.phoneNumberId,
        })
        return { estado: ConversationEstado.respondido, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
    }

    /* ====== 7) Precio directo ====== */
    if (isPrice(mensaje) && productos.length) {
        const p = productos[0]
        const precio = p?.precioDesde != null ? formatMoney(p.precioDesde) : null
        const texto = precio
            ? `*${p.nombre}*: desde ${precio}. ¿Te confirmo *stock* o prefieres ver *imágenes*?`
            : `No tengo el precio cargado de *${p.nombre}*. ¿Te comparto *beneficios* o reviso *disponibilidad*?`
        const saved = await persistBotReply({
            conversationId: chatId, empresaId: conversacion.empresaId, texto,
            nuevoEstado: ConversationEstado.respondido,
            sendTo: opts?.autoSend ? (opts?.toPhone || conversacion.phone) : undefined,
            phoneNumberId: opts?.phoneNumberId,
        })
        return { estado: ConversationEstado.respondido, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
    }

    /* ====== 8) Imágenes directas ====== */
    if (wantsImages(mensaje) && productos.length && opts?.autoSend) {
        const mediaRes = await sendProductImages({ chatId, conversacion, productosRelevantes: productos, phoneNumberId: opts?.phoneNumberId, toOverride: opts?.toPhone })
        const texto = mediaRes.length ? 'Te compartí imágenes del catálogo. ¿Quieres *precios* o confirmar *stock*?' : 'No encontré imágenes ahora. ¿Te paso *beneficios* o *precio*?'
        const saved = await persistBotReply({
            conversationId: chatId, empresaId: conversacion.empresaId, texto,
            nuevoEstado: ConversationEstado.respondido,
            sendTo: opts?.autoSend ? (opts?.toPhone || conversacion.phone) : undefined,
            phoneNumberId: opts?.phoneNumberId,
        })
        return { estado: ConversationEstado.respondido, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: mediaRes }
    }

    /* ====== 9) Seguimiento de CTA ====== */
    const lastCTA = lastBotCTA(mensajesPrevios)
    if ((isAffirmative(mensaje) || isProductIntent(mensaje) || isPrice(mensaje)) && productos.length) {
        const want: LastCTA =
            (isPrice(mensaje) && 'precio') ||
            (/beneficio|ventaja/.test(nrm(mensaje)) && 'beneficios') ||
            (/disponibilidad|stock/.test(nrm(mensaje)) && 'disponibilidad') ||
            (/foto|imagen|fotos/.test(nrm(mensaje)) && 'fotos') ||
            lastCTA

        const p = productos[0]
        if (want === 'precio') {
            const precio = p?.precioDesde != null ? formatMoney(p.precioDesde) : null
            const texto = precio
                ? `*${p.nombre}*: desde ${precio}. ¿Te confirmo *stock* o prefieres *imágenes*?`
                : `De *${p.nombre}* no tengo precio en sistema. ¿Te paso *beneficios* o reviso *disponibilidad*?`
            const saved = await persistBotReply({ conversationId: chatId, empresaId: conversacion.empresaId, texto, nuevoEstado: ConversationEstado.respondido, sendTo: opts?.autoSend ? (opts?.toPhone || conversacion.phone) : undefined, phoneNumberId: opts?.phoneNumberId })
            return { estado: ConversationEstado.respondido, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
        }
        if (want === 'beneficios') {
            const texto = buildBenefitsReply(p)
            const saved = await persistBotReply({ conversationId: chatId, empresaId: conversacion.empresaId, texto, nuevoEstado: ConversationEstado.respondido, sendTo: opts?.autoSend ? (opts?.toPhone || conversacion.phone) : undefined, phoneNumberId: opts?.phoneNumberId })
            return { estado: ConversationEstado.respondido, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
        }
        if (want === 'disponibilidad') {
            const texto = 'Con gusto verifico *stock*. ¿Para cuántas unidades y en qué ciudad recibes?'
            const saved = await persistBotReply({ conversationId: chatId, empresaId: conversacion.empresaId, texto, nuevoEstado: ConversationEstado.en_proceso, sendTo: opts?.autoSend ? (opts?.toPhone || conversacion.phone) : undefined, phoneNumberId: opts?.phoneNumberId })
            return { estado: ConversationEstado.en_proceso, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
        }
        if (want === 'fotos' && opts?.autoSend) {
            const mediaRes = await sendProductImages({ chatId, conversacion, productosRelevantes: productos, phoneNumberId: opts?.phoneNumberId, toOverride: opts?.toPhone })
            const texto = mediaRes.length ? 'Listo, envié imágenes. ¿Seguimos con *precio* o *disponibilidad*?' : 'No tengo fotos ahora mismo. ¿Te comparto *beneficios* o *precio*?'
            const saved = await persistBotReply({ conversationId: chatId, empresaId: conversacion.empresaId, texto, nuevoEstado: ConversationEstado.respondido, sendTo: opts?.autoSend ? (opts?.toPhone || conversacion.phone) : undefined, phoneNumberId: opts?.phoneNumberId })
            return { estado: ConversationEstado.respondido, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: mediaRes }
        }
    }

    /* ===== 10) IA libre (visión o texto) ===== */
    const slots = {
        productName: productos?.[0]?.nombre ?? null,
        qty: null,
        city: null,
        address: null,
    }
    const baseMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: any }> = [
        { role: 'system', content: systemPrompt(config, productos, mensajeEscalamiento, empresa?.nombre, slots) },
        ...historial,
    ]
    if (imageUrl) {
        baseMessages.push({
            role: 'user',
            content: [
                { type: 'text', text: mensaje || ultimoCliente?.caption || 'Analiza la imagen en el contexto del negocio y ayuda al cliente.' },
                { type: 'image_url', image_url: { url: imageUrl } },
            ],
        } as any)
    } else {
        baseMessages.push({ role: 'user', content: (mensaje || '').trim() })
    }

    let respuesta = ''
    try {
        respuesta = (await chatComplete({ model: imageUrl ? VISION_MODEL : RAW_MODEL, messages: baseMessages, temperature: TEMPERATURE, maxTokens: MAX_COMPLETION_TOKENS }))?.trim()
    } catch (e) {
        try {
            respuesta = (await chatComplete({ model: fallbackModel(), messages: baseMessages, temperature: TEMPERATURE, maxTokens: MAX_COMPLETION_TOKENS }))?.trim()
        } catch (e2) {
            const saved = await persistBotReply({
                conversationId: chatId, empresaId: conversacion.empresaId, texto: pick(CTAS),
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
            conversationId: chatId, empresaId: conversacion.empresaId,
            texto: 'No sabría decirte con certeza; debo consultarlo. Si deseas, lo escalo con un asesor humano.',
            nuevoEstado: ConversationEstado.requiere_agente,
            sendTo: opts?.autoSend ? (opts?.toPhone || conversacion.phone) : undefined,
            phoneNumberId: opts?.phoneNumberId,
        })
        return { estado: ConversationEstado.requiere_agente, mensaje: saved.texto, motivo: 'confianza_baja', messageId: saved.messageId, wamid: saved.wamid }
    }

    const saved = await persistBotReply({
        conversationId: chatId, empresaId: conversacion.empresaId, texto: respuesta,
        nuevoEstado: ConversationEstado.respondido,
        sendTo: opts?.autoSend ? (opts?.toPhone || conversacion.phone) : undefined,
        phoneNumberId: opts?.phoneNumberId,
    })

    // Envío proactivo de imágenes si aplica
    let mediaSent: Array<{ productId: number; imageUrl: string; wamid?: string }> = []
    if (isProductIntent(mensaje || ultimoCliente?.caption || '') && opts?.autoSend && (opts?.toPhone || conversacion.phone) && productos.length) {
        mediaSent = await sendProductImages({ chatId, conversacion, productosRelevantes: productos, phoneNumberId: opts?.phoneNumberId, toOverride: opts?.toPhone })
    }

    return { estado: ConversationEstado.respondido, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: mediaSent }
}

/* ===================== Helpers ===================== */
async function catalogReply(empresaId: number) {
    const items = await prisma.product.findMany({ where: { empresaId, disponible: true }, take: 6, orderBy: { id: 'asc' } })
    if (!items.length) return 'Hoy tenemos un catálogo reducido. ¿Qué estás buscando exactamente?'
    const bullets = items.map((p) => `• *${p.nombre}*${p.precioDesde != null ? ` – desde ${formatMoney(p.precioDesde)}` : ''}`).join('\n')
    return `${bullets}\n¿Te paso *imágenes* o prefieres *precios* de alguno?`
}

function normalizeToE164(n: string) {
    return String(n || '').replace(/[^\d]/g, '')
}

async function persistBotReply({
    conversationId, empresaId, texto, nuevoEstado, sendTo, phoneNumberId,
}: {
    conversationId: number; empresaId: number; texto: string; nuevoEstado: ConversationEstado; sendTo?: string; phoneNumberId?: string;
}) {
    const msg = await prisma.message.create({
        data: {
            conversationId, from: MessageFrom.bot, contenido: texto, empresaId,
            mediaType: null, mediaUrl: null, mimeType: null, caption: null, isVoiceNote: false, transcription: null,
        } as any,
    })
    await prisma.conversation.update({ where: { id: conversationId }, data: { estado: nuevoEstado } })

    let wamid: string | undefined
    if (sendTo && String(sendTo).trim()) {
        try {
            const resp = await sendWhatsappMessage({ empresaId, to: normalizeToE164(sendTo!), body: texto, phoneNumberIdHint: phoneNumberId })
            wamid = (resp as any)?.data?.messages?.[0]?.id || (resp as any)?.messages?.[0]?.id
            if (wamid) await prisma.message.update({ where: { id: msg.id }, data: { externalId: wamid } })
        } catch (err: any) {
            console.error('[persistBotReply] ERROR WhatsApp:', err?.response?.data || err?.message || err)
        }
    }
    return { messageId: msg.id, texto, wamid }
}

function buildBenefitsReply(p: { nombre: string; beneficios?: string | null; caracteristicas?: string | null; precioDesde?: any | null; }) {
    const bens = String(p?.beneficios || '').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 3)
    const lines: string[] = []
    lines.push(`*${p.nombre}* – Beneficios principales:`)
    if (bens.length) lines.push(...bens.map((b) => `• ${b}`))
    else lines.push('• Fórmula efectiva y bien valorada.')
    if (p.precioDesde != null) lines.push(`Precio desde: ${formatMoney(p.precioDesde)}.`)
    lines.push('¿Te confirmo *stock* o prefieres ver *imágenes*?')
    return short(lines.join('\n'))
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
        take: MAX_PRODUCTS_TO_SEND,
    })

    const media: Array<{ productId: number; imageUrl: string; wamid?: string }> = []
    for (const img of imgs) {
        const prod = productosRelevantes.find((p: any) => p.id === img.productId); if (!prod) continue
        const caption = buildProductCaption(prod)
        try {
            const resp = await sendWhatsappMedia({ empresaId: conversacion.empresaId, to: phone, url: img.url, type: 'image', caption, phoneNumberIdHint: phoneNumberId } as any)
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
    const bullets = (txt?: string | null, max = 3) => String(txt || '').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, max)
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

/* ===================== Pedidos / pagos ===================== */
function inferMethodFromConfig(c: any): string | null {
    if (String(cfg(c, 'transferenciaQRUrl') || '').trim() || String(cfg(c, 'bancoNombre') || '').trim()) return 'transfer'
    if (String(cfg(c, 'pagoLinkGenerico') || '').trim() || String(cfg(c, 'pagoLinkProductoBase') || '').trim()) return 'link'
    return null
}

async function ensureDraftOrder(conversacion: { id: number; empresaId: number; phone: string; nombre?: string | null }, c: any) {
    let order = await prisma.order.findFirst({
        where: { empresaId: conversacion.empresaId, conversationId: conversacion.id, status: { in: ['pending', 'pending_payment', 'created'] } },
        orderBy: { id: 'desc' },
    })
    if (order) return order
    order = await prisma.order.create({
        data: {
            empresaId: conversacion.empresaId,
            conversationId: conversacion.id,
            customerPhone: conversacion.phone,
            customerName: conversacion.nombre || null,
            city: null,
            address: null,
            status: 'pending',
            subtotal: 0,
            shippingCost: Number(cfg(c, 'envioCostoFijo') || 0) || 0,
            total: 0,
            notes: '',
        },
    })
    return order
}

async function upsertFirstItem(orderId: number, prod: any) {
    const exists = await prisma.orderItem.findFirst({ where: { orderId, productId: prod.id } })
    if (exists) return exists
    const price = Number(prod?.precioDesde ?? 0) || 0
    return prisma.orderItem.create({ data: { orderId, productId: prod.id, name: prod.nombre, price, qty: 1, total: price } })
}

async function recalcOrderTotals(orderId: number, c: any) {
    const items = await prisma.orderItem.findMany({ where: { orderId } })
    const subtotal = items.reduce((acc, it) => acc + Number(it.total || 0), 0)
    let shipping = Number(cfg(c, 'envioCostoFijo') || 0) || 0
    const gratisDesde = Number(cfg(c, 'envioGratisDesde') || 0) || 0
    if (gratisDesde && subtotal >= gratisDesde) shipping = 0
    const total = subtotal + shipping
    await prisma.order.update({ where: { id: orderId }, data: { subtotal, shippingCost: shipping, total } })
}

function composePaymentLinkMessage(c: any, prod?: any, order?: any) {
    const linkGen = String(cfg(c, 'pagoLinkGenerico') || '').trim()
    const linkBase = String(cfg(c, 'pagoLinkProductoBase') || '').trim()
    const notas = String(cfg(c, 'pagoNotas') || '').trim()
    const parts: string[] = []
    if (linkBase && prod?.slug) parts.push(`💳 Pago online: ${linkBase}?sku=${encodeURIComponent(prod.slug)}&qty=1`)
    else if (linkGen) parts.push(`💳 Pago online: ${linkGen}`)
    else parts.push('💳 Habilitamos pagos online. Si prefieres, también puedes pagar por transferencia.')
    if (order) parts.push(`Total a pagar: *${formatMoney(order.total)}* (incluye envío).`)
    if (notas) parts.push(`ℹ️ Nota: ${notas}`)
    parts.push('Cuando completes el pago, envíame el *comprobante* por aquí (foto).')
    return short(parts.join('\n'))
}

function composeBankTransferMessage(c: any, prod?: any, order?: any) {
    const bank = {
        banco: String(cfg(c, 'bancoNombre') || '').trim(),
        titular: String(cfg(c, 'bancoTitular') || '').trim(),
        tipo: String(cfg(c, 'bancoTipoCuenta') || '').trim(),
        numero: String(cfg(c, 'bancoNumeroCuenta') || '').trim(),
        doc: String(cfg(c, 'bancoDocumento') || '').trim(),
        qr: String(cfg(c, 'transferenciaQRUrl') || '').trim(),
        notas: String(cfg(c, 'pagoNotas') || '').trim(),
    }
    const parts: string[] = []
    parts.push('🏦 *Transferencia bancaria*')
    if (bank.banco) parts.push(`• Banco: ${bank.banco}`)
    if (bank.titular) parts.push(`• Titular: ${bank.titular}`)
    if (bank.tipo) parts.push(`• Tipo de cuenta: ${bank.tipo}`)
    if (bank.numero) parts.push(`• Nº de cuenta: ${bank.numero}`)
    if (bank.doc) parts.push(`• Documento: ${bank.doc}`)
    if (bank.qr) parts.push(`• QR: ${bank.qr}`)
    if (order) parts.push(`• Importe: *${formatMoney(order.total)}* (incluye envío).`)
    if (bank.notas) parts.push(`ℹ️ ${bank.notas}`)
    parts.push('Al hacer la transferencia, envíame el *comprobante* (foto) por aquí.')
    return short(parts.join('\n'))
}

function composeCheckoutOptions(c: any, prod?: any, order?: any) {
    const hasLink = Boolean(String(cfg(c, 'pagoLinkGenerico') || cfg(c, 'pagoLinkProductoBase') || '').trim())
    const hasBank = Boolean(String(cfg(c, 'bancoNombre') || cfg(c, 'transferenciaQRUrl') || '').trim())
    const envioEta = String(cfg(c, 'envioEntregaEstimado') || '').trim()
    const parts: string[] = []
    parts.push('¡Perfecto! Para completar tu pedido puedes:')
    if (hasLink) parts.push('• 💳 Pagar con *link* (tarjeta/PSE).')
    if (hasBank) parts.push('• 🏦 Pagar por *transferencia bancaria*.')
    if (!hasLink && !hasBank) parts.push('• Confirmar por aquí y coordinamos el pago.')
    if (order) parts.push(`Total a pagar: *${formatMoney(order.total)}*.`)
    if (envioEta) parts.push(`⏰ Entrega estimada: ${envioEta}.`)
    parts.push('¿Qué método prefieres?')
    return short(parts.join('\n'))
}

/* ====== Business Q&A simple ====== */
function maybeBusinessAnswer(c: any, t: string) {
    const anyIn = (txt: string, arr: string[]) => arr.some((k) => nrm(txt).includes(nrm(k)))
    const Q = {
        ENVIO: ['envio', 'envios', 'envíos', 'domicilio', 'a domicilio', 'hacen envios', 'hacen envíos'],
        PAGO: ['pago', 'pagos', 'metodos de pago', 'tarjeta', 'transferencia', 'contraentrega', 'contra entrega'],
        HORARIO: ['horario', 'atienden', 'abren', 'cierran'],
        TIENDA: ['tienda fisica', 'tienda física', 'direccion', 'dirección', 'donde quedan', 'ubicacion', 'ubicación'],
        DEV: ['devolucion', 'devolución', 'cambio', 'cambios', 'reembolso'],
        GAR: ['garantia', 'garantía'],
        PROMO: ['promocion', 'promoción', 'promos', 'descuento', 'descuentos', 'oferta', 'ofertas'],
        CANAL: ['canal', 'contacto', 'atencion', 'soporte', 'hablar', 'comunicar'],
    }
    const parts: string[] = []
    const em = { box: '📦', money: '💳', clock: '⏰', pin: '📍', refresh: '🔄', shield: '🛡️', tag: '🏷️', chat: '💬' }
    const envioTxt = String(cfg(c, 'enviosInfo') || '').trim()
    const costoFijo = Number(cfg(c, 'envioCostoFijo') || 0) || 0
    const gratisDesde = Number(cfg(c, 'envioGratisDesde') || 0) || 0
    const extraCostos = (costoFijo || gratisDesde) ? ` ${costoFijo ? `(Costo fijo: ${formatMoney(costoFijo)})` : ''}${gratisDesde ? ` (Gratis desde ${formatMoney(gratisDesde)})` : ''}` : ''
    if (anyIn(t, Q.ENVIO) && (envioTxt || extraCostos)) parts.push(`${em.box} *Envíos:* ${envioTxt || 'Coordinamos envíos a nivel nacional.'}${extraCostos}`)
    if (anyIn(t, Q.PAGO) && String(cfg(c, 'metodosPago')).trim()) parts.push(`${em.money} *Pagos:* ${cfg(c, 'metodosPago')}`)
    if (anyIn(t, Q.HORARIO) && String(cfg(c, 'horarios')).trim()) parts.push(`${em.clock} *Horario:* ${cfg(c, 'horarios')}`)
    if (anyIn(t, Q.TIENDA)) {
        const tf = Boolean(cfg(c, 'tiendaFisica'))
        const dir = tf ? (cfg(c, 'direccionTienda') || 'Tienda física disponible') : 'Por ahora solo atendemos online'
        parts.push(`${em.pin} *Tienda:* ${tf ? 'Sí' : 'No'}. ${dir}`)
    }
    if (anyIn(t, Q.DEV) && String(cfg(c, 'politicasDevolucion')).trim()) parts.push(`${em.refresh} *Devoluciones:* ${cfg(c, 'politicasDevolucion')}`)
    if (anyIn(t, Q.GAR) && String(cfg(c, 'politicasGarantia')).trim()) parts.push(`${em.shield} *Garantía:* ${cfg(c, 'politicasGarantia')}`)
    if (anyIn(t, Q.PROMO) && String(cfg(c, 'promocionesInfo')).trim()) parts.push(`${em.tag} *Promos:* ${cfg(c, 'promocionesInfo')}`)
    if (anyIn(t, Q.CANAL) && String(cfg(c, 'canalesAtencion')).trim()) parts.push(`${em.chat} *Atención:* ${cfg(c, 'canalesAtencion')}`)
    if (!parts.length) return null
    return short(parts.join('\n'))
}

/* ====== Parsing dirección/ciudad ====== */
function parseAddressCity(text: string): { city?: string; address?: string } {
    const t = nrm(text)
    const cities = ['bogota', 'bogotá', 'medellin', 'cali', 'barranquilla', 'cartagena', 'manizales', 'pereira', 'bucaramanga', 'villavicencio', 'ibague', 'armenia', 'cucuta']
    const city = cities.find((c) => t.includes(nrm(c)))
    const addrRegex = /(cra|carrera|cll|calle|av|avenida|transv|transversal|mz|manzana|dg|diagonal)\s*[\w#\-\s]+?\d{1,5}[^\n]*/i
    const m = (text || '').match(addrRegex)
    const address = m ? m[0].trim() : undefined
    return { city, address }
}
