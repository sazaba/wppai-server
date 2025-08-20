// src/routes/whatsapp.routes.ts
import { Router, Request, Response, NextFunction } from 'express'

import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { verificarJWT } from '../middleware/auth.middleware'
import {
    vincular,
    estadoWhatsappAccount,
    eliminarWhatsappAccount,
    enviarPrueba,
    enviarMedia,
    infoNumero,
    enviarMediaUpload,
    debugToken,
    health,
    streamMediaById,
} from '../controllers/whatsapp.controller'

const router = Router()

// --- Helper: permite token corto en ?t= SOLO para /media,
//     o pasa a verificarJWT para el resto. No valida aquí el JWT;
//     lo valida el controlador (y también lo soporta verificarJWT).
function authOrSignedToken(req: Request, res: Response, next: NextFunction) {
    if (req.method === 'OPTIONS') return res.sendStatus(204)
    const t = req.query?.t
    if (typeof t === 'string' && t.length > 0) {
        return next()
    }
    return verificarJWT(req, res, next)
}

/* ===== Públicas de diagnóstico ===== */
router.get('/ping', (_req, res) => res.json({ ok: true, from: 'whatsapp.routes', ping: 'pong' }))
router.get('/health-public', (_req, res) => res.json({ ok: true, msg: 'health (public) online' }))

/* ===== Multer (subidas locales temporales) ===== */
const uploadDir = path.join(process.cwd(), 'uploads')
fs.mkdirSync(uploadDir, { recursive: true })

const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname) || ''
        const name = `${file.fieldname}-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`
        cb(null, name)
    },
})

const ALLOWED_MIME = new Set([
    'image/jpeg', 'image/png', 'image/webp',
    'video/mp4', 'video/quicktime',
    'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/amr', 'audio/wav',
    'application/pdf',
])

const upload = multer({
    storage,
    limits: { fileSize: 16 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        if (ALLOWED_MIME.has(file.mimetype)) return cb(null, true)
        cb(new Error('Tipo de archivo no permitido para WhatsApp'))
    },
})

/* ===== Conexión / Estado ===== */
router.post('/vincular', verificarJWT, vincular)
router.get('/estado', verificarJWT, estadoWhatsappAccount)
router.delete('/eliminar', verificarJWT, eliminarWhatsappAccount)

/* ===== Cloud API ===== */
router.post('/enviar-prueba', verificarJWT, enviarPrueba)
router.post('/media', verificarJWT, enviarMedia)
router.post('/media-upload', verificarJWT, upload.single('file'), enviarMediaUpload)
router.get('/numero/:phoneNumberId', verificarJWT, infoNumero)

/* ===== Stream de media (GET desde <img>/<video>) =====
   - Acepta ?t=JWT corto (sin header) o Authorization normal
*/
router.get('/media/:mediaId', streamMediaById)

/* ===== Utilidades ===== */
router.get('/debug-token', verificarJWT, debugToken)
router.get('/health', verificarJWT, health)

export default router
