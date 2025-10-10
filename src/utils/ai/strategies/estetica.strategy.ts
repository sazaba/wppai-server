// utils/ai/strategies/estetica.strategy.ts
import axios from "axios";
import prisma from "../../../lib/prisma";
import { openai } from "../../../lib/openai";
import type { Prisma } from "@prisma/client";
import { ConversationEstado, MediaType, MessageFrom } from "@prisma/client";

import * as Wam from "../../../services/whatsapp.service";
import { transcribeAudioBuffer } from "../../../services/transcription.service";

// === Estética (KB + Agenda) ===
import {
    loadEsteticaKB,
    resolveServiceName,
    serviceDisplayPrice,
    MONEY_RE as KB_MONEY_RE,
    type EsteticaKB,
} from "./esteticaModules/domain/estetica.kb";

import {
    getNextAvailableSlots,
    createAppointmentSafe,
    type Slot,
} from "./esteticaModules/schedule/estetica.schedule";

import { formatInTimeZone } from "date-fns-tz";

/* -------------------------------------------------------
   Config (estilo, dedup, etc.)
-------------------------------------------------------- */
const REPLY_DEDUP_WINDOW_MS = Number(process.env.REPLY_DEDUP_WINDOW_MS ?? 120_000);
const IMAGE_WAIT_MS = Number(process.env.IA_IMAGE_WAIT_MS ?? 1000);
const IMAGE_CARRY_MS = Number(process.env.IA_IMAGE_CARRY_MS ?? 60_000);
const IMAGE_LOOKBACK_MS = Number(process.env.IA_IMAGE_LOOKBACK_MS ?? 5 * 60 * 1000);

const IA_MAX_LINES = Number(process.env.IA_MAX_LINES ?? 5);
const IA_MAX_TOKENS = Number(process.env.IA_MAX_TOKENS ?? 180);

const LLM_MODEL = process.env.IA_TEXT_MODEL || process.env.IA_MODEL || "gpt-4o-mini";
const LLM_TEMP = Number(process.env.IA_TEMPERATURE ?? 0.5);

/* -------------------------------------------------------
   Helpers base
-------------------------------------------------------- */
const processedInbound = new Map<number, number>();
function seenInboundRecently(messageId: number, windowMs = REPLY_DEDUP_WINDOW_MS): boolean {
    const now = Date.now();
    const prev = processedInbound.get(messageId);
    if (prev && now - prev <= windowMs) return true;
    processedInbound.set(messageId, now);
    return false;
}
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
const rand = <T>(arr: T[], fallback?: T) => (arr.length ? arr[Math.floor(Math.random() * arr.length)] : (fallback as T));

const EMOJI_WARM = ["🙂", "✨", "😊", "👌", "💬", "🫶", "💡"];
const EMOJI_TIME = ["⏰", "🗓️", "📅"];
const EMOJI_OK = ["✅", "👌", "👍"];

function closeNicely(raw: string) {
    let t = (raw || "").trim();
    if (!t) return t;
    if (/[.!?…]\s*$/.test(t)) return t;
    t = t.replace(/\s+[^\s]*$/, "").trim();
    if (!t) return raw.trim();
    return `${t}…`;
}
function clampConcise(text: string, maxLines = IA_MAX_LINES) {
    let t = String(text || "").replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    const lines = t ? t.split("\n").filter(Boolean) : [];
    if (lines.length > maxLines) {
        t = lines.slice(0, maxLines).join("\n").trim();
        if (!/[.!?…]$/.test(t)) t += "…";
    }
    return t;
}
function formatConcise(text: string) {
    let t = String(text || "").trim();
    if (!t) return "¿En qué te ayudo?";
    t = t.replace(/^[•\-]\s*/gm, "").replace(/\s+\n/g, "\n").replace(/\n{2,}/g, "\n").trim();
    return clampConcise(t, IA_MAX_LINES);
}
const normalizeToE164 = (n: string) => String(n || "").replace(/[^\d]/g, "");

