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

// Rutas que no requieren autenticación
const OPEN_PATHS = [
    '/api/auth/register',
    '/api/auth/login',
    '/api/auth/whatsapp',    // inicio OAuth
    '/api/auth/callback',    // callback OAuth
    '/api/auth/exchange-code',
    '/api/auth/wabas'
]

// Rutas donde permitimos token en query ?t=... (para <img>, <video>, etc.)
const QUERY_TOKEN_PATHS = [
    '/api/whatsapp/media' // GET /api/whatsapp/media/:mediaId?t=JWT
]

function stripQuery(originalUrl: string) {
    return originalUrl.split('?')[0]
}

function matchPrefix(url: string, prefixes: string[]) {
    const clean = stripQuery(url)
    return prefixes.some(p => clean.startsWith(p))
}

export const verificarJWT = (req: Request, res: Response, next: NextFunction) => {
    // Preflight CORS
    if (req.method === 'OPTIONS') return res.sendStatus(204)

    // Permitir rutas públicas
    if (matchPrefix(req.originalUrl, OPEN_PATHS)) {
        return next()
    }

    // 1) Intentar por Authorization: Bearer ...
    const authHeader = req.headers.authorization
    if (authHeader && /^Bearer\s+/i.test(authHeader)) {
        const token = authHeader.replace(/^Bearer\s+/i, '')
        try {
            const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload
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

    // 2) Si NO hay header, permitir token por query SOLO en rutas habilitadas
    if (matchPrefix(req.originalUrl, QUERY_TOKEN_PATHS)) {
        const tokenQ = typeof req.query.t === 'string' ? req.query.t : null
        if (!tokenQ) {
            return res.status(401).json({ error: 'Token no proporcionado' })
        }
        try {
            const decoded = jwt.verify(tokenQ, JWT_SECRET) as JwtPayload
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

    // Si llegamos aquí, no hubo token válido
    return res.status(401).json({ error: 'Token no proporcionado' })
}
