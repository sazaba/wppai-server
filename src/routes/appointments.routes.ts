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
    // NUEVOS
    listReminderRules,
    upsertReminderRule,
    triggerReminderTick,
    deleteAppointment,
    dispatchAppointmentReminders,

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
router.delete("/:id", deleteAppointment);



// ===== NUEVO: Reminder Rules (no rompe nada existente)
router.get("/reminders", listReminderRules);
router.post("/reminders", upsertReminderRule);
router.post("/reminders/tick", triggerReminderTick);
router.post("/reminders/dispatch", dispatchAppointmentReminders);



router.post("/internal/reminders/tick", verifyCronToken, triggerReminderTick);
router.post("/internal/reminders/dispatch", verifyCronToken, dispatchAppointmentReminders);


export default router;
