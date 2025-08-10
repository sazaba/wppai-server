// src/routes/auth.route.ts
import { Router } from 'express'
import {
    registrar,
    login,
    authCallback,
    exchangeCode,
    getWabasAndPhones,
    iniciarOAuthMeta
} from '../controllers/auth.controller'

const router = Router()

// ====================
// Registro + Login
// ====================
router.post('/register', registrar)
router.post('/login', login)

// ====================
// OAuth Meta
// ====================

// 1️⃣ Iniciar flujo OAuth (desde backend)
router.get('/auth', iniciarOAuthMeta)

// 2️⃣ Callback de OAuth → obtiene code y lo intercambia por token
router.get('/callback', authCallback)

// 3️⃣ Intercambiar code → access_token (opcional si se maneja en frontend)
router.post('/exchange-code', exchangeCode)

// ====================
// WABAs y teléfonos
// ====================

// 4️⃣ Listar WABAs y teléfonos con fallback
router.get('/wabas', getWabasAndPhones)

export default router
