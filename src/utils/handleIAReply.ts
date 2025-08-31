// server/src/utils/handleIAReply.ts
import axios from 'axios'
import prisma from '../lib/prisma'
import { shouldEscalateChat } from './shouldEscalate'
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
    'anthropic/claude-3.5-sonnet'

// 🔓 Más libre por defecto (puedes seguir controlándolo con IA_TEMPERATURE en .env)
const TEMPERATURE = Number(process.env.IA_TEMPERATURE ?? 0.55)
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

// CTAs más variadas y suaves
const CTAS = [
    '¿Te confirmo *stock*, *precio* o te cuento *beneficios*?',
    '¿Prefieres ver *imágenes* o saber *precios*?',
    'Puedo pasarte *promos*, *precio* o *disponibilidad*. ¿Qué te sirve?',
    '¿Seguimos con *precio* o prefieres *beneficios* primero?',
]

// Frases que nunca debe decir
const NO_DECIR = ['soy una ia', 'modelo de lenguaje', 'inteligencia artificial'].map(nrm)
const esRespuestaInvalida = (r: string) => {
    const t = nrm(r || '')
    const email = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/.test(r)
    const link = /https?:\/\/|www\./i.test(r)
    const tel = /\+?\d[\d\s().-]{6,}/.test(r)
    return email || link || tel || NO_DECIR.some(p => t.includes(p))
}

// ====== Lectura ROBUSTA de BusinessConfig (acepta alias)
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

        // nuevos de ecommerce
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
const isProductIntent = (t: string) =>
    ['producto', 'productos', 'catalogo', 'catálogo', 'precio', 'precios', 'foto', 'fotos', 'imagen', 'imagenes', 'mostrar', 'ver', 'presentacion', 'beneficio', 'beneficios', 'caracteristica', 'caracteristicas', 'promocion', 'promoción', 'oferta', 'ofertas', 'disponibilidad', 'stock'].some(k => nrm(t).includes(nrm(k)))

const isPrice = (t: string) =>
    ['precio', 'cuesta', 'vale', 'costo', 'cuanto', 'cuánto', 'valor', 'exactamente'].some(k => nrm(t).includes(nrm(k)))

const wantsImages = (t: string) =>
    ['imagen', 'imagenes', 'imágenes', 'foto', 'fotos', 'ver foto', 'ver imagen', 'muestra foto'].some(k => nrm(t).includes(nrm(k)))

const isAffirmative = (t: string) =>
    ['si', 'sí', 'dale', 'ok', 'listo', 'va', 'claro', 'perfecto', 'de una', 'me interesa', 'quiero', 'comprar', 'lo quiero', 'lo compro'].some(k => nrm(t).includes(k))

// Intents de cierre/compra/pago/dirección
const wantsToBuy = (t: string) =>
    ['comprar', 'lo compro', 'lo quiero', 'quiero comprar', 'me lo llevo', 'cerrar compra', 'finalizar compra', 'hacer pedido', 'ordenar', 'pedido'].some(k => nrm(t).includes(nrm(k)))

const askPaymentLink = (t: string) =>
    ['link de pago', 'enlace de pago', 'pagar con tarjeta', 'pse', 'nequi', 'daviplata', 'stripe', 'mercado pago', 'pagos online', 'pago online'].some(k => nrm(t).includes(nrm(k)))

const askTransfer = (t: string) =>
    ['transferencia', 'bancaria', 'datos bancarios', 'cuenta', 'consignacion', 'consignación', 'ban', 'bancolombia', 'qr', 'nequi', 'daviplata'].some(k => nrm(t).includes(nrm(k)))

const providesAddress = (t: string) =>
    ['direccion', 'dirección', 'dir', 'calle', 'cra', 'carrera', 'av', 'avenida', 'barrio', 'manzana', 'mz', 'casa', 'apto'].some(k => nrm(t).includes(nrm(k)))

const providesCity = (t: string) =>
    ['ciudad', 'municipio', 'poblacion', 'población', 'localidad', 'bogota', 'bogotá', 'medellin', 'cali', 'barranquilla', 'cartagena'].some(k => nrm(t).includes(nrm(k)))

