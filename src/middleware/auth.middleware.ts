// src/middleware/auth.middleware.ts
import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'

const JWT_SECRET = process.env.JWT_SECRET || 'supersecreto'

interface JwtPayload {
    id: number
    email: string
    rol: string
    empresaId: number
}

declare global {
    namespace Express {
        interface Request {
            user?: JwtPayload
        }
    }
}

// Rutas que no requieren autenticación
const OPEN_PATHS = [
    '/api/auth/register',
    '/api/auth/login',
    '/api/auth/whatsapp', // inicio OAuth
    '/api/auth/callback', // callback OAuth
    '/api/auth/exchange-code',
    '/api/auth/wabas'
]

export const verificarJWT = (req: Request, res: Response, next: NextFunction) => {
    // Si la ruta está en las públicas, dejar pasar sin token
    if (OPEN_PATHS.includes(req.path)) {
        return next()
    }

    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Token no proporcionado' })
    }

    const token = authHeader.split(' ')[1]

    try {
        const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload
        req.user = decoded
        next()
    } catch (error) {
        return res.status(401).json({ error: 'Token inválido o expirado' })
    }
}
