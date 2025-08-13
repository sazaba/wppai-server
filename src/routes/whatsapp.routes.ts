// src/routes/whatsapp.routes.ts
import { Router } from 'express'
import { verificarJWT } from '../middleware/auth.middleware'
import {
    // existentes
    estadoWhatsappAccount,

    eliminarWhatsappAccount,

    // cloud api

    enviarPrueba,
    infoNumero,

    // utilidades

    debugToken,
    health,

} from '../controllers/whatsapp.controller'

const router = Router()

/* ===== Existentes ===== */

router.get('/estado', verificarJWT, estadoWhatsappAccount)
router.delete('/eliminar', verificarJWT, eliminarWhatsappAccount)

// 👉 Acepta POST (para el callback) y mantiene PUT por retrocompatibilidad


/* ===== Cloud API ===== */


// Enviar mensaje de texto de prueba (dentro de 24h o si ya hay sesión)
router.post('/enviar-prueba', verificarJWT, enviarPrueba)

// Info básica del número
router.get('/numero/:phoneNumberId', verificarJWT, infoNumero)



/* ===== Utilidades ===== */


// Depurar token guardado en BD con {APP_ID}|{APP_SECRET}
router.get('/debug-token', verificarJWT, debugToken)



// Health check rápido (token length, presencia de phoneNumberId)
router.get('/health', verificarJWT, health)

export default router
