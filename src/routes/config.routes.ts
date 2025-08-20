
// src/routes/config.routes.ts
import { Router } from "express"
import { verificarJWT } from '../middleware/auth.middleware'
import { getConfig, upsertConfig, getAllConfigs, deleteConfig } from "../controllers/config.controller"

const router = Router()

router.get("/api/config", verificarJWT, getConfig)
router.put("/api/config", verificarJWT, upsertConfig)         // 👈 sin :id (match con tu frontend)
router.get("/api/config/all", verificarJWT, getAllConfigs)
router.delete("/api/config/:id", verificarJWT, deleteConfig)

export default router
