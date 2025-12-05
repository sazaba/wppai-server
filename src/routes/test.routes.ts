import { Router } from "express";
import {
    crearTest,
    listarTests,
    obtenerTest,
    eliminarTest
} from "../controllers/testModel.controller";

const router = Router();

router.post("/", crearTest);
router.get("/", listarTests);
router.get("/:id", obtenerTest);
router.delete("/:id", eliminarTest);

export default router;
