// server/src/routes/config.routes.ts
import { Router } from "express"
import { verificarJWT } from "../middleware/auth.middleware"
import {
    getConfig,
    upsertConfig,
    upsertAgentConfig,   // ⬅️ nuevo import
    getAllConfigs,
    deleteConfig,
    resetConfig,
    resetConfigDelete,

} from "../controllers/config.controller"

const r = Router()
r.use(verificarJWT)

r.get("/", getConfig)
r.put("/", upsertConfig)
r.put("/agent", upsertAgentConfig)   // ⬅️ NUEVO ENDPOINT
r.get("/all", getAllConfigs)
r.post("/reset", resetConfig)
r.delete("/", resetConfigDelete)
r.delete("/:id", deleteConfig)


export default r
