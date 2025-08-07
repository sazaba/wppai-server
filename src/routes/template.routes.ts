import { Router } from 'express'
import {
    crearPlantilla,
    listarPlantillas,
    obtenerPlantilla,
    eliminarPlantilla,
    enviarPlantillaAMeta,
    consultarEstadoPlantilla // ⬅️ nuevo controlador importado
} from '../controllers/template.controller'
import { verificarJWT } from '../middleware/auth.middleware'

const router = Router()

// 🔐 Todas las rutas están protegidas por JWT
router.use(verificarJWT)

// Crear nueva plantilla
router.post('/', crearPlantilla)

// Listar todas las plantillas de la empresa
router.get('/', listarPlantillas)

// Obtener una plantilla específica por ID
router.get('/:id', obtenerPlantilla)

// Eliminar una plantilla
router.delete('/:id', eliminarPlantilla)

// Enviar plantilla a Meta
router.post('/:id/enviar', enviarPlantillaAMeta)

// Consultar estado de aprobación en Meta
router.get('/:id/estado', consultarEstadoPlantilla)

export default router