/* -------------------------------------------------------
   Imagen & voz
-------------------------------------------------------- */
function mentionsImageExplicitly(t: string) {
    const s = String(t || "").toLowerCase();
    return (
        /\b(foto|imagen|selfie|captura|screenshot)\b/.test(s) ||
        /(mira|revisa|checa|verifica)\s+la\s+(foto|imagen)/.test(s) ||
        /(te\s+mand(e|é)|te\s+envi(e|é))\s+(la\s+)?(foto|imagen)/.test(s) ||
        /\b(de|en)\s+la\s+(foto|imagen)\b/.test(s)
    );
}
async function pickImageForContext(opts: {
    conversationId: number; directUrl?: string | null; userText: string; caption: string; referenceTs: Date;
}) {
    const { conversationId, directUrl, userText, caption, referenceTs } = opts;
    if (directUrl) return { url: String(directUrl), noteToAppend: caption ? `\n\nNota de la imagen: ${caption}` : "" };
    if (!userText) return { url: null as string | null, noteToAppend: "" };

    const veryRecent = await prisma.message.findFirst({
        where: {
            conversationId, from: MessageFrom.client, mediaType: MediaType.image,
            timestamp: { gte: new Date(referenceTs.getTime() - IMAGE_CARRY_MS), lte: referenceTs },
        },
        orderBy: { timestamp: "desc" }, select: { mediaUrl: true, caption: true },
    });
    if (veryRecent?.mediaUrl) {
        const note = veryRecent.caption ? `\n\nNota de la imagen: ${veryRecent.caption}` : "";
        return { url: String(veryRecent.mediaUrl), noteToAppend: note };
    }

    if (mentionsImageExplicitly(userText)) {
        const referenced = await prisma.message.findFirst({
            where: {
                conversationId, from: MessageFrom.client, mediaType: MediaType.image,
                timestamp: { gte: new Date(referenceTs.getTime() - IMAGE_LOOKBACK_MS), lte: referenceTs },
            },
            orderBy: { timestamp: "desc" }, select: { mediaUrl: true, caption: true },
        });
        if (referenced?.mediaUrl) {
            const note = referenced.caption ? `\n\nNota de la imagen: ${referenced.caption}` : "";
            return { url: String(referenced.mediaUrl), noteToAppend: note };
        }
    }
    return { url: null as string | null, noteToAppend: "" };
}

/* -------------------------------------------------------
   Persistencia + WhatsApp
-------------------------------------------------------- */
async function persistBotReply({
    conversationId, empresaId, texto, nuevoEstado, to, phoneNumberId,
}: {
    conversationId: number; empresaId: number; texto: string; nuevoEstado: ConversationEstado;
    to?: string | null; phoneNumberId?: string | null;
}) {
    const msg = await prisma.message.create({
        data: { conversationId, from: MessageFrom.bot, contenido: texto, empresaId },
    });
    await prisma.conversation.update({ where: { id: conversationId }, data: { estado: nuevoEstado } });

    let wamid: string | undefined;
    if (to && String(to).trim()) {
        try {
            const resp = await Wam.sendWhatsappMessage({
                empresaId, to: normalizeToE164(to), body: texto, phoneNumberIdHint: phoneNumberId || undefined,
            });
            wamid = (resp as any)?.data?.messages?.[0]?.id || (resp as any)?.messages?.[0]?.id;
            if (wamid) await prisma.message.update({ where: { id: msg.id }, data: { externalId: wamid } });
        } catch (e: any) {
            console.error("[WAM send error]", e?.response?.data || e?.message || e);
        }
    }
    return { messageId: msg.id, texto, wamid };
}

/* -------------------------------------------------------
   Historial compacto
-------------------------------------------------------- */
async function getRecentHistory(conversationId: number, excludeMessageId?: number, take = 10) {
    const where: Prisma.MessageWhereInput = { conversationId };
    if (excludeMessageId) where.id = { not: excludeMessageId };
    const rows = await prisma.message.findMany({
        where, orderBy: { timestamp: "asc" }, take, select: { from: true, contenido: true },
    });
    return rows.map((r) => ({
        role: r.from === MessageFrom.client ? "user" : "assistant",
        content: (r.contenido || "").slice(0, 220),
    }));
}

