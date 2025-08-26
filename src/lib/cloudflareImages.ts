import axios from 'axios'
import FormData from 'form-data'
import { randomUUID } from 'node:crypto'

const { CF_ACCOUNT_ID, CF_IMAGES_API_TOKEN, CF_IMAGES_ACCOUNT_HASH } = process.env
if (!CF_ACCOUNT_ID || !CF_IMAGES_API_TOKEN || !CF_IMAGES_ACCOUNT_HASH) {
    throw new Error('Faltan CF_ACCOUNT_ID / CF_IMAGES_API_TOKEN / CF_IMAGES_ACCOUNT_HASH')
}

// Variante por defecto (ponla también en Render)
const CF_IMAGES_VARIANT = process.env.CF_IMAGES_VARIANT || 'public'

const API = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/images/v1`

export async function cfImagesUpload(buffer: Buffer, filename = `${randomUUID()}.jpg`) {
    const form = new FormData()
    form.append('file', buffer, { filename })
    const { data } = await axios.post(API, form, {
        headers: { Authorization: `Bearer ${CF_IMAGES_API_TOKEN}`, ...form.getHeaders() },
        maxBodyLength: Infinity,
    })
    if (!data?.success) throw new Error('Cloudflare Images upload failed')
    return data.result as { id: string }
}

export async function cfImagesDelete(imageId: string) {
    const { data } = await axios.delete(`${API}/${imageId}`, {
        headers: { Authorization: `Bearer ${CF_IMAGES_API_TOKEN}` },
    })
    if (!data?.success) throw new Error('Cloudflare Images delete failed')
}

// 👉 siempre devuelve con VARIANTE nombrada
export function cfImageUrl(imageId: string, variant = CF_IMAGES_VARIANT) {
    return `https://imagedelivery.net/${CF_IMAGES_ACCOUNT_HASH}/${imageId}/${variant}`
}
