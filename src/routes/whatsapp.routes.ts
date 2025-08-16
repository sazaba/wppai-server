import { Router } from 'express'
import { verificarJWT } from '../middleware/auth.middleware'
import {
    // conexión
    vincular,
    // existentes
    estadoWhatsappAccount,
    eliminarWhatsappAccount,
    // cloud api
    enviarPrueba,
    enviarMedia,        // ⬅️ NUEVO
    infoNumero,
    // utilidades
    debugToken,
    health,
} from '../controllers/whatsapp.controller'

const router = Router()

/**
 * IMPORTANTE:
 * Este router debe montarse así:
 *   app.use('/api/whatsapp', whatsappRoutes)
 * para que las rutas queden /api/whatsapp/...
 */

/* ===== Públicas para diagnóstico rápido ===== */
router.get('/ping', (_req, res) => res.json({ ok: true, from: 'whatsapp.routes', ping: 'pong' }))
router.get('/health-public', (_req, res) => res.json({ ok: true, msg: 'health (public) online' }))

/* ===== Conexión (callback → guardar selección) ===== */
// POST /api/whatsapp/vincular
router.post('/vincular', verificarJWT, vincular)

/* ===== Existentes ===== */
// GET    /api/whatsapp/estado
router.get('/estado', verificarJWT, estadoWhatsappAccount)
// DELETE /api/whatsapp/eliminar
router.delete('/eliminar', verificarJWT, eliminarWhatsappAccount)

/* ===== Cloud API ===== */
// POST   /api/whatsapp/enviar-prueba
router.post('/enviar-prueba', verificarJWT, enviarPrueba)
// POST   /api/whatsapp/media   ⬅️ NUEVO
router.post('/media', verificarJWT, enviarMedia)
// GET    /api/whatsapp/numero/:phoneNumberId
router.get('/numero/:phoneNumberId', verificarJWT, infoNumero)

/* ===== Utilidades ===== */
// GET    /api/whatsapp/debug-token
router.get('/debug-token', verificarJWT, debugToken)
// GET    /api/whatsapp/health
router.get('/health', verificarJWT, health)

export default router
