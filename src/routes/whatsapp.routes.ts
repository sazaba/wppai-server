// src/routes/whatsapp.routes.ts
import { Router } from 'express'
import { verificarJWT } from '../middleware/auth.middleware'
import {
    // existentes
    estadoWhatsappAccount,
    guardarWhatsappAccount,
    eliminarWhatsappAccount,
    actualizarDatosWhatsapp,
    // cloud api
    registrarNumero,
    enviarPrueba,
    infoNumero,
    vincularManual,
    // nuevas utilidades
    requestCode,
    verifyCode,
    debugToken,
    health,
} from '../controllers/whatsapp.controller'

const router = Router()

/* ===== Existentes ===== */
router.post('/vincular', verificarJWT, guardarWhatsappAccount)
router.get('/estado', verificarJWT, estadoWhatsappAccount)
router.delete('/eliminar', verificarJWT, eliminarWhatsappAccount)
router.put('/actualizar-datos', verificarJWT, actualizarDatosWhatsapp)

/* ===== Cloud API ===== */
// Registrar número (si PIN habilitado, incluir { pin })
router.post('/registrar', verificarJWT, registrarNumero)

// Enviar mensaje de texto de prueba (dentro de 24h o si ya hay sesión)
router.post('/enviar-prueba', verificarJWT, enviarPrueba)

// Info básica del número
router.get('/numero/:phoneNumberId', verificarJWT, infoNumero)

// Vincular datos manualmente (token + ids)
router.post('/vincular-manual', verificarJWT, vincularManual)

/* ===== Utilidades ===== */
// Solicitar código de verificación (SMS/VOICE)
router.post('/request-code', verificarJWT, requestCode)

// Verificar el código recibido
router.post('/verify-code', verificarJWT, verifyCode)

// Depurar token con {APP_ID}|{APP_SECRET}
router.get('/debug-token', verificarJWT, debugToken)

// Health check rápido (token length, presencia de phoneNumberId)
router.get('/health', verificarJWT, health)

export default router
