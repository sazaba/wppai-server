import { Router } from "express"
import { verificarJWT } from "../middleware/auth.middleware"
import { getConfig, upsertConfig, getAllConfigs, deleteConfig } from "../controllers/config.controller"

const r = Router()

// Protege todo el grupo
r.use(verificarJWT)

// OJO: rutas relativas (sin /api/config)
r.get("/", getConfig)          // GET    /api/config
r.put("/", upsertConfig)       // PUT    /api/config
r.get("/all", getAllConfigs)   // GET    /api/config/all
r.delete("/:id", deleteConfig) // DELETE /api/config/:id

export default r
