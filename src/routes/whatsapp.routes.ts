// src/routes/whatsapp.routes.ts
import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { verificarJWT } from '../middleware/auth.middleware'

import {
    // conexión
    vincular,
    // existentes
    estadoWhatsappAccount,
    eliminarWhatsappAccount,
    // cloud api
    enviarPrueba,
    enviarMedia,              // por LINK (image|video|audio|document)
    infoNumero,
    // upload -> /media -> enviar por id
    enviarMediaUpload,        // ⬅️ NUEVO
    // utilidades
    debugToken,
    health,
    // stream de media por mediaId
    streamMediaById,
} from '../controllers/whatsapp.controller'

const router = Router()

/**
 * IMPORTANTE:
 * Montar en app.ts:
 *   app.use('/api/whatsapp', whatsappRoutes)
 */

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

// Tipos permitidos por WhatsApp (comunes)
const ALLOWED_MIME = new Set([
    'image/jpeg', 'image/png', 'image/webp',
    'video/mp4', 'video/quicktime',
    'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/amr', 'audio/wav',
    'application/pdf',
])

const upload = multer({
    storage,
    limits: { fileSize: 16 * 1024 * 1024 }, // ~16 MB
    fileFilter: (_req, file, cb) => {
        if (ALLOWED_MIME.has(file.mimetype)) return cb(null, true)
        cb(new Error('Tipo de archivo no permitido para WhatsApp'))
    },
})

/* ===== Conexión (guardar selección) ===== */
router.post('/vincular', verificarJWT, vincular)

/* ===== Estado / Eliminar cuenta ===== */
router.get('/estado', verificarJWT, estadoWhatsappAccount)
router.delete('/eliminar', verificarJWT, eliminarWhatsappAccount)

/* ===== Cloud API ===== */
// Texto
router.post('/enviar-prueba', verificarJWT, enviarPrueba)
// Media por LINK
router.post('/media', verificarJWT, enviarMedia)
// Media por archivo (sube a /media → envia por id)
router.post('/media-upload', verificarJWT, upload.single('file'), enviarMediaUpload)
// Info del número conectado
router.get('/numero/:phoneNumberId', verificarJWT, infoNumero)
// Stream seguro de media por mediaId (para reproducir en el front)
router.get('/media/:mediaId', verificarJWT, streamMediaById)

/* ===== Utilidades ===== */
router.get('/debug-token', verificarJWT, debugToken)
router.get('/health', verificarJWT, health)

export default router
