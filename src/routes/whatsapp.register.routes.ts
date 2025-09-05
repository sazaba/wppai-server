// src/routes/whatsapp.register.routes.ts
import { Router } from 'express'
import { verificarJWT } from '../middleware/auth.middleware'
import {
    activarNumero,
    estadoNumero,
    listarTelefonosDeWaba,
    setTwoStepPin,
    requestVerificationCode,
    verifyCode,
} from '../controllers/whatsapp.register.controller'

const router = Router()

router.post('/whatsapp/activar-numero', verificarJWT, activarNumero)
router.get('/whatsapp/numero/:phoneNumberId/estado', verificarJWT, estadoNumero)
router.get('/whatsapp/waba/:wabaId/phones', verificarJWT, listarTelefonosDeWaba)

router.post('/whatsapp/numero/:phoneNumberId/two-step', verificarJWT, setTwoStepPin)

// (Opcional) flujo request/verify code clásico
router.post('/whatsapp/numero/:phoneNumberId/request-code', verificarJWT, requestVerificationCode)
router.post('/whatsapp/numero/:phoneNumberId/verify-code', verificarJWT, verifyCode)

export default router
