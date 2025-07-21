// src/routes/webhook.route.ts
import express from 'express'
import { receiveWhatsappMessage, verifyWebhook } from '../controllers/webhook.controller'

const router = express.Router()

// Endpoint que Meta usará para enviar mensajes entrantes
router.post('/webhooks/whatsapp', receiveWhatsappMessage)

// Endpoint de verificación del webhook (paso obligatorio para validar en Meta)
router.get('/webhooks/whatsapp', verifyWebhook)

export default router