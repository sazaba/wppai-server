// server/src/utils/sendWhatsappMessage.ts
import axios from 'axios'
import { getWhatsappCreds } from '../services/whatsapp.services'

const FB_VERSION = process.env.META_GRAPH_VERSION || 'v20.0'

type SendTextInput = {
    empresaId: number
    to: string
    message: string
}

type MediaType = 'image' | 'video' | 'audio' | 'document'
type SendMediaInput = {
    empresaId: number
    to: string
    url: string
    type: MediaType
    caption?: string
    filename?: string
}

// --- helpers ---
function normalizeToE164(n: string) {
    const digits = String(n || '').replace(/[^\d]/g, '')
    return digits // para WA Cloud API basta con CC+NSN sin '+'
}

function assertCreds(accessToken?: string, phoneNumberId?: string) {
    if (!accessToken || !phoneNumberId) {
        throw new Error('[WA] Credenciales incompletas: accessToken o phoneNumberId faltan')
    }
}

function endpoint(phoneNumberId: string) {
    return `https://graph.facebook.com/${FB_VERSION}/${phoneNumberId}/messages`
}

function headers(token: string) {
    return {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
    }
}

/** Enviar TEXTO por WhatsApp usando credenciales guardadas por empresa. */
export const sendWhatsappMessage = async ({ empresaId, to, message }: SendTextInput) => {
    if (!message?.trim()) throw new Error('[WA] EMPTY_BODY')

    const { accessToken, phoneNumberId } = await getWhatsappCreds(empresaId)
    assertCreds(accessToken, phoneNumberId)

    const toNorm = normalizeToE164(to)
    const url = endpoint(phoneNumberId!)

    const payload = {
        messaging_product: 'whatsapp',
        to: toNorm,
        type: 'text',
        text: { body: message, preview_url: false },
    }

    try {
        const resp = await axios.post(url, payload, {
            headers: headers(accessToken!),
            timeout: 30000,
        })
        const wamid = resp?.data?.messages?.[0]?.id
        console.log('[WA SEND text][OK]', { to: toNorm, wamid })
        return resp.data
    } catch (err: any) {
        const data = err?.response?.data
        console.error('[WA SEND text][ERROR]', {
            to: toNorm,
            status: err?.response?.status,
            data: data || err?.message || err,
        })
        throw err
    }
}

/** Enviar MEDIA (imagen / video / audio / document). */
export const sendWhatsappMedia = async ({ empresaId, to, url, type, caption, filename }: SendMediaInput) => {
    if (!url) throw new Error('[WA] MEDIA_URL_REQUIRED')

    const { accessToken, phoneNumberId } = await getWhatsappCreds(empresaId)
    assertCreds(accessToken, phoneNumberId)

    const toNorm = normalizeToE164(to)
    const ep = endpoint(phoneNumberId!)

    let mediaPayload: any
    switch (type) {
        case 'image':
        case 'video':
            mediaPayload = { link: url, ...(caption ? { caption } : {}) }
            break
        case 'audio':
            mediaPayload = { link: url }
            break
        case 'document':
            mediaPayload = { link: url, ...(caption ? { caption } : {}), ...(filename ? { filename } : {}) }
            break
        default:
            throw new Error(`[WA] Tipo de media no soportado: ${type}`)
    }

    const payload: any = {
        messaging_product: 'whatsapp',
        to: toNorm,
        type,
        [type]: mediaPayload,
    }

    try {
        const resp = await axios.post(ep, payload, {
            headers: headers(accessToken!),
            timeout: 40000,
        })
        const wamid = resp?.data?.messages?.[0]?.id
        console.log('[WA SEND media][OK]', { to: toNorm, type, wamid })
        return resp.data
    } catch (err: any) {
        const data = err?.response?.data
        console.error('[WA SEND media][ERROR]', {
            to: toNorm,
            type,
            status: err?.response?.status,
            data: data || err?.message || err,
        })
        throw err
    }
}