/* -------------------------------------------------------
   Intents suaves
-------------------------------------------------------- */
const isCatalogQuery = (t: string) => {
    const s = ` ${(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()} `;
    const nouns = ["servicio", "servicios", "procedimiento", "procedimientos", "tratamiento", "tratamientos", "catalogo", "catálogo"];
    const intents = ["que ", "qué ", "cuales", "cuáles", "lista", "disponible", "ofrecen", "tienes", "hay", "oferta", "precios", "precio", "costos", "tarifas"];
    return nouns.some(k => s.includes(` ${k} `)) || intents.some(k => s.includes(k));
};
const asksPrice = (t: string) => /\b(precio|precios|costo|costos|valor|tarifa|tarifas)\b/i.test((t || "").toLowerCase());
const wantsSchedule = (t: string) => /\b(horario|horarios|disponibilidad|agenda|agendar|agéndame|cita|turno|reservar|programar)\b/i.test(t || "");
const isServiceInfoQuestion = (t: string) =>
    /\b(beneficios?|ventajas?|resultados?)\b/i.test(t) ||
    /\b(preparaci[oó]n|indicaciones|antes de|previo|en que consiste|en qué consiste)\b/i.test(t) ||
    /\b(contraindicaciones?|riesgos?|efectos?\s+secundarios?)\b/i.test(t) ||
    /\b(cuidados?|post\s*cuidado|despu[eé]s|postoperatorio)\b/i.test(t);

/* -------------------------------------------------------
   Memoria corta de servicio (tag en el último mensaje del bot)
-------------------------------------------------------- */
const CTX_TAG_RE = /\[CTX svc:(\d+)\]/;
async function getLastCtxService(conversationId: number): Promise<number | null> {
    const lastBot = await prisma.message.findFirst({
        where: { conversationId, from: MessageFrom.bot },
        orderBy: { id: "desc" },
        select: { contenido: true },
    });
    if (!lastBot?.contenido) return null;
    const m = CTX_TAG_RE.exec(lastBot.contenido);
    return m ? Number(m[1]) : null;
}
async function attachCtxTag(messageId: number, serviceId?: number | null) {
    if (!serviceId) return;
    const msg = await prisma.message.findUnique({ where: { id: messageId }, select: { contenido: true } });
    if (!msg) return;
    const next = `${msg.contenido}\n[CTX svc:${serviceId}]`;
    await prisma.message.update({ where: { id: messageId }, data: { contenido: next } });
}

/* -------------------------------------------------------
   HÍBRIDO INTELIGENTE: cache de KB → prompt libre
-------------------------------------------------------- */
type KBContext = { text: string; kb: EsteticaKB; builtAt: number; hash: string };
const KB_CACHE = new Map<number, KBContext>(); // empresaId → contexto
const KB_TTL_MS = Number(process.env.IA_KB_TTL_MS ?? 5 * 60 * 1000); // 5 min

function hashKB(kb: EsteticaKB) {
    // hash simple y determinístico para invalidar cuando cambie lo relevante
    const payload = JSON.stringify({
        empresaId: kb.empresaId,
        timezone: kb.timezone,
        bufferMin: kb.bufferMin,
        policies: kb.policies ?? "",
        staff: (kb.staff || []).map(s => [s.id, s.name, s.role, s.active]),
        exceptions: (kb.exceptions || []).map(e => [e.dateISO, e.isOpen, e.start1, e.end1, e.start2, e.end2]),
        procedures: (kb.procedures || []).map(p => [p.id, p.name, p.enabled, p.durationMin, p.priceMin, p.priceMax, p.depositRequired]),
        location: kb.location ?? {},
    });
    let h = 0;
    for (let i = 0; i < payload.length; i++) {
        h = (h * 31 + payload.charCodeAt(i)) | 0;
    }
    return String(h);
}

function buildKBText(kb: EsteticaKB) {
    const procs = (kb.procedures || [])
        .filter(p => p && p.enabled !== false)
        .map(p => {
            const from = serviceDisplayPrice(p as any);
            const dur = p.durationMin ? ` | Duración aprox: ${p.durationMin} min` : "";
            return `- ${p.name}${from ? ` (Desde ${from})` : ""}${dur}${p.prepInstructions ? `\n  • Indicaciones: ${p.prepInstructions}` : ""
                }${p.postCare ? `\n  • Cuidados: ${p.postCare}` : ""}${p.contraindications ? `\n  • Contraindicaciones: ${p.contraindications}` : ""
                }`;
        })
        .join("\n");

    const staff = (kb.staff || [])
        .map(s => `- ${s.name} (${s.role}${!s.active ? ", inactivo" : ""})`).join("\n");

    const ex = (kb.exceptions || [])
        .slice(0, 6)
        .map(e => `- ${e.dateISO}: ${e.isOpen === false ? "Cerrado" : [e.start1, e.end1, e.start2 && ` / ${e.start2}-${e.end2}`].filter(Boolean).join("-")}`)
        .join("\n");

    const loc = kb.location ? [
        kb.location.name ? `Sede: ${kb.location.name}` : "",
        kb.location.address ? `Dirección: ${kb.location.address}` : "",
        kb.location.mapsUrl ? `Maps: ${kb.location.mapsUrl}` : "",
        kb.location.parkingInfo ? `Parqueo: ${kb.location.parkingInfo}` : "",
        kb.location.arrivalInstructions ? `Llegada: ${kb.location.arrivalInstructions}` : "",
    ].filter(Boolean).join(" | ") : "";

    return [
        `EmpresaId: ${kb.empresaId}`,
        `Zona horaria: ${kb.timezone} | Buffer: ${kb.bufferMin} min`,
        kb.policies ? `Políticas: ${kb.policies}` : "",
        loc ? `Ubicación: ${loc}` : "",
        staff ? `\nStaff:\n${staff}` : "",
        procs ? `\nProcedimientos:\n${procs}` : "",
        ex ? `\nExcepciones (muestras):\n${ex}` : "",
    ].filter(Boolean).join("\n");
}

