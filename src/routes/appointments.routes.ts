import { Router } from "express";
import { verificarJWT } from "../middleware/auth.middleware";
import { verifyCronToken } from "../middleware/cron.middleware";
import {
    listAppointments,
    createAppointment,
    updateAppointment,
    getAppointmentConfig,
    saveAppointmentConfig,
    resetAppointments,
    listReminderRules,
    upsertReminderRule,
    triggerReminderTick,
    deleteAppointment,
    dispatchAppointmentReminders,
} from "../controllers/appointments.controller";

const router = Router();

/* ===== RUTAS INTERNAS PARA CRON (SIN JWT) ===== */
router.post("/internal/reminders/tick", verifyCronToken, triggerReminderTick);
router.post("/internal/reminders/dispatch", verifyCronToken, dispatchAppointmentReminders);

/* ===== A PARTIR DE AQUÍ, TODO REQUIERE JWT ===== */
router.use(verificarJWT);

// Config
router.get("/config", getAppointmentConfig);
router.post("/config", saveAppointmentConfig);
router.post("/reset", resetAppointments);

// CRUD
router.get("/", listAppointments);
router.post("/", createAppointment);
router.put("/:id", updateAppointment);
router.delete("/:id", deleteAppointment);

// Reminder Rules (UI)
router.get("/reminders", listReminderRules);
router.post("/reminders", upsertReminderRule);
router.post("/reminders/tick", triggerReminderTick);
router.post("/reminders/dispatch", dispatchAppointmentReminders);

export default router;
