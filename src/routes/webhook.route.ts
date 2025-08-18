// src/routes/webhook.route.ts
import { Router } from 'express'

import { receiveWhatsappMessage, verifyWebhook } from '../controllers/webhook.controller'

const router = Router()

// GET para verificación de Meta (hub.challenge)
router.get('/', verifyWebhook)

// POST para recibir eventos (messages, statuses)
router.post('/', receiveWhatsappMessage)

export default router