/* ====== Intents de negocio (desde BusinessConfig) ====== */
const anyIn = (t: string, arr: string[]) => arr.some(k => nrm(t).includes(nrm(k)))
const Q = {
    ENVIO: ['envio', 'envios', 'envíos', 'domicilio', 'a domicilio', 'hacen envios', 'hacen envíos'],
    PAGO: ['pago', 'pagos', 'metodos de pago', 'tarjeta', 'transferencia', 'contraentrega', 'contra entrega'],
    HORARIO: ['horario', 'atienden', 'abren', 'cierran'],
    TIENDA: ['tienda fisica', 'tienda física', 'direccion', 'dirección', 'donde quedan', 'ubicacion', 'ubicación'],
    DEV: ['devolucion', 'devolución', 'cambio', 'cambios', 'reembolso'],
    GAR: ['garantia', 'garantía'],
    PROMO: ['promocion', 'promoción', 'promos', 'descuento', 'descuentos', 'oferta', 'ofertas'],
    CANAL: ['canal', 'contacto', 'atencion', 'soporte', 'hablar', 'comunicar'],

    // NUEVOS:
    FACT: ['factura', 'factura electronica', 'facturación', 'facturacion', 'rut', 'nit'],
    POSV: ['postventa', 'post-venta', 'post venta', 'soporte devoluciones', 'devoluciones soporte', 'garantia soporte'],
}
const bizFlags = (t: string) => ({
    envios: anyIn(t, Q.ENVIO),
    pagos: anyIn(t, Q.PAGO),
    horario: anyIn(t, Q.HORARIO),
    tienda: anyIn(t, Q.TIENDA),
    devol: anyIn(t, Q.DEV),
    garantia: anyIn(t, Q.GAR),
    promos: anyIn(t, Q.PROMO),
    canales: anyIn(t, Q.CANAL),

    // NUEVOS:
    fact: anyIn(t, Q.FACT),
    postv: anyIn(t, Q.POSV),

    any: false as boolean,
})
const markAny = (f: ReturnType<typeof bizFlags>) => ({ ...f, any: Object.values(f).some(Boolean) })

const short = (s: string) => s.trim().split('\n').slice(0, 4).join('\n')

/* ====== Memoria de CTA (sin tocar schema) ====== */
type LastCTA = 'precio' | 'beneficios' | 'disponibilidad' | 'fotos' | null
const lastBotCTA = (hist: Array<{ from: MessageFrom; contenido: string }>): LastCTA => {
    for (let i = hist.length - 1; i >= 0; i--) {
        const m = hist[i]; if (m.from !== 'bot') continue
        const t = nrm(m.contenido || '')
        if (/precio|precios|vale|cuesta|costo|valor/.test(t)) return 'precio'
        if (/beneficio|ventaja|caracteristica/.test(t)) return 'beneficios'
        if (/disponibilidad|stock/.test(t)) return 'disponibilidad'
        if (/foto|imagen|imagenes|fotos|ver foto/.test(t)) return 'fotos'
    }
    return null
}

