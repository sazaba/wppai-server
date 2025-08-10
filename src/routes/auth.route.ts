// src/routes/auth.route.ts

import { Router } from 'express'
import { registrar, login, authCallback, exchangeCode } from '../controllers/auth.controller'

const router = Router()

const META_APP_ID = process.env.META_APP_ID!
const REDIRECT_URI = process.env.META_REDIRECT_URI!

// 🔐 Registro de empresa + usuario admin
router.post('/register', registrar)

// 🔑 Login de usuarios (valida empresa activa)
router.post('/login', login)

// 🌐 Inicia el flujo de autenticación con Meta
router.get('/auth', (req, res) => {
    const scope =
        'whatsapp_business_messaging whatsapp_business_management business_management pages_messaging'

    const authUrl = `https://www.facebook.com/v20.0/dialog/oauth?client_id=${META_APP_ID}&redirect_uri=${REDIRECT_URI}&scope=${scope}&response_type=code`

    res.redirect(authUrl)
})

// ✅ Callback del OAuth de Meta
router.post('/callback', authCallback)

router.post('/exchange-code', exchangeCode)


export default router
