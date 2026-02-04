// src/routes/auth.route.ts
import { Router } from 'express'
import {
    registrar,
    login,
    activarCuenta,
    solicitarRecuperacion, // <--- NUEVO
    resetearPassword,      // <--- NUEVO
    authCallback,
    exchangeCode,
    getWabasAndPhones,
    iniciarOAuthMeta
} from '../controllers/auth.controller'

const router = Router()

// Públicas
router.post('/register', registrar)
router.post('/login', login)
router.post('/activate', activarCuenta)

// Recuperación de contraseña
router.post('/forgot-password', solicitarRecuperacion)
router.post('/reset-password', resetearPassword)

// OAuth públicas
router.get('/whatsapp', iniciarOAuthMeta)   // → /api/auth/whatsapp
router.get('/callback', authCallback)       // → /api/auth/callback
router.post('/exchange-code', exchangeCode) // → /api/auth/exchange-code

// (Puedes dejar /wabas público mientras pruebas)
router.get('/wabas', getWabasAndPhones)     // → /api/auth/wabas

export default router