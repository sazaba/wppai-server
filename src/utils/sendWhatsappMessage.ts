// server/src/utils/sendWhatsappMessage.ts
import axios from 'axios'
import { getWhatsappCreds } from '../services/whatsapp.services'

const FB_VERSION = 'v20.0'

type SendTextInput = {
    empresaId: number
    to: string
    message: string
}

type MediaType = 'image' | 'video'
type SendMediaInput = {
    empresaId: number
    to: string
    url: string
    type: MediaType
    caption?: string
}

/**
 * Enviar TEXTO por WhatsApp usando credenciales guardadas por empresa.
 */
export const sendWhatsappMessage = async ({ empresaId, to, message }: SendTextInput) => {
    if (!message?.trim()) throw new Error('EMPTY_BODY')

    const { accessToken, phoneNumberId } = await getWhatsappCreds(empresaId)
    const url = `https://graph.facebook.com/${FB_VERSION}/${phoneNumberId}/messages`

    const payload = {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: message },
    }

    const { data } = await axios.post(url, payload, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
        },
        timeout: 12000,
    })

    return data // incluye messages[0].id (wamid)
}

/**
 * Enviar MEDIA (imagen o video/mp4 – ideal para GIFs convertidos a mp4).
 */
export const sendWhatsappMedia = async ({ empresaId, to, url, type, caption }: SendMediaInput) => {
    if (!url) throw new Error('MEDIA_URL_REQUIRED')

    const { accessToken, phoneNumberId } = await getWhatsappCreds(empresaId)
    const endpoint = `https://graph.facebook.com/${FB_VERSION}/${phoneNumberId}/messages`

    const payload: any = {
        messaging_product: 'whatsapp',
        to,
        type,
        [type]: { link: url, ...(caption ? { caption } : {}) },
    }

    const { data } = await axios.post(endpoint, payload, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
        },
        timeout: 12000,
    })

    return data
}
