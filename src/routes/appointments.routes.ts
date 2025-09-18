// server/src/routes/appointments.routes.ts
import { Router } from "express";
import { verificarJWT } from "../middleware/auth.middleware";
import {
    listAppointments,
    createAppointment,
    updateAppointment,
    getAppointmentConfig,
    saveAppointmentConfig,
    resetAppointments,
} from "../controllers/appointments.controller";

const router = Router();
router.use(verificarJWT);

// Config
router.get("/config", getAppointmentConfig);
router.post("/config", saveAppointmentConfig);
router.post("/reset", resetAppointments);

// CRUD básico
router.get("/", listAppointments);
router.post("/", createAppointment);
router.put("/:id", updateAppointment);

export default router;
