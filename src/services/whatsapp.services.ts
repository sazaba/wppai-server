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

export async function getWhatsappCreds(empresaId: number) {
    const acc = await prisma.whatsappAccount.findUnique({ where: { empresaId } })
    if (!acc?.accessToken || !acc?.phoneNumberId) {
        throw new Error('Cuenta de WhatsApp no conectada para esta empresa.')
    }
    return { accessToken: acc.accessToken, phoneNumberId: acc.phoneNumberId }
}

export async function sendText({ empresaId, to, body }: SendTextArgs) {
    const { accessToken, phoneNumberId } = await getWhatsappCreds(empresaId)
    const url = `https://graph.facebook.com/${FB_VERSION}/${phoneNumberId}/messages`
    const payload = { messaging_product: 'whatsapp', to, type: 'text', text: { body } }

    const { data } = await axios
        .post(url, payload, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            }
        })
        .catch((e) => {
            console.error('[WA sendText] Error:', e?.response?.data || e.message)
            throw e
        })

    return data
}

export async function sendTemplate({
    empresaId,
    to,
    templateName,
    templateLang,
    variables = []
}: SendTemplateArgs) {
    const { accessToken, phoneNumberId } = await getWhatsappCreds(empresaId)
    const url = `https://graph.facebook.com/${FB_VERSION}/${phoneNumberId}/messages`

    const components =
        variables.length > 0
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

    const { data } = await axios
        .post(url, payload, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            }
        })
        .catch((e) => {
            console.error('[WA sendTemplate] Error:', e?.response?.data || e.message)
            throw e
        })

    return data
}

export async function sendOutboundMessage(args: {
    conversationId: number
    empresaId: number
    to: string
    body?: string
    /** Forzar envío de plantilla (necesario si está fuera de 24h) */
    forceTemplate?: { name: string; lang: string; variables?: string[] }
}) {
    const { conversationId, empresaId, to, body, forceTemplate } = args

    // Último mensaje entrante (cliente) para validar 24 h
    const lastInbound = await prisma.message.findFirst({
        where: { conversationId, from: MessageFrom.client },
        orderBy: { timestamp: 'desc' }
    })

    const within24h = !!lastInbound
        ? Date.now() - new Date(lastInbound.timestamp).getTime() <= 24 * 60 * 60 * 1000
        : false

    // Si se fuerza plantilla, siempre se puede enviar (dentro o fuera de 24h)
    if (forceTemplate) {
        return await sendTemplate({
            empresaId,
            to,
            templateName: forceTemplate.name,
            templateLang: forceTemplate.lang,
            variables: forceTemplate.variables || []
        })
    }

    // Dentro de 24h: permitir texto libre si hay body
    if (within24h) {
        if (!body || body.trim() === '') {
            const err: any = new Error('EMPTY_BODY_WITHIN_24H')
            err.status = 400
            throw err
        }
        return await sendText({ empresaId, to, body })
    }

    // Fuera de 24h y sin plantilla: bloquear
    const err: any = new Error('OUT_OF_24H_WINDOW')
    err.status = 409
    throw err
}
