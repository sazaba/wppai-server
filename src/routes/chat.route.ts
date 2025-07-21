// src/routes/chat.routes.ts

import express from 'express'
import {
    getConversations,
    getMessagesByConversation,
    postMessageToConversation,
    responderConIA,
    updateConversationEstado,
    cerrarConversacion,
    responderManual
} from '../controllers/chat.controller'

import { verificarJWT } from '../middleware/auth.middleware'

const router = express.Router()

// ✅ Todas las rutas ahora requieren token válido
router.use(verificarJWT)

router.get('/chats', getConversations)
router.get('/chats/:id/messages', getMessagesByConversation)
router.post('/chats/:id/messages', postMessageToConversation)
router.post('/responder', responderConIA)
router.put('/chats/:id/estado', updateConversationEstado)
router.put('/chats/:id/cerrar', cerrarConversacion)
router.post('/chats/:id/responder-manual', responderManual)

export default router
