// src/services/whatsapp.service.ts
import axios from 'axios'
import prisma from '../lib/prisma'
import { MessageFrom } from '@prisma/client'

const FB_VERSION = 'v20.0'

/* ===================== Types ===================== */

type SendTextArgs = {
    empresaId: number
    to: string
    body: string
    conversationId?: number // opcional: si lo tienes, se guarda el mensaje en DB
}

type SendTemplateArgs = {
    empresaId: number
    to: string
    templateName: string
    templateLang: string
    variables?: string[]
}

type MediaType = 'image' | 'video'

type SendMediaArgs = {
    empresaId: number
    to: string
    url: string
    type: MediaType
    caption?: string
    conversationId?: number // opcional: si lo tienes, se guarda el mensaje en DB
}

export type OutboundResult = {
    type: 'text' | 'template' | 'media'
    data: any
    outboundId: string | null // wamid retornado por Graph
}

/* ===================== HTTP ===================== */

const http = axios.create({
    timeout: 12000,
    headers: { 'Content-Type': 'application/json' },
})

/* ===================== Helpers ===================== */

export async function getWhatsappCreds(empresaId: number) {
    const acc = await prisma.whatsappAccount.findUnique({ where: { empresaId } })
    if (!acc?.accessToken || !acc?.phoneNumberId) {
        throw new Error('Cuenta de WhatsApp no conectada para esta empresa.')
    }
    return { accessToken: acc.accessToken, phoneNumberId: acc.phoneNumberId }
}

function sanitizePhone(to: string | number) {
    return String(to).replace(/\D+/g, '')
}

// WhatsApp Cloud suele aceptar hasta 1024 chars en caption
function clampCaption(c?: string) {
    if (!c) return undefined
    return c.length > 1024 ? c.slice(0, 1024) : c
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

        // (Opcional) Persistir si tienes conversationId y columnas en tu schema
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

/* ===================== Media ===================== */

export async function sendWhatsappMedia({
    empresaId,
    to,
    url,
    type,
    caption,
    conversationId,
}: SendMediaArgs): Promise<OutboundResult> {
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

        // (Opcional) Persistir si tienes conversationId y campos en tu schema
        // Requiere que tu modelo Message tenga: externalId?, mediaType?, mediaUrl?, caption?, empresaId
        if (conversationId) {
            try {
                await prisma.message.create({
                    data: {
                        conversationId,
                        empresaId,
                        from: 'bot' as MessageFrom,
                        contenido: safeCaption || (type === 'image' ? '[imagen]' : '[video]'),
                        externalId: outboundId || undefined,
                        // Estos campos son opcionales según tu migración:
                        // @ts-ignore - si aún no migraste, ignora sin romper
                        mediaType: type,
                        // @ts-ignore
                        mediaUrl: url,
                        // @ts-ignore
                        caption: safeCaption || null,
                    } as any,
                })
            } catch (e) {
                console.warn('[WA sendWhatsappMedia] No se pudo guardar el mensaje en DB:', e)
            }
        }

        return { type: 'media', data, outboundId }
    } catch (e: any) {
        console.error('[WA sendWhatsappMedia] Error:', e?.response?.data || e.message)
        throw e
    }
}

/* ===================== Template (opcional) ===================== */

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
    conversationId?: number // ahora es opcional, por si no lo tienes en ese contexto
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
