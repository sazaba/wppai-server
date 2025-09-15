import { Router } from "express";
import { verificarJWT } from '../middleware/auth.middleware'

import { listSedes, createSede, updateSede } from "../controllers/sedes.controller";

const router = Router();
router.use(verificarJWT);

router.get("/", listSedes);
router.post("/", createSede);
router.put("/:id", updateSede);

export default router;
