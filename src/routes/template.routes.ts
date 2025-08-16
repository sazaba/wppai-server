import { Router } from 'express'
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

// 🔐 Todas las rutas protegidas por JWT
router.use(verificarJWT)

/**
 * Crear plantilla en DB.
 * Tip: agrega ?publicar=true para también subirla a Meta inmediatamente.
 * Body: { nombre, idioma, categoria, cuerpo }
 */
router.post('/', crearPlantilla)

/**
 * Listar plantillas (sincroniza con Meta y devuelve DB ordenada).
 */
router.get('/', listarPlantillas)

/**
 * Obtener una plantilla por ID (DB).
 */
router.get('/:id(\\d+)', obtenerPlantilla)

/**
 * Enviar/Subir una plantilla existente (por ID) a Meta (WABA).
 * Ej: POST /:id/enviar
 */
router.post('/:id(\\d+)/enviar', enviarPlantillaAMeta)

/**
 * Consultar estado de aprobación en Meta y actualizar DB.
 * Ej: GET /:id/estado
 */
router.get('/:id(\\d+)/estado', consultarEstadoPlantilla)

/**
 * Eliminar plantilla (DB). Tip: agrega ?borrarMeta=true para intentar borrarla en Meta también.
 * Ej: DELETE /:id?borrarMeta=true
 */
router.delete('/:id(\\d+)', eliminarPlantilla)

export default router
