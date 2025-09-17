"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/whatsapp.routes.ts
const express_1 = require("express");
const multer_1 = __importDefault(require("multer"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const auth_middleware_1 = require("../middleware/auth.middleware");
const whatsapp_controller_1 = require("../controllers/whatsapp.controller");
const router = (0, express_1.Router)();
// server/src/routes/whatsapp.routes.ts
const whatsapp_service_1 = require("../services/whatsapp.service");
router.get('/ping-send', async (req, res) => {
    try {
        const empresaId = Number(req.query.empresaId || 0);
        const to = String(req.query.to || '');
        const body = String(req.query.body || '✅ Ping desde Wasaaa (service)');
        if (!empresaId || !to) {
            return res.status(400).json({ ok: false, error: 'Falta empresaId o to' });
        }
        const r = await (0, whatsapp_service_1.sendText)({ empresaId, to, body });
        return res.json({ ok: true, meta: r });
    }
    catch (err) {
        return res.status(err?.response?.status || 500).json({
            ok: false,
            status: err?.response?.status,
            error: err?.response?.data || err?.message || err,
        });
    }
});
// --- Helper: permite token corto en ?t= SOLO para /media,
//     o pasa a verificarJWT para el resto. No valida aquí el JWT;
//     lo valida el controlador (y también lo soporta verificarJWT).
function authOrSignedToken(req, res, next) {
    if (req.method === 'OPTIONS')
        return res.sendStatus(204);
    const t = req.query?.t;
    if (typeof t === 'string' && t.length > 0) {
        return next();
    }
    return (0, auth_middleware_1.verificarJWT)(req, res, next);
}
/* ===== Públicas de diagnóstico ===== */
router.get('/ping', (_req, res) => res.json({ ok: true, from: 'whatsapp.routes', ping: 'pong' }));
router.get('/health-public', (_req, res) => res.json({ ok: true, msg: 'health (public) online' }));
/* ===== Multer (subidas locales temporales) ===== */
const uploadDir = path_1.default.join(process.cwd(), 'uploads');
fs_1.default.mkdirSync(uploadDir, { recursive: true });
const storage = multer_1.default.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
        const ext = path_1.default.extname(file.originalname) || '';
        const name = `${file.fieldname}-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
        cb(null, name);
    },
});
const ALLOWED_MIME = new Set([
    'image/jpeg', 'image/png', 'image/webp',
    'video/mp4', 'video/quicktime',
    'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/amr', 'audio/wav',
    'application/pdf',
]);
const upload = (0, multer_1.default)({
    storage,
    limits: { fileSize: 16 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        if (ALLOWED_MIME.has(file.mimetype))
            return cb(null, true);
        cb(new Error('Tipo de archivo no permitido para WhatsApp'));
    },
});
/* ===== Conexión / Estado ===== */
router.post('/vincular', auth_middleware_1.verificarJWT, whatsapp_controller_1.vincular);
router.get('/estado', auth_middleware_1.verificarJWT, whatsapp_controller_1.estadoWhatsappAccount);
router.delete('/eliminar', auth_middleware_1.verificarJWT, whatsapp_controller_1.eliminarWhatsappAccount);
/* ===== Cloud API ===== */
router.post('/enviar-prueba', auth_middleware_1.verificarJWT, whatsapp_controller_1.enviarPrueba);
router.post('/media', auth_middleware_1.verificarJWT, whatsapp_controller_1.enviarMedia);
router.post('/media-upload', auth_middleware_1.verificarJWT, upload.single('file'), whatsapp_controller_1.enviarMediaUpload);
router.get('/numero/:phoneNumberId', auth_middleware_1.verificarJWT, whatsapp_controller_1.infoNumero);
/* ===== Stream de media (GET desde <img>/<video>) =====
   - Acepta ?t=JWT corto (sin header) o Authorization normal
*/
router.get('/media/:mediaId', whatsapp_controller_1.streamMediaById);
/* ===== Utilidades ===== */
router.get('/debug-token', auth_middleware_1.verificarJWT, whatsapp_controller_1.debugToken);
router.get('/health', auth_middleware_1.verificarJWT, whatsapp_controller_1.health);
exports.default = router;
