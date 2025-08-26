import express from 'express'
import axios from 'axios'
import crypto from 'node:crypto'
import { getWhatsappCreds } from '../services/whatsapp.services'

const router = express.Router()

// Ajusta por .env
const WINDOW_MS = Number(process.env.MEDIA_PROXY_TTL_MS || 2 * 60 * 1000) // 2 min
const SECRET = process.env.MEDIA_PROXY_SECRET || 'change-me' // ⚠️ pon algo fuerte en .env

/* ============= Firma HMAC ============= */
function sign(mediaId: string, empresaId: number, exp: number) {
    return crypto.createHmac('sha256', SECRET).update(`${mediaId}.${empresaId}.${exp}`).digest('hex')
}
function safeEqual(a: string, b: string) {
    const ba = Buffer.from(a)
    const bb = Buffer.from(b)
    if (ba.length !== bb.length) return false
    return crypto.timingSafeEqual(ba, bb)
}

/* ============= Ruta pública temporal ============= */
/**
 * GET /api/media/proxy/:mediaId?empresaId=123&exp=...&sig=...
 * Streamea el binario desde WhatsApp Graph → respuesta pública temporal
 */
router.get('/api/media/proxy/:mediaId', async (req, res) => {
    try {
        const { mediaId } = req.params
        const exp = Number(req.query.exp || 0)
        const sig = String(req.query.sig || '')
        const empresaId = Number(req.query.empresaId || 0)

        if (!mediaId || !exp || !sig || !empresaId) {
            return res.status(400).send('Missing params')
        }
        if (Date.now() > exp) return res.status(403).send('URL expired')

        const expected = sign(mediaId, empresaId, exp)
        if (!safeEqual(sig, expected)) return res.status(403).send('Bad signature')

        // Trae credenciales de ESA empresa
        const { accessToken } = await getWhatsappCreds(empresaId)

        // 1) Pide a Graph el URL de descarga
        const meta = await axios.get(`https://graph.facebook.com/v20.0/${mediaId}`, {
            headers: { Authorization: `Bearer ${accessToken}` },
            timeout: 10000,
        })
        const fileUrl = meta.data?.url
        if (!fileUrl) return res.status(404).send('Media not found')

        // 2) Descarga y retransmite el binario
        const file = await axios.get(fileUrl, {
            headers: { Authorization: `Bearer ${accessToken}` },
            responseType: 'stream',
            timeout: 20000,
        })

        // (Opcional) valida MIME permitido
        const ct = String(file.headers['content-type'] || '')
        const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/heic']
        if (!allowed.some(a => ct.includes(a))) {
            return res.status(415).send('Unsupported media type')
        }

        if (file.headers['content-type']) res.setHeader('Content-Type', file.headers['content-type'])
        if (file.headers['content-length']) res.setHeader('Content-Length', file.headers['content-length'])
        res.setHeader('Cache-Control', 'no-store')
        res.setHeader('Content-Disposition', 'inline')

        file.data.pipe(res)
    } catch (err: any) {
        console.error('[media-proxy]', err?.response?.data || err?.message || err)
        res.status(500).send('Proxy error')
    }
})

/* ============= Helpers para construir URLs firmadas ============= */
export function buildSignedMediaPath(mediaId: string, empresaId: number) {
    const exp = Date.now() + WINDOW_MS
    const sig = sign(mediaId, empresaId, exp)
    const pId = encodeURIComponent(mediaId)
    return `/api/media/proxy/${pId}?empresaId=${empresaId}&exp=${exp}&sig=${sig}`
}

export function buildSignedMediaURL(mediaId: string, empresaId: number) {
    const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '') // ej: https://miapp.com
    const path = buildSignedMediaPath(mediaId, empresaId)
    return `${base}${path}`
}

export default router
