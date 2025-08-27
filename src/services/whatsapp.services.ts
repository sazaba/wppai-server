// src/services/whatsapp.services.ts
import axios from 'axios'
import prisma from '../lib/prisma'
import { MessageFrom, MediaType as PrismaMediaType } from '@prisma/client'
import fs from 'fs'
import FormData from 'form-data'

const FB_VERSION = process.env.FB_VERSION || 'v20.0'

/* ===================== Types ===================== */

type SendTextArgs = {
    empresaId: number
    to: string
    body: string
    conversationId?: number
}

type SendTemplateArgs = {
    empresaId: number
    to: string
    templateName: string
    templateLang: string
    variables?: string[]
}

export type MediaType = 'image' | 'video' | 'audio' | 'document'

type SendMediaByLinkArgs = {
    empresaId: number
    to: string
    url: string
    type: MediaType
    caption?: string
    conversationId?: number
    mimeType?: string
}

type SendMediaByIdArgs = {
    empresaId: number
    to: string
    type: MediaType
    mediaId: string
    caption?: string
    conversationId?: number
    mimeType?: string
}

export type OutboundResult = {
    type: 'text' | 'template' | 'media'
    data: any
    outboundId: string | null
}

/* ===================== HTTP ===================== */

const http = axios.create({
    timeout: 12000,
    headers: { 'Content-Type': 'application/json' },
})

/* ===================== Helpers ===================== */

export async function getWhatsappCreds(empresaId: number, phoneNumberIdHint?: string) {
    if (phoneNumberIdHint) {
        const accByPhone = await prisma.whatsappAccount.findFirst({
            where: { empresaId, phoneNumberId: phoneNumberIdHint, accessToken: { not: '' } },
            select: { accessToken: true, phoneNumberId: true },
        })
        if (accByPhone?.accessToken && accByPhone?.phoneNumberId) {
            return { accessToken: accByPhone.accessToken, phoneNumberId: accByPhone.phoneNumberId }
        }
    }
    const acc = await prisma.whatsappAccount.findFirst({
        where: { empresaId, accessToken: { not: '' } },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        select: { accessToken: true, phoneNumberId: true },
    })
    if (!acc?.accessToken || !acc?.phoneNumberId) {
        throw new Error(`[WA] Cuenta de WhatsApp no conectada para empresaId=${empresaId}.`)
    }
    return { accessToken: acc.accessToken, phoneNumberId: acc.phoneNumberId }
}



function sanitizePhone(to: string | number) {
    return String(to).replace(/\D+/g, '')
}

function clampCaption(c?: string) {
    if (!c) return undefined
    return c.length > 1024 ? c.slice(0, 1024) : c
}

async function persistMediaMessage(opts: {
    conversationId?: number
    empresaId: number
    from: MessageFrom
    outboundId: string | null
    type: MediaType
    mediaId?: string | null
    mediaUrl?: string | null
    caption?: string | null
    mimeType?: string | null
}) {
    const {
        conversationId,
        empresaId,
        from,
        outboundId,
        type,
        mediaId = null,
        mediaUrl = null,
        caption = null,
        mimeType = null,
    } = opts
    if (!conversationId) return

    try {
        await prisma.message.create({
            data: {
                conversationId,
                empresaId,
                from,
                contenido:
                    caption ??
                    (type === 'image'
                        ? '[imagen]'
                        : type === 'video'
                            ? '[video]'
                            : type === 'audio'
                                ? '[nota de voz]'
                                : '[documento]'),
                externalId: outboundId || undefined,
                mediaType: type as PrismaMediaType,
                mediaId,
                mediaUrl,
                mimeType,
                caption,
            },
        })
    } catch (e) {
        console.warn('[WA persistMediaMessage] No se pudo guardar el mensaje en DB:', e)
    }
}

/* ===================== Text ===================== */

