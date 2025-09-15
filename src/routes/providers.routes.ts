import { Router } from "express";
import { verificarJWT } from '../middleware/auth.middleware'
import { listProviders, createProvider, updateProvider } from "../controllers/providers.controller";

const router = Router();
router.use(verificarJWT);

router.get("/", listProviders);
router.post("/", createProvider);
router.put("/:id", updateProvider);

export default router;
