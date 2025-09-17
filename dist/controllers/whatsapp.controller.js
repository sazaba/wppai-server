"use strict";
// // src/controllers/whatsapp.controller.ts
// import { Request, Response } from 'express'
// import axios from 'axios'
// import fs from 'fs/promises'
// import jwt from 'jsonwebtoken'
// import prisma from '../lib/prisma'
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.health = exports.debugToken = exports.streamMediaById = exports.infoNumero = exports.enviarMediaUpload = exports.enviarMedia = exports.enviarPrueba = exports.eliminarWhatsappAccount = exports.estadoWhatsappAccount = exports.vincular = void 0;
exports.signMediaToken = signMediaToken;
const axios_1 = __importDefault(require("axios"));
const promises_1 = __importDefault(require("fs/promises"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const prisma_1 = __importDefault(require("../lib/prisma"));
const whatsapp_service_1 = require("../services/whatsapp.service");
const FB_VERSION = process.env.FB_VERSION || 'v20.0';
// ✅ normaliza (evita espacios o comillas perdidas de la UI del host)
const JWT_SECRET = (process.env.JWT_SECRET ?? 'dev-secret').trim();
// 🔐 token que **SIEMPRE** usaremos para operar la WABA (System User)
// (fallback al TEMP si aún no defines el nuevo)
const SYSTEM_USER_TOKEN = (process.env.WHATSAPP_SYSTEM_USER_TOKEN ||
    process.env.WHATSAPP_TEMP_TOKEN ||
    '').trim();
/* ===================== Helpers ===================== */
function metaError(err) {
    const e = err?.response?.data?.error || err?.response?.data || err;
    return {
        ok: false,
        error: {
            message: e?.message ?? err?.message ?? 'Unknown error',
            type: e?.type,
            code: e?.code,
            error_subcode: e?.error_subcode,
            details: e,
        },
    };
}
function logMetaError(tag, err) {
    const e = err?.response?.data || err;
    console.error(`[${tag}] Meta error:`, JSON.stringify(e, null, 2));
}
// ⛔️ Importante: de ahora en adelante priorizamos el token del System User.
// Si la empresa no tiene guardado token, devolvemos el SYSTEM_USER_TOKEN de env.
// Así evitas que se use un token de usuario OAuth (sin permisos).
async function getAccessToken(empresaId) {
    const acc = await prisma_1.default.whatsappAccount.findUnique({
        where: { empresaId },
        select: { accessToken: true },
    });
    const dbToken = (acc?.accessToken || '').trim();
    if (dbToken)
        return dbToken;
    if (SYSTEM_USER_TOKEN)
        return SYSTEM_USER_TOKEN;
    throw new Error('No hay accessToken para la empresa ni WHATSAPP_SYSTEM_USER_TOKEN configurado');
}
function sanitizePhone(to) {
    return String(to).replace(/\D+/g, '');
}
/** Deducir tipo soportado por WhatsApp a partir del MIME */
function guessTypeFromMime(mime) {
    if (!mime)
        return 'document';
    if (mime.startsWith('image/'))
        return 'image';
    if (mime.startsWith('video/'))
        return 'video';
    if (mime.startsWith('audio/'))
        return 'audio';
    return 'document';
}
/** 🔏 Firma un token corto para pedir /media/:id desde <img>/<video> */
function signMediaToken(empresaId, mediaId) {
    return jsonwebtoken_1.default.sign({ empresaId, mediaId }, JWT_SECRET, { expiresIn: '24h' });
}
/** 🔎 1er intento: obtener empresaId desde (1) auth normal o (2) token ?t= */
function resolveEmpresaIdFromRequest(req) {
    const authEmpresa = req.user?.empresaId;
    if (authEmpresa)
        return { empresaId: Number(authEmpresa), why: 'req.user' };
    const tokenQ = req.query?.t || '';
    if (!tokenQ)
        return { empresaId: null, why: 'no_query_token' };
    try {
        const decoded = jsonwebtoken_1.default.verify(tokenQ, JWT_SECRET);
        return { empresaId: Number(decoded?.empresaId) || null, why: 'jwt_query' };
    }
    catch (e) {
        console.warn('[streamMediaById] JWT inválido:', e?.name, e?.message);
        return { empresaId: null, why: `jwt_error:${e?.name || 'unknown'}` };
    }
}
/** 🔎 2do intento (fallback): inferir empresaId por mediaId desde tu DB */
async function resolveEmpresaIdByMediaId(mediaId) {
    try {
        // 1) Coincidencia directa por mediaId (lo normal hoy)
        const direct = await prisma_1.default.message.findFirst({
            where: { mediaId },
            select: { empresaId: true, id: true },
            orderBy: { id: 'desc' },
        });
        if (direct?.empresaId)
            return direct.empresaId;
        // 2) Histórico: si alguna vez guardaste en mediaUrl rutas tipo /media/:id
        const viaUrl = await prisma_1.default.message.findFirst({
            where: { mediaUrl: { contains: `/media/${mediaId}` } },
            select: { empresaId: true, id: true },
            orderBy: { id: 'desc' },
        });
        if (viaUrl?.empresaId)
            return viaUrl.empresaId;
        return null;
    }
    catch (e) {
        console.warn('[resolveEmpresaIdByMediaId] DB error:', e?.message || e);
        return null;
    }
}
/**
 * ¿Existe la plantilla en Meta?
 */
async function templateExistsInMeta(params) {
    const { accessToken, wabaId, name } = params;
    const url = `https://graph.facebook.com/${FB_VERSION}/${wabaId}/message_templates`;
    const { data } = await axios_1.default.get(url, {
        params: { access_token: accessToken, name, limit: 1 },
        headers: { 'Content-Type': 'application/json' },
    });
    const list = Array.isArray(data?.data) ? data.data : [];
    return list.some((t) => t.name === name);
}
/**
 * Intenta crear la plantilla fallback si no existe (no bloquea si falla).
 */
async function ensureFallbackTemplateInMeta(params) {
    const { accessToken, wabaId, name, lang } = params;
    try {
        const exists = await templateExistsInMeta({ accessToken, wabaId, name });
        if (exists)
            return;
    }
    catch (e) {
        console.warn('[ensureFallbackTemplateInMeta] fallo consultando templates:', e?.response?.data || e?.message);
    }
    const url = `https://graph.facebook.com/${FB_VERSION}/${wabaId}/message_templates?access_token=${encodeURIComponent(accessToken)}`;
    const payload = {
        name,
        category: 'MARKETING',
        allow_category_change: true,
        language: lang,
        components: [{ type: 'BODY', text: '¡Hola! Gracias por escribirnos. ¿En qué podemos ayudarte?' }],
    };
    try {
        await axios_1.default.post(url, payload, { headers: { 'Content-Type': 'application/json' } });
        console.log(`[Templates] Creada plantilla ${name}/${lang} en WABA ${wabaId}`);
    }
    catch (e) {
        console.warn('[Templates] No se pudo crear plantilla fallback:', e?.response?.data || e.message);
    }
}
/* =============================================================================
 * CONEXIÓN (flujo único)
 * ========================================================================== */
const vincular = async (req, res) => {
    try {
        const empresaId = req.user?.empresaId;
        if (!empresaId)
            return res.status(401).json({ ok: false, error: 'No autorizado' });
        // ⚠️ El body puede traer accessToken de usuario (OAuth), pero ya NO lo usaremos para operar.
        const { accessToken: _userAccessToken, phoneNumberId, wabaId, businessId: bodyBusinessId, displayPhoneNumber } = req.body;
        if (!phoneNumberId || !wabaId) {
            return res.status(400).json({ ok: false, error: 'Faltan phoneNumberId o wabaId' });
        }
        if (!SYSTEM_USER_TOKEN) {
            return res.status(500).json({
                ok: false,
                error: 'WHATSAPP_SYSTEM_USER_TOKEN (o WHATSAPP_TEMP_TOKEN) no está configurado en el backend. No podemos operar la WABA.',
            });
        }
        const APP_ID = (process.env.META_APP_ID || '').trim();
        const headers = { Authorization: `Bearer ${SYSTEM_USER_TOKEN}`, 'Content-Type': 'application/json' };
        // === 1) Resolver owner del Business (dueño de la WABA) + apps suscritas ===
        let businessId = (bodyBusinessId || '').trim();
        const info = await axios_1.default.get(`https://graph.facebook.com/${FB_VERSION}/${wabaId}`, {
            params: { fields: 'owner_business_info,subscribed_apps' },
            headers,
        });
        if (!businessId)
            businessId = info.data?.owner_business_info?.id || '';
        if (!businessId) {
            return res.status(400).json({ ok: false, error: 'No se pudo resolver el Business dueño de la WABA' });
        }
        // ¿Ya está suscrita mi App?
        const already = Array.isArray(info.data?.subscribed_apps?.data)
            ? info.data.subscribed_apps.data.some((a) => String(a?.id) === APP_ID)
            : false;
        // === 2) Si NO está suscrita, intentar suscribir con el token del System User ===
        if (!already) {
            async function addAppAndResubscribe() {
                if (!APP_ID)
                    throw new Error('META_APP_ID no configurado en backend');
                await axios_1.default.post(`https://graph.facebook.com/${FB_VERSION}/${businessId}/apps`, { app_id: APP_ID }, { headers });
                await axios_1.default.post(`https://graph.facebook.com/${FB_VERSION}/${wabaId}/subscribed_apps`, {}, { headers });
            }
            try {
                await axios_1.default.post(`https://graph.facebook.com/${FB_VERSION}/${wabaId}/subscribed_apps`, {}, { headers });
            }
            catch (e) {
                const err = e?.response?.data?.error;
                const msg = err?.message || '';
                const code = err?.code;
                if (code === 200 || /Permissions error/i.test(msg)) {
                    try {
                        await addAppAndResubscribe();
                    }
                    catch (e2) {
                        const why = e2?.response?.data?.error?.message || e2?.message || 'Permissions error';
                        return res.status(403).json({
                            ok: false,
                            error: `No pudimos suscribir la WABA automáticamente.\n` +
                                `➡️ En el Business OWNER: Accounts → WhatsApp accounts → (WABA) → Apps → Add → App ID: ${APP_ID}\n` +
                                `Luego reintenta desde el SaaS.\n` +
                                `Meta: ${why}`,
                        });
                    }
                }
                else {
                    return res.status(400).json({
                        ok: false,
                        error: `No pudimos suscribir tu WABA a la app. Detalle: ${msg}`,
                    });
                }
            }
        }
        // === 3) Guardar/actualizar credenciales ===
        // ⛔️ OJO: ahora guardamos SIEMPRE el token del System User.
        await prisma_1.default.whatsappAccount.upsert({
            where: { empresaId },
            update: {
                accessToken: SYSTEM_USER_TOKEN,
                phoneNumberId,
                wabaId,
                businessId,
                displayPhoneNumber: displayPhoneNumber || null,
                updatedAt: new Date(),
            },
            create: {
                empresaId,
                accessToken: SYSTEM_USER_TOKEN,
                phoneNumberId,
                wabaId,
                businessId,
                displayPhoneNumber: displayPhoneNumber || null,
            },
        });
        return res.json({ ok: true });
    }
    catch (e) {
        console.error('[vincular] error:', e?.response?.data || e?.message || e);
        return res.status(500).json({ ok: false, error: 'Error al guardar conexión de WhatsApp' });
    }
};
exports.vincular = vincular;
/**
 * GET /api/whatsapp/estado
 */
const estadoWhatsappAccount = async (req, res) => {
    try {
        const empresaId = req.user?.empresaId;
        if (!empresaId)
            return res.status(401).json({ ok: false, error: 'No autorizado' });
        const cuenta = await prisma_1.default.whatsappAccount.findUnique({ where: { empresaId } });
        if (!cuenta)
            return res.json({ conectado: false });
        return res.json({
            conectado: true,
            phoneNumberId: cuenta.phoneNumberId,
            displayPhoneNumber: cuenta.displayPhoneNumber,
            wabaId: cuenta.wabaId,
            businessId: cuenta.businessId,
        });
    }
    catch (err) {
        console.error('[estadoWhatsappAccount] error:', err);
        return res.status(500).json({ ok: false, error: 'Error al consultar estado' });
    }
};
exports.estadoWhatsappAccount = estadoWhatsappAccount;
/**
 * DELETE /api/whatsapp/eliminar
 */
const eliminarWhatsappAccount = async (req, res) => {
    try {
        const empresaId = req.user?.empresaId;
        if (!empresaId)
            return res.status(401).json({ ok: false, error: 'No autorizado' });
        await prisma_1.default.whatsappAccount.delete({ where: { empresaId } }).catch(() => null);
        return res.json({ ok: true, mensaje: 'Cuenta de WhatsApp eliminada correctamente' });
    }
    catch (err) {
        console.error('[eliminarWhatsappAccount] error:', err);
        return res.status(500).json({ ok: false, error: 'Error al eliminar cuenta de WhatsApp' });
    }
};
exports.eliminarWhatsappAccount = eliminarWhatsappAccount;
/* =============================================================================
 * CLOUD API – Envío / Consulta
 * ========================================================================== */
const enviarPrueba = async (req, res) => {
    try {
        const empresaId = req.user?.empresaId;
        if (!empresaId)
            return res.status(401).json({ ok: false, error: 'No autorizado' });
        const { to, body, conversationId } = req.body;
        if (!to || !body) {
            return res.status(400).json({ ok: false, error: 'to y body son requeridos' });
        }
        const toSanitized = sanitizePhone(to);
        const result = await (0, whatsapp_service_1.sendText)({ empresaId, to: toSanitized, body, conversationId });
        return res.json({ ok: true, ...result });
    }
    catch (err) {
        logMetaError('enviarPrueba', err);
        const code = err?.response?.data?.error?.code;
        const msg = err?.response?.data?.error?.message || '';
        if (/24|template|message template|HSM|outside the 24/i.test(msg)) {
            return res.status(400).json({
                ok: false,
                error: {
                    message: 'El usuario está fuera de la ventana de 24h: usa una plantilla aprobada.',
                    code,
                    details: err?.response?.data,
                },
            });
        }
        if (/not registered|phone number is not registered/i.test(msg)) {
            return res.status(400).json({
                ok: false,
                error: {
                    message: 'El número no está registrado en Cloud API: registra/valida el número desde Meta.',
                    code,
                    details: err?.response?.data,
                },
            });
        }
        return res.status(400).json(metaError(err));
    }
};
exports.enviarPrueba = enviarPrueba;
/**
 * POST /api/whatsapp/media (por LINK)
 */
const enviarMedia = async (req, res) => {
    try {
        const empresaId = req.user?.empresaId;
        if (!empresaId)
            return res.status(401).json({ ok: false, error: 'No autorizado' });
        const { to, url, type, caption, conversationId } = req.body;
        // Resolver destino y conversationId
        let toFinal = (to || '').trim();
        let convId = conversationId;
        if (!toFinal && conversationId) {
            const conv = await prisma_1.default.conversation.findUnique({
                where: { id: conversationId },
                select: { phone: true },
            });
            toFinal = conv?.phone || '';
        }
        else if (toFinal && !convId) {
            const existing = await prisma_1.default.conversation.findFirst({
                where: { phone: sanitizePhone(toFinal), empresaId },
                select: { id: true },
            });
            convId =
                existing?.id ||
                    (await prisma_1.default.conversation.create({
                        data: { phone: sanitizePhone(toFinal), estado: 'pendiente', empresaId },
                    })).id;
        }
        if (!toFinal || !url || !type) {
            return res.status(400).json({ ok: false, error: 'to, url y type son requeridos' });
        }
        if (!['image', 'video', 'audio', 'document'].includes(type)) {
            return res.status(400).json({ ok: false, error: 'type inválido' });
        }
        const toSanitized = sanitizePhone(toFinal);
        // 1) Enviar por LINK
        const result = await (0, whatsapp_service_1.sendWhatsappMedia)({
            empresaId,
            to: toSanitized,
            url,
            type,
            caption,
            conversationId: convId,
        });
        // 2) Emitir al frontend (mediaUrl = url pública)
        const io = req.app.get('io');
        if (io && convId) {
            io.emit('nuevo_mensaje', {
                conversationId: convId,
                message: {
                    id: null,
                    externalId: result?.outboundId ?? null,
                    from: 'bot',
                    contenido: caption ||
                        (type === 'image'
                            ? '[imagen]'
                            : type === 'video'
                                ? '[video]'
                                : type === 'audio'
                                    ? '[nota de voz]'
                                    : '[documento]'),
                    timestamp: new Date().toISOString(),
                    mediaType: type,
                    mediaUrl: url,
                    mimeType: null,
                    caption: caption || null,
                },
            });
        }
        return res.json({ ok: true, ...result });
    }
    catch (err) {
        logMetaError('enviarMedia', err);
        const msg = err?.response?.data?.error?.message || '';
        if (/24|template|message template|HSM|outside the 24/i.test(msg)) {
            return res.status(400).json({
                ok: false,
                error: {
                    message: 'Fuera de la ventana de 24h: debes usar una plantilla aprobada para iniciar la conversación.',
                    details: err?.response?.data,
                },
            });
        }
        return res.status(400).json(metaError(err));
    }
};
exports.enviarMedia = enviarMedia;
/**
 * POST /api/whatsapp/media-upload
 */
const enviarMediaUpload = async (req, res) => {
    const tmpPath = req.file?.path;
    try {
        const empresaId = Number(req.user?.empresaId);
        if (!empresaId)
            return res.status(401).json({ ok: false, error: 'No autorizado' });
        if (!tmpPath)
            return res.status(400).json({ ok: false, error: 'Archivo requerido (file)' });
        const body = (req.body || {});
        const caption = (body.caption || '').toString();
        const mime = req.file.mimetype || 'application/octet-stream';
        const waType = body.type || guessTypeFromMime(mime);
        if (!['image', 'video', 'audio', 'document'].includes(waType)) {
            return res.status(400).json({ ok: false, error: 'type inválido' });
        }
        // Resolver destino y conversación
        let toFinal = (body.to || '').trim();
        let convId = body.conversationId ? Number(body.conversationId) : undefined;
        if (!toFinal && convId) {
            const conv = await prisma_1.default.conversation.findUnique({
                where: { id: convId },
                select: { phone: true },
            });
            toFinal = conv?.phone || '';
        }
        else if (toFinal && !convId) {
            const existing = await prisma_1.default.conversation.findFirst({
                where: { phone: sanitizePhone(toFinal), empresaId },
                select: { id: true },
            });
            convId =
                existing?.id ||
                    (await prisma_1.default.conversation.create({
                        data: { phone: sanitizePhone(toFinal), estado: 'pendiente', empresaId },
                    })).id;
        }
        if (!toFinal) {
            return res.status(400).json({ ok: false, error: 'to o conversationId son requeridos' });
        }
        const toSanitized = sanitizePhone(toFinal);
        // 1) subir archivo a /media
        const mediaId = await (0, whatsapp_service_1.uploadToWhatsappMedia)(empresaId, tmpPath, mime);
        // 2) enviar por media_id
        const result = await (0, whatsapp_service_1.sendWhatsappMediaById)({
            empresaId,
            to: toSanitized,
            type: waType,
            mediaId,
            caption,
            conversationId: convId,
            mimeType: mime,
        });
        // 3) Firmar URL del proxy para el frontend
        const token = signMediaToken(empresaId, mediaId);
        const mediaUrl = `/api/whatsapp/media/${mediaId}?t=${encodeURIComponent(token)}`;
        // 4) Emitir al frontend
        const io = req.app.get('io');
        if (io && convId) {
            io.emit('nuevo_mensaje', {
                conversationId: convId,
                message: {
                    id: null,
                    externalId: result?.outboundId ?? null,
                    from: 'bot',
                    contenido: caption ||
                        (waType === 'image'
                            ? '[imagen]'
                            : waType === 'video'
                                ? '[video]'
                                : waType === 'audio'
                                    ? '[nota de voz]'
                                    : '[documento]'),
                    timestamp: new Date().toISOString(),
                    mediaType: waType,
                    mediaUrl, // URL firmada
                    mimeType: mime ?? null,
                    caption: caption || null,
                    mediaId, // incluye mediaId para fallback en el front
                },
            });
        }
        // 5) limpiar archivo temporal
        try {
            await promises_1.default.unlink(tmpPath);
        }
        catch { }
        return res.json({ ok: true, mediaId, ...result });
    }
    catch (err) {
        try {
            if (tmpPath)
                await promises_1.default.unlink(tmpPath);
        }
        catch { }
        logMetaError('enviarMediaUpload', err);
        return res.status(400).json(metaError(err));
    }
};
exports.enviarMediaUpload = enviarMediaUpload;
/**
 * GET /api/whatsapp/numero/:phoneNumberId
 */
const infoNumero = async (req, res) => {
    try {
        const empresaId = req.user?.empresaId;
        if (!empresaId)
            return res.status(401).json({ ok: false, error: 'No autorizado' });
        const { phoneNumberId } = req.params;
        const accessToken = await getAccessToken(empresaId);
        const url = `https://graph.facebook.com/${FB_VERSION}/${phoneNumberId}`;
        const { data } = await axios_1.default.get(url, {
            params: {
                fields: 'display_phone_number,verified_name,name_status,wa_id,account_mode',
                access_token: accessToken,
            },
            headers: { 'Content-Type': 'application/json' },
        });
        return res.json({ ok: true, data });
    }
    catch (err) {
        logMetaError('infoNumero', err);
        return res.status(400).json(metaError(err));
    }
};
exports.infoNumero = infoNumero;
/* =============================================================================
 * Stream de media por mediaId (proxy a WhatsApp)
 * ========================================================================== */
const streamMediaById = async (req, res) => {
    console.log('[streamMediaById] HIT', {
        path: req.originalUrl,
        hasT: typeof req.query?.t === 'string',
        authHdr: req.headers.authorization ? 'yes' : 'no',
    });
    res.setHeader('X-Handler', 'streamMediaById');
    try {
        const { mediaId } = req.params;
        if (!mediaId)
            return res.status(400).json({ ok: false, error: 'mediaId requerido' });
        // 1) Intento por token / req.user
        const attempt = resolveEmpresaIdFromRequest(req);
        // 2) Fallback por DB si falla
        let empresaId = attempt.empresaId;
        if (!empresaId) {
            empresaId = await resolveEmpresaIdByMediaId(mediaId);
            if (empresaId) {
                console.log(`[streamMediaById] Fallback DB OK → empresaId=${empresaId} (mediaId=${mediaId})`);
            }
        }
        else {
            console.log(`[streamMediaById] Auth via ${attempt.why} → empresaId=${empresaId}`);
        }
        if (!empresaId) {
            console.warn('[streamMediaById] 401: empresaId nulo.', {
                mediaId,
                hasQueryToken: typeof req.query?.t === 'string',
                why: attempt.why,
            });
            return res.status(401).json({
                ok: false,
                error: 'No autorizado',
                reason: attempt.why || 'not_found_in_db',
                mediaId,
            });
        }
        const accessToken = await getAccessToken(empresaId);
        // 3) Obtener URL firmada de Graph (con mime y tamaño)
        const meta = await axios_1.default.get(`https://graph.facebook.com/${FB_VERSION}/${mediaId}`, {
            params: { fields: 'url,mime_type,file_size' },
            headers: { Authorization: `Bearer ${accessToken}` },
            timeout: 15000,
        });
        const mediaUrl = meta?.data?.url;
        const mime = meta?.data?.mime_type;
        if (!mediaUrl) {
            console.warn('[streamMediaById] 404 Meta url vacía', { mediaId, empresaId });
            return res.status(404).json({ ok: false, error: 'Media no encontrada' });
        }
        // 4) Descargar y streamear (pasando Range si viene)
        const range = req.headers.range;
        const file = await axios_1.default.get(mediaUrl, {
            responseType: 'stream',
            headers: { Authorization: `Bearer ${accessToken}`, ...(range ? { Range: range } : {}) },
            timeout: 30000,
        });
        // Copiamos cabeceras útiles (mejora video/seek)
        const pass = [
            'content-type',
            'content-length',
            'content-range',
            'accept-ranges',
            'etag',
            'last-modified',
            'cache-control',
        ];
        for (const h of pass) {
            const v = file.headers[h];
            if (v !== undefined)
                res.setHeader(h, v);
        }
        if (!file.headers['content-type'] && mime)
            res.setHeader('Content-Type', mime);
        res.setHeader('Content-Disposition', 'inline');
        if (!file.headers['cache-control'])
            res.setHeader('Cache-Control', 'private, max-age=300');
        res.status(file.status === 206 ? 206 : 200);
        file.data.pipe(res);
    }
    catch (err) {
        const status = err?.response?.status;
        const data = err?.response?.data;
        if (status === 404)
            return res.status(404).json({ ok: false, error: 'Media no encontrada' });
        if (status === 401 || status === 403) {
            console.warn('[streamMediaById] 401/403 desde Graph:', data);
            return res.status(401).json({ ok: false, error: 'No autorizado para este media' });
        }
        console.error('[streamMediaById] error:', data || err.message || err);
        return res.status(500).json({ ok: false, error: 'No se pudo obtener la media' });
    }
};
exports.streamMediaById = streamMediaById;
/* =============================================================================
 * Utilidades
 * ========================================================================== */
const debugToken = async (req, res) => {
    try {
        const empresaId = req.user?.empresaId;
        if (!empresaId)
            return res.status(401).json({ ok: false, error: 'No autorizado' });
        const token = await getAccessToken(empresaId);
        const appAccessToken = `${process.env.META_APP_ID}|${process.env.META_APP_SECRET}`;
        const { data } = await axios_1.default.get(`https://graph.facebook.com/${FB_VERSION}/debug_token`, {
            params: { input_token: token, access_token: appAccessToken },
            headers: { 'Content-Type': 'application/json' },
        });
        return res.json({ ok: true, data });
    }
    catch (err) {
        logMetaError('debugToken', err);
        return res.status(400).json(metaError(err));
    }
};
exports.debugToken = debugToken;
const health = async (_req, res) => {
    try {
        return res.json({ ok: true, status: 'ready' });
    }
    catch (err) {
        console.error('[health] error:', err);
        return res.status(500).json({ ok: false, error: 'Error en health check' });
    }
};
exports.health = health;
