// src/routes/auth.route.ts
import { Router } from 'express'
import {
    registrar,
    login,
    authCallback,
    exchangeCode,
    getWabasAndPhones
} from '../controllers/auth.controller'

const router = Router()

const META_APP_ID = process.env.META_APP_ID!
const REDIRECT_URI = process.env.META_REDIRECT_URI!

// ====================
// Registro + Login
// ====================
router.post('/register', registrar)
router.post('/login', login)

// ====================
// Iniciar OAuth desde backend
// ====================
router.get('/auth', (req, res) => {
    const scope = [
        'whatsapp_business_messaging',
        'whatsapp_business_management',
        'business_management',
        'public_profile'
    ].join(',') // coma separadas

    const authUrl =
        `https://www.facebook.com/v20.0/dialog/oauth?client_id=${encodeURIComponent(META_APP_ID)}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
        `&scope=${encodeURIComponent(scope)}` +
        `&response_type=code`

    res.redirect(authUrl)
})

// ====================
// Callback del OAuth
// ====================
router.get('/callback', authCallback)

// ====================
// Intercambiar code -> access_token (opcional, si el front lo maneja)
// ====================
router.post('/exchange-code', exchangeCode)

// ====================
// Listar WABAs y teléfonos con fallback
// ====================
router.get('/wabas', getWabasAndPhones)

export default router
