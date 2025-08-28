// server/src/routes/config.routes.ts
import { Router } from "express"
import { verificarJWT } from "../middleware/auth.middleware"
import {
    getConfig,
    upsertConfig,
    getAllConfigs,
    deleteConfig,
    resetConfig,
} from "../controllers/config.controller"

const r = Router()

// Proteger todo
r.use(verificarJWT)

/**
 * Base URL montada: /api/config
 */
r.get("/", getConfig)            // GET    /api/config
r.put("/", upsertConfig)         // PUT    /api/config
r.get("/all", getAllConfigs)     // GET    /api/config/all

// ✅ Más claro: reset como POST explícito (antes tenías DELETE "/")
r.post("/reset", resetConfig)    // POST   /api/config/reset?withCatalog=1

// Borrar una versión puntual por id (si usas histórico)
r.delete("/:id", deleteConfig)   // DELETE /api/config/:id

export default r
