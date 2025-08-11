// src/routes/whatsapp.routes.ts
import { Router } from 'express'
import {
    estadoWhatsappAccount,
    guardarWhatsappAccount,
    eliminarWhatsappAccount,
    actualizarDatosWhatsapp,
    // 👇 nuevas
    registrarNumero,
    enviarPrueba,
    infoNumero
} from '../controllers/whatsapp.controller'
import { verificarJWT } from '../middleware/auth.middleware'

const router = Router()

// ✅ Rutas existentes (no se tocan)
router.post('/vincular', verificarJWT, guardarWhatsappAccount)
router.get('/estado', verificarJWT, estadoWhatsappAccount)
router.delete('/eliminar', verificarJWT, eliminarWhatsappAccount)
router.put('/actualizar-datos', verificarJWT, actualizarDatosWhatsapp)

// ✅ Nuevas rutas Cloud API
// Registrar el número (usa { phoneNumberId, pin? })
router.post('/registrar', verificarJWT, registrarNumero)

// Enviar mensaje de prueba (usa { phoneNumberId, to, body })
router.post('/enviar-prueba', verificarJWT, enviarPrueba)

// Info básica del número (display_phone_number, verified_name, name_status)
router.get('/numero/:phoneNumberId', verificarJWT, infoNumero)

export default router
