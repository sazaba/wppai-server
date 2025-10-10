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

import { formatInTimeZone, utcToZonedTime, format as tzFormat } from "date-fns-tz";

// ================= Config =================
const REPLY_DEDUP_WINDOW_MS = Number(process.env.REPLY_DEDUP_WINDOW_MS ?? 120_000);
const IMAGE_WAIT_MS = Number(process.env.IA_IMAGE_WAIT_MS ?? 1000);
const IMAGE_CARRY_MS = Number(process.env.IA_IMAGE_CARRY_MS ?? 60_000);
const IMAGE_LOOKBACK_MS = Number(process.env.IA_IMAGE_LOOKBACK_MS ?? 5 * 60 * 1000);

// Estilo
const IA_MAX_LINES = Number(process.env.IA_MAX_LINES ?? 5);
const IA_MAX_CHARS = Number(process.env.IA_MAX_CHARS ?? 1000);
const IA_MAX_TOKENS = Number(process.env.IA_MAX_TOKENS ?? 180);

// ================= Utils =================
const processedInbound = new Map<number, number>();
function seenInboundRecently(messageId: number, windowMs = REPLY_DEDUP_WINDOW_MS): boolean {
    const now = Date.now();
    const prev = processedInbound.get(messageId);
    if (prev && now - prev <= windowMs) return true;
    processedInbound.set(messageId, now);
    return false;
}
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));
const rand = <T>(arr: T[], fallback?: T) => (arr.length ? arr[Math.floor(Math.random() * arr.length)] : (fallback as T));
const EMOJI_WARM = ["🙂", "✨", "😊", "👌", "💬", "🫶", "💡"];
const EMOJI_TIME = ["⏰", "🗓️", "📅"];
const EMOJI_OK = ["✅", "👌", "👍"];

// ——— Text helpers ———
const softTrim = (s: string | null | undefined, max = 220) => {
    const t = (s || "").trim();
    if (!t) return "";
    return t.length <= max ? t : t.slice(0, max).replace(/\s+[^\s]*$/, "") + "…";
};
const approxTokens = (str: string) => Math.ceil((str || "").length / 4);
function clampConcise(text: string, maxLines = IA_MAX_LINES): string {
    let t = String(text || "").replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    const lines = t ? t.split("\n").filter(Boolean) : [];
    if (lines.length > maxLines) {
        t = lines.slice(0, maxLines).join("\n").trim();
        if (!/[.!?…]$/.test(t)) t += "…";
    }
    return t;
}
function formatConcise(text: string, maxLines = IA_MAX_LINES) {
    let t = String(text || "").trim();
    if (!t) return "¿En qué te ayudo?";
    t = t.replace(/^[•\-]\s*/gm, "").replace(/\s+\n/g, "\n").replace(/\n{2,}/g, "\n").trim();
    return clampConcise(t, maxLines);
}
const closeNicely = (raw: string) => {
    let t = (raw || "").trim();
    if (!t) return t;
    if (/[.!?…]\s*$/.test(t)) return t;
    t = t.replace(/\s+[^\s]*$/, "").trim();
    if (!t) return raw.trim();
    return `${t}…`;
};
const normalizeToE164 = (n: string) => String(n || "").replace(/[^\d]/g, "");

// ===== Imagen & Voz =====
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

// ===== Persistencia + WhatsApp =====
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

// ===== Historial compacto =====
async function getRecentHistory(conversationId: number, excludeMessageId?: number, take = 8) {
    const where: Prisma.MessageWhereInput = { conversationId };
    if (excludeMessageId) where.id = { not: excludeMessageId };
    const rows = await prisma.message.findMany({
        where, orderBy: { timestamp: "asc" }, take, select: { from: true, contenido: true },
    });
    return rows.map((r) => ({ role: r.from === MessageFrom.client ? "user" : "assistant", content: softTrim(r.contenido || "", 200) }));
}
function budgetMessages(messages: any[], budgetPromptTokens = 120) {
    const sys = messages.find((m: any) => m.role === "system");
    const user = messages.find((m: any) => m.role === "user");
    if (!sys) return messages;

    const sysText = String(sys.content || "");
    const userText = typeof user?.content === "string" ? user?.content :
        Array.isArray(user?.content) ? String(user?.content?.[0]?.text || "") : "";

    let total = approxTokens(sysText) + approxTokens(userText);
    for (const m of messages) {
        if (m.role !== "system" && m !== user) {
            const t = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? String(m.content?.[0]?.text || "") : "";
            total += approxTokens(t);
        }
    }
    if (total <= budgetPromptTokens) return messages;

    const lines = sysText.split("\n").map((l: string) => l.trim()).filter(Boolean);
    const keep: string[] = [];
    for (const l of lines) { if (/clínica estética|agenda|servicios|precios|tono/i.test(l)) keep.push(l); if (keep.length >= 7) break; }
    (sys as any).content = keep.join("\n") || lines.slice(0, 7).join("\n");

    if (typeof user?.content === "string") {
        const ut = String(user.content); user.content = ut.length > 240 ? ut.slice(0, 240) : ut;
    } else if (Array.isArray(user?.content)) {
        const ut = String(user.content?.[0]?.text || ""); (user.content as any[])[0].text = softTrim(ut, 240);
    }
    return messages;
}

