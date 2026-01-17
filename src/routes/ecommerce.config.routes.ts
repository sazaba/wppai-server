import express from 'express'
import { getEcommerceConfig, updateEcommerceConfig } from '../controllers/ecommerce.config.controller'
import { verificarJWT } from '../middleware/auth.middleware'

const router = express.Router()

// GET: Obtener la configuración (Protegido)
router.get('/config', verificarJWT, getEcommerceConfig)

// POST: Guardar/Actualizar la configuración (Protegido)
router.post('/config', verificarJWT, updateEcommerceConfig)

export default router