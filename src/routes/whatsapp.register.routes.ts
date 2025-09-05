import { Router } from 'express'
import { activarNumero, estadoNumero } from '../controllers/whatsapp.register.controller'
import { verificarJWT } from '../middleware/auth.middleware'

const router = Router()

router.post('/api/whatsapp/activar-numero', verificarJWT, activarNumero)
router.get('/api/whatsapp/numero/:phoneNumberId/estado', verificarJWT, estadoNumero)

export default router
