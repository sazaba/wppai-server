import express from 'express'
import {
    getConversations,
    getMessagesByConversation,
    postMessageToConversation,
    responderConIA,
    updateConversationEstado,
    cerrarConversacion,
    responderManual,
    crearConversacion
} from '../controllers/chat.controller'

import { verificarJWT } from '../middleware/auth.middleware'
import { checkTrialLimits } from '../middleware/trialLimit.middleware'

const router = express.Router()

router.use(verificarJWT)

// 📌 Rutas que NO cuentan para el límite
router.get('/chats', getConversations)
router.get('/chats/:id/messages', getMessagesByConversation)

// 📌 Rutas que cuentan mensajes enviados
router.post('/chats/:id/messages', checkTrialLimits, postMessageToConversation)
router.post('/responder', checkTrialLimits, responderConIA)
router.post('/chats/:id/responder-manual', checkTrialLimits, responderManual)

// 📌 Crear conversación no incrementa por sí misma, solo los mensajes que envíe
router.post('/chats', crearConversacion)

// 📌 Rutas de actualización de estado
router.put('/chats/:id/estado', updateConversationEstado)
router.put('/chats/:id/cerrar', cerrarConversacion)

export default router
