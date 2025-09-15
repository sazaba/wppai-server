import { Router } from "express";
import { verificarJWT } from '../middleware/auth.middleware'
import {
    listAppointments,
    createAppointment,
    updateAppointment,
    updateAppointmentStatus,
    deleteAppointment,
} from "../controllers/appointments.controller";

const router = Router();
router.use(verificarJWT);

// filtros: empresaId (middleware), from, to, sedeId, serviceId, providerId
router.get("/", listAppointments);
router.post("/", createAppointment);
router.put("/:id", updateAppointment);
router.put("/:id/status", updateAppointmentStatus);
router.delete("/:id", deleteAppointment);

export default router;
