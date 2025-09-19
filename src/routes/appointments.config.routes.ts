// server/src/routes/appointments.config.routes.ts
import { Router } from "express";
import { verificarJWT } from "../middleware/auth.middleware";
import {
    getAppointmentConfig,
    saveAppointmentConfig,
    patchAppointmentConfig,
    deleteAppointmentConfig,
    resetAppointments,
} from "../controllers/appointments.config.controller";

const router = Router();
router.use(verificarJWT);

// 👇 OJO: estas rutas ahora cuelgan de /api/appointments/config (ver index.ts)
router.get("/", getAppointmentConfig);        // GET /api/appointments/config
router.post("/", saveAppointmentConfig);      // POST /api/appointments/config (upsert)
router.patch("/", patchAppointmentConfig);    // PATCH /api/appointments/config (parcial)
router.delete("/", deleteAppointmentConfig);  // DELETE /api/appointments/config
router.post("/reset", resetAppointments);     // POST /api/appointments/config/reset

export default router;
