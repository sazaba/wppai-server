import { Router } from "express";
import { verificarJWT } from "../middleware/auth.middleware";
import {
    listAppointments,
    createAppointment,
    updateAppointment,
    getAppointmentConfig,
    saveAppointmentConfig,
    resetAppointments,
    // NUEVOS
    listReminderRules,
    upsertReminderRule,
    triggerReminderTick,
    deleteAppointment,
} from "../controllers/appointments.controller";

const router = Router();
router.use(verificarJWT);

// ===== Config (LEGACY, se mantiene igual)
router.get("/config", getAppointmentConfig);
router.post("/config", saveAppointmentConfig);
router.post("/reset", resetAppointments);

// ===== CRUD básico (se mantiene igual)
router.get("/", listAppointments);
router.post("/", createAppointment);
router.put("/:id", updateAppointment);
router.delete("/api/appointments/:id", deleteAppointment);


// ===== NUEVO: Reminder Rules (no rompe nada existente)
router.get("/reminders", listReminderRules);
router.post("/reminders", upsertReminderRule);
router.post("/reminders/tick", triggerReminderTick);

export default router;