async function getOrBuildKBContext(empresaId: number): Promise<KBContext | null> {
    const now = Date.now();
    const cached = KB_CACHE.get(empresaId);
    if (cached && now - cached.builtAt <= KB_TTL_MS) return cached;

    const kb = await loadEsteticaKB({ empresaId, vertical: "estetica" });
    if (!kb) return null;

    const text = buildKBText(kb);
    const ctx: KBContext = { text, kb, builtAt: now, hash: hashKB(kb) };
    KB_CACHE.set(empresaId, ctx);
    return ctx;
}

/* -------------------------------------------------------
   API pública
-------------------------------------------------------- */
export type IAReplyResult = { estado: ConversationEstado; mensaje: string; messageId?: number; wamid?: string; media?: any[]; };

export async function handleEsteticaReply(args: {
    chatId: number; empresaId: number; mensajeArg?: string; toPhone?: string | null; phoneNumberId?: string | null;
}): Promise<IAReplyResult> {
    const { chatId, empresaId, mensajeArg = "", toPhone, phoneNumberId } = args;

    const conversacion = await prisma.conversation.findUnique({ where: { id: chatId }, select: { id: true, estado: true, phone: true } });
    if (!conversacion) return { estado: ConversationEstado.pendiente, mensaje: "" };

    const last = await prisma.message.findFirst({
        where: { conversationId: chatId, from: MessageFrom.client },
        orderBy: { timestamp: "desc" },
        select: { id: true, mediaType: true, mediaUrl: true, caption: true, isVoiceNote: true, transcription: true, contenido: true, mimeType: true, timestamp: true },
    });

    if (last?.id && seenInboundRecently(last.id)) return { estado: conversacion.estado, mensaje: "" };

    // === HÍBRIDO: construir/leer contexto KB (cacheado)
    const kbCtx = await getOrBuildKBContext(empresaId);
    if (!kbCtx) {
        const saved = await persistBotReply({
            conversationId: chatId, empresaId,
            texto: "No tengo la configuración completa de la clínica. Te comunico con un asesor humano. 🙏",
            nuevoEstado: ConversationEstado.requiere_agente, to: toPhone ?? conversacion.phone, phoneNumberId,
        });
        return { estado: ConversationEstado.requiere_agente, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
    }
    const kb = kbCtx.kb;

    // ===== Texto usuario (directo / transcripción)
    let userText = (mensajeArg || last?.contenido || "").trim();
    if (!userText && last?.isVoiceNote) {
        let transcript = (last.transcription || "").trim();
        if (!transcript) {
            try {
                let audioBuf: Buffer | null = null;
                if (last.mediaUrl && /^https?:\/\//i.test(String(last.mediaUrl))) {
                    const { data } = await axios.get(String(last.mediaUrl), { responseType: "arraybuffer", timeout: 30000 });
                    audioBuf = Buffer.from(data);
                }
                if (audioBuf) {
                    const name = last.mimeType?.includes("mpeg") ? "audio.mp3"
                        : last.mimeType?.includes("wav") ? "audio.wav"
                            : last.mimeType?.includes("m4a") ? "audio.m4a"
                                : last.mimeType?.includes("webm") ? "audio.webm"
                                    : "audio.ogg";
                    transcript = await transcribeAudioBuffer(audioBuf, name);
                    if (transcript) await prisma.message.update({ where: { id: last.id }, data: { transcription: transcript } });
                }
            } catch { }
        }
        if (transcript) userText = transcript;
    }

    const isImage = last?.mediaType === MediaType.image && !!last?.mediaUrl;
    const imageUrl = isImage ? String(last?.mediaUrl) : null;
    const caption = String(last?.caption || "").trim();
    const referenceTs = last?.timestamp ?? new Date();
    if (isImage && !caption && !userText) { await sleep(IMAGE_WAIT_MS); return { estado: conversacion.estado, mensaje: "" }; }

    // ===== Servicio en texto o en contexto
    const explicit = resolveServiceName(kb, userText || caption || "");
    let svc = explicit?.procedure ?? null;
    if (!svc) {
        const lastSvcId = await getLastCtxService(chatId);
        if (lastSvcId) svc = (kb.procedures || []).find(p => p.id === lastSvcId) || null;
    }

    // ===== Prioridad suave de intents
    if (asksPrice(userText || caption || "")) {
        const procs = (kb.procedures || []).filter(p => p.enabled !== false);
        const list = procs.slice(0, 24).map(p => {
            const from = serviceDisplayPrice(p as any);
            return `• ${p.name}${from ? ` (Desde ${from})` : ""}`;
        }).join("\n");
        const txt = `Te comparto precios *en COP* ${rand(EMOJI_WARM)}:\n\n${list}\n\n¿Quieres opciones de horario ${rand(EMOJI_TIME)} para alguno?`;
        const saved = await persistBotReply({
            conversationId: chatId, empresaId, texto: txt, nuevoEstado: ConversationEstado.en_proceso,
            to: toPhone ?? conversacion.phone, phoneNumberId,
        });
        return { estado: ConversationEstado.en_proceso, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
    }

    if (svc && isServiceInfoQuestion(userText || caption || "")) {
        const bits: string[] = [];
        if (svc.prepInstructions) bits.push(`• *Indicaciones previas:* ${svc.prepInstructions}`);
        if (svc.postCare) bits.push(`• *Cuidados posteriores:* ${svc.postCare}`);
        if (svc.contraindications) bits.push(`• *Contraindicaciones:* ${svc.contraindications}`);
        if (svc.notes) bits.push(`• *Nota:* ${svc.notes}`);
        if (!bits.length) bits.push("• Recomendación general: llega con la piel limpia, evita exfoliantes fuertes 48–72 h antes y usa protector solar.");

        const from = serviceDisplayPrice(svc);
        const txt = `${rand(["Sobre", "Resumen de", "Te cuento de"])} *${svc.name}*${from ? ` (Desde ${from})` : ""} ${rand(EMOJI_WARM)}:\n${bits.join("\n")}\n\nSi te sirve, te paso horarios ${rand(EMOJI_TIME)}.`;
        const saved = await persistBotReply({
            conversationId: chatId, empresaId, texto: txt, nuevoEstado: ConversationEstado.en_proceso,
            to: toPhone ?? conversacion.phone, phoneNumberId,
        });
        await attachCtxTag(saved.messageId!, svc.id);
        return { estado: ConversationEstado.en_proceso, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
    }

    if (wantsSchedule(userText || caption || "")) {
        const tz = kb.timezone || "America/Bogota";
        const bufferMin = kb.bufferMin ?? 10;
        const durationMin = svc?.durationMin ?? kb.defaultServiceDurationMin ?? 45;

        const nowLocalISO = formatInTimeZone(new Date(), tz, "yyyy-MM-dd");

        const found = await getNextAvailableSlots(
            { empresaId, vertical: "estetica", timezone: tz, bufferMin, granularityMin: 15 },
            nowLocalISO, durationMin, 14, 6
        );

        if (found.length) {
            const pretty = found
                .map((day) => {
                    const times = day.slots.slice(0, 3).map((s) => s.startISO.slice(11, 16)).join(", ");
                    return `• ${day.date}: ${times}${day.slots.length > 3 ? "…" : ""}`;
                }).join("\n");

            const fromLabel = svc ? serviceDisplayPrice(svc) : null;
            const head = svc ? `Para *${svc.name}*${fromLabel ? ` (Desde ${fromLabel})` : ""}, tengo:` : "Tengo disponibilidad cercana:";
            const txt = `${head}\n\n${pretty}\n\nElige una y dime tu *nombre* y *teléfono* para reservar ${rand(EMOJI_OK)}.`;

            const saved = await persistBotReply({
                conversationId: chatId, empresaId, texto: txt, nuevoEstado: ConversationEstado.en_proceso,
                to: toPhone ?? conversacion.phone, phoneNumberId,
            });
            if (svc) await attachCtxTag(saved.messageId!, svc.id);
            return { estado: ConversationEstado.en_proceso, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
        }
        const savedNo = await persistBotReply({
            conversationId: chatId, empresaId,
            texto: `Por ahora no veo cupos cercanos. Si quieres, te contacto con un asesor para coordinar un horario que te sirva ${rand(EMOJI_WARM)}.`,
            nuevoEstado: ConversationEstado.en_proceso, to: toPhone ?? conversacion.phone, phoneNumberId,
        });
        return { estado: ConversationEstado.en_proceso, mensaje: savedNo.texto, messageId: savedNo.messageId, wamid: savedNo.wamid, media: [] };
    }

    if (isCatalogQuery(userText || caption || "")) {
        const procs = (kb.procedures || []).filter(p => p.enabled !== false);
        const list = procs.slice(0, 24).map(p => {
            const from = serviceDisplayPrice(p as any);
            return `• ${p.name}${from ? ` (Desde ${from})` : ""}`;
        }).join("\n");
        const txt = `Ofrecemos ${rand(EMOJI_WARM)}:\n\n${list}\n\n¿Quieres ver horarios para alguno ${rand(EMOJI_TIME)}?`;
        const saved = await persistBotReply({
            conversationId: chatId, empresaId, texto: txt, nuevoEstado: ConversationEstado.en_proceso,
            to: toPhone ?? conversacion.phone, phoneNumberId,
        });
        return { estado: ConversationEstado.en_proceso, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
    }

    /* ---------- Conversación libre con HÍBRIDO (KB completo cacheado) ---------- */
    const system = [
        "Actúa como un asesor humano de clínica estética.",
        "Tono natural, cercano y profesional; usa emojis con moderación y varía la redacción.",
        "Responde breve (2–5 líneas), concreta y empática. Evita sonar a bot.",
        "Usa únicamente la información real de la clínica que verás a continuación.",
        "Si hablan de precios, usa el formato “Desde $X (COP)” cuando exista priceMin.",
        "Si detectas intención clara de agendar, ofrece horarios concretos.",
        "",
        "=== INFORMACIÓN DE LA CLÍNICA (CONOCIMIENTO) ===",
        kbCtx.text,
        "=== FIN DEL CONOCIMIENTO ===",
    ].join("\n");

    // Imagen contextual opcional
    let effectiveImageUrl = isImage ? imageUrl : null;
    let textForLLM = (userText || caption || "Hola").trim();
    if (!effectiveImageUrl && textForLLM) {
        const picked = await pickImageForContext({ conversationId: chatId, directUrl: null, userText: textForLLM, caption, referenceTs });
        effectiveImageUrl = picked.url;
        if (picked.noteToAppend) textForLLM = `${textForLLM}${picked.noteToAppend}`;
    }

    const history = await getRecentHistory(chatId, last?.id, 10);
    const messages: any[] = [{ role: "system", content: system }, ...history];

    if (effectiveImageUrl) {
        messages.push({
            role: "user",
            content: [
                { type: "text", text: textForLLM || "Hola" },
                { type: "image_url", image_url: { url: effectiveImageUrl } },
            ],
        });
    } else {
        messages.push({ role: "user", content: textForLLM || "Hola" });
    }

    let texto = "";
    try {
        const resp = await (openai.chat.completions.create as any)({
            model: LLM_MODEL,
            temperature: LLM_TEMP,
            max_tokens: IA_MAX_TOKENS,
            messages,
        });
        texto = resp?.choices?.[0]?.message?.content?.trim() || "";
    } catch {
        texto = `Puedo orientarte y, si quieres, te paso horarios ${rand(EMOJI_WARM)}.`;
    }

    // blindaje: si NO pidieron precio, borra montos que el modelo pueda inventar
    if (!asksPrice(userText || caption || "")) {
        if (KB_MONEY_RE.test(texto)) texto = texto.replace(KB_MONEY_RE, "consulta por precio");
    }

    texto = closeNicely(texto);
    texto = formatConcise(texto);

    const saved = await persistBotReply({
        conversationId: chatId, empresaId, texto, nuevoEstado: ConversationEstado.respondido,
        to: toPhone ?? conversacion.phone, phoneNumberId,
    });
    if (svc) await attachCtxTag(saved.messageId!, svc.id);

    return { estado: ConversationEstado.respondido, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
}
