// src/routes/auth.route.ts
import { Router } from 'express'
import { iniciarOAuthMeta, authCallback, exchangeCode, registrar, login, getWabasAndPhones } from '../controllers/auth.controller'

const router = Router()

// públicas (sin JWT)
router.get('/auth/whatsapp', iniciarOAuthMeta)
router.get('/auth/callback', authCallback)
router.post('/auth/exchange-code', exchangeCode)
router.post('/register', registrar)
router.post('/login', login)

// protegidas (si quieres)
router.get('/wabas', getWabasAndPhones)

export default router
