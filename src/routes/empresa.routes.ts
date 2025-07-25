import express from 'express'
import { getEmpresa } from '../controllers/empresa.controller'
import { verificarJWT } from '../middleware/auth.middleware'

const router = express.Router()

// 🛡️ Protegido por JWT
router.get('/empresa', verificarJWT, getEmpresa)

export default router
