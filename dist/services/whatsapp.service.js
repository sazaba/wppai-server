"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendWhatsappMessage = void 0;
exports.getWhatsappCreds = getWhatsappCreds;
exports.sendText = sendText;
exports.sendWhatsappMedia = sendWhatsappMedia;
exports.sendWhatsappMediaById = sendWhatsappMediaById;
exports.uploadToWhatsappMedia = uploadToWhatsappMedia;
exports.getMediaMeta = getMediaMeta;
exports.getMediaUrl = getMediaUrl;
exports.downloadMediaToBuffer = downloadMediaToBuffer;
exports.downloadMediaByIdToBuffer = downloadMediaByIdToBuffer;
exports.sendTemplate = sendTemplate;
exports.sendOutboundMessage = sendOutboundMessage;
exports.sendVoiceNoteByLink = sendVoiceNoteByLink;
exports.sendImageByLink = sendImageByLink;
exports.sendVideoByLink = sendVideoByLink;
// server/src/services/whatsapp.service.ts
const axios_1 = __importDefault(require("axios"));
const prisma_1 = __importDefault(require("../lib/prisma"));
const fs_1 = __importDefault(require("fs"));
const form_data_1 = __importDefault(require("form-data"));
const FB_VERSION = process.env.FB_VERSION || 'v21.0';
/* ===================== HTTP ===================== */
const http = axios_1.default.create({
    timeout: 15000,
    headers: { 'Content-Type': 'application/json' },
});
/* ===================== Helpers ===================== */
async function getWhatsappCreds(empresaId, phoneNumberIdHint) {
    if (phoneNumberIdHint) {
        const accByPhone = await prisma_1.default.whatsappAccount.findFirst({
            where: { empresaId, phoneNumberId: phoneNumberIdHint, accessToken: { not: '' } },
            select: { accessToken: true, phoneNumberId: true },
        });
        if (accByPhone?.accessToken && accByPhone?.phoneNumberId) {
            return { accessToken: accByPhone.accessToken, phoneNumberId: accByPhone.phoneNumberId };
        }
    }
    const acc = await prisma_1.default.whatsappAccount.findFirst({
        where: { empresaId, accessToken: { not: '' } },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        select: { accessToken: true, phoneNumberId: true },
    });
    if (!acc?.accessToken || !acc?.phoneNumberId) {
        throw new Error(`[WA] Cuenta de WhatsApp no conectada para empresaId=${empresaId}.`);
    }
    return { accessToken: acc.accessToken, phoneNumberId: acc.phoneNumberId };
}
function sanitizePhone(to) {
    return String(to).replace(/\D+/g, '');
}
function clampCaption(c) {
    if (!c)
        return undefined;
    return c.length > 1024 ? c.slice(0, 1024) : c;
}
async function persistMediaMessage(opts) {
    const { conversationId, empresaId, from, outboundId, type, mediaId = null, mediaUrl = null, caption = null, mimeType = null, } = opts;
    if (!conversationId)
        return;
    try {
        await prisma_1.default.message.create({
            data: {
                conversationId,
                empresaId,
                from,
                contenido: caption ??
                    (type === 'image'
                        ? '[imagen]'
                        : type === 'video'
                            ? '[video]'
                            : type === 'audio'
                                ? '[nota de voz]'
                                : '[documento]'),
                externalId: outboundId || undefined,
                mediaType: type,
                mediaId,
                mediaUrl,
                mimeType,
                caption,
            },
        });
    }
    catch (e) {
        console.warn('[WA persistMediaMessage] No se pudo guardar el mensaje en DB:', e);
    }
}
/* ===================== Text ===================== */
async function sendText({ empresaId, to, body, conversationId, phoneNumberIdHint, }) {
    const { accessToken, phoneNumberId } = await getWhatsappCreds(empresaId, phoneNumberIdHint);
    const url = `https://graph.facebook.com/${FB_VERSION}/${phoneNumberId}/messages`;
    const toSanitized = sanitizePhone(to);
    const payload = { messaging_product: 'whatsapp', to: toSanitized, type: 'text', text: { body } };
    try {
        const { data } = await http.post(url, payload, {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        const outboundId = data?.messages?.[0]?.id ?? null;
        console.log('[WA SEND text][OK]', { to: toSanitized, outboundId });
        if (conversationId) {
            try {
                await prisma_1.default.message.create({
                    data: {
                        conversationId,
                        empresaId,
                        from: 'bot',
                        contenido: body,
                        externalId: outboundId || undefined,
                    },
                });
            }
            catch (e) {
                console.warn('[WA sendText] No se pudo guardar el mensaje en DB:', e);
            }
        }
        return { type: 'text', data, outboundId };
    }
    catch (e) {
        console.error('[WA sendText][ERROR]', e?.response?.data || e.message);
        throw e;
    }
}
/* ===================== Media (por LINK) ===================== */
async function sendWhatsappMedia({ empresaId, to, url, type, caption, conversationId, mimeType, phoneNumberIdHint, }) {
    if (!to)
        throw new Error('Destino (to) requerido');
    if (!url)
        throw new Error('URL de media requerida');
    const { accessToken, phoneNumberId } = await getWhatsappCreds(empresaId, phoneNumberIdHint);
    const endpoint = `https://graph.facebook.com/${FB_VERSION}/${phoneNumberId}/messages`;
    const toSanitized = sanitizePhone(to);
    const safeCaption = clampCaption(caption);
    const payload = {
        messaging_product: 'whatsapp',
        to: toSanitized,
        type,
        [type]: {
            link: url,
            ...(safeCaption ? { caption: safeCaption } : {}),
        },
    };
    try {
        const { data } = await http.post(endpoint, payload, {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        const outboundId = data?.messages?.[0]?.id ?? null;
        console.log('[WA SEND media][OK]', { to: toSanitized, type, outboundId });
        await persistMediaMessage({
            conversationId,
            empresaId,
            from: 'bot',
            outboundId,
            type,
            mediaUrl: url,
            caption: safeCaption ?? null,
            mimeType: mimeType ?? null,
        });
        return { type: 'media', data, outboundId };
    }
    catch (e) {
        console.error('[WA sendWhatsappMedia][ERROR]', e?.response?.data || e.message);
        throw e;
    }
}
/* ===================== Media (por MEDIA_ID) ===================== */
async function sendWhatsappMediaById({ empresaId, to, type, mediaId, caption, conversationId, mimeType, phoneNumberIdHint, }) {
    if (!to)
        throw new Error('Destino (to) requerido');
    if (!mediaId)
        throw new Error('mediaId requerido');
    const { accessToken, phoneNumberId } = await getWhatsappCreds(empresaId, phoneNumberIdHint);
    const endpoint = `https://graph.facebook.com/${FB_VERSION}/${phoneNumberId}/messages`;
    const toSanitized = sanitizePhone(to);
    const safeCaption = clampCaption(caption);
    const payload = {
        messaging_product: 'whatsapp',
        to: toSanitized,
        type,
        [type]: {
            id: mediaId,
            ...(safeCaption ? { caption: safeCaption } : {}),
        },
    };
    try {
        const { data } = await http.post(endpoint, payload, {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        const outboundId = data?.messages?.[0]?.id ?? null;
        console.log('[WA SEND mediaById][OK]', { to: toSanitized, type, outboundId });
        await persistMediaMessage({
            conversationId,
            empresaId,
            from: 'bot',
            outboundId,
            type,
            mediaId,
            caption: safeCaption ?? null,
            mimeType: mimeType ?? null,
        });
        return { type: 'media', data, outboundId };
    }
    catch (e) {
        console.error('[WA sendWhatsappMediaById][ERROR]', e?.response?.data || e.message);
        throw e;
    }
}
/* ====== Subir archivo a WhatsApp /media (devuelve media_id) ====== */
async function uploadToWhatsappMedia(empresaId, filePath, mimeType) {
    const { accessToken, phoneNumberId } = await getWhatsappCreds(empresaId);
    const form = new form_data_1.default();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mimeType);
    form.append('file', fs_1.default.createReadStream(filePath));
    try {
        const { data } = await axios_1.default.post(`https://graph.facebook.com/${FB_VERSION}/${phoneNumberId}/media`, form, {
            headers: { Authorization: `Bearer ${accessToken}`, ...form.getHeaders() },
            timeout: 30000,
        });
        return data?.id;
    }
    catch (e) {
        console.error('[WA uploadToWhatsappMedia][ERROR]', e?.response?.data || e.message);
        throw e;
    }
}
async function getMediaMeta(empresaId, mediaId) {
    const { accessToken } = await getWhatsappCreds(empresaId);
    const { data } = await axios_1.default.get(`https://graph.facebook.com/${FB_VERSION}/${mediaId}`, {
        params: { fields: 'url,mime_type,file_size,sha256' },
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 15000,
    });
    return data;
}
async function getMediaUrl(empresaId, mediaId) {
    const meta = await getMediaMeta(empresaId, mediaId);
    return meta.url;
}
async function downloadMediaToBuffer(empresaId, mediaUrl) {
    const { accessToken } = await getWhatsappCreds(empresaId);
    const { data } = await axios_1.default.get(mediaUrl, {
        responseType: 'arraybuffer',
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 30000,
    });
    return Buffer.from(data);
}
async function downloadMediaByIdToBuffer(empresaId, mediaId) {
    const meta = await getMediaMeta(empresaId, mediaId);
    const { accessToken } = await getWhatsappCreds(empresaId);
    const resp = await axios_1.default.get(meta.url, {
        responseType: 'arraybuffer',
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 30000,
    });
    const mimeType = resp.headers['content-type'];
    const fileSize = Number(resp.headers['content-length'] || meta.file_size || 0);
    return { buffer: Buffer.from(resp.data), mimeType, fileSize };
}
/* ===================== Template ===================== */
async function sendTemplate({ empresaId, to, templateName, templateLang, variables = [], phoneNumberIdHint, }) {
    const { accessToken, phoneNumberId } = await getWhatsappCreds(empresaId, phoneNumberIdHint);
    const url = `https://graph.facebook.com/${FB_VERSION}/${phoneNumberId}/messages`;
    const toSanitized = sanitizePhone(to);
    const components = variables.length
        ? [{ type: 'body', parameters: variables.map((t) => ({ type: 'text', text: t })) }]
        : undefined;
    const payload = {
        messaging_product: 'whatsapp',
        to: toSanitized,
        type: 'template',
        template: {
            name: templateName,
            language: { code: templateLang },
            ...(components ? { components } : {}),
        },
    };
    try {
        const { data } = await http.post(url, payload, {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        const outboundId = data?.messages?.[0]?.id ?? null;
        console.log('[WA SEND template][OK]', { to: toSanitized, outboundId });
        return { type: 'template', data, outboundId };
    }
    catch (e) {
        console.error('[WA sendTemplate][ERROR]', e?.response?.data || e.message);
        throw e;
    }
}
/* ===================== Facade y alias ===================== */
async function sendOutboundMessage(args) {
    const { empresaId, to, body, conversationId, phoneNumberIdHint } = args;
    if (!body?.trim()) {
        const err = new Error('EMPTY_BODY');
        err.status = 400;
        throw err;
    }
    return sendText({ empresaId, to, body, conversationId, phoneNumberIdHint });
}
// Alias
exports.sendWhatsappMessage = sendText;
/* ===================== Atajos útiles ===================== */
async function sendVoiceNoteByLink(opts) {
    return sendWhatsappMedia({ ...opts, type: 'audio' });
}
async function sendImageByLink(opts) {
    return sendWhatsappMedia({ ...opts, type: 'image' });
}
async function sendVideoByLink(opts) {
    return sendWhatsappMedia({ ...opts, type: 'video' });
}
