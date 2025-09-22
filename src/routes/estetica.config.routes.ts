import { Router } from "express";
import { verificarJWT } from "../middleware/auth.middleware";
import {
    getEsteticaConfig,
    saveEsteticaConfig,
    patchEsteticaConfig,
    deleteEsteticaConfig,
    resetEsteticaConfig,
} from "../controllers/estetica.config.controller";

const router = Router();
router.use(verificarJWT);

// Log de entrada
router.use((req, _res, next) => {
    console.log("[estetica.config]", req.method, req.originalUrl);
    next();
});

// 👇 cuelga de /api/estetica/config (ver index.ts)
router.get("/", getEsteticaConfig);            // GET /api/estetica/config
router.post("/", saveEsteticaConfig);          // POST /api/estetica/config (upsert)
router.patch("/", patchEsteticaConfig);        // PATCH /api/estetica/config (parcial)
router.delete("/", deleteEsteticaConfig);      // DELETE /api/estetica/config
router.post("/reset", resetEsteticaConfig);    // POST /api/estetica/config/reset

export default router;
