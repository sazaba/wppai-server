import { Router } from "express";
import { verificarJWT } from '../middleware/auth.middleware'

import { listServices, createService, updateService } from "../controllers/services.controller";

const router = Router();
router.use(verificarJWT);

router.get("/", listServices);
router.post("/", createService);
router.put("/:id", updateService);

export default router;
