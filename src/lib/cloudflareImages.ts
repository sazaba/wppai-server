import axios from 'axios'
import FormData from 'form-data'
import { randomUUID } from 'node:crypto'

const { CF_ACCOUNT_ID, CF_IMAGES_API_TOKEN, CF_IMAGES_ACCOUNT_HASH } = process.env
if (!CF_ACCOUNT_ID || !CF_IMAGES_API_TOKEN || !CF_IMAGES_ACCOUNT_HASH) {
    throw new Error('Faltan CF_ACCOUNT_ID / CF_IMAGES_API_TOKEN / CF_IMAGES_ACCOUNT_HASH')
}

const API = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/images/v1`

// Subir imagen a Cloudflare Images
export async function cfImagesUpload(buffer: Buffer, filename = `${randomUUID()}.jpg`) {
    const form = new FormData()
    form.append('file', buffer, { filename })
    // Si usas variantes firmadas: form.append('requireSignedURLs', 'true')

    const { data } = await axios.post(API, form, {
        headers: { Authorization: `Bearer ${CF_IMAGES_API_TOKEN}`, ...form.getHeaders() },
        maxBodyLength: Infinity,
    })
    if (!data?.success) throw new Error('Cloudflare Images upload failed')
    return data.result as { id: string }
}

// Borrar imagen de Cloudflare Images
export async function cfImagesDelete(imageId: string) {
    const { data } = await axios.delete(`${API}/${imageId}`, {
        headers: { Authorization: `Bearer ${CF_IMAGES_API_TOKEN}` },
    })
    if (!data?.success) throw new Error('Cloudflare Images delete failed')
}

// Obtener URL de entrega (variante o params)
export function cfImageUrl(imageId: string, paramsOrVariant = 'w=640,h=640,fit=cover') {
    return `https://imagedelivery.net/${CF_IMAGES_ACCOUNT_HASH}/${imageId}/${paramsOrVariant}`
}