// ===== Intents =====
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

// ===== Memoria corta de servicio (solo marca) =====
const CTX_TAG_RE = /\[CTX svc:(\d+)\]/; // añadimos esto a la última respuesta del bot
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

// ===== Tipos públicos =====
export type IAReplyResult = { estado: ConversationEstado; mensaje: string; messageId?: number; wamid?: string; media?: any[]; };

// ===== Agente =====
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

    const kb = (await loadEsteticaKB({ empresaId, vertical: "estetica" })) as EsteticaKB | null;
    if (!kb) {
        const saved = await persistBotReply({
            conversationId: chatId, empresaId,
            texto: "Ahora mismo no tengo la configuración completa de la clínica. Te comunico con un asesor humano. 🙏",
            nuevoEstado: ConversationEstado.requiere_agente, to: toPhone ?? conversacion.phone, phoneNumberId,
        });
        return { estado: ConversationEstado.requiere_agente, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
    }

    // Texto usuario (mensajeArg || último texto || transcripción)
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
            } catch (e) { }
        }
        if (transcript) userText = transcript;
    }

    const isImage = last?.mediaType === MediaType.image && !!last?.mediaUrl;
    const imageUrl = isImage ? String(last?.mediaUrl) : null;
    const caption = String(last?.caption || "").trim();
    const referenceTs = last?.timestamp ?? new Date();
    if (isImage && !caption && !userText) { await sleep(IMAGE_WAIT_MS); return { estado: conversacion.estado, mensaje: "" }; }

    // ===== Resolver servicio por texto o por contexto previo
    const explicit = resolveServiceName(kb, userText || caption || "");
    let svc = explicit?.procedure ?? null;
    if (!svc) {
        const lastId = await getLastCtxService(chatId);
        if (lastId) svc = (kb.procedures || []).find(p => p.id === lastId) || null;
    }

    // ===== Prioridad de intents (suave):
    // 1) Precios → lista libre con COP (sale de cualquier flujo)
    if (asksPrice(userText || caption || "")) {
        const procs = Array.isArray(kb.procedures) ? kb.procedures : [];
        if (!procs.length) {
            const savedEmpty = await persistBotReply({
                conversationId: chatId, empresaId,
                texto: `Te cuento ${rand(EMOJI_WARM)}: aún no veo servicios configurados. Si quieres, te oriento y luego agendamos.`,
                nuevoEstado: ConversationEstado.en_proceso, to: toPhone ?? conversacion.phone, phoneNumberId,
            });
            return { estado: ConversationEstado.en_proceso, mensaje: savedEmpty.texto, messageId: savedEmpty.messageId, wamid: savedEmpty.wamid, media: [] };
        }
        const list = procs.slice(0, 20).map((p) => {
            const from = serviceDisplayPrice(p);
            return `• ${p.name}${from ? ` (Desde ${from})` : ""}`;
        }).join("\n");

        const txt = `Estos son nuestros valores *en COP* ${rand(EMOJI_WARM)}:\n\n${list}\n\n¿Te comparto horarios para alguno ${rand(EMOJI_TIME)}?`;
        const saved = await persistBotReply({
            conversationId: chatId, empresaId, texto: txt, nuevoEstado: ConversationEstado.en_proceso,
            to: toPhone ?? conversacion.phone, phoneNumberId,
        });
        return { estado: ConversationEstado.en_proceso, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
    }

    // 2) Info de un procedimiento (beneficios / consiste / preparación / contraindicaciones / cuidados)
    if (svc && isServiceInfoQuestion(userText || caption || "")) {
        const bullets: string[] = [];
        if (svc.prepInstructions) bullets.push(`• *Indicaciones previas:* ${svc.prepInstructions}`);
        if (svc.postCare) bullets.push(`• *Cuidados posteriores:* ${svc.postCare}`);
        if (svc.contraindications) bullets.push(`• *Contraindicaciones:* ${svc.contraindications}`);
        if (svc.notes) bullets.push(`• *Nota:* ${svc.notes}`);
        if (!bullets.length) bullets.push("• Recomendación general: llega con la piel limpia, evita exfoliantes fuertes 48–72 h antes y usa protector solar.");

        const from = serviceDisplayPrice(svc);
        const openers = [
            `Te cuento sobre *${svc.name}*`,
            `Resumen de *${svc.name}*`,
            `Sobre *${svc.name}*`,
        ];
        const tail = `\n\nSi te sirve, te paso horarios ${rand(EMOJI_TIME)}.`;

        const txt = `${rand(openers)}${from ? ` (Desde ${from})` : ""} ${rand(EMOJI_WARM)}:\n${bullets.join("\n")}${tail}`;

        const saved = await persistBotReply({
            conversationId: chatId, empresaId, texto: txt, nuevoEstado: ConversationEstado.en_proceso,
            to: toPhone ?? conversacion.phone, phoneNumberId,
        });
        await attachCtxTag(saved.messageId!, svc.id); // guardar contexto de servicio
        return { estado: ConversationEstado.en_proceso, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
    }

    // 3) Agendamiento (en cualquier momento)
    if (wantsSchedule(userText || caption || "")) {
        const tz = kb.timezone || "America/Bogota";
        const bufferMin = kb.bufferMin ?? 10;
        const durationMin = svc?.durationMin ?? kb.defaultServiceDurationMin ?? 45;

        // HOY (YYYY-MM-DD) en tz del negocio
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
                })
                .join("\n");

            const fromLabel = svc ? serviceDisplayPrice(svc) : null;
            const head = svc
                ? `Para *${svc.name}*${fromLabel ? ` (Desde ${fromLabel})` : ""}, estas son opciones cercanas:`
                : `Tengo estas opciones próximas:`;

            const endings = [
                `Elige una y dime tu *nombre* y *teléfono* para reservar ${rand(EMOJI_OK)}.`,
                `¿Cuál te funciona? Te tomo datos y la dejo confirmada ${rand(EMOJI_OK)}.`,
            ];

            const txt = `${head}\n\n${pretty}\n\n${rand(endings)}`;

            const saved = await persistBotReply({
                conversationId: chatId, empresaId, texto: txt, nuevoEstado: ConversationEstado.en_proceso,
                to: toPhone ?? conversacion.phone, phoneNumberId,
            });
            if (svc) await attachCtxTag(saved.messageId!, svc.id);
            return { estado: ConversationEstado.en_proceso, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
        }

        const savedNo = await persistBotReply({
            conversationId: chatId, empresaId,
            texto: `No veo cupos cercanos por ahora. Si quieres, te contacto con un asesor para coordinar un horario que te sirva ${rand(EMOJI_WARM)}.`,
            nuevoEstado: ConversationEstado.en_proceso, to: toPhone ?? conversacion.phone, phoneNumberId,
        });
        return { estado: ConversationEstado.en_proceso, mensaje: savedNo.texto, messageId: savedNo.messageId, wamid: savedNo.wamid, media: [] };
    }

    // 4) Catálogo general (si no pidieron precio explícito)
    if (isCatalogQuery(userText || caption || "")) {
        const procs = Array.isArray(kb.procedures) ? kb.procedures : [];
        if (!procs.length) {
            const savedEmpty = await persistBotReply({
                conversationId: chatId, empresaId,
                texto: `Aún no tengo servicios cargados. Puedo orientarte igual y cuando quieras agendamos ${rand(EMOJI_WARM)}.`,
                nuevoEstado: ConversationEstado.en_proceso, to: toPhone ?? conversacion.phone, phoneNumberId,
            });
            return { estado: ConversationEstado.en_proceso, mensaje: savedEmpty.texto, messageId: savedEmpty.messageId, wamid: savedEmpty.wamid, media: [] };
        }

        const list = procs.slice(0, 20).map((p) => {
            const from = serviceDisplayPrice(p);
            return `• ${p.name}${from ? ` (Desde ${from})` : ""}`;
        }).join("\n");

        const txt = `Ofrecemos ${rand(EMOJI_WARM)}:\n\n${list}\n\n¿Quieres ver horarios para alguno ${rand(EMOJI_TIME)}?`;

        const saved = await persistBotReply({
            conversationId: chatId, empresaId, texto: txt, nuevoEstado: ConversationEstado.en_proceso,
            to: toPhone ?? conversacion.phone, phoneNumberId,
        });
        return { estado: ConversationEstado.en_proceso, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
    }

    // ===== Conversación libre (LLM) con imagen contextual (fallback)
    const businessName: string = (kb as any)?.businessName ?? "";
    const kbTexts: { businessOverview?: string; disclaimers?: string } | undefined = (kb as any)?.kbTexts ?? undefined;
    const logistics: { locationAddress?: string; locationName?: string } | undefined = (kb as any)?.logistics ?? undefined;
    const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

    let effectiveImageUrl = isImage ? imageUrl : null;
    let textForLLM = (userText || caption || "Hola").trim();
    if (!effectiveImageUrl && textForLLM) {
        const picked = await pickImageForContext({ conversationId: chatId, directUrl: null, userText: textForLLM, caption, referenceTs });
        effectiveImageUrl = picked.url;
        if (picked.noteToAppend) textForLLM = `${textForLLM}${picked.noteToAppend}`;
    }

    const system = [
        businessName ? `Agente de clínica estética de "${businessName}".` : `Agente de clínica estética.`,
        "Tono natural, cercano y profesional. Habla como humano (no te presentes como bot).",
        "Respuestas breves (2–5 líneas) y concretas. Varía la redacción y usa emojis con moderación.",
        "Foco: orientación de tratamientos y agenda.",
        "Usa solo servicios de la BD; si preguntan precio: formato “Desde $X (COP)”.",
        kbTexts?.businessOverview ? `Contexto: ${softTrim(kbTexts.businessOverview, 220)}` : "",
        logistics?.locationAddress ? `Dirección: ${logistics.locationAddress}` : "",
        logistics?.locationName ? `Sede: ${logistics.locationName}` : "",
        kbTexts?.disclaimers ? `Avisos: ${softTrim(kbTexts.disclaimers, 180)}` : "",
    ].filter(isString).join("\n");

    const history = await getRecentHistory(chatId, last?.id, 10);
    const messages: any[] = [{ role: "system", content: system }, ...history];

    if (effectiveImageUrl) {
        messages.push({ role: "user", content: [{ type: "text", text: textForLLM || "Hola" }, { type: "image_url", image_url: { url: effectiveImageUrl } }] });
    } else {
        messages.push({ role: "user", content: textForLLM || "Hola" });
    }
    budgetMessages(messages, 120);

    const model = process.env.IA_TEXT_MODEL || process.env.IA_MODEL || "gpt-4o-mini";
    const temperature = Number(process.env.IA_TEMPERATURE ?? 0.5);

    let texto = "";
    try {
        const resp = await (openai.chat.completions.create as any)({ model, temperature, max_tokens: IA_MAX_TOKENS, messages });
        texto = resp?.choices?.[0]?.message?.content?.trim() || "";
    } catch {
        texto = `Te oriento sobre tratamientos y, si quieres, te paso horarios ${rand(EMOJI_WARM)}.`;
    }

    // Quitar montos inventados si no pidieron precio explícito
    if (!asksPrice(userText || caption || "")) {
        if (KB_MONEY_RE.test(texto)) texto = texto.replace(KB_MONEY_RE, "consulta por precio");
    }

    texto = closeNicely(texto);
    texto = formatConcise(texto, IA_MAX_LINES);

    const saved = await persistBotReply({
        conversationId: chatId, empresaId, texto, nuevoEstado: ConversationEstado.respondido,
        to: toPhone ?? conversacion.phone, phoneNumberId,
    });
    if (svc) await attachCtxTag(saved.messageId!, svc.id); // mantener contexto si lo había

    return { estado: ConversationEstado.respondido, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
}
