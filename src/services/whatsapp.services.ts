import axios from 'axios'
import prisma from '../lib/prisma'

const FB_VERSION = 'v20.0'

type SendTextArgs = { empresaId: number; to: string; body: string }
type SendTemplateArgs = {
    empresaId: number
    to: string
    templateName: string
    templateLang: string
    variables?: string[]
}

export type OutboundResult = {
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

/** Queda disponible por si la usas más adelante; NO se usa ahora */
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
 * Envío simplificado: siempre intenta TEXTO y deja que Meta valide la ventana de 24h.
 * (Si está fuera, Meta responderá error de política; el controller lo manejará)
 */
export async function sendOutboundMessage(args: {
    conversationId: number // mantenemos la firma por compatibilidad (no se usa aquí)
    empresaId: number
    to: string
    body: string
}): Promise<OutboundResult> {
    const { empresaId, to, body } = args
    if (!body?.trim()) {
        const err: any = new Error('EMPTY_BODY')
        err.status = 400
        throw err
    }
    return sendText({ empresaId, to, body })
}
//         const msg = value.messages[0]