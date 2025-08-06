import express from 'express'
import { cambiarPlan, getEmpresa } from '../controllers/empresa.controller'
import { verificarJWT } from '../middleware/auth.middleware'

const router = express.Router()

// 🛡️ Protegido por JWT
router.get('/empresa', verificarJWT, getEmpresa)

// 🔹 Actualizar plan (gratis ↔ pro)
router.put('/empresa/plan', verificarJWT, cambiarPlan)

export default router
