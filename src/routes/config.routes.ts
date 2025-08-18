// src/routes/config.routes.ts

import express from 'express'

import {
    saveConfig,
    getAllConfigs,
    updateConfig,
    deleteConfig
} from '../controllers/config.controller'
import { verificarJWT } from '../middleware/auth.middleware'

const router = express.Router()

// 🔐 Todas las rutas protegidas con JWT
router.use(verificarJWT)

router.post('/', saveConfig)
router.get('/', getAllConfigs)
router.put('/:id', updateConfig)
router.delete('/:id', deleteConfig)

export default router
