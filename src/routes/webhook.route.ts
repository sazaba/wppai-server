// src/routes/webhook.route.ts
import express from 'express'
import { receiveWhatsappMessage, verifyWebhook } from '../controllers/webhook.controller'

const router = express.Router()

// webhook.route.ts
router.get('/webhook', verifyWebhook)
router.post('/webhook', receiveWhatsappMessage)


export default router