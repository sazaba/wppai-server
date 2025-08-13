import axios from 'axios'
import prisma from '../lib/prisma'
import { MessageFrom } from '@prisma/client'

const FB_VERSION = 'v20.0'

type SendTextArgs = { empresaId: number; to: string; body: string }
type SendTemplateArgs = {
    empresaId: number
    to: string
    templateName: string
    templateLang: string
    variables?: string[]
}

type OutboundResult = {
    type: 'text' | 'template'
    data: any
    outboundId: string | null // wamid retornado por Graph
}

const http = axios.create({
    timeout: 12000,
    headers: { 'Content-Type': 'application/json' }
})

export async function getWhatsappCreds(empresaId: number) {
    const acc = await prisma.whatsappAccount.findUnique({ where: { empresaId } })
    if (!acc?.accessToken || !acc?.phoneNumberId) {
        throw new Error('Cuenta de WhatsApp no conectada para esta empresa.')
    }
    return { accessToken: acc.accessToken, phoneNumberId: acc.phoneNumberId }
}

export async function sendText({ empresaId, to, body }: SendTextArgs): Promise<OutboundResult> {
    const { accessToken, phoneNumberId } = await getWhatsappCreds(empresaId)
    const url = `https://graph.facebook.com/${FB_VERSION}/${phoneNumberId}/messages`
    const payload = { messaging_product: 'whatsapp', to, type: 'text', text: { body } }

    try {
        const { data } = await http.post(url, payload, { headers: { Authorization: `Bearer ${accessToken}` } })
        const outboundId = data?.messages?.[0]?.id ?? null
        return { type: 'text', data, outboundId }
    } catch (e: any) {
        console.error('[WA sendText] Error:', e?.response?.data || e.message)
        throw e
    }
}

export async function sendTemplate({
    empresaId, to, templateName, templateLang, variables = []
}: SendTemplateArgs): Promise<OutboundResult> {
    const { accessToken, phoneNumberId } = await getWhatsappCreds(empresaId)
    const url = `https://graph.facebook.com/${FB_VERSION}/${phoneNumberId}/messages`

    const components =
        variables.length
            ? [{ type: 'body', parameters: variables.map((t) => ({ type: 'text', text: t })) }]
            : undefined

    const payload = {
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
            name: templateName,
            language: { code: templateLang },
            ...(components ? { components } : {})
        }
    }

    try {
        const { data } = await http.post(url, payload, { headers: { Authorization: `Bearer ${accessToken}` } })
        const outboundId = data?.messages?.[0]?.id ?? null
        return { type: 'template', data, outboundId }
    } catch (e: any) {
        console.error('[WA sendTemplate] Error:', e?.response?.data || e.message)
        throw e
    }
}

/**
 * Envío inteligente según ventana de 24h.
 * - Dentro de 24h: texto libre (requiere "body")
 * - Fuera de 24h: lanza 409 para que el caller decida plantilla
 * - Si se pasa `forceTemplate`, envía plantilla siempre
 */
export async function sendOutboundMessage(args: {
    conversationId: number
    empresaId: number
    to: string
    body?: string
    forceTemplate?: { name: string; lang: string; variables?: string[] }
}): Promise<OutboundResult> {
    const { conversationId, empresaId, to, body, forceTemplate } = args

    // Último inbound del cliente para evaluar 24 horas
    const lastInbound = await prisma.message.findFirst({
        where: { conversationId, from: MessageFrom.client },
        orderBy: { timestamp: 'desc' }
    })

    const within24h = !!lastInbound
        ? Date.now() - new Date(lastInbound.timestamp).getTime() <= 24 * 60 * 60 * 1000
        : false

    if (forceTemplate) {
        return sendTemplate({
            empresaId,
            to,
            templateName: forceTemplate.name,
            templateLang: forceTemplate.lang,
            variables: forceTemplate.variables || []
        })
    }

    if (within24h) {
        if (!body || body.trim() === '') {
            const err: any = new Error('EMPTY_BODY_WITHIN_24H')
            err.status = 400
            throw err
        }
        return sendText({ empresaId, to, body })
    }

    const err: any = new Error('OUT_OF_24H_WINDOW')
    err.status = 409
    throw err
}
