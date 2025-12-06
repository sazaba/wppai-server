import { Router } from "express";
import {
    crearTest,
    listarTests,
    obtenerTest,
    eliminarTest
} from "../controllers/testModel.controller";

// 👇 1. IMPORTA TU MIDDLEWARE DE AUTH
// (Revisa si tu archivo se llama auth.middleware.ts o similar)
import { verificarJWT } from '../middleware/auth.middleware'
const router = Router();

// 👇 2. AGREGA EL MIDDLEWARE ANTES DE LOS CONTROLADORES
// Esto asegura que req.user exista cuando llegue al controlador
router.post("/", verificarJWT , crearTest);
router.get("/", verificarJWT , listarTests);
router.get("/:id", verificarJWT , obtenerTest);
router.delete("/:id", verificarJWT , eliminarTest);

export default router;