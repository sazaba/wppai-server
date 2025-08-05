import { Router } from 'express'
import { estadoWhatsappAccount, guardarWhatsappAccount, eliminarWhatsappAccount, actualizarDatosWhatsapp } from '../controllers/whatsapp.controller'
import { verificarJWT } from '../middleware/auth.middleware'

const router = Router()

router.post('/vincular', verificarJWT, guardarWhatsappAccount)

router.get('/estado', verificarJWT, estadoWhatsappAccount)

router.delete('/eliminar', verificarJWT, eliminarWhatsappAccount)

router.put('/actualizar-datos', verificarJWT, actualizarDatosWhatsapp)

export default router
