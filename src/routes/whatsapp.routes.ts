import { Router } from 'express'
import { estadoWhatsappAccount, guardarWhatsappAccount, eliminarWhatsappAccount } from '../controllers/whatsapp.controller'
import { verificarJWT } from '../middleware/auth.middleware'

const router = Router()

router.post('/vincular', verificarJWT, guardarWhatsappAccount)

router.get('/estado', verificarJWT, estadoWhatsappAccount)

router.delete('/eliminar', verificarJWT, eliminarWhatsappAccount)


export default router
