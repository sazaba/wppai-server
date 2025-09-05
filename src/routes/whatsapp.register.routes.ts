// src/routes/whatsapp.register.routes.ts
import { Router } from 'express'
import { verificarJWT } from '../middleware/auth.middleware'
import { activarNumero, estadoNumero, listarTelefonosDeWaba } from '../controllers/whatsapp.register.controller'

const router = Router()

router.post('/whatsapp/activar-numero', verificarJWT, activarNumero)
router.get('/whatsapp/numero/:phoneNumberId/estado', verificarJWT, estadoNumero)
router.get('/whatsapp/waba/:wabaId/phones', verificarJWT, listarTelefonosDeWaba)

export default router
