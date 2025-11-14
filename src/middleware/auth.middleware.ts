// src/middleware/auth.middleware.ts
import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'

const JWT_SECRET = process.env.JWT_SECRET || 'supersecreto'
const CRON_INTERNAL_TOKEN = process.env.CRON_INTERNAL_TOKEN || null

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

const OPEN_PATHS = [
    '/api/auth/register',
    '/api/auth/login',
    '/api/auth/whatsapp',
    '/api/auth/callback',
    '/api/auth/exchange-code',
    '/api/auth/wabas'
]

const QUERY_TOKEN_PATHS = [
    '/api/whatsapp/media'
]

function stripQuery(originalUrl: string) {
    return originalUrl.split('?')[0]
}

function matchPrefix(url: string, prefixes: string[]) {
    const clean = stripQuery(url)
    return prefixes.some(p => clean.startsWith(p))
}

export const verificarJWT = (req: Request, res: Response, next: NextFunction) => {

    if (req.method === 'OPTIONS') return res.sendStatus(204)

    const cleanPath = stripQuery(req.originalUrl)
    if (req.method === 'GET' && /^\/api\/whatsapp\/media\//.test(cleanPath)) {
        return next()
    }

    if (matchPrefix(req.originalUrl, OPEN_PATHS)) {
        return next()
    }

    // 🔥🔥🔥 >>>> NUEVO: BYPASS PARA CRON <<<< 🔥🔥🔥
    const authHeader = req.headers.authorization
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.replace('Bearer ', '')

        // Si coincide con el token interno, no se valida JWT
        if (CRON_INTERNAL_TOKEN && token === CRON_INTERNAL_TOKEN) {
            // Puedes asignar empresa fija, o leer de la agenda
            req.user = {
                id: 0,
                email: 'cron@system',
                rol: 'admin',
                empresaId: 1 // OJO: puedes cambiarlo si manejas multiempresa
            }
            return next()
        }

        // ---- Validación JWT normal ----
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

    if (matchPrefix(req.originalUrl, QUERY_TOKEN_PATHS)) {
        const tokenQ = typeof req.query.t === 'string' ? req.query.t : null
        if (!tokenQ) return res.status(401).json({ error: 'Token no proporcionado' })
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

    return res.status(401).json({ error: 'Token no proporcionado' })
}