/* ====== Respuestas determinísticas de negocio ====== */
const businessAnswer = (c: any, f: ReturnType<typeof bizFlags>) => {
    const parts: string[] = []
    const em = { box: '📦', money: '💳', clock: '⏰', pin: '📍', refresh: '🔄', shield: '🛡️', tag: '🏷️', chat: '💬', doc: '🧾', lifebuoy: '🛟' }

    // ENVÍOS: texto libre + (si hay) costo fijo / umbral gratis
    if (f.envios) {
        const envioTxt = String(cfg(c, 'enviosInfo') || '').trim()
        const costoFijo = Number(cfg(c, 'envioCostoFijo') || 0) || 0
        const gratisDesde = Number(cfg(c, 'envioGratisDesde') || 0) || 0
        const extraCostos = (costoFijo || gratisDesde)
            ? ` ${costoFijo ? `(Costo fijo: ${formatMoney(costoFijo)})` : ''}${gratisDesde ? ` (Gratis desde ${formatMoney(gratisDesde)})` : ''}`
            : ''
        if (envioTxt || extraCostos) parts.push(`${em.box} *Envíos:* ${envioTxt || 'Coordinamos envíos a nivel nacional.'}${extraCostos}`)
    }

    if (f.pagos && String(cfg(c, 'metodosPago')).trim())
        parts.push(`${em.money} *Pagos:* ${cfg(c, 'metodosPago')}`)

    if (f.horario && String(cfg(c, 'horarios')).trim())
        parts.push(`${em.clock} *Horario:* ${cfg(c, 'horarios')}`)

    if (f.tienda) {
        const tf = Boolean(cfg(c, 'tiendaFisica'))
        const dir = tf ? (cfg(c, 'direccionTienda') || 'Tienda física disponible') : 'Por ahora solo atendemos online'
        parts.push(`${em.pin} *Tienda:* ${tf ? 'Sí' : 'No'}. ${dir}`)
    }

    if (f.devol && String(cfg(c, 'politicasDevolucion')).trim())
        parts.push(`${em.refresh} *Devoluciones:* ${cfg(c, 'politicasDevolucion')}`)

    if (f.garantia && String(cfg(c, 'politicasGarantia')).trim())
        parts.push(`${em.shield} *Garantía:* ${cfg(c, 'politicasGarantia')}`)

    if (f.promos && String(cfg(c, 'promocionesInfo')).trim())
        parts.push(`${em.tag} *Promos:* ${cfg(c, 'promocionesInfo')}`)

    if (f.canales && String(cfg(c, 'canalesAtencion')).trim())
        parts.push(`${em.chat} *Atención:* ${cfg(c, 'canalesAtencion')}`)

    // NUEVOS bloques:
    if (f.fact && String(cfg(c, 'facturaElectronicaInfo')).trim())
        parts.push(`${em.doc} *Factura electrónica:* ${cfg(c, 'facturaElectronicaInfo')}`)

    if (f.postv && String(cfg(c, 'soporteDevolucionesInfo')).trim())
        parts.push(`${em.lifebuoy} *Post-venta:* ${cfg(c, 'soporteDevolucionesInfo')}`)

    if (!parts.length) return null
    return short(parts.join('\n'))
}

