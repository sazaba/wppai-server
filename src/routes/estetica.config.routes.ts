import { Router } from 'express'
import { verificarJWT } from '../middleware/auth.middleware'
import {
    getApptConfig,
    upsertApptConfig,
    listHours,
    upsertHours,
    listProcedures,
    upsertProcedure,
    listStaff,
    upsertStaff,
    listExceptions,
    upsertException,
} from '../controllers/estetica.config.controller'

const router = Router()

// 🔐 Aplica auth a todo el módulo
router.use(verificarJWT)

/** ========= BusinessConfigAppt ========= */
// Obtener config completa (incluye procedimientos y reminder rules)
router.get('/estetica/config/:empresaId', getApptConfig)
// Crear/actualizar config
router.post('/estetica/config/:empresaId', upsertApptConfig)

/** ========= AppointmentHour ========= */
// Listar horario semanal
router.get('/estetica/hours/:empresaId', listHours)
// Guardar horario semanal (sobrescribe por día)
router.post('/estetica/hours/:empresaId', upsertHours)

/** ========= EsteticaProcedure ========= */
// Listar procedimientos
router.get('/estetica/procedures/:empresaId', listProcedures)
// Crear/actualizar procedimiento
router.post('/estetica/procedures/:empresaId', upsertProcedure)

/** ========= Staff (opcional) ========= */
// Listar staff
router.get('/estetica/staff/:empresaId', listStaff)
// Crear/actualizar staff
router.post('/estetica/staff/:empresaId', upsertStaff)

/** ========= Excepciones (opcional) ========= */
// Listar días de excepción
router.get('/estetica/exceptions/:empresaId', listExceptions)
// Crear/actualizar excepción
router.post('/estetica/exceptions/:empresaId', upsertException)

export default router
