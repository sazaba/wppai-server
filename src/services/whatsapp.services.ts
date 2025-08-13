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

    const { data } = await axios.post(url, payload, {
        headers: { Authorization: `Bearer ${accessToken}` }
    }).catch((e) => { console.error('[WA sendText] Error:', e?.response?.data || e.message); throw e })

    return data
}

export async function sendTemplate({
    empresaId, to, templateName, templateLang, variables = []
}: SendTemplateArgs) {
    const { accessToken, phoneNumberId } = await getWhatsappCreds(empresaId)
    const url = `https://graph.facebook.com/${FB_VERSION}/${phoneNumberId}/messages`

    const components = variables.length
        ? [{ type: 'body', parameters: variables.map(t => ({ type: 'text', text: t })) }]
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

    const { data } = await axios.post(url, payload, {
        headers: { Authorization: `Bearer ${accessToken}` }
    }).catch((e) => { console.error('[WA sendTemplate] Error:', e?.response?.data || e.message); throw e })

    return data
}

export async function sendOutboundMessage(args: {
    conversationId: number
    empresaId: number
    to: string
    body?: string
    forceTemplate?: { name: string; lang: string; variables?: string[] }
}) {
    const { conversationId, empresaId, to, body, forceTemplate } = args

    // Último entrante (cliente) para validar 24 h
    const lastInbound = await prisma.message.findFirst({
        where: { conversationId, from: MessageFrom.client },
        orderBy: { timestamp: 'desc' }
    })

    const within24h = lastInbound
        ? (Date.now() - new Date(lastInbound.timestamp).getTime()) <= 24 * 60 * 60 * 1000
        : false

    // Fallback 1:1 por empresa
    const oc = await prisma.outboundConfig.findUnique({ where: { empresaId } })
    const fallbackTemplateName = oc?.fallbackTemplateName ?? 'hola'
    const fallbackTemplateLang = oc?.fallbackTemplateLang ?? 'es'

    // Envío
    if (forceTemplate) {
        return await sendTemplate({
            empresaId, to,
            templateName: forceTemplate.name,
            templateLang: forceTemplate.lang,
            variables: forceTemplate.variables || []
        })
    }

    if (within24h && body) {
        return await sendText({ empresaId, to, body })
    }

    return await sendTemplate({
        empresaId, to,
        templateName: fallbackTemplateName,
        templateLang: fallbackTemplateLang
    })
}
