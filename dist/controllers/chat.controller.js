"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.crearConversacion = exports.cerrarConversacion = exports.updateConversationEstado = exports.responderConIA = exports.iniciarChat = exports.postMessageToConversation = exports.responderManual = exports.getMessagesByConversation = exports.getConversations = void 0;
const prisma_1 = __importDefault(require("../lib/prisma"));
const client_1 = require("@prisma/client");
const handleIAReply_1 = require("../utils/handleIAReply");
const whatsapp_service_1 = require("../services/whatsapp.service");
// 🆕 importar el firmador de URLs cortas para media
const whatsapp_controller_1 = require("./whatsapp.controller");
// Helper para socket
const getIO = (req) => req.app.get('io');
// 🆕 helper: si hay mediaId y no hay mediaUrl público, genera URL firmada del proxy
function withSignedMediaUrl(m, empresaId) {
    const mediaUrl = (m.mediaUrl || '').trim();
    if ((!mediaUrl || mediaUrl.length === 0) && m.mediaId) {
        const t = (0, whatsapp_controller_1.signMediaToken)(empresaId, String(m.mediaId));
        return {
            ...m,
            mediaUrl: `/api/whatsapp/media/${m.mediaId}?t=${encodeURIComponent(t)}`,
        };
    }
    return m;
}
// ——————————————————————————————
// GET conversaciones
// ——————————————————————————————
const getConversations = async (req, res) => {
    const empresaId = req.user?.empresaId;
    try {
        const conversations = await prisma_1.default.conversation.findMany({
            where: { empresaId },
            orderBy: { createdAt: 'desc' },
            include: {
                mensajes: {
                    orderBy: { timestamp: 'desc' },
                    take: 1,
                },
            },
        });
        const formatted = conversations.map((c) => ({
            id: c.id,
            nombre: c.nombre ?? c.phone,
            mensaje: c.mensajes[0]?.contenido ?? '',
            estado: c.estado,
            fecha: c.mensajes[0]?.timestamp?.toISOString() ?? '',
        }));
        res.json(formatted);
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al obtener conversaciones' });
    }
};
exports.getConversations = getConversations;
// ——————————————————————————————
// GET mensajes de una conversación (paginado)
// ——————————————————————————————
const getMessagesByConversation = async (req, res) => {
    const empresaId = req.user?.empresaId;
    const { id } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;
    try {
        const conv = await prisma_1.default.conversation.findUnique({ where: { id: Number(id) } });
        if (!conv || conv.empresaId !== empresaId) {
            return res.status(403).json({ error: 'No autorizado para ver esta conversación' });
        }
        const total = await prisma_1.default.message.count({ where: { conversationId: conv.id } });
        const messages = await prisma_1.default.message.findMany({
            where: { conversationId: conv.id },
            orderBy: { timestamp: 'asc' },
            skip,
            take: limit,
            // Nota: no cambiamos tu select; asumimos que message incluye mediaId/mediaUrl si existen
        });
        // 🆕: firmar mediaUrl cuando solo tenemos mediaId (necesario para <img>/<video>)
        const messagesSigned = messages.map((m) => withSignedMediaUrl(m, empresaId));
        res.json({
            messages: messagesSigned,
            pagination: { total, page, limit, hasMore: skip + limit < total },
        });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al obtener mensajes' });
    }
};
exports.getMessagesByConversation = getMessagesByConversation;
// ——————————————————————————————
// POST enviar mensaje manual del agente
// Evita duplicado/rol 'bot': NO pases conversationId al service.
// Persiste tú como AGENTE.
// ——————————————————————————————
const responderManual = async (req, res) => {
    const { id } = req.params;
    const { contenido } = req.body;
    const empresaId = req.user?.empresaId;
    if (!contenido?.trim()) {
        return res.status(400).json({ error: 'El contenido del mensaje es requerido' });
    }
    try {
        const conv = await prisma_1.default.conversation.findUnique({ where: { id: Number(id) } });
        if (!conv || conv.empresaId !== empresaId) {
            return res.status(403).json({ error: 'No autorizado para responder esta conversación' });
        }
        // 1) Enviar a WhatsApp (NO pasar conversationId para evitar persistencia automática como 'bot')
        await (0, whatsapp_service_1.sendOutboundMessage)({
            empresaId: conv.empresaId,
            to: conv.phone,
            body: contenido,
            // no conversationId !
        });
        // 2) Persistir como AGENTE en nuestra DB
        const message = await prisma_1.default.message.create({
            data: {
                conversationId: conv.id,
                empresaId: conv.empresaId,
                from: client_1.MessageFrom.agent,
                contenido,
                timestamp: new Date(),
            },
        });
        // 3) Actualizar estado (ajusta a tu gusto)
        await prisma_1.default.conversation.update({
            where: { id: conv.id },
            data: { estado: client_1.ConversationEstado.respondido },
        });
        // 4) Emitir socket en el formato que tu frontend espera
        const io = getIO(req);
        io?.emit?.('nuevo_mensaje', {
            conversationId: conv.id,
            message,
        });
        res.status(200).json({ success: true, message });
    }
    catch (err) {
        console.error('Error al guardar respuesta manual:', err?.response?.data || err.message);
        res.status(500).json({ error: 'Error al guardar el mensaje' });
    }
};
exports.responderManual = responderManual;
// ——————————————————————————————
// POST responder (si quieres mantener esta variante genérica)
// Igual que arriba: NO pasar conversationId al service.
// ——————————————————————————————
const postMessageToConversation = async (req, res) => {
    const empresaId = req.user?.empresaId;
    const { id } = req.params;
    const { contenido } = req.body;
    if (!contenido?.trim()) {
        return res.status(400).json({ error: 'El mensaje no puede estar vacío' });
    }
    try {
        const conv = await prisma_1.default.conversation.findUnique({ where: { id: Number(id) } });
        if (!conv || conv.empresaId !== empresaId) {
            return res.status(403).json({ error: 'No autorizado para responder esta conversación' });
        }
        await (0, whatsapp_service_1.sendOutboundMessage)({
            empresaId: conv.empresaId,
            to: conv.phone,
            body: contenido,
            // no conversationId !
        });
        const message = await prisma_1.default.message.create({
            data: {
                conversationId: conv.id,
                empresaId: conv.empresaId,
                from: client_1.MessageFrom.agent,
                contenido,
                timestamp: new Date(),
            },
        });
        await prisma_1.default.conversation.update({
            where: { id: conv.id },
            data: { estado: client_1.ConversationEstado.respondido },
        });
        const io = getIO(req);
        io?.emit?.('nuevo_mensaje', {
            conversationId: conv.id,
            message,
        });
        res.status(201).json({ message });
    }
    catch (error) {
        console.error(error?.response?.data || error);
        res.status(500).json({ error: 'Error al enviar o guardar el mensaje' });
    }
};
exports.postMessageToConversation = postMessageToConversation;
// ——————————————————————————————
// POST iniciar chat con plantilla (fuera de 24h)
// Usa sendTemplate (tu service ya lo expone).
// ——————————————————————————————
const iniciarChat = async (req, res) => {
    try {
        const { conversationId, empresaId, to, templateName, templateLang, variables = [], } = req.body;
        if (!templateName || !templateLang) {
            return res.status(409).json({
                ok: false,
                reason: 'template_required',
                message: 'Para iniciar conversaciones fuera de 24h necesitas una plantilla aprobada.',
            });
        }
        let convId = conversationId;
        if (!convId) {
            const conv = await prisma_1.default.conversation.create({
                data: { empresaId, phone: to, estado: client_1.ConversationEstado.pendiente },
            });
            convId = conv.id;
        }
        const result = await (0, whatsapp_service_1.sendTemplate)({
            empresaId,
            to,
            templateName,
            templateLang,
            variables,
        });
        return res.json({ ok: true, conversationId: convId, result });
    }
    catch (error) {
        const msg = error?.response?.data || error?.message || error;
        if (error?.status === 409 || /OUT_OF_24H_WINDOW/i.test(String(msg))) {
            return res.status(409).json({
                ok: false,
                reason: 'out_of_24h',
                message: 'La ventana de 24h está cerrada; usa una plantilla para responder.',
            });
        }
        console.error('[iniciarChat] error:', msg);
        return res.status(500).json({ ok: false, message: 'Error iniciando chat con plantilla' });
    }
};
exports.iniciarChat = iniciarChat;
// ——————————————————————————————
// IA (sin cambios de tipos)
// ——————————————————————————————
const responderConIA = async (req, res) => {
    const { chatId, mensaje, intentosFallidos = 0 } = req.body;
    const empresaId = req.user?.empresaId;
    try {
        const conv = await prisma_1.default.conversation.findUnique({ where: { id: Number(chatId) } });
        if (!conv || conv.empresaId !== empresaId) {
            return res.status(403).json({ error: 'No autorizado para responder esta conversación' });
        }
        const result = await (0, handleIAReply_1.handleIAReply)(chatId, mensaje);
        if (!result)
            return res.status(400).json({ error: 'No se pudo generar respuesta con IA' });
        if (result.estado === client_1.ConversationEstado.requiere_agente) {
            return res.json({
                estado: client_1.ConversationEstado.requiere_agente,
                mensaje: 'Chat marcado como requiere atención humana',
            });
        }
        return res.json({ mensaje: result.mensaje });
    }
    catch (err) {
        console.error('Error al responder con IA:', err);
        return res.status(500).json({ error: 'Error al procesar respuesta de IA' });
    }
};
exports.responderConIA = responderConIA;
// ——————————————————————————————
// Cambiar estado conversación
// ——————————————————————————————
const updateConversationEstado = async (req, res) => {
    const { id } = req.params;
    const { estado } = req.body;
    const empresaId = req.user?.empresaId;
    if (!estado || !Object.values(client_1.ConversationEstado).includes(estado)) {
        return res.status(400).json({ error: 'Estado inválido' });
    }
    try {
        const conv = await prisma_1.default.conversation.findUnique({ where: { id: Number(id) } });
        if (!conv || conv.empresaId !== empresaId) {
            return res.status(403).json({ error: 'No autorizado para modificar esta conversación' });
        }
        const updated = await prisma_1.default.conversation.update({
            where: { id: conv.id },
            data: { estado },
        });
        return res.json({ success: true, estado: updated.estado });
    }
    catch (err) {
        console.error('❌ Error actualizando estado:', err);
        return res.status(500).json({ error: 'Error actualizando estado de la conversación' });
    }
};
exports.updateConversationEstado = updateConversationEstado;
// ——————————————————————————————
// Cerrar conversación
// ——————————————————————————————
const cerrarConversacion = async (req, res) => {
    const { id } = req.params;
    const empresaId = req.user?.empresaId;
    try {
        const conv = await prisma_1.default.conversation.findUnique({ where: { id: Number(id) } });
        if (!conv || conv.empresaId !== empresaId) {
            return res.status(403).json({ error: 'No autorizado para cerrar esta conversación' });
        }
        const updated = await prisma_1.default.conversation.update({
            where: { id: conv.id },
            data: { estado: client_1.ConversationEstado.cerrado },
        });
        const io = getIO(req);
        io?.emit?.('chat_actualizado', { id: updated.id, estado: updated.estado });
        res.status(200).json({ success: true });
    }
    catch (err) {
        console.error('Error al cerrar conversación:', err);
        res.status(500).json({ error: 'No se pudo cerrar la conversación' });
    }
};
exports.cerrarConversacion = cerrarConversacion;
// ——————————————————————————————
// Crear conversación (desde dashboard)
// ——————————————————————————————
const crearConversacion = async (req, res) => {
    const { phone, nombre } = req.body;
    const empresaId = req.user?.empresaId;
    if (!empresaId)
        return res.status(401).json({ error: 'No autorizado' });
    if (!phone?.trim())
        return res.status(400).json({ error: 'El número de teléfono es obligatorio' });
    try {
        const nueva = await prisma_1.default.conversation.create({
            data: {
                phone,
                nombre: nombre?.trim() || null,
                estado: client_1.ConversationEstado.pendiente,
                empresaId,
            },
        });
        // Opcional: emite a la lista de chats si quieres que aparezca en tiempo real
        const io = req.app.get('io');
        io?.emit?.('chat_actualizado', { id: nueva.id, estado: nueva.estado });
        return res.status(201).json({ message: 'Conversación creada', chat: nueva });
    }
    catch (err) {
        console.error('[crearConversacion] Error:', err);
        return res.status(500).json({ error: 'Error al crear la conversación' });
    }
};
exports.crearConversacion = crearConversacion;
