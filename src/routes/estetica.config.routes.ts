import { Router } from 'express'
import { verificarJWT } from '../middleware/auth.middleware'
import {
    getApptConfig,
    upsertApptConfig,
    // OJO: los de hours ya los manejas en /api/appointment-hours
    // listHours,
    // upsertHours,
    listProcedures,
    upsertProcedure,
    listStaff,
    upsertStaff,
    listExceptions,
    upsertException,
    purgeAllEsteticaData,
    deleteStaff,
    deleteProcedure,
    deleteException,
} from '../controllers/estetica.config.controller'

const router = Router()

// 🔐 Aplica auth a todo el módulo
router.use(verificarJWT)

/** ========= BusinessConfigAppt ========= */
// GET /api/estetica/config
router.get('/estetica/config', getApptConfig)
// POST /api/estetica/config
router.post('/estetica/config', upsertApptConfig)

/** ========= AppointmentHour ========= */
/* ¡Ya tienes /api/appointment-hours funcionando! No dupliquemos paths aquí.
   Si algún día quisieras traerlos a este router, serían:
   router.get('/estetica/hours', listHours)
   router.post('/estetica/hours', upsertHours)
*/

/** ========= EsteticaProcedure ========= */
// GET /api/estetica/procedures
router.get('/estetica/procedures', listProcedures)
// POST /api/estetica/procedure
router.post('/estetica/procedure', upsertProcedure)
router.delete('/estetica/procedure/:id', deleteProcedure)

/** ========= Staff ========= */
// GET /api/estetica/staff
router.get('/estetica/staff', listStaff)
// POST /api/estetica/staff
router.post('/estetica/staff', upsertStaff)
router.delete('/estetica/staff/:id', deleteStaff)

/** ========= Exceptions ========= */
// GET /api/estetica/exceptions
router.get('/estetica/exceptions', listExceptions)
// POST /api/estetica/exception
router.post('/estetica/exception', upsertException)
router.delete('/estetica/exception/:id', deleteException)

router.delete("/estetica/purge", purgeAllEsteticaData);

export default router
