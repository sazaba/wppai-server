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
    // ⬅️ NUEVO: stream de media por mediaId
    streamMediaById,
} from '../controllers/whatsapp.controller'

const router = Router()

/**
 * IMPORTANTE:
 * Montar así en app.ts:
 *   app.use('/api/whatsapp', whatsappRoutes)
 */

/* ===== Públicas para diagnóstico rápido ===== */
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
    limits: {
        // WhatsApp suele aceptar hasta ~16 MB por media
        fileSize: 16 * 1024 * 1024,
    },
    fileFilter: (_req, file, cb) => {
        if (ALLOWED_MIME.has(file.mimetype)) return cb(null, true)
        cb(new Error('Tipo de archivo no permitido para WhatsApp'))
    },
})

/* ===== Conexión (callback → guardar selección) ===== */
// POST /api/whatsapp/vincular
router.post('/vincular', verificarJWT, vincular)

/* ===== Existentes ===== */
// GET    /api/whatsapp/estado
router.get('/estado', verificarJWT, estadoWhatsappAccount)
// DELETE /api/whatsapp/eliminar
router.delete('/eliminar', verificarJWT, eliminarWhatsappAccount)

/* ===== Cloud API ===== */
// POST   /api/whatsapp/enviar-prueba (texto)
router.post('/enviar-prueba', verificarJWT, enviarPrueba)
// POST   /api/whatsapp/media (por LINK)
router.post('/media', verificarJWT, enviarMedia)
// POST   /api/whatsapp/media-upload (por ARCHIVO -> /media -> enviar por id)
router.post('/media-upload', verificarJWT, upload.single('file'), enviarMediaUpload)
// GET    /api/whatsapp/numero/:phoneNumberId
router.get('/numero/:phoneNumberId', verificarJWT, infoNumero)
// ⬅️ NUEVO: GET /api/whatsapp/media/:mediaId (proxy seguro para reproducir en el front)
router.get('/media/:mediaId', verificarJWT, streamMediaById)

/* ===== Utilidades ===== */
// GET    /api/whatsapp/debug-token
router.get('/debug-token', verificarJWT, debugToken)
// GET    /api/whatsapp/health
router.get('/health', verificarJWT, health)

export default router