/* ====== System prompt (más libre y humano) ====== */
function systemPrompt(c: any, prods: any[], msgEsc: string, empresaNombre?: string) {
    const marca = (cfg(c, 'nombre') || empresaNombre || 'la marca')

    const cat =
        Array.isArray(prods) && prods.length
            ? `\n[CATÁLOGO]\n${prods.map((p) => `- ${p.nombre}
  Descripción: ${p.descripcion ?? ''}
  Beneficios: ${p.beneficios ?? ''}
  Características: ${p.caracteristicas ?? ''}
  ${p?.precioDesde != null ? `Precio desde: ${p.precioDesde}` : ''}`).join('\n\n')}\n`
            : ''

    const envioCostoFijo = Number(cfg(c, 'envioCostoFijo') || 0) || 0
    const envioGratisDesde = Number(cfg(c, 'envioGratisDesde') || 0) || 0

    const info = `
[NEGOCIO]
- Nombre: ${marca}
- Descripción: ${cfg(c, 'descripcion')}
- Tipo: ${cfg(c, 'businessType')}
- Servicios/Portafolio:
${cfg(c, 'servicios') || '- (no especificado)'}
- Horarios: ${cfg(c, 'horarios')}

[OPERACIÓN]
- Envíos: ${cfg(c, 'enviosInfo')}
- Envío (costos):
  - Costo fijo: ${envioCostoFijo ? formatMoney(envioCostoFijo) : '—'}
  - Gratis desde: ${envioGratisDesde ? formatMoney(envioGratisDesde) : '—'}
- Métodos de pago (texto libre): ${cfg(c, 'metodosPago')}
- Tienda física: ${cfg(c, 'tiendaFisica') ? 'Sí' : 'No'}${cfg(c, 'tiendaFisica') && cfg(c, 'direccionTienda') ? ` (Dirección: ${cfg(c, 'direccionTienda')})` : ''}
- Devoluciones: ${cfg(c, 'politicasDevolucion')}
- Garantía: ${cfg(c, 'politicasGarantia')}
- Promociones: ${cfg(c, 'promocionesInfo')}
- Canales de atención: ${cfg(c, 'canalesAtencion')}
- Extras: ${cfg(c, 'extras')}

[POST-VENTA]
- Factura electrónica: ${cfg(c, 'facturaElectronicaInfo')}
- Soporte devoluciones: ${cfg(c, 'soporteDevolucionesInfo')}

[FAQs]
${cfg(c, 'faq')}

${cat}
  `.trim()

    const reglas = `
[REGLAS]
1) Habla como asesor humano: cercano, natural y útil. Puedes saludar breve y usar frases amistosas.
2) Prioriza datos de [NEGOCIO]/[OPERACIÓN]/[POST-VENTA]/[CATÁLOGO]/[FAQs]. Si falta un dato, dilo sin inventar.
3) Máx 2–4 líneas por respuesta; usa viñetas si suma.
4) No menciones que eres IA.
5) Si preguntan algo fuera del negocio, reconduce con elegancia. Si de verdad no hay info, di: "No sabría decirte con certeza; debo consultarlo." y ofrece escalar. Solo usa:
   "${msgEsc}"
   como último recurso.
6) No inventes links ni datos de pago. Si debes hablar de pagos, explica opciones en general y ofrece compartir el link o datos *si el cliente lo pide*.
${cfg(c, 'disclaimers') ? `7) Disclaimers:\n${cfg(c, 'disclaimers')}` : ''}
${cfg(c, 'palabrasClaveNegocio') ? `8) Palabras clave: ${cfg(c, 'palabrasClaveNegocio')}` : ''}
  `.trim()

    return `Eres un asesor de "${marca}" con estilo cálido, sencillo y comercial.
Presenta la marca en 1 frase cuando tenga sentido y guía con micro-CTAs hacia precio, beneficios o disponibilidad.

${info}

${reglas}

[FORMATO]
- Respuestas concisas (2–4 líneas), específicas y accionables.
- Cierra con una micro-CTA contextual.`
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
    const hasImage = messages.some(m => Array.isArray(m.content) && m.content.some((p: any) => p?.type === 'image_url'))

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

    // 1) Config del negocio (última)
    const config = await prisma.businessConfig.findFirst({
        where: { empresaId: conversacion.empresaId },
        orderBy: { updatedAt: 'desc' },
    })
    const empresa = await prisma.empresa.findUnique({
        where: { id: conversacion.empresaId },
        select: { nombre: true }
    })
    const marca = (cfg(config, 'nombre') || empresa?.nombre || 'nuestra marca')

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

    // 2) Último mensaje del cliente
    const ultimoCliente = await prisma.message.findFirst({
        where: { conversationId: chatId, from: 'client' },
        orderBy: { timestamp: 'desc' },
        select: { id: true, mediaType: true, mediaUrl: true, caption: true, isVoiceNote: true, transcription: true, contenido: true }
    })

    let mensaje = (mensajeArg || '').trim()
    if (!mensaje && ultimoCliente?.isVoiceNote && (ultimoCliente.transcription || '').trim()) {
        mensaje = String(ultimoCliente.transcription).trim()
    }
    const isImage = ultimoCliente?.mediaType === MediaType.image && !!ultimoCliente.mediaUrl
    const imageUrl = isImage ? String(ultimoCliente?.mediaUrl) : null

    // 2.1 Si vino imagen del cliente: la tratamos como posible comprobante de pago
    if (isImage) {
        const maybePayment = /comprobante|pago|recibo|transferencia|soporte|consignacion|consignación|voucher|dep[oó]sito|qr/i.test(
            (ultimoCliente?.caption || '') + ' ' + (ultimoCliente?.contenido || '')
        )
        if (maybePayment) {
            // Creamos o ubicamos un pedido "pending" de esta conversación
            const order = await ensureDraftOrder(conversacion, config)
            // Guardar PaymentReceipt asociado al mensaje/imagen
            try {
                await prisma.paymentReceipt.create({
                    data: {
                        orderId: order.id,
                        messageId: ultimoCliente.id,
                        imageUrl: imageUrl!,
                        method: inferMethodFromConfig(config) || 'transfer|link',
                        isVerified: false,
                        rawOcrText: '', // (OCR futuro)
                    }
                })
            } catch (e) {
                console.warn('[handleIAReply] paymentReceipt create error:', (e as any)?.message || e)
            }
            const texto = [
                '¡Gracias! Recibimos tu *comprobante* 🙌',
                'Lo revisamos y te confirmamos por aquí.',
                cfg(config, 'envioEntregaEstimado') ? `Entrega estimada: ${cfg(config, 'envioEntregaEstimado')}.` : '',
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
    }

    // 3) Historial (para memoria)
    const mensajesPrevios = await prisma.message.findMany({
        where: { conversationId: chatId },
        orderBy: { timestamp: 'asc' },
        take: 18,
        select: { from: true, contenido: true },
    })
    const historial = mensajesPrevios
        .filter(m => (m.contenido || '').trim().length > 0)
        .map(m => ({ role: m.from === 'client' ? 'user' : 'assistant', content: m.contenido } as const))

    // 3.1) Productos relevantes
    let productos: any[] = []
    try {
        productos = await retrieveRelevantProducts(conversacion.empresaId, mensaje || (ultimoCliente?.caption ?? ''), 5)
    } catch (e) {
        console.warn('[handleIAReply] retrieveRelevantProducts error:', (e as any)?.message || e)
        productos = []
    }
    if (!productos.length && mensaje) {
        const tokens = Array.from(new Set(nrm(mensaje).split(' ').filter(w => w.length >= 3)))
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
                take: 3, orderBy: { id: 'asc' }
            })
        }
    }

    /* ===== 4) Determinísticos antes de IA ===== */

    // 4.0 Bienvenida humana si es de las primeras interacciones
    const isEarly = mensajesPrevios.filter(m => m.from === 'bot' || m.from === 'client').length < 3
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

    // 4.1 Preguntas de negocio (usa DB)
    const f = markAny(bizFlags(mensaje || ultimoCliente?.caption || ''))
    if (f.any) {
        const ans = businessAnswer(config, f)
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

    // 4.2 Precio directo
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

    // 4.3 Imágenes directas
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

    // 4.4 Flujo de compra (nuevo): intención de comprar / pago / dirección
    if (wantsToBuy(mensaje) || askPaymentLink(mensaje) || askTransfer(mensaje) || providesAddress(mensaje) || providesCity(mensaje)) {
        const draft = await ensureDraftOrder(conversacion, config)

        // Si hay productos relevantes, agregamos primero (si no existe item)
        if (productos.length) {
            await upsertFirstItem(draft.id, productos[0])
            await recalcOrderTotals(draft.id, config)
        }

        // Si pregunta por link de pago
        if (askPaymentLink(mensaje)) {
            const txt = composePaymentLinkMessage(config, productos[0])
            const saved = await persistBotReply({
                conversationId: chatId, empresaId: conversacion.empresaId, texto: txt,
                nuevoEstado: ConversationEstado.venta_en_proceso,
                sendTo: opts?.autoSend ? (opts?.toPhone || conversacion.phone) : undefined,
                phoneNumberId: opts?.phoneNumberId,
            })
            return { estado: ConversationEstado.venta_en_proceso, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
        }

        // Si pide transferencia / datos bancarios
        if (askTransfer(mensaje)) {
            const txt = composeBankTransferMessage(config, productos[0])
            const saved = await persistBotReply({
                conversationId: chatId, empresaId: conversacion.empresaId, texto: txt,
                nuevoEstado: ConversationEstado.venta_en_proceso,
                sendTo: opts?.autoSend ? (opts?.toPhone || conversacion.phone) : undefined,
                phoneNumberId: opts?.phoneNumberId,
            })
            return { estado: ConversationEstado.venta_en_proceso, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
        }

        // Recolección mínima de datos de envío
        const needCity = !draft.city && providesCity(mensaje) === false
        const needAddress = !draft.address && providesAddress(mensaje) === false
        if (!draft.city || !draft.address) {
            // Si mencionó algo de ciudad o dirección pero aún falta el otro campo
            let ask = ''
            if (!draft.city && draft.address) ask = '¿En qué *ciudad* recibes el pedido?'
            else if (!draft.address && draft.city) ask = '¿Cuál es la *dirección* de entrega (calle, número, barrio)?'
            else ask = 'Para coordinar el envío, ¿me compartes *ciudad* y *dirección* de entrega?'
            const saved = await persistBotReply({
                conversationId: chatId, empresaId: conversacion.empresaId, texto: ask,
                nuevoEstado: ConversationEstado.venta_en_proceso,
                sendTo: opts?.autoSend ? (opts?.toPhone || conversacion.phone) : undefined,
                phoneNumberId: opts?.phoneNumberId,
            })
            return { estado: ConversationEstado.venta_en_proceso, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
        }

        // Si ya tenemos dirección y ciudad → ofrecer métodos de pago
        const txt = composeCheckoutOptions(config, productos[0])
        const saved = await persistBotReply({
            conversationId: chatId, empresaId: conversacion.empresaId, texto: txt,
            nuevoEstado: ConversationEstado.venta_en_proceso,
            sendTo: opts?.autoSend ? (opts?.toPhone || conversacion.phone) : undefined,
            phoneNumberId: opts?.phoneNumberId,
        })
        return { estado: ConversationEstado.venta_en_proceso, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] }
    }

    // 4.5 Seguimiento de CTA (memoria)
    const lastCTA = lastBotCTA(mensajesPrevios)
    if ((isAffirmative(mensaje) || isProductIntent(mensaje) || isPrice(mensaje)) && productos.length) {
        const want: LastCTA =
            (isPrice(mensaje) && 'precio') ||
            (/beneficio|ventaja/.test(nrm(mensaje)) && 'beneficios') ||
            (/disponibilidad|stock/.test(nrm(mensaje)) && 'disponibilidad') ||
            (/foto|imagen|fotos/.test(nrm(mensaje)) && 'fotos') ||
            lastCTA

        if (want) {
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
    }

    /* ===== 5) IA (más libre) ===== */
    const baseMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: any }> = [
        { role: 'system', content: systemPrompt(config, productos, mensajeEscalamiento, empresa?.nombre) },
        ...historial
    ]
    if (imageUrl) {
        baseMessages.push({ role: 'user', content: [{ type: 'text', text: mensaje || ultimoCliente?.caption || 'Analiza la imagen en el contexto del negocio y ayuda al cliente.' }, { type: 'image_url', image_url: { url: imageUrl } }] } as any)
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
            texto: 'No sabría decirte con certeza; debo consultarlo. Si deseas, lo escalo con un asesor humano.',
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

    // Envío proactivo de imágenes si aplica
    let mediaSent: Array<{ productId: number; imageUrl: string; wamid?: string }> = []
    if (isProductIntent(mensaje || ultimoCliente?.caption || '') && opts?.autoSend && (opts?.toPhone || conversacion.phone) && productos.length) {
        mediaSent = await sendProductImages({ chatId, conversacion, productosRelevantes: productos, phoneNumberId: opts?.phoneNumberId, toOverride: opts?.toPhone })
    }

    return { estado: ConversationEstado.respondido, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: mediaSent }
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
    const bens = String(p?.beneficios || '').split('\n').map(s => s.trim()).filter(Boolean).slice(0, 3)
    const lines: string[] = []
    lines.push(`*${p.nombre}* – Beneficios principales:`)
    if (bens.length) lines.push(...bens.map(b => `• ${b}`))
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
        take: MAX_PRODUCTS_TO_SEND
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

/* ===================== Helpers de pedidos/pagos ===================== */

function inferMethodFromConfig(c: any): string | null {
    if (String(cfg(c, 'transferenciaQRUrl') || '').trim() || String(cfg(c, 'bancoNombre') || '').trim()) return 'transfer'
    if (String(cfg(c, 'pagoLinkGenerico') || '').trim() || String(cfg(c, 'pagoLinkProductoBase') || '').trim()) return 'link'
    return null
}

async function ensureDraftOrder(
    conversacion: { id: number; empresaId: number; phone: string; nombre?: string | null },
    c: any
) {
    // Busca pedido pendiente por conversación
    let order = await prisma.order.findFirst({
        where: { empresaId: conversacion.empresaId, conversationId: conversacion.id, status: { in: ['pending', 'pending_payment', 'created'] } },
        orderBy: { id: 'desc' }
    })
    if (order) return order

    // Crea nuevo
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
        }
    })
    return order
}

async function upsertFirstItem(orderId: number, prod: any) {
    const exists = await prisma.orderItem.findFirst({ where: { orderId, productId: prod.id } })
    if (exists) return exists
    const price = Number(prod?.precioDesde ?? 0) || 0
    return prisma.orderItem.create({
        data: { orderId, productId: prod.id, name: prod.nombre, price, qty: 1, total: price }
    })
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

function composePaymentLinkMessage(c: any, prod?: any) {
    const linkGen = String(cfg(c, 'pagoLinkGenerico') || '').trim()
    const linkBase = String(cfg(c, 'pagoLinkProductoBase') || '').trim()
    const notas = String(cfg(c, 'pagoNotas') || '').trim()
    const parts: string[] = []
    if (linkBase && prod?.slug) {
        parts.push(`💳 Pago online: ${linkBase}?sku=${encodeURIComponent(prod.slug)}&qty=1`)
    } else if (linkGen) {
        parts.push(`💳 Pago online: ${linkGen}`)
    } else {
        parts.push('💳 Habilitamos pagos online. Si prefieres, también puedes pagar por transferencia.')
    }
    if (notas) parts.push(`ℹ️ Nota: ${notas}`)
    parts.push('Cuando completes el pago, envíame el *comprobante* por aquí (foto).')
    return short(parts.join('\n'))
}

function composeBankTransferMessage(c: any, prod?: any) {
    const bank = {
        banco: String(cfg(c, 'bancoNombre') || '').trim(),
        titular: String(cfg(c, 'bancoTitular') || '').trim(),
        tipo: String(cfg(c, 'bancoTipoCuenta') || '').trim(),
        numero: String(cfg(c, 'bancoNumeroCuenta') || '').trim(),
        doc: String(cfg(c, 'bancoDocumento') || '').trim(),
        qr: String(cfg(c, 'transferenciaQRUrl') || '').trim(),
        notas: String(cfg(c, 'pagoNotas') || '').trim()
    }
    const parts: string[] = []
    parts.push('🏦 *Transferencia bancaria*')
    if (bank.banco) parts.push(`• Banco: ${bank.banco}`)
    if (bank.titular) parts.push(`• Titular: ${bank.titular}`)
    if (bank.tipo) parts.push(`• Tipo de cuenta: ${bank.tipo}`)
    if (bank.numero) parts.push(`• Nº de cuenta: ${bank.numero}`)
    if (bank.doc) parts.push(`• Documento: ${bank.doc}`)
    if (bank.qr) parts.push(`• QR: ${bank.qr}`)
    if (bank.notas) parts.push(`ℹ️ ${bank.notas}`)
    parts.push('Al hacer la transferencia, envíame el *comprobante* (foto) por aquí.')
    return short(parts.join('\n'))
}

function composeCheckoutOptions(c: any, prod?: any) {
    const hasLink = Boolean(String(cfg(c, 'pagoLinkGenerico') || cfg(c, 'pagoLinkProductoBase') || '').trim())
    const hasBank = Boolean(String(cfg(c, 'bancoNombre') || cfg(c, 'transferenciaQRUrl') || '').trim())
    const envioEta = String(cfg(c, 'envioEntregaEstimado') || '').trim()
    const parts: string[] = []
    parts.push('¡Perfecto! Para completar tu pedido puedes:')
    if (hasLink) parts.push('• 💳 Pagar con *link* (tarjeta/PSE).')
    if (hasBank) parts.push('• 🏦 Pagar por *transferencia bancaria*.')
    if (!hasLink && !hasBank) parts.push('• Confirmar por aquí y coordinamos el pago.')
    if (envioEta) parts.push(`⏰ Entrega estimada: ${envioEta}.`)
    parts.push('¿Qué método prefieres?')
    return short(parts.join('\n'))
}
