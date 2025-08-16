// src/middleware/auth.middleware.ts
import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'

const JWT_SECRET = process.env.JWT_SECRET || 'supersecreto'

export interface JwtPayload {
    id: number
    email: string
    rol: 'admin' | 'agente' | 'invitado' | string
    empresaId: number
}

declare global {
    namespace Express {
        interface Request {
            user?: JwtPayload
        }
    }
}

// Rutas que no requieren autenticación (se mantiene tu lista)
const OPEN_PATHS = [
    '/api/auth/register',
    '/api/auth/login',
    '/api/auth/whatsapp',    // inicio OAuth
    '/api/auth/callback',    // callback OAuth
    '/api/auth/exchange-code',
    '/api/auth/wabas'
]

/**
 * Verifica si la URL actual coincide con alguna ruta pública.
 * Usa originalUrl (ignora query) y compara con startsWith para que funcione
 * igual si el router está montado con prefijos.
 */
function isOpenPath(originalUrl: string) {
    const url = originalUrl.split('?')[0]
    return OPEN_PATHS.some(p => url.startsWith(p))
}

export const verificarJWT = (req: Request, res: Response, next: NextFunction) => {
    // Deja pasar preflight CORS sin token
    if (req.method === 'OPTIONS') return res.sendStatus(204)

    // Si la ruta está en las públicas, dejar pasar sin token
    if (isOpenPath(req.originalUrl)) {
        return next()
    }

    // Soporta "Authorization: Bearer <token>"
    const authHeader = req.headers.authorization
    if (!authHeader || !/^Bearer\s+/i.test(authHeader)) {
        return res.status(401).json({ error: 'Token no proporcionado' })
    }

    const token = authHeader.replace(/^Bearer\s+/i, '')

    try {
        const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload

        // Validaciones mínimas del payload (mantiene tu lógica)
        if (!decoded?.empresaId || !decoded?.id) {
            return res.status(401).json({ error: 'Token inválido (payload incompleto)' })
        }

        req.user = decoded
        return next()
    } catch (error: any) {
        if (error?.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Token expirado' })
        }
        return res.status(401).json({ error: 'Token inválido o expirado' })
    }
}
