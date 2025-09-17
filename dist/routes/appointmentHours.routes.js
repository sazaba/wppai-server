"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_middleware_1 = require("../middleware/auth.middleware");
const appointmentHours_controller_1 = require("../controllers/appointmentHours.controller");
const router = (0, express_1.Router)();
router.use(auth_middleware_1.verificarJWT);
// Lista los 7 días (autoseed si faltan)
router.get("/", appointmentHours_controller_1.listAppointmentHours);
// Actualiza un día: mon|tue|wed|thu|fri|sat|sun
router.put("/:day", appointmentHours_controller_1.upsertAppointmentHour);
// Actualiza varios días a la vez
router.put("/", appointmentHours_controller_1.bulkUpsertAppointmentHours);
exports.default = router;
