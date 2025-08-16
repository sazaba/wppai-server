import axios from 'axios'

const FB_VERSION = 'v20.0'

export type MetaTemplateComponent = {
    type: string
    text?: string
}

export type MetaTemplate = {
    name: string
    language: string
    category: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION' | string
    status: string
    components?: MetaTemplateComponent[]
}

/**
 * Lista plantillas desde Meta (incluye components para extraer el BODY).
 */
export async function listTemplatesFromMeta(wabaId: string, accessToken: string): Promise<MetaTemplate[]> {
    const url = `https://graph.facebook.com/${FB_VERSION}/${wabaId}/message_templates`
    const res = await axios.get(url, {
        params: { fields: 'name,language,category,status,components' },
        headers: { Authorization: `Bearer ${accessToken}` },
    })
    return res.data?.data ?? []
}

/**
 * Crea/publica una plantilla en Meta.
 * language debe ser string simple (ej: 'es', 'es_AR', 'en_US')
 * category: 'UTILITY' | 'MARKETING' | 'AUTHENTICATION'
 */
export async function createTemplateInMeta(
    wabaId: string,
    accessToken: string,
    args: { name: string; language: string; category: string; bodyText: string }
) {
    const url = `https://graph.facebook.com/${FB_VERSION}/${wabaId}/message_templates`
    const payload = {
        name: args.name,
        language: args.language,
        category: args.category,
        components: [{ type: 'BODY', text: args.bodyText }],
    }
    const res = await axios.post(url, payload, {
        headers: { Authorization: `Bearer ${accessToken}` },
    })
    return res.data
}

/**
 * Elimina una plantilla en Meta por name + language.
 */
export async function deleteTemplateInMeta(
    wabaId: string,
    accessToken: string,
    name: string,
    language: string
) {
    const url = `https://graph.facebook.com/${FB_VERSION}/${wabaId}/message_templates`
    const res = await axios.delete(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: { name, language },
    })
    return res.data
}
