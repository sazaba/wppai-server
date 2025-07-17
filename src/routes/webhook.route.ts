import express from 'express'
import { receiveWhatsappMessage } from '../controllers/webhook.controller'

const router = express.Router()

router.post('/webhooks/whatsapp', receiveWhatsappMessage)

export default router
