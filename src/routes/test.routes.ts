import { Router } from "express";
import {
    crearTest,
    listarTests,
    obtenerTest,
    eliminarTest
} from "../controllers/testModel.controller";

// 👇 CORRECCIÓN: Usamos el nombre real que tienes en tu archivo
import { verificarJWT } from "../middleware/auth.middleware"; 

const router = Router();

// 👇 Agregamos 'verificarJWT' en todas las rutas
router.post("/", verificarJWT, crearTest);
router.get("/", verificarJWT, listarTests);
router.get("/:id", verificarJWT, obtenerTest);
router.delete("/:id", verificarJWT, eliminarTest);

export default router;