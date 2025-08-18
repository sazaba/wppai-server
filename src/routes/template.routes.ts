// src/routes/template.routes.ts

// import { Router } from 'express'
import { Router } from '../router-debug'

import {
    crearPlantilla,
    listarPlantillas,
    obtenerPlantilla,
    eliminarPlantilla,
    enviarPlantillaAMeta,
    consultarEstadoPlantilla
} from '../controllers/template.controller'
import { verificarJWT } from '../middleware/auth.middleware'

const router = Router()

router.use(verificarJWT)

router.post('/', crearPlantilla)
router.get('/', listarPlantillas)

router.get('/:id', obtenerPlantilla)
router.post('/:id/enviar', enviarPlantillaAMeta)
router.get('/:id/estado', consultarEstadoPlantilla)
router.delete('/:id', eliminarPlantilla)

export default router
