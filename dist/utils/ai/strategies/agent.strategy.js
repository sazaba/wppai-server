"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleAgentReply = handleAgentReply;
const axios_1 = __importDefault(require("axios"));
const prisma_1 = __importDefault(require("../../../lib/prisma"));
const openai_1 = require("../../../lib/openai");
const client_1 = require("@prisma/client");
const Wam = __importStar(require("../../../services/whatsapp.service"));
const transcription_service_1 = require("../../../services/transcription.service");
/** Config imagen/texto */
const IMAGE_WAIT_MS = Number(process.env.IA_IMAGE_WAIT_MS ?? 1000); // 1s re-chequeo (no respondemos desde imagen sola)
const IMAGE_LOOKBACK_MS = Number(process.env.IA_IMAGE_LOOKBACK_MS ?? 5 * 60 * 1000); // 5min adjuntar imagen reciente
const REPLY_DEDUP_WINDOW_MS = Number(process.env.REPLY_DEDUP_WINDOW_MS ?? 120000); // 120s ventana idempotencia in-memory
/** ===== Respuesta breve (soft clamp) =====
 *  - Limitamos por líneas (no por caracteres) para evitar cortes a media frase.
 *  - El modelo ya viene breve por IA_MAX_TOKENS.
 */
const IA_MAX_LINES = Number(process.env.IA_MAX_LINES ?? 5); // líneas duras
const IA_MAX_CHARS = Number(process.env.IA_MAX_CHARS ?? 1000); // tope blando, no cortamos por chars
const IA_MAX_TOKENS = Number(process.env.IA_MAX_TOKENS ?? 100); // tokens del LLM (ligeramente más aire para cerrar frases)
const IA_ALLOW_EMOJI = (process.env.IA_ALLOW_EMOJI ?? '0') === '1';
// ===== Idempotencia por inbound (sin DB) =====
const processedInbound = new Map(); // messageId -> timestamp ms
function seenInboundRecently(messageId, windowMs = REPLY_DEDUP_WINDOW_MS) {
    const now = Date.now();
    const prev = processedInbound.get(messageId);
    if (prev && (now - prev) <= windowMs)
        return true;
    processedInbound.set(messageId, now);
    return false;
}
async function handleAgentReply(args) {
    const { chatId, empresaId, mensajeArg = '', toPhone, phoneNumberId, agent } = args;
    // 1) Conversación y último mensaje del cliente
    const conversacion = await prisma_1.default.conversation.findUnique({
        where: { id: chatId },
        select: { id: true, estado: true, phone: true },
    });
    if (!conversacion)
        return null;
    const last = await prisma_1.default.message.findFirst({
        where: { conversationId: chatId, from: client_1.MessageFrom.client },
        orderBy: { timestamp: 'desc' },
        select: {
            id: true,
            mediaType: true,
            mediaUrl: true,
            caption: true,
            isVoiceNote: true,
            transcription: true,
            contenido: true,
            mimeType: true,
            timestamp: true,
        },
    });
    if (process.env.DEBUG_AI === '1') {
        console.log('[AGENT] handleAgentReply enter', {
            chatId, empresaId,
            lastId: last?.id, lastTs: last?.timestamp, lastType: last?.mediaType,
            hasCaption: !!(last?.caption && String(last.caption).trim()),
            hasContenido: !!(last?.contenido && String(last.contenido).trim()),
            mensajeArgLen: (args.mensajeArg || '').length,
        });
    }
    // 🔒 Guard: si ya procesamos este inbound (last.id) recientemente, salir
    if (last?.id && seenInboundRecently(last.id)) {
        if (process.env.DEBUG_AI === '1')
            console.log('[AGENT] Skip: inbound already processed', { lastId: last.id });
        return null;
    }
    // 2) Config del negocio
    const [bc, empresa] = await Promise.all([
        prisma_1.default.businessConfig.findUnique({
            where: { empresaId },
            select: {
                agentSpecialty: true,
                agentPrompt: true,
                agentScope: true,
                agentDisclaimers: true,
                nombre: true,
            },
        }),
        prisma_1.default.empresa.findUnique({ where: { id: empresaId }, select: { nombre: true } }),
    ]);
    // 3) Preparar texto (prioriza transcripción si es nota de voz)
    let userText = (mensajeArg || '').trim();
    if (!userText && last?.isVoiceNote) {
        let transcript = (last.transcription || '').trim();
        if (!transcript) {
            try {
                let audioBuf = null;
                if (last.mediaUrl && /^https?:\/\//i.test(String(last.mediaUrl))) {
                    const { data } = await axios_1.default.get(String(last.mediaUrl), {
                        responseType: 'arraybuffer',
                        timeout: 30000,
                    });
                    audioBuf = Buffer.from(data);
                }
                if (audioBuf) {
                    const name = last.mimeType?.includes('mpeg') ? 'audio.mp3'
                        : last.mimeType?.includes('wav') ? 'audio.wav'
                            : last.mimeType?.includes('m4a') ? 'audio.m4a'
                                : last.mimeType?.includes('webm') ? 'audio.webm'
                                    : 'audio.ogg';
                    transcript = await (0, transcription_service_1.transcribeAudioBuffer)(audioBuf, name);
                    if (transcript) {
                        await prisma_1.default.message.update({ where: { id: last.id }, data: { transcription: transcript } });
                    }
                }
            }
            catch (e) {
                if (process.env.DEBUG_AI === '1')
                    console.error('[AGENT] Transcription error:', e?.message || e);
            }
        }
        if (transcript)
            userText = transcript;
    }
    const isImage = last?.mediaType === client_1.MediaType.image && !!last?.mediaUrl;
    const imageUrl = isImage ? String(last?.mediaUrl) : null;
    const caption = String(last?.caption || '').trim();
    // ====== Debounce por conversación ======
    if (isImage) {
        if (caption || userText) {
            if (last?.timestamp && shouldSkipDoubleReply(chatId, last.timestamp, REPLY_DEDUP_WINDOW_MS)) {
                if (process.env.DEBUG_AI === '1')
                    console.log('[AGENT] Skip (debounce): image+caption same webhook');
                return null;
            }
            const comboText = (userText || caption || '').trim() || 'Hola';
            const resp = await answerWithLLM({
                chatId,
                empresaId,
                agent,
                negocio: empresa,
                bc,
                userText: comboText,
                effectiveImageUrl: imageUrl,
                attachRecentIfTextOnly: false,
                lastIdToExcludeFromHistory: last?.id,
                toPhone,
                phoneNumberId,
            });
            if (last?.timestamp)
                markActuallyReplied(chatId, last.timestamp);
            return resp;
        }
        else {
            if (process.env.DEBUG_AI === '1')
                console.log('[AGENT] Image-only: defer to upcoming text');
            await sleep(IMAGE_WAIT_MS);
            return null;
        }
    }
    else {
        if (last?.timestamp && shouldSkipDoubleReply(chatId, last.timestamp, REPLY_DEDUP_WINDOW_MS)) {
            if (process.env.DEBUG_AI === '1')
                console.log('[AGENT] Skip (debounce): normal text flow');
            return null;
        }
    }
    // 5) System + presupuesto
    const negocioName = (bc?.nombre || empresa?.nombre || '').trim();
    const especialidad = (agent.specialty || bc?.agentSpecialty || 'generico');
    const persona = personaLabel(especialidad);
    const nameLine = negocioName
        ? `Asistente de orientación de ${humanSpecialty(especialidad)} de "${negocioName}".`
        : `Asistente de orientación de ${humanSpecialty(especialidad)}.`;
    const lineScope = softTrim(agent.scope || bc?.agentScope, 160);
    const lineDisc = softTrim(agent.disclaimers || bc?.agentDisclaimers, 160);
    const extraInst = softTrim(agent.prompt || bc?.agentPrompt, 220);
    const system = [
        nameLine,
        `Actúa como ${persona}. Habla en primera persona (yo), tono profesional y cercano.`,
        'Responde en 2–5 líneas, claro y empático. Sé específico y evita párrafos largos.',
        'Puedes usar 1 emoji ocasionalmente (no siempre).',
        'Si corresponde, puedes mencionar productos del negocio y su web.',
        `Mantente solo en ${humanSpecialty(especialidad)}; si preguntan fuera, indícalo y reconduce.`,
        lineScope ? `Ámbito: ${lineScope}` : '',
        lineDisc ? `Incluye cuando aplique: ${lineDisc}` : '',
        extraInst ? `Sigue estas instrucciones del negocio: ${extraInst}` : '',
    ].filter(Boolean).join('\n');
    // 6) Historial reciente
    const history = await getRecentHistory(chatId, last?.id, 10);
    // 7) Construcción de mensajes (adjunta imagen reciente si solo hay texto)
    let effectiveImageUrl = imageUrl;
    if (!effectiveImageUrl && userText) {
        const recentImage = await prisma_1.default.message.findFirst({
            where: {
                conversationId: chatId,
                from: client_1.MessageFrom.client,
                mediaType: client_1.MediaType.image,
                timestamp: { gte: new Date(Date.now() - IMAGE_LOOKBACK_MS) },
            },
            orderBy: { timestamp: 'desc' },
            select: { mediaUrl: true, caption: true },
        });
        if (recentImage?.mediaUrl) {
            effectiveImageUrl = String(recentImage.mediaUrl);
            if (!caption && recentImage.caption) {
                userText = `${userText}\n\nNota de la imagen: ${recentImage.caption}`;
            }
        }
    }
    const messages = [{ role: 'system', content: system }, ...history];
    if (effectiveImageUrl) {
        messages.push({
            role: 'user',
            content: [
                { type: 'text', text: userText || caption || 'Analiza la imagen con prudencia clínica y brinda orientación general.' },
                { type: 'image_url', image_url: { url: effectiveImageUrl } },
            ],
        });
    }
    else {
        messages.push({ role: 'user', content: userText || caption || 'Hola' });
    }
    // Presupuestar prompt total (incluye historial)
    budgetMessages(messages, Number(process.env.IA_PROMPT_BUDGET ?? 110));
    // 8) LLM con retry y salida corta (tokens)
    const model = process.env.IA_TEXT_MODEL || process.env.IA_MODEL || 'gpt-4o-mini';
    const temperature = Number(process.env.IA_TEMPERATURE ?? 0.35);
    const defaultMax = IA_MAX_TOKENS;
    let texto = '';
    try {
        texto = await runChatWithBudget({ model, messages, temperature, maxTokens: defaultMax });
    }
    catch (err) {
        console.error('[AGENT] OpenAI error (final):', err?.response?.data || err?.message || err);
        texto = 'Gracias por escribirnos. Podemos ayudarte con orientación general sobre tu consulta.';
    }
    // NUEVO: cerrar bonito si quedó cortado
    texto = closeNicely(texto);
    // 9) Post-formateo + marca/web (solo líneas)
    texto = clampConcise(texto, IA_MAX_LINES, IA_MAX_CHARS);
    texto = formatConcise(texto, IA_MAX_LINES, IA_MAX_CHARS, IA_ALLOW_EMOJI);
    const businessPrompt = (agent?.prompt && agent.prompt.trim()) ||
        (bc?.agentPrompt && bc.agentPrompt.trim()) ||
        undefined;
    texto = maybeInjectBrand(texto, businessPrompt);
    // 10) Persistir y responder
    const saved = await persistBotReply({
        conversationId: chatId,
        empresaId,
        texto,
        nuevoEstado: client_1.ConversationEstado.respondido,
        to: toPhone ?? conversacion.phone,
        phoneNumberId,
    });
    if (!isImage && last?.timestamp)
        markActuallyReplied(chatId, last.timestamp);
    return {
        estado: client_1.ConversationEstado.respondido,
        mensaje: saved.texto,
        messageId: saved.messageId,
        wamid: saved.wamid,
        media: [],
    };
}
/* ================= helpers ================= */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
async function answerWithLLM(opts) {
    const { chatId, empresaId, agent, negocio, bc, userText, effectiveImageUrl, lastIdToExcludeFromHistory, toPhone, phoneNumberId } = opts;
    const negocioName = (bc?.nombre || negocio?.nombre || '').trim();
    const especialidad = (agent.specialty || bc?.agentSpecialty || 'generico');
    const persona = personaLabel(especialidad);
    const nameLine = negocioName
        ? `Asistente de orientación de ${humanSpecialty(especialidad)} de "${negocioName}".`
        : `Asistente de orientación de ${humanSpecialty(especialidad)}.`;
    const lineScope = softTrim(agent.scope || bc?.agentScope, 160);
    const lineDisc = softTrim(agent.disclaimers || bc?.agentDisclaimers, 160);
    const extraInst = softTrim(agent.prompt || bc?.agentPrompt, 220);
    const system = [
        nameLine,
        `Actúa como ${persona}. Habla en primera persona (yo), tono profesional y cercano.`,
        'Responde en 2–4 líneas, claro y empático. Sé específico y evita párrafos largos.',
        'Puedes usar 1 emoji ocasionalmente (no siempre).',
        'Si corresponde, puedes mencionar productos del negocio y su web.',
        `Mantente solo en ${humanSpecialty(especialidad)}; si preguntan fuera, indícalo y reconduce.`,
        lineScope ? `Ámbito: ${lineScope}` : '',
        lineDisc ? `Incluye cuando aplique: ${lineDisc}` : '',
        extraInst ? `Sigue estas instrucciones del negocio: ${extraInst}` : '',
    ].filter(Boolean).join('\n');
    const history = await getRecentHistory(chatId, lastIdToExcludeFromHistory, 10);
    const messages = [{ role: 'system', content: system }, ...history];
    if (effectiveImageUrl) {
        messages.push({
            role: 'user',
            content: [
                { type: 'text', text: userText || 'Hola' },
                { type: 'image_url', image_url: { url: effectiveImageUrl } },
            ],
        });
    }
    else {
        messages.push({ role: 'user', content: userText || 'Hola' });
    }
    budgetMessages(messages, Number(process.env.IA_PROMPT_BUDGET ?? 110));
    const model = process.env.IA_TEXT_MODEL || process.env.IA_MODEL || 'gpt-4o-mini';
    const temperature = Number(process.env.IA_TEMPERATURE ?? 0.35);
    const defaultMax = IA_MAX_TOKENS;
    let texto = '';
    try {
        texto = await runChatWithBudget({ model, messages, temperature, maxTokens: defaultMax });
    }
    catch (err) {
        console.error('[AGENT] OpenAI error (final):', err?.response?.data || err?.message || err);
        texto = 'Gracias por escribirnos. Podemos ayudarte con orientación general sobre tu consulta.';
    }
    // NUEVO: cerrar bonito si quedó cortado
    texto = closeNicely(texto);
    texto = clampConcise(texto, IA_MAX_LINES, IA_MAX_CHARS);
    texto = formatConcise(texto, IA_MAX_LINES, IA_MAX_CHARS, IA_ALLOW_EMOJI);
    const businessPrompt = (agent?.prompt && agent.prompt.trim()) ||
        (bc?.agentPrompt && bc.agentPrompt.trim()) ||
        undefined;
    texto = maybeInjectBrand(texto, businessPrompt);
    const saved = await persistBotReply({
        conversationId: chatId,
        empresaId,
        texto,
        nuevoEstado: client_1.ConversationEstado.respondido,
        to: toPhone,
        phoneNumberId,
    });
    try {
        if (lastIdToExcludeFromHistory) {
            const ref = await prisma_1.default.message.findUnique({
                where: { id: lastIdToExcludeFromHistory },
                select: { timestamp: true },
            });
            if (ref?.timestamp)
                markActuallyReplied(chatId, ref.timestamp);
        }
    }
    catch { /* noop */ }
    return {
        estado: client_1.ConversationEstado.respondido,
        mensaje: saved.texto,
        messageId: saved.messageId,
        wamid: saved.wamid,
        media: [],
    };
}
// Historial: últimos N mensajes en formato compacto
async function getRecentHistory(conversationId, excludeMessageId, take = 10) {
    const where = { conversationId };
    if (excludeMessageId)
        where.id = { not: excludeMessageId };
    const rows = await prisma_1.default.message.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        take,
        select: { from: true, contenido: true },
    });
    return rows.reverse().map(r => {
        const role = r.from === client_1.MessageFrom.client ? 'user' : 'assistant';
        const content = softTrim(r.contenido || '', 220);
        return { role, content };
    });
}
async function runChatWithBudget(opts) {
    const { model, messages, temperature } = opts;
    const firstMax = opts.maxTokens;
    if (process.env.DEBUG_AI === '1') {
        console.log('[AGENT] model =', model);
        console.log('[AGENT] OPENAI_API_KEY set =', !!process.env.OPENAI_API_KEY);
        console.log('[AGENT] max_tokens try #1 =', firstMax);
    }
    try {
        const resp1 = await openai_1.openai.chat.completions.create({
            model, messages, temperature, max_tokens: firstMax,
        });
        return resp1?.choices?.[0]?.message?.content?.trim() || '';
    }
    catch (err) {
        const msg = String(err?.response?.data || err?.message || '');
        if (process.env.DEBUG_AI === '1')
            console.error('[AGENT] first call error:', msg);
        const affordable = parseAffordableTokens(msg);
        const retryTokens = (typeof affordable === 'number' && Number.isFinite(affordable))
            ? Math.max(12, Math.min(affordable - 1, 48))
            : 32;
        if (process.env.DEBUG_AI === '1')
            console.log('[AGENT] retry with max_tokens =', retryTokens);
        const resp2 = await openai_1.openai.chat.completions.create({
            model, messages, temperature, max_tokens: retryTokens,
        });
        return resp2?.choices?.[0]?.message?.content?.trim() || '';
    }
}
function parseAffordableTokens(message) {
    const m = message.match(/can\s+only\s+afford\s+(\d+)/i) ||
        message.match(/only\s+(\d+)\s+tokens?/i) ||
        message.match(/exceeded:\s*(\d+)\s*>\s*\d+/i);
    if (m && m[1]) {
        const n = Number(m[1]);
        return Number.isFinite(n) ? n : null;
    }
    return null;
}
// ===== prompt budgeting =====
function softTrim(s, max = 140) {
    const t = (s || '').trim();
    if (!t)
        return '';
    return t.length <= max ? t : t.slice(0, max).replace(/\s+[^\s]*$/, '') + '…';
}
function approxTokens(str) { return Math.ceil((str || '').length / 4); }
function budgetMessages(messages, budgetPromptTokens = 110) {
    const sys = messages.find((m) => m.role === 'system');
    const user = messages.find((m) => m.role === 'user');
    if (!sys)
        return messages;
    const sysText = String(sys.content || '');
    const userText = typeof user?.content === 'string'
        ? user?.content
        : Array.isArray(user?.content)
            ? String(user?.content?.[0]?.text || '') : '';
    let total = approxTokens(sysText) + approxTokens(userText);
    for (const m of messages) {
        if (m.role !== 'system' && m !== user) {
            const t = typeof m.content === 'string'
                ? m.content
                : Array.isArray(m.content)
                    ? String(m.content?.[0]?.text || '')
                    : '';
            total += approxTokens(t);
        }
    }
    if (total <= budgetPromptTokens)
        return messages;
    const lines = sysText.split('\n').map(l => l.trim()).filter(Boolean);
    const keep = [];
    for (const l of lines) {
        if (/Asistente de orientación|Responde en|Puedes usar|No diagnostiques|Mantente solo|Ámbito:|Incluye cuando|Sigue estas/i.test(l)) {
            keep.push(l);
        }
        if (keep.length >= 5)
            break;
    }
    ;
    sys.content = keep.join('\n') || lines.slice(0, 5).join('\n');
    if (typeof user?.content === 'string') {
        const ut = String(user.content);
        user.content = ut.length > 200 ? ut.slice(0, 200) : ut;
    }
    else if (Array.isArray(user?.content)) {
        const ut = String(user.content?.[0]?.text || '');
        user.content[0].text = ut.length > 200 ? ut.slice(0, 200) : ut;
    }
    let budget = budgetPromptTokens;
    const sizeOf = (c) => approxTokens(typeof c === 'string'
        ? c
        : Array.isArray(c) ? String(c?.[0]?.text || '') : '');
    const sysTokens = approxTokens(sys.content || '');
    budget -= sysTokens;
    const toTrim = messages.filter(m => m.role !== 'system' && m !== user);
    for (const m of toTrim) {
        const tks = sizeOf(m.content);
        if (budget - tks <= 0) {
            if (typeof m.content === 'string') {
                m.content = softTrim(m.content, 120);
            }
            else if (Array.isArray(m.content)) {
                const txt = String(m.content?.[0]?.text || '');
                m.content[0].text = softTrim(txt, 120);
            }
        }
        else {
            budget -= tks;
        }
    }
    return messages;
}
// ===== formatting / misc =====
// Soft clamp: SOLO líneas, no recortamos por caracteres para evitar “Te recom…”
function clampConcise(text, maxLines = IA_MAX_LINES, _maxChars = IA_MAX_CHARS) {
    let t = String(text || '').replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!t)
        return t;
    const lines = t.split('\n').filter(Boolean);
    if (lines.length > maxLines) {
        t = lines.slice(0, maxLines).join('\n').trim();
        if (!/[.!?…]$/.test(t))
            t += '…';
    }
    return t;
}
function formatConcise(text, maxLines = IA_MAX_LINES, maxChars = IA_MAX_CHARS, allowEmoji = IA_ALLOW_EMOJI) {
    let t = String(text || '').trim();
    if (!t)
        return 'Gracias por escribirnos. ¿Cómo puedo ayudarte?';
    // Limpieza ligera
    t = t.replace(/^[•\-]\s*/gm, '').replace(/\s+\n/g, '\n').replace(/\n{2,}/g, '\n').trim();
    // Recorte final SOLO por líneas
    t = clampConcise(t, maxLines, maxChars);
    // 1 emoji opcional si el texto es “limpio”
    if (allowEmoji && !/[^\w\s.,;:()¿?¡!…]/.test(t)) {
        const EMOJIS = ['🙂', '💡', '👌', '✅', '✨', '🧴', '💬', '🫶'];
        t = `${t} ${EMOJIS[Math.floor(Math.random() * EMOJIS.length)]}`;
        t = clampConcise(t, maxLines, maxChars);
    }
    return t;
}
// === NUEVO: helpers para cerrar bonito ===
function endsWithPunctuation(t) {
    return /[.!?…]\s*$/.test((t || '').trim());
}
function closeNicely(raw) {
    let t = (raw || '').trim();
    if (!t)
        return t;
    if (endsWithPunctuation(t))
        return t;
    // Quitar última palabra "a medias" y cerrar con puntos suspensivos
    t = t.replace(/\s+[^\s]*$/, '').trim();
    if (!t)
        return raw.trim();
    return `${t}…`;
}
function maybeInjectBrand(text, businessPrompt) {
    const p = String(businessPrompt || '');
    const urlMatch = p.match(/(https?:\/\/[^\s]+|www\.[^\s]+)/i);
    const url = urlMatch ? urlMatch[0] : '';
    const brand = /leavid/i.test(p) ? 'Leavid Skincare' : '';
    if (!brand && !url)
        return text;
    // Solo inyecta si el texto terminó en puntuación (evita "corte abrupto" + marca)
    if (!endsWithPunctuation(text))
        return text;
    const low = text.toLowerCase();
    const alreadyHas = (brand && low.includes(brand.toLowerCase())) || (url && low.includes(url.toLowerCase()));
    if (alreadyHas)
        return text;
    const tail = `Más info: ${brand || ''}${brand && url ? ' – ' : ''}${url || ''}`.trim();
    const candidate = `${text}\n${tail}`.trim();
    // Revalidamos SOLO por líneas
    return clampConcise(candidate, IA_MAX_LINES, IA_MAX_CHARS);
}
function humanSpecialty(s) {
    switch (s) {
        case 'medico': return 'medicina general';
        case 'dermatologia': return 'dermatología';
        case 'nutricion': return 'nutrición';
        case 'psicologia': return 'psicología';
        case 'odontologia': return 'odontología';
        default: return 'salud';
    }
}
function personaLabel(s) {
    switch (s) {
        case 'dermatologia': return 'un asistente virtual de dermatología';
        case 'medico': return 'un asistente virtual de medicina general';
        case 'nutricion': return 'un asistente virtual de nutrición';
        case 'psicologia': return 'un asistente virtual de psicología';
        case 'odontologia': return 'un asistente virtual de odontología';
        default: return 'un asistente virtual de salud';
    }
}
function normalizeToE164(n) { return String(n || '').replace(/[^\d]/g, ''); }
async function persistBotReply({ conversationId, empresaId, texto, nuevoEstado, to, phoneNumberId, }) {
    const msg = await prisma_1.default.message.create({
        data: { conversationId, from: client_1.MessageFrom.bot, contenido: texto, empresaId },
    });
    await prisma_1.default.conversation.update({ where: { id: conversationId }, data: { estado: nuevoEstado } });
    let wamid;
    if (to && String(to).trim()) {
        try {
            const resp = await Wam.sendWhatsappMessage({
                empresaId, to: normalizeToE164(to), body: texto, phoneNumberIdHint: phoneNumberId,
            });
            wamid = resp?.data?.messages?.[0]?.id || resp?.messages?.[0]?.id;
            if (wamid)
                await prisma_1.default.message.update({ where: { id: msg.id }, data: { externalId: wamid } });
        }
        catch { /* noop */ }
    }
    return { messageId: msg.id, texto, wamid };
}
/** ===== Idempotencia in-memory (sin DB) ===== */
const recentReplies = new Map();
function shouldSkipDoubleReply(conversationId, clientTs, windowMs = REPLY_DEDUP_WINDOW_MS) {
    const now = Date.now();
    const prev = recentReplies.get(conversationId);
    const clientMs = clientTs.getTime();
    if (prev && prev.afterMs >= clientMs && (now - prev.repliedAtMs) <= windowMs) {
        return true;
    }
    recentReplies.set(conversationId, { afterMs: clientMs, repliedAtMs: now });
    return false;
}
function markActuallyReplied(conversationId, clientTs) {
    const now = Date.now();
    recentReplies.set(conversationId, { afterMs: clientTs.getTime(), repliedAtMs: now });
}
/** ===== (Opcional) Guard DB ===== */
async function alreadyRepliedAfter(conversationId, afterTs, windowMs = 90000) {
    const bot = await prisma_1.default.message.findFirst({
        where: {
            conversationId,
            from: client_1.MessageFrom.bot,
            timestamp: { gt: afterTs },
        },
        orderBy: { timestamp: 'desc' },
        select: { timestamp: true },
    });
    if (!bot)
        return false;
    const now = Date.now();
    return now - bot.timestamp.getTime() <= windowMs;
}
