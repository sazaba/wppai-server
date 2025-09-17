"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.verificarJWT = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const JWT_SECRET = process.env.JWT_SECRET || 'supersecreto';
// Rutas que no requieren autenticación
const OPEN_PATHS = [
    '/api/auth/register',
    '/api/auth/login',
    '/api/auth/whatsapp', // inicio OAuth
    '/api/auth/callback', // callback OAuth
    '/api/auth/exchange-code',
    '/api/auth/wabas'
];
// Rutas donde permitimos token en query ?t=... (para <img>, <video>, etc.)
const QUERY_TOKEN_PATHS = [
    '/api/whatsapp/media' // GET /api/whatsapp/media/:mediaId?t=JWT
];
function stripQuery(originalUrl) {
    return originalUrl.split('?')[0];
}
function matchPrefix(url, prefixes) {
    const clean = stripQuery(url);
    return prefixes.some(p => clean.startsWith(p));
}
// src/middleware/auth.middleware.ts
const verificarJWT = (req, res, next) => {
    // Preflight CORS
    if (req.method === 'OPTIONS')
        return res.sendStatus(204);
    // ⛔ BYPASS total para el stream de media (el controlador valida t o usa DB)
    const cleanPath = stripQuery(req.originalUrl);
    if (req.method === 'GET' && /^\/api\/whatsapp\/media\//.test(cleanPath)) {
        return next();
    }
    // Permitir rutas públicas
    if (matchPrefix(req.originalUrl, OPEN_PATHS)) {
        return next();
    }
    // 1) Authorization: Bearer ...
    const authHeader = req.headers.authorization;
    if (authHeader && /^Bearer\s+/i.test(authHeader)) {
        try {
            const token = authHeader.replace(/^Bearer\s+/i, '');
            const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
            if (!decoded?.empresaId || !decoded?.id) {
                return res.status(401).json({ error: 'Token inválido (payload incompleto)' });
            }
            req.user = decoded;
            return next();
        }
        catch (error) {
            if (error?.name === 'TokenExpiredError') {
                return res.status(401).json({ error: 'Token expirado' });
            }
            return res.status(401).json({ error: 'Token inválido o expirado' });
        }
    }
    // 2) Token por query SOLO en rutas habilitadas (no aplica a /media, ya hicimos bypass)
    if (matchPrefix(req.originalUrl, QUERY_TOKEN_PATHS)) {
        const tokenQ = typeof req.query.t === 'string' ? req.query.t : null;
        if (!tokenQ)
            return res.status(401).json({ error: 'Token no proporcionado' });
        try {
            const decoded = jsonwebtoken_1.default.verify(tokenQ, JWT_SECRET);
            if (!decoded?.empresaId || !decoded?.id) {
                return res.status(401).json({ error: 'Token inválido (payload incompleto)' });
            }
            req.user = decoded;
            return next();
        }
        catch (error) {
            if (error?.name === 'TokenExpiredError') {
                return res.status(401).json({ error: 'Token expirado' });
            }
            return res.status(401).json({ error: 'Token inválido o expirado' });
        }
    }
    return res.status(401).json({ error: 'Token no proporcionado' });
};
exports.verificarJWT = verificarJWT;
