"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_middleware_1 = require("../middleware/auth.middleware");
const appointments_controller_1 = require("../controllers/appointments.controller");
const router = (0, express_1.Router)();
router.use(auth_middleware_1.verificarJWT);
/** ===================== CONFIG DE AGENDA ===================== **
 *  GET  /api/appointments/config  -> { config, hours, provider }
 *  POST /api/appointments/config  -> { ok: true }
 */
router.get("/config", appointments_controller_1.getAppointmentConfig);
router.post("/config", appointments_controller_1.saveAppointmentConfig);
/** ===================== CRUD DE CITAS ===================== **
 *  filtros: empresaId (middleware), from, to, sedeId, serviceId, providerId
 */
router.get("/", appointments_controller_1.listAppointments);
router.post("/", appointments_controller_1.createAppointment);
router.put("/:id", appointments_controller_1.updateAppointment);
router.put("/:id/status", appointments_controller_1.updateAppointmentStatus);
router.delete("/:id", appointments_controller_1.deleteAppointment);
router.post("/reset", appointments_controller_1.resetAppointments);
exports.default = router;
