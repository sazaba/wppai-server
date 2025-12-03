import { Router } from 'express'
import { getAllCompanies, resetCompanyPassword } from '../controllers/superadmin.controller'
import { verificarJWT } from '../middleware/auth.middleware'

const router = Router()

// Middleware de seguridad estricta: Solo permite el correo maestro definido en .env
const requireSuperAdmin = (req: any, res: any, next: any) => {
    // req.user viene del middleware authenticateToken
    const userEmail = req.user?.email

    // Verificamos contra la variable de entorno
    // Asegúrate de tener SUPERADMIN_EMAIL="tu_correo@gmail.com" en tu .env del backend
    if (userEmail && userEmail === process.env.SUPERADMIN_EMAIL) {
        next()
    } else {
        console.warn(`⚠️ [SuperAdmin] Intento de acceso no autorizado por: ${userEmail}`)
        return res.status(403).json({ error: 'Acceso denegado. Se requiere rol SuperAdmin.' })
    }
}

// 1. Primero validamos que tenga un token válido (Usuario logueado)
router.use(verificarJWT)

// 2. Luego validamos que sea EL superadmin
router.use(requireSuperAdmin)

// --- Rutas Protegidas ---

// Obtener listado completo de empresas con métricas
router.get('/companies', getAllCompanies)

// Restablecer contraseña de un usuario específico
router.post('/reset-password', resetCompanyPassword)

export default router