export async function sendText({
    empresaId,
    to,
    body,
    conversationId,
}: SendTextArgs): Promise<OutboundResult> {
    const { accessToken, phoneNumberId } = await getWhatsappCreds(empresaId)
    const url = `https://graph.facebook.com/${FB_VERSION}/${phoneNumberId}/messages`
    const toSanitized = sanitizePhone(to)
    const payload = { messaging_product: 'whatsapp', to: toSanitized, type: 'text', text: { body } }

    try {
        const { data } = await http.post(url, payload, {
            headers: { Authorization: `Bearer ${accessToken}` },
        })
        const outboundId = data?.messages?.[0]?.id ?? null

        if (conversationId) {
            try {
                await prisma.message.create({
                    data: {
                        conversationId,
                        empresaId,
                        from: 'bot' as MessageFrom,
                        contenido: body,
                        externalId: outboundId || undefined,
                    },
                })
            } catch (e) {
                console.warn('[WA sendText] No se pudo guardar el mensaje en DB:', e)
            }
        }

        return { type: 'text', data, outboundId }
    } catch (e: any) {
        console.error('[WA sendText] Error:', e?.response?.data || e.message)
        throw e
    }
}

/* ===================== Media (por LINK) ===================== */

export async function sendWhatsappMedia({
    empresaId,
    to,
    url,
    type,
    caption,
    conversationId,
    mimeType,
}: SendMediaByLinkArgs): Promise<OutboundResult> {
    if (!to) throw new Error('Destino (to) requerido')
    if (!url) throw new Error('URL de media requerida')

    const { accessToken, phoneNumberId } = await getWhatsappCreds(empresaId)
    const endpoint = `https://graph.facebook.com/${FB_VERSION}/${phoneNumberId}/messages`
    const toSanitized = sanitizePhone(to)
    const safeCaption = clampCaption(caption)

    const payload: any = {
        messaging_product: 'whatsapp',
        to: toSanitized,
        type,
        [type]: {
            link: url,
            ...(safeCaption ? { caption: safeCaption } : {}),
        },
    }

    try {
        const { data } = await http.post(endpoint, payload, {
            headers: { Authorization: `Bearer ${accessToken}` },
        })
        const outboundId = data?.messages?.[0]?.id ?? null

        await persistMediaMessage({
            conversationId,
            empresaId,
            from: 'bot',
            outboundId,
            type,
            mediaUrl: url,
            caption: safeCaption ?? null,
            mimeType: mimeType ?? null,
        })

        return { type: 'media', data, outboundId }
    } catch (e: any) {
        console.error('[WA sendWhatsappMedia] Error:', e?.response?.data || e.message)
        throw e
    }
}

/* ===================== Media (por MEDIA_ID) ===================== */

export async function sendWhatsappMediaById({
    empresaId,
    to,
    type,
    mediaId,
    caption,
    conversationId,
    mimeType,
}: SendMediaByIdArgs): Promise<OutboundResult> {
    if (!to) throw new Error('Destino (to) requerido')
    if (!mediaId) throw new Error('mediaId requerido')

    const { accessToken, phoneNumberId } = await getWhatsappCreds(empresaId)
    const endpoint = `https://graph.facebook.com/${FB_VERSION}/${phoneNumberId}/messages`
    const toSanitized = sanitizePhone(to)
    const safeCaption = clampCaption(caption)

    const payload: any = {
        messaging_product: 'whatsapp',
        to: toSanitized,
        type,
        [type]: {
            id: mediaId,
            ...(safeCaption ? { caption: safeCaption } : {}),
        },
    }

    try {
        const { data } = await http.post(endpoint, payload, {
            headers: { Authorization: `Bearer ${accessToken}` },
        })
        const outboundId = data?.messages?.[0]?.id ?? null

        await persistMediaMessage({
            conversationId,
            empresaId,
            from: 'bot',
            outboundId,
            type,
            mediaId,
            caption: safeCaption ?? null,
            mimeType: mimeType ?? null,
        })

        return { type: 'media', data, outboundId }
    } catch (e: any) {
        console.error('[WA sendWhatsappMediaById] Error:', e?.response?.data || e.message)
        throw e
    }
}

/* ====== Subir archivo a WhatsApp /media (devuelve media_id) ====== */

export async function uploadToWhatsappMedia(empresaId: number, filePath: string, mimeType: string) {
    const { accessToken, phoneNumberId } = await getWhatsappCreds(empresaId)
    const form = new FormData()
    form.append('messaging_product', 'whatsapp')
    form.append('type', mimeType)
    form.append('file', fs.createReadStream(filePath))

    try {
        const { data } = await axios.post(
            `https://graph.facebook.com/${FB_VERSION}/${phoneNumberId}/media`,
            form,
            {
                headers: { Authorization: `Bearer ${accessToken}`, ...form.getHeaders() },
                timeout: 30000,
            }
        )
        return data?.id as string
    } catch (e: any) {
        console.error('[WA uploadToWhatsappMedia] Error:', e?.response?.data || e.message)
        throw e
    }
}

