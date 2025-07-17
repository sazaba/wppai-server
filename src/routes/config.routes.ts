// src/routes/config.routes.ts
import express from "express"
import { saveConfig, getAllConfigs, updateConfig, deleteConfig } from "../controllers/config.controller"

const router = express.Router()

router.post("/", saveConfig)
router.get("/", getAllConfigs)
router.put("/:id", updateConfig)
router.delete("/:id", deleteConfig)



export default router
