import { Router } from "express";
import { verificarJWT } from "../middleware/auth.middleware";
import {
    // CRUD de citas
    listAppointments,
    createAppointment,
    updateAppointment,
    updateAppointmentStatus,
    deleteAppointment,
    // Config de agenda
    getAppointmentConfig,
    saveAppointmentConfig,
} from "../controllers/appointments.controller";

const router = Router();
router.use(verificarJWT);

/** ===================== CONFIG DE AGENDA ===================== **
 *  GET  /api/appointments/config  -> { config, hours, provider }
 *  POST /api/appointments/config  -> { ok: true }
 */
router.get("/config", getAppointmentConfig);
router.post("/config", saveAppointmentConfig);

/** ===================== CRUD DE CITAS ===================== **
 *  filtros: empresaId (middleware), from, to, sedeId, serviceId, providerId
 */
router.get("/", listAppointments);
router.post("/", createAppointment);
router.put("/:id", updateAppointment);
router.put("/:id/status", updateAppointmentStatus);
router.delete("/:id", deleteAppointment);

export default router;
