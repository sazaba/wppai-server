import { Router } from "express"
import { verificarJWT } from "../middleware/auth.middleware"
import {
    listAppointmentHours,
    upsertAppointmentHour,
    bulkUpsertAppointmentHours,
} from "../controllers/appointmentHours.controller"

const router = Router()
router.use(verificarJWT)

// Lista los 7 días (autoseed si faltan)
router.get("/", listAppointmentHours)

// Actualiza un día: mon|tue|wed|thu|fri|sat|sun
router.put("/:day", upsertAppointmentHour)

// Actualiza varios días a la vez
router.put("/", bulkUpsertAppointmentHours)

export default router