/* ===================== Helpers inbound media ===================== */

type MediaMeta = {
    id: string
    url: string
    mime_type?: string
    sha256?: string
    file_size?: number
}

/** Devuelve metadatos del media-id (incluye url firmada y mime_type) */
export async function getMediaMeta(empresaId: number, mediaId: string): Promise<MediaMeta> {
    const { accessToken } = await getWhatsappCreds(empresaId)
    const { data } = await axios.get(`https://graph.facebook.com/${FB_VERSION}/${mediaId}`, {
        params: { fields: 'url,mime_type,file_size,sha256' },
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 15000,
    })
    return data as MediaMeta
}

export async function getMediaUrl(empresaId: number, mediaId: string): Promise<string> {
    const meta = await getMediaMeta(empresaId, mediaId)
    return meta.url
}

export async function downloadMediaToBuffer(empresaId: number, mediaUrl: string): Promise<Buffer> {
    const { accessToken } = await getWhatsappCreds(empresaId)
    const { data } = await axios.get(mediaUrl, {
        responseType: 'arraybuffer',
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 30000,
    })
    return Buffer.from(data)
}

/** Descarga directo a partir de un mediaId (retorna buffer y mime) */
export async function downloadMediaByIdToBuffer(
    empresaId: number,
    mediaId: string
): Promise<{ buffer: Buffer; mimeType?: string; fileSize?: number }> {
    const meta = await getMediaMeta(empresaId, mediaId)
    const { accessToken } = await getWhatsappCreds(empresaId)

    const resp = await axios.get(meta.url, {
        responseType: 'arraybuffer',
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 30000,
    })

    const mimeType = resp.headers['content-type'] as string | undefined
    const fileSize = Number(resp.headers['content-length'] || meta.file_size || 0)

    return { buffer: Buffer.from(resp.data), mimeType, fileSize }
}

/* ===================== Template ===================== */

export async function sendTemplate({
    empresaId,
    to,
    templateName,
    templateLang,
    variables = [],
}: SendTemplateArgs): Promise<OutboundResult> {
    const { accessToken, phoneNumberId } = await getWhatsappCreds(empresaId)
    const url = `https://graph.facebook.com/${FB_VERSION}/${phoneNumberId}/messages`
    const toSanitized = sanitizePhone(to)

    const components =
        variables.length
            ? [{ type: 'body', parameters: variables.map((t) => ({ type: 'text', text: t })) }]
            : undefined

    const payload = {
        messaging_product: 'whatsapp',
        to: toSanitized,
        type: 'template',
        template: {
            name: templateName,
            language: { code: templateLang },
            ...(components ? { components } : {}),
        },
    }

    try {
        const { data } = await http.post(url, payload, {
            headers: { Authorization: `Bearer ${accessToken}` },
        })
        const outboundId = data?.messages?.[0]?.id ?? null
        return { type: 'template', data, outboundId }
    } catch (e: any) {
        console.error('[WA sendTemplate] Error:', e?.response?.data || e.message)
        throw e
    }
}

/* ===================== Facade (texto simple) ===================== */

export async function sendOutboundMessage(args: {
    conversationId?: number
    empresaId: number
    to: string
    body: string
}): Promise<OutboundResult> {
    const { empresaId, to, body, conversationId } = args

    if (!body?.trim()) {
        const err: any = new Error('EMPTY_BODY')
        err.status = 400
        throw err
    }

    return sendText({ empresaId, to, body, conversationId })
}


/* ===================== Atajos útiles ===================== */

export async function sendVoiceNoteByLink(opts: {
    empresaId: number
    to: string
    url: string
    conversationId?: number
    mimeType?: string
}) {
    return sendWhatsappMedia({ ...opts, type: 'audio' })
}

export async function sendImageByLink(opts: {
    empresaId: number
    to: string
    url: string
    caption?: string
    conversationId?: number
    mimeType?: string
}) {
    return sendWhatsappMedia({ ...opts, type: 'image' })
}

export async function sendVideoByLink(opts: {
    empresaId: number
    to: string
    url: string
    caption?: string
    conversationId?: number
    mimeType?: string
}) {
    return sendWhatsappMedia({ ...opts, type: 'video' })
}
