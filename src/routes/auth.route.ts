// src/routes/auth.route.ts
import { Router } from 'express'
import { registrar, login, /* authCallback, */ exchangeCode } from '../controllers/auth.controller'

const router = Router()

const META_APP_ID = process.env.META_APP_ID!
const REDIRECT_URI = process.env.META_REDIRECT_URI!

// Registro + login
router.post('/register', registrar)
router.post('/login', login)

// Iniciar OAuth desde backend (opcional; usa este o el del frontend, no ambos)
router.get('/auth', (req, res) => {
    const scope = [
        'whatsapp_business_messaging',
        'whatsapp_business_management',
        'business_management',
        'public_profile'
    ].join(',') // ← coma separadas (recomendado por Meta)

    const authUrl =
        `https://www.facebook.com/v20.0/dialog/oauth?client_id=${encodeURIComponent(META_APP_ID)}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
        `&scope=${encodeURIComponent(scope)}` +
        `&response_type=code`

    res.redirect(authUrl)
})

// Callback del OAuth (NO usar en flujo de frontend callback)
// router.get('/callback', authCallback)

router.post('/exchange-code', exchangeCode)

export default router
