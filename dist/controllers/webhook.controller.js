"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.receiveWhatsappMessage = exports.verifyWebhook = void 0;
const prisma_1 = __importDefault(require("../lib/prisma"));
const handleIAReply_1 = require("../utils/handleIAReply");
const client_1 = require("@prisma/client");
const whatsapp_service_1 = require("../services/whatsapp.service");
const transcription_service_1 = require("../services/transcription.service");
const mediaProxy_route_1 = require("../routes/mediaProxy.route"); // 👈 proxy firmado
// ⬇️ Cachear imágenes en Cloudflare Images
const cacheWhatsappMedia_1 = require("../utils/cacheWhatsappMedia"); // 👈 limpiamos foco al (re)abrir conv
// GET /api/webhook  (verificación con token)
const verifyWebhook = (req, res) => {
    const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        console.log('🟢 Webhook verificado correctamente');
        return res.status(200).send(challenge ?? '');
    }
    else {
        console.warn('🔴 Verificación de webhook fallida');
        return res.sendStatus(403);
    }
};
exports.verifyWebhook = verifyWebhook;
// POST /api/webhook  (recepción de eventos)
const receiveWhatsappMessage = async (req, res) => {
    console.log('📩 Webhook recibido:', JSON.stringify(req.body, null, 2));
    try {
        const entry = req.body?.entry?.[0];
        const change = entry?.changes?.[0];
        const value = change?.value;
        // 1) STATUS callbacks de mensajes salientes
        if (value?.statuses?.length) {
            const io = req.app.get('io');
            for (const st of value.statuses) {
                const codes = (st.errors || []).map((e) => e.code);
                console.log('[WA status]', { recipient: st.recipient_id, status: st.status, codes });
                if (st.status === 'failed') {
                    io?.emit?.('wa_policy_error', {
                        conversationId: await resolveConversationIdByWaId(req, st.recipient_id),
                        code: codes?.[0],
                        message: 'Ventana de 24h cerrada o error de política. Se requiere plantilla para iniciar la conversación.',
                    });
                }
            }
            return res.status(200).json({ handled: 'statuses' });
        }
        // 2) MENSAJE ENTRANTE REAL
        if (!value?.messages?.[0])
            return res.status(200).json({ ignored: true });
        const msg = value.messages[0];
        const phoneNumberId = value?.metadata?.phone_number_id;
        const fromWa = msg.from;
        const ts = msg.timestamp ? new Date(parseInt(msg.timestamp, 10) * 1000) : new Date();
        if (!phoneNumberId || !fromWa)
            return res.status(200).json({ ignored: true });
        // Empresa / cuenta
        const cuenta = await prisma_1.default.whatsappAccount.findUnique({
            where: { phoneNumberId },
            include: { empresa: true },
        });
        if (!cuenta || cuenta.empresa.estado !== 'activo') {
            console.warn(`⚠️ Empresa inactiva o no encontrada para el número: ${phoneNumberId}`);
            return res.status(200).json({ ignored: true });
        }
        const empresaId = cuenta.empresaId;
        // Conversación
        let conversation = await prisma_1.default.conversation.findFirst({ where: { phone: fromWa, empresaId } });
        if (!conversation) {
            conversation = await prisma_1.default.conversation.create({
                data: { phone: fromWa, estado: client_1.ConversationEstado.pendiente, empresaId },
            });
            // 🧠 limpiar foco por si acaso (nueva conv)
            (0, cacheWhatsappMedia_1.clearFocus)(conversation.id);
            console.log('[CONV] creada', { id: conversation.id, phone: fromWa });
        }
        else if (conversation.estado === client_1.ConversationEstado.cerrado) {
            await prisma_1.default.conversation.update({
                where: { id: conversation.id },
                data: { estado: client_1.ConversationEstado.pendiente },
            });
            conversation.estado = client_1.ConversationEstado.pendiente;
            // 🧠 limpiar foco al reabrir
            (0, cacheWhatsappMedia_1.clearFocus)(conversation.id);
            console.log('[CONV] reabierta', { id: conversation.id });
        }
        // ----- Contenido base (texto/botones)
        let contenido = msg.text?.body ||
            msg.button?.text ||
            msg.interactive?.list_reply?.title ||
            '[mensaje no soportado]';
        // ----- Campos de media a persistir/emitir
        let inboundMediaType;
        let inboundMediaId;
        let inboundMime;
        let transcription;
        let isVoiceNote = false;
        let mediaUrlForFrontend;
        let captionForDb;
        // ⚐ Flag para decidir si llamamos a IA en este webhook
        let skipIAForThisWebhook = false;
        // 🔊 NOTA DE VOZ / AUDIO
        if (msg.type === 'audio' && msg.audio?.id) {
            inboundMediaType = client_1.MediaType.audio;
            inboundMediaId = String(msg.audio.id);
            inboundMime = msg.audio?.mime_type;
            isVoiceNote = Boolean(msg.audio?.voice);
            try {
                const signedUrl = await (0, whatsapp_service_1.getMediaUrl)(empresaId, inboundMediaId);
                const buf = await (0, whatsapp_service_1.downloadMediaToBuffer)(empresaId, signedUrl);
                const guessedName = inboundMime?.includes('mp3') ? 'nota-voz.mp3'
                    : inboundMime?.includes('wav') ? 'nota-voz.wav'
                        : inboundMime?.includes('m4a') ? 'nota-voz.m4a'
                            : inboundMime?.includes('webm') ? 'nota-voz.webm'
                                : 'nota-voz.ogg';
                const texto = await (0, transcription_service_1.transcribeAudioBuffer)(buf, guessedName);
                transcription = (texto || '').trim();
            }
            catch (e) {
                console.warn('[AUDIO] No se pudo transcribir.', e);
            }
            contenido = transcription || '[nota de voz]';
            if (inboundMediaId)
                mediaUrlForFrontend = (0, mediaProxy_route_1.buildSignedMediaURL)(inboundMediaId, empresaId);
            // 🛈 Para audio sí dejamos pasar a IA (tu lógica ya trata el caso sin transcripción)
        }
        // 🖼️ IMAGEN (➡️ cache a Cloudflare Images con fallback al proxy)
        else if (msg.type === 'image' && msg.image?.id) {
            inboundMediaType = client_1.MediaType.image;
            inboundMediaId = String(msg.image.id);
            inboundMime = msg.image?.mime_type;
            captionForDb = msg.image?.caption || undefined;
            contenido = captionForDb || '[imagen]';
            // 1) Intentar cachear en Cloudflare Images
            try {
                const accessToken = cuenta.accessToken; // ya lo tienes en la cuenta
                const { url } = await (0, cacheWhatsappMedia_1.cacheWhatsappMediaToCloudflare)({
                    waMediaId: inboundMediaId,
                    accessToken,
                });
                mediaUrlForFrontend = url; // URL pública de CF Images (variant)
            }
            catch (err) {
                console.warn('[IMAGE] cache CF falló, uso proxy firmado:', err?.message || err);
                // 2) Fallback a tu proxy firmado
                if (inboundMediaId)
                    mediaUrlForFrontend = (0, mediaProxy_route_1.buildSignedMediaURL)(inboundMediaId, empresaId);
            }
            // ❗ Clave: si es imagen SIN caption ⇒ NO llamar IA en este webhook
            if (!captionForDb) {
                skipIAForThisWebhook = true;
            }
        }
        // 🎞️ VIDEO (se mantiene proxy firmado)
        else if (msg.type === 'video' && msg.video?.id) {
            inboundMediaType = client_1.MediaType.video;
            inboundMediaId = String(msg.video.id);
            inboundMime = msg.video?.mime_type;
            captionForDb = msg.video?.caption || undefined;
            contenido = captionForDb || '[video]';
            if (inboundMediaId)
                mediaUrlForFrontend = (0, mediaProxy_route_1.buildSignedMediaURL)(inboundMediaId, empresaId);
            // (opcional) si quieres el mismo comportamiento que imagen:
            // if (!captionForDb) skipIAForThisWebhook = true
        }
        // 📎 DOCUMENTO (se mantiene proxy firmado)
        else if (msg.type === 'document' && msg.document?.id) {
            inboundMediaType = client_1.MediaType.document;
            inboundMediaId = String(msg.document.id);
            inboundMime = msg.document?.mime_type;
            const filename = msg.document?.filename || undefined;
            captionForDb = filename;
            contenido = filename ? `[documento] ${filename}` : '[documento]';
            if (inboundMediaId)
                mediaUrlForFrontend = (0, mediaProxy_route_1.buildSignedMediaURL)(inboundMediaId, empresaId);
            // (opcional) mismo criterio que imagen/video:
            // if (!captionForDb) skipIAForThisWebhook = true
        }
        // Guardar ENTRANTE (🔁 ahora también persistimos mediaUrl si existe)
        const inboundData = {
            conversationId: conversation.id,
            empresaId,
            from: client_1.MessageFrom.client,
            contenido,
            timestamp: ts,
            mediaType: inboundMediaType,
            mediaId: inboundMediaId,
            mediaUrl: mediaUrlForFrontend, // 👈 CF o proxy
            mimeType: inboundMime,
            transcription: transcription || undefined,
        };
        if (captionForDb)
            inboundData.caption = captionForDb;
        if (process.env.FEATURE_ISVOICENOTE === '1')
            inboundData.isVoiceNote = Boolean(isVoiceNote);
        const inbound = await prisma_1.default.message.create({ data: inboundData });
        console.log('[INBOUND] guardado', {
            id: inbound.id,
            conv: conversation.id,
            type: inboundMediaType || 'text',
            mediaId: inboundMediaId,
        });
        // Emitir ENTRANTE al frontend
        const io = req.app.get('io');
        io?.emit?.('nuevo_mensaje', {
            conversationId: conversation.id,
            message: {
                id: inbound.id,
                externalId: inbound.externalId ?? null,
                from: 'client',
                contenido,
                timestamp: inbound.timestamp.toISOString(),
                mediaType: inboundMediaType,
                mediaUrl: mediaUrlForFrontend,
                mimeType: inboundMime,
                transcription,
                isVoiceNote,
                caption: captionForDb,
                mediaId: inboundMediaId,
            },
            phone: conversation.phone,
            nombre: conversation.nombre ?? conversation.phone,
            estado: conversation.estado,
        });
        // ----- Evitar falso escalado con audio sin transcripción
        const skipEscalateForAudioNoTranscript = (msg.type === 'audio' && !transcription);
        // 3) IA → RESPUESTA (auto envía y persiste)
        // 👇 Si es imagen SIN caption, NO invocamos IA (esperamos el texto siguiente)
        if (skipIAForThisWebhook) {
            if (process.env.DEBUG_AI === '1') {
                console.log('[IA] Skip: imagen sin caption; esperamos texto para responder.');
            }
            return res.status(200).json({ success: true, skipped: 'image_without_caption' });
        }
        console.log('[IA] Llamando handleIAReply con:', {
            conversationId: conversation.id,
            empresaId,
            toPhone: conversation.phone,
            phoneNumberId,
            contenido,
        });
        let result;
        try {
            result = await (0, handleIAReply_1.handleIAReply)(conversation.id, contenido, {
                autoSend: true,
                toPhone: conversation.phone,
                phoneNumberId,
            });
            if (skipEscalateForAudioNoTranscript &&
                result?.estado === client_1.ConversationEstado.requiere_agente &&
                result?.motivo === 'palabra_clave') {
                result = {
                    estado: client_1.ConversationEstado.en_proceso,
                    mensaje: 'No pude escuchar bien tu nota de voz. ¿Puedes repetir o escribir lo que necesitas?',
                    messageId: undefined,
                };
            }
        }
        catch (e) {
            console.error('[IA] handleIAReply lanzó error:', e?.response?.data || e?.message || e);
            result = {
                estado: client_1.ConversationEstado.en_proceso,
                mensaje: 'Gracias por tu mensaje. ¿Podrías darme un poco más de contexto?',
                messageId: undefined,
            };
        }
        console.log('[IA] Resultado handleIAReply:', {
            estado: result?.estado,
            messageId: result?.messageId,
            wamid: result?.wamid,
            mediaCount: result?.media?.length || 0,
            mensaje: result?.mensaje,
        });
        // 4) Persistir/emitir SIEMPRE la respuesta del bot (con fallback)
        let botMessageId = result?.messageId ?? undefined;
        let botContenido = (result?.mensaje || '').trim();
        if (botContenido && !botMessageId) {
            const creadoFallback = await prisma_1.default.message.create({
                data: {
                    conversationId: conversation.id,
                    empresaId,
                    from: client_1.MessageFrom.bot,
                    contenido: botContenido,
                    timestamp: new Date(),
                },
            });
            botMessageId = creadoFallback.id;
            console.log('[BOT] persistido fallback', { id: botMessageId });
        }
        if (botContenido && botMessageId) {
            const creado = await prisma_1.default.message.findUnique({ where: { id: botMessageId } });
            if (result?.estado && result.estado !== conversation.estado) {
                await prisma_1.default.conversation.update({
                    where: { id: conversation.id },
                    data: { estado: result.estado },
                });
                conversation.estado = result.estado;
                console.log('[CONV] estado actualizado por IA', { id: conversation.id, estado: conversation.estado });
            }
            if (creado) {
                io?.emit?.('nuevo_mensaje', {
                    conversationId: conversation.id,
                    message: {
                        id: creado.id,
                        externalId: creado.externalId ?? null,
                        from: 'bot',
                        contenido: creado.contenido,
                        timestamp: creado.timestamp.toISOString(),
                    },
                    estado: conversation.estado,
                });
            }
        }
        // 5) Si el handler envió imágenes de productos, emítelas también
        if (result?.media?.length) {
            const wamids = result.media
                .map(m => m.wamid)
                .filter(Boolean);
            if (wamids.length) {
                const medias = await prisma_1.default.message.findMany({
                    where: {
                        conversationId: conversation.id,
                        from: client_1.MessageFrom.bot,
                        externalId: { in: wamids },
                    },
                    orderBy: { id: 'asc' },
                    select: {
                        id: true,
                        externalId: true,
                        mediaType: true,
                        mediaUrl: true,
                        caption: true,
                        timestamp: true,
                    }
                });
                for (const m of medias) {
                    io?.emit?.('nuevo_mensaje', {
                        conversationId: conversation.id,
                        message: {
                            id: m.id,
                            externalId: m.externalId ?? null,
                            from: 'bot',
                            contenido: '', // el texto va en caption
                            mediaType: m.mediaType,
                            mediaUrl: m.mediaUrl,
                            caption: m.caption,
                            timestamp: m.timestamp.toISOString(),
                        },
                    });
                }
            }
        }
        return res.status(200).json({ success: true });
    }
    catch (error) {
        console.error('[receiveWhatsappMessage] Error:', error);
        return res.status(500).json({ error: 'Error al recibir mensaje' });
    }
};
exports.receiveWhatsappMessage = receiveWhatsappMessage;
// Ayudante: mapear wa_id (cliente) a conversationId
async function resolveConversationIdByWaId(_req, waId) {
    try {
        const conv = await prisma_1.default.conversation.findFirst({ where: { phone: waId } });
        return conv?.id ?? null;
    }
    catch {
        return null;
    }
}
