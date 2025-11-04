import { Router } from 'express'
import { verificarJWT } from '../middleware/auth.middleware'
import { checkTrialLimits } from '../middleware/trialLimit.middleware'

// Importa TODO como objeto y desestructura (evita undefined por default/named)
import * as ChatCtrl from '../controllers/chat.controller'

const {
    getConversations,
    getMessagesByConversation,
    postMessageToConversation,
    responderConIA,
    updateConversationEstado,
    cerrarConversacion,
    reabrirConversacion,     // 🆕
    responderManual,
    crearConversacion,
    eliminarConversacion,
    iniciarChat,
} = ChatCtrl

const router = Router()

// JWT para todo
router.use(verificarJWT)

// 📌 NO cuentan para el límite
router.get('/chats', getConversations)
router.get('/chats/:id/messages', getMessagesByConversation)

// 📌 Cuentan envío
router.post('/chats/:id/messages', checkTrialLimits, postMessageToConversation)
router.post('/responder', checkTrialLimits, responderConIA)
router.post('/chats/:id/responder-manual', checkTrialLimits, responderManual)

// 📌 Crear conversación (no cuenta)
router.post('/chats', crearConversacion)
router.delete('/chats/:id', eliminarConversacion)

// 📌 Iniciar fuera de 24h con plantilla (si lo usas)
if (iniciarChat) {
    router.post('/chats/iniciar', iniciarChat)
}

// 📌 Estados
router.put('/chats/:id/estado', updateConversationEstado)
router.put('/chats/:id/cerrar', cerrarConversacion)
router.put('/chats/:id/reabrir', reabrirConversacion) // 🆕

export default router
