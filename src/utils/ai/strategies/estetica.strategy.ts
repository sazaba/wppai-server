// utils/ai/strategies/estetica.strategy.ts
import axios from "axios";
import prisma from "../../../lib/prisma";
import type { Prisma } from "@prisma/client";
import { openai } from "../../../lib/openai";
import {
    ConversationEstado,
    MediaType,
    MessageFrom,
    AppointmentStatus,
    AppointmentVertical,
} from "@prisma/client";
import * as Wam from "../../../services/whatsapp.service";
import { transcribeAudioBuffer } from "../../../services/transcription.service";
import type { IAReplyResult } from "../../handleIAReply.ecommerce";

import { Logger } from "../../ai/strategies/esteticaModules/log";
const log = Logger.child("estetica.strategy");

// === Módulos de Estética (KB + Agenda + Fechas) ===
import {
    loadEsteticaKB,
    resolveServiceName,
    serviceDisplayPrice,
} from "./esteticaModules/domain/estetica.kb";
import {
    findNextSlots,
    bookAppointment,
    rescheduleAppointment,
    cancelAppointment,
    type SlotView,
} from "./esteticaModules/schedule/estetica.schedule";
import {
    parseRelativeDateText,
    fromLocalTZToUTC,
    fromUTCtoLocalTZ,
    combineLocalDateTime,
    parseHHMM, // keep import (no-op safe)
} from "./esteticaModules/datetime";

/** ===== Config imagen/texto ===== */
const IMAGE_WAIT_MS = Number(process.env.IA_IMAGE_WAIT_MS ?? 1000);
const IMAGE_CARRY_MS = Number(process.env.IA_IMAGE_CARRY_MS ?? 60_000);
const IMAGE_LOOKBACK_MS = Number(process.env.IA_IMAGE_LOOKBACK_MS ?? 5 * 60 * 1000);
const REPLY_DEDUP_WINDOW_MS = Number(process.env.REPLY_DEDUP_WINDOW_MS ?? 120_000);

/** ===== Respuesta breve ===== */
const IA_MAX_LINES = Number(process.env.IA_MAX_LINES ?? 5);
const IA_MAX_CHARS = Number(process.env.IA_MAX_CHARS ?? 1000);
const IA_MAX_TOKENS = Number(process.env.IA_MAX_TOKENS ?? 100);
const IA_ALLOW_EMOJI = (process.env.IA_ALLOW_EMOJI ?? "0") === "1";

/** ===== Idempotencia por inbound (sin DB) ===== */
const processedInbound = new Map<number, number>(); // messageId -> ts
function seenInboundRecently(messageId: number, windowMs = REPLY_DEDUP_WINDOW_MS): boolean {
    const now = Date.now();
    const prev = processedInbound.get(messageId);
    if (prev && now - prev <= windowMs) return true;
    processedInbound.set(messageId, now);
    return false;
}

/** ===== Utils ===== */
function sleep(ms: number) {
    return new Promise((res) => setTimeout(res, ms));
} // no se usa para delay de respuesta

/** Moneda: COP */
function formatCOP(value?: number | null): string | null {
    if (value == null || isNaN(Number(value))) return null;
    return new Intl.NumberFormat("es-CO", {
        style: "currency",
        currency: "COP",
        maximumFractionDigits: 0,
    }).format(Number(value));
}

/** ===== Detección de referencia explícita a imagen ===== */
function mentionsImageExplicitly(t: string) {
    const s = String(t || "").toLowerCase();
    return (
        /\b(foto|imagen|selfie|captura|screenshot)\b/.test(s) ||
        /(mira|revisa|checa|ve|verifica)\s+la\s+(foto|imagen)/.test(s) ||
        /(te\s+mand(e|é)|te\s+envi(e|é))\s+(la\s+)?(foto|imagen)/.test(s) ||
        /\b(de|en)\s+la\s+(foto|imagen)\b/.test(s)
    );
}

/** ===== Selección de imagen contextual ===== */
async function pickImageForContext(opts: {
    conversationId: number;
    directUrl?: string | null;
    userText: string;
    caption: string;
    referenceTs: Date; // timestamp del último texto del cliente
}): Promise<{ url: string | null; noteToAppend: string }> {
    const { conversationId, directUrl, userText, caption, referenceTs } = opts;

    if (directUrl) {
        return {
            url: String(directUrl),
            noteToAppend: caption ? `\n\nNota de la imagen: ${caption}` : "",
        };
    }
    if (!userText) return { url: null, noteToAppend: "" };

    // 1) Ventana corta automática
    const veryRecent = await prisma.message.findFirst({
        where: {
            conversationId,
            from: MessageFrom.client,
            mediaType: MediaType.image,
            timestamp: { gte: new Date(referenceTs.getTime() - IMAGE_CARRY_MS), lte: referenceTs },
        },
        orderBy: { timestamp: "desc" },
        select: { mediaUrl: true, caption: true },
    });
    if (veryRecent?.mediaUrl) {
        const note = veryRecent.caption ? `\n\nNota de la imagen: ${veryRecent.caption}` : "";
        return { url: String(veryRecent.mediaUrl), noteToAppend: note };
    }

    // 2) Mención explícita → lookback largo
    if (mentionsImageExplicitly(userText)) {
        const referenced = await prisma.message.findFirst({
            where: {
                conversationId,
                from: MessageFrom.client,
                mediaType: MediaType.image,
                timestamp: { gte: new Date(referenceTs.getTime() - IMAGE_LOOKBACK_MS), lte: referenceTs },
            },
            orderBy: { timestamp: "desc" },
            select: { mediaUrl: true, caption: true },
        });
        if (referenced?.mediaUrl) {
            const note = referenced.caption ? `\n\nNota de la imagen: ${referenced.caption}` : "";
            return { url: String(referenced.mediaUrl), noteToAppend: note };
        }
    }
    return { url: null, noteToAppend: "" };
}

/** ====== Normalizador & Matchers semánticos ====== */
function norm(s: string) {
    return (s || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
}

function isCatalogQuery(t: string) {
    const s = ` ${norm(t)} `;
    const nouns = ["servicio", "servicios", "procedimiento", "procedimientos", "tratamiento", "tratamientos", "catalogo", "catálogo", "catalog"];
    const intents = ["que ", "qué ", "cuales", "cuáles", "lista", "disponible", "disponibles", "ofreces", "ofrecen", "tienes", "hay", "oferta"];
    const hitNoun = nouns.some(k => s.includes(` ${k} `));
    const hitIntent = intents.some(k => s.includes(k));
    return hitNoun && hitIntent;
}

/** ===== Intents mínimos (texto) ===== */
function detectIntent(
    text: string
): "saludo" | "faq" | "agendar" | "reagendar" | "cancelar" | "confirmar" | "smalltalk" {
    const t = text.toLowerCase();
    if (/(confirmo|confirmar|sí,?\s*correcto|si,?\s*correcto|correcto|dale|listo|agéndala|agendala)/i.test(t))
        return "confirmar";
    if (/(reagendar|cambiar|mover|otra hora|reprogramar)/i.test(t)) return "reagendar";
    if (/(cancelar|anular)/i.test(t)) return "cancelar";
    if (/(cita|agendar|agenda|programar|reservar)/i.test(t)) return "agendar";
    if (/(horario|direccion|dónde|servicios|procedimientos|tratamientos|cat[aá]logo|precios|costo|valor)/i.test(t)) return "faq";
    if (/(hola|buen[oa]s|qué tal|como estas|saludo)/i.test(t)) return "saludo";
    // señal semántica de catálogo
    if (isCatalogQuery(text)) return "faq";
    return "smalltalk";
}

/** ==== Pregunta de precio (incluye “¿qué vale…?”) ==== */
function asksPrice(t: string) {
    const s = (t || "").toLowerCase();
    return (
        /\b(precio|costo|valor|tarifa)\b/i.test(s) ||
        /\bcu[aá]nto\s+(vale|sale)\b/i.test(s) ||
        /\b(que|qué)\s+vale\b/i.test(s)
    );
}

/** ==== Follow-up de precio por contexto reciente (“¿y el peeling?”) ==== */
type LastIntentTag = "price" | "schedule";
function isFollowupPriceAsk(text: string, d?: Draft) {
    const s = (text || "").toLowerCase().trim();
    const looksLikeFollow =
        /^y\s+(el|la|los|las)\b/.test(s) ||
        /\b(peeling|botox|toxina|limpieza|facial|depilaci[oó]n|laser)\b/.test(s);
    const recent = d?.lastIntent === "price" && (Date.now() - (d.lastIntentAt || 0) < 15 * 60_000);
    return looksLikeFollow && !!recent;
}

/** ===== Extractores sencillos ===== */
function extractPhone(text: string): string | undefined {
    const clean = text.replace(/[^\d+]/g, " ");
    const m = /(\+?57)?\s*(\d{10})\b/.exec(clean);
    return m ? m[2] : undefined;
}
function extractName(text: string): string | undefined {
    const m = /(soy|me llamo)\s+([a-záéíóúñ\s]{2,40})/i.exec(text);
    if (m) return m[2].trim().replace(/\s+/g, " ").replace(/^\p{L}/u, (c: string) => c.toUpperCase());
    return undefined;
}
function extractTime(text: string): string | undefined {
    const m = /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(text);
    return m ? `${m[1].padStart(2, "0")}:${m[2]}` : undefined;
}

/** ===== Util: duración segura del servicio ===== */
function readSvcDuration(svc: any, kbRules?: any): number | undefined {
    if (!svc) return undefined;
    return svc.duration ?? svc.durationMin ?? kbRules?.defaultServiceDurationMin;
}

/** ===== Estado temporal (borrador) ===== */
type DraftStage =
    | "oferta"
    | "confirm"
    | "reagendar_pedir"
    | "reagendar_confirm"
    | "cancel_confirm";
type Draft = {
    empresaId: number;
    serviceId?: number;
    serviceName?: string;
    duration?: number;
    whenUTC?: string; // ISO (para agendar o nueva fecha en reagendar)
    name?: string;
    phone?: string;
    stage?: DraftStage;
    // Para reagendar/cancelar:
    targetApptId?: number;

    // === Memoria de intención para follow-ups ===
    lastIntent?: LastIntentTag;
    lastIntentAt?: number; // Date.now()
};

async function getDraft(chatId: number): Promise<Draft | undefined> {
    const last = await prisma.message.findFirst({
        where: {
            conversationId: chatId,
            from: MessageFrom.bot,
            contenido: { startsWith: "[DEBUG booking]" },
        },
        orderBy: { id: "desc" },
        select: { contenido: true },
    });
    if (!last) return;
    try {
        return JSON.parse(last.contenido.replace("[DEBUG booking] ", "")) as Draft;
    } catch {
        return;
    }
}
async function putDraft(chatId: number, d: Draft) {
    await prisma.message.create({
        data: {
            empresaId: d.empresaId,
            conversationId: chatId,
            from: MessageFrom.bot,
            contenido: `[DEBUG booking] ${JSON.stringify(d)}`,
        } as any,
    });
}

/** ===== Historial compacto ===== */
async function getRecentHistory(
    conversationId: number,
    excludeMessageId?: number,
    take = 10
) {
    const where: Prisma.MessageWhereInput = { conversationId };
    if (excludeMessageId) where.id = { not: excludeMessageId };
    const rows = await prisma.message.findMany({
        where,
        orderBy: { timestamp: "desc" },
        take,
        select: { from: true, contenido: true },
    });
    return rows.reverse().map((r) => ({
        role: r.from === MessageFrom.client ? "user" : "assistant",
        content: softTrim(r.contenido || "", 220),
    }));
}

/** ===== Persistencia y envío ===== */
function normalizeToE164(n: string) {
    return String(n || "").replace(/[^\d]/g, "");
}
async function persistBotReply({
    conversationId,
    empresaId,
    texto,
    nuevoEstado,
    to,
    phoneNumberId,
}: {
    conversationId: number;
    empresaId: number;
    texto: string;
    nuevoEstado: ConversationEstado;
    to?: string;
    phoneNumberId?: string;
}) {
    const msg = await prisma.message.create({
        data: { conversationId, from: MessageFrom.bot, contenido: texto, empresaId },
    });
    await prisma.conversation.update({
        where: { id: conversationId },
        data: { estado: nuevoEstado },
    });

    let wamid: string | undefined;
    if (to && String(to).trim()) {
        try {
            const resp = await Wam.sendWhatsappMessage({
                empresaId,
                to: normalizeToE164(to),
                body: texto,
                phoneNumberIdHint: phoneNumberId,
            });
            wamid = (resp as any)?.data?.messages?.[0]?.id || (resp as any)?.messages?.[0]?.id;
            if (wamid)
                await prisma.message.update({
                    where: { id: msg.id },
                    data: { externalId: wamid },
                });
        } catch {
            /* noop */
        }
    }
    return { messageId: msg.id, texto, wamid };
}

/** ===== prompt budgeting / formato breve ===== */
function softTrim(s: string | null | undefined, max = 140) {
    const t = (s || "").trim();
    if (!t) return "";
    return t.length <= max ? t : t.slice(0, max).replace(/\s+[^\s]*$/, "") + "…";
}
function approxTokens(str: string) {
    return Math.ceil((str || "").length / 4);
}
function clampConcise(text: string, maxLines = IA_MAX_LINES, _maxChars = IA_MAX_CHARS): string {
    let t = String(text || "").replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    const lines = t ? t.split("\n").filter(Boolean) : [];
    if (lines.length > maxLines) {
        t = lines.slice(0, maxLines).join("\n").trim();
        if (!/[.!?…]$/.test(t)) t += "…";
    }
    return t;
}
function formatConcise(
    text: string,
    maxLines = IA_MAX_LINES,
    maxChars = IA_MAX_CHARS,
    allowEmoji = IA_ALLOW_EMOJI
): string {
    let t = String(text || "").trim();
    if (!t) return "Gracias por escribirnos. ¿Cómo puedo ayudarte?";
    t = t.replace(/^[•\-]\s*/gm, "").replace(/\s+\n/g, "\n").replace(/\n{2,}/g, "\n").trim();
    t = clampConcise(t, maxLines, maxChars);
    if (allowEmoji && !/[^\w\s.,;:()¿?¡!…]/.test(t)) {
        const EMOJIS = ["🙂", "💡", "👌", "✅", "✨", "🧴", "💬", "🫶"];
        t = `${t} ${EMOJIS[Math.floor(Math.random() * EMOJIS.length)]}`;
        t = clampConcise(t, maxLines, maxChars);
    }
    return t;
}
function endsWithPunctuation(t: string) {
    return /[.!?…]\s*$/.test((t || "").trim());
}
function closeNicely(raw: string): string {
    let t = (raw || "").trim();
    if (!t) return t;
    if (endsWithPunctuation(t)) return t;
    t = t.replace(/\s+[^\s]*$/, "").trim();
    if (!t) return raw.trim();
    return `${t}…`;
}
function budgetMessages(messages: any[], budgetPromptTokens = 110) {
    const sys = messages.find((m: any) => m.role === "system");
    const user = messages.find((m: any) => m.role === "user");
    if (!sys) return messages;

    const sysText = String(sys.content || "");
    const userText =
        typeof user?.content === "string"
            ? user?.content
            : Array.isArray(user?.content)
                ? String(user?.content?.[0]?.text || "")
                : "";

    let total = approxTokens(sysText) + approxTokens(userText);
    for (const m of messages) {
        if (m.role !== "system" && m !== user) {
            const t =
                typeof m.content === "string"
                    ? m.content
                    : Array.isArray(m.content)
                        ? String(m.content?.[0]?.text || "")
                        : "";
            total += approxTokens(t);
        }
    }
    if (total <= budgetPromptTokens) return messages;

    const lines = sysText.split("\n").map((l: string) => l.trim()).filter(Boolean);
    const keep: string[] = [];
    for (const l of lines) {
        if (
            /Asistente de clínica estética|Responde en|Puedes usar|Mantente|Ámbito:|Incluye cuando|Sigue estas/i.test(
                l
            )
        )
            keep.push(l);
        if (keep.length >= 6) break;
    }
    (sys as any).content = keep.join("\n") || lines.slice(0, 6).join("\n");

    if (typeof user?.content === "string") {
        const ut = String(user.content);
        user.content = ut.length > 200 ? ut.slice(0, 200) : ut;
    } else if (Array.isArray(user?.content)) {
        const ut = String(user.content?.[0]?.text || "");
        user.content[0].text = softTrim(ut, 200);
    }
    return messages;
}

/** ====== Helpers de citas (offset 5h en APPOINTMENT) ====== */
const APPT_DB_OFFSET_MIN = 300; // 5 horas
const addMinutes = (d: Date, min: number) => new Date(d.getTime() + min * 60000);
const applyApptOffsetWrite = (utc: Date) => addMinutes(utc, -APPT_DB_OFFSET_MIN);
const applyApptOffsetRead = (dbUtcWithOffset: Date) => addMinutes(dbUtcWithOffset, APPT_DB_OFFSET_MIN);

async function getUpcomingAppointmentForConversation(empresaId: number, conversationId: number) {
    const nowUTC = new Date();
    const nowDB = applyApptOffsetWrite(nowUTC);
    const appt = await prisma.appointment.findFirst({
        where: {
            empresaId,
            conversationId,
            status: {
                in: [AppointmentStatus.pending, AppointmentStatus.confirmed, AppointmentStatus.rescheduled],
            },
            startAt: { gte: nowDB },
            deletedAt: null,
        },
        orderBy: { startAt: "asc" },
        select: {
            id: true,
            serviceName: true,
            startAt: true,
            endAt: true,
            timezone: true,
            customerName: true,
            customerPhone: true,
            serviceDurationMin: true,
        },
    });
    if (!appt) return null;
    return {
        ...appt,
        startAt: applyApptOffsetRead(appt.startAt),
        endAt: applyApptOffsetRead(appt.endAt),
    };
}

/** ===== Helpers: lista de servicios habilitados ===== */
function listEnabledServices(kb: any, max = 12): string {
    const names = (kb?.services ?? [])
        .filter((s: any) => s && s.enabled !== false)
        .map((s: any) => s.name);
    return names.slice(0, max).join(", ");
}

/** ====== Clasificador LLM de intención (B) ====== */
async function classifyIntentLLM(text: string): Promise<"catalog" | "price" | "schedule" | "reschedule" | "cancel" | "other"> {
    const sys = "Clasifica el mensaje del usuario en una sola etiqueta: catalog|price|schedule|reschedule|cancel|other. SOLO responde la etiqueta.";
    try {
        const resp = await (openai.chat.completions.create as any)({
            model: process.env.IA_TEXT_MODEL || process.env.IA_MODEL || "gpt-4o-mini",
            temperature: 0,
            max_tokens: 3,
            messages: [{ role: "system", content: sys }, { role: "user", content: String(text || "").slice(0, 200) }],
        });
        const tag = resp?.choices?.[0]?.message?.content?.trim()?.toLowerCase() || "other";
        if (["catalog", "price", "schedule", "reschedule", "cancel", "other"].includes(tag)) return tag as any;
        return "other";
    } catch {
        return "other";
    }
}

/** ===== Helper: ejecución con control de tokens ===== */
async function runChatWithBudget({
    model,
    messages,
    temperature,
    maxTokens,
}: {
    model: string;
    messages: any[];
    temperature: number;
    maxTokens: number;
}) {
    try {
        const resp = await (openai.chat.completions.create as any)({
            model,
            messages,
            temperature,
            max_tokens: maxTokens,
        });
        return resp?.choices?.[0]?.message?.content?.trim() || "";
    } catch (e) {
        const resp2 = await (openai.chat.completions.create as any)({
            model,
            messages,
            temperature,
            max_tokens: 32,
        });
        return resp2?.choices?.[0]?.message?.content?.trim() || "";
    }
}

/** ======= PUBLIC: handleEsteticaReply ======= */
export async function handleEsteticaReply(args: {
    chatId: number;
    empresaId: number;
    mensajeArg?: string;
    toPhone?: string;
    phoneNumberId?: string;
    apptConfig?: {
        timezone: string;
        bufferMin: number;
        vertical: AppointmentVertical | "custom";
        verticalCustom: string | null;
        enabled: boolean;
        policies: string | null;
        reminders: boolean;
        services?: string[];
        servicesText?: string;
        logistics?: {
            locationName?: string;
            locationAddress?: string;
            locationMapsUrl?: string;
            virtualMeetingLink?: string;
            parkingInfo?: string;
            instructionsArrival?: string;
        };
        rules?: Record<string, any>;
        remindersConfig?: Record<string, any>;
        kb?: Record<string, any>;
    };
}): Promise<IAReplyResult> {
    const { chatId, empresaId, mensajeArg = "", toPhone, phoneNumberId } = args;

    // 1) Conversación y último inbound del cliente
    const conversacion = await prisma.conversation.findUnique({
        where: { id: chatId },
        select: { id: true, estado: true, phone: true },
    });
    if (!conversacion) return { estado: ConversationEstado.pendiente, mensaje: "" };

    const last = await prisma.message.findFirst({
        where: { conversationId: chatId, from: MessageFrom.client },
        orderBy: { timestamp: "desc" },
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

    // 🔒 Idempotencia inbound
    if (last?.id && seenInboundRecently(last.id)) {
        if (process.env.DEBUG_AI === "1")
            console.log("[EST] Skip: inbound already processed", { lastId: last.id });
        return { estado: conversacion.estado, mensaje: "" };
    }

    // 2) KB
    const kb = await loadEsteticaKB(empresaId);
    if (!kb) {
        return {
            estado: ConversationEstado.requiere_agente,
            mensaje:
                "Ahora mismo no tengo la configuración completa de la clínica. Te comunico con un asesor humano. 🙏",
        };
    }

    // 3) Texto del usuario (nota de voz → transcripción si aplica)
    let userText = (mensajeArg || "").trim();
    if (!userText && last?.isVoiceNote) {
        let transcript = (last.transcription || "").trim();
        if (!transcript) {
            try {
                let audioBuf: Buffer | null = null;
                if (last.mediaUrl && /^https?:\/\//i.test(String(last.mediaUrl))) {
                    const { data } = await axios.get(String(last.mediaUrl), {
                        responseType: "arraybuffer",
                        timeout: 30000,
                    });
                    audioBuf = Buffer.from(data);
                }
                if (audioBuf) {
                    const name =
                        last.mimeType?.includes("mpeg")
                            ? "audio.mp3"
                            : last.mimeType?.includes("wav")
                                ? "audio.wav"
                                : last.mimeType?.includes("m4a")
                                    ? "audio.m4a"
                                    : last.mimeType?.includes("webm")
                                        ? "audio.webm"
                                        : "audio.ogg";
                    transcript = await transcribeAudioBuffer(audioBuf, name);
                    if (transcript)
                        await prisma.message.update({
                            where: { id: last.id },
                            data: { transcription: transcript },
                        });
                }
            } catch (e) {
                if (process.env.DEBUG_AI === "1")
                    console.error("[EST] Transcription error:", (e as any)?.message || e);
            }
        }
        if (transcript) userText = transcript;
    }

    const isImage = last?.mediaType === MediaType.image && !!last?.mediaUrl;
    const imageUrl = isImage ? String(last?.mediaUrl) : null;
    const caption = String(last?.caption || "").trim();
    const referenceTs = last?.timestamp ?? new Date();

    // Debounce por conversación
    if (isImage) {
        if (!caption && !userText) {
            if (process.env.DEBUG_AI === "1") console.log("[EST] Image-only: defer to upcoming text");
            await sleep(IMAGE_WAIT_MS);
            return { estado: conversacion.estado, mensaje: "" };
        }
    }

    // 4) INTENT + flujo de agenda (draft/confirmaciones)
    let intent = detectIntent(userText || caption || "");
    // === B: clasificador LLM si quedó en smalltalk ===
    if (intent === "smalltalk") {
        const tag = await classifyIntentLLM(userText || caption || "");
        if (tag === "catalog") intent = "faq";
        else if (tag === "price") intent = "faq"; // el bloque de precio maneja asksPrice + follow-up
        else if (tag === "schedule") intent = "agendar";
        else if (tag === "reschedule") intent = "reagendar";
        else if (tag === "cancel") intent = "cancelar";
    }

    const draft = (await getDraft(chatId)) ?? ({ empresaId } as Draft);

    // Resolver servicio por texto o mantener el previo (solo para agendar)
    const svc =
        resolveServiceName(kb, userText) ??
        (draft.serviceId ? kb.services.find((s: any) => s.id === draft.serviceId) ?? null : null);
    if (svc && (!draft.serviceId || draft.serviceId !== svc.id)) {
        draft.serviceId = svc.id;
        draft.serviceName = svc.name;
        draft.duration = readSvcDuration(svc, (kb as any)?.rules) ?? 60;
    }

    // Fecha relativa + hora (si vienen)
    const rel = parseRelativeDateText(userText, kb.timezone);
    const hhmm = extractTime(userText);
    if (rel.ok && hhmm) {
        draft.whenUTC = combineLocalDateTime(rel.localStart, hhmm, kb.timezone).toISOString();
    }

    // Nombre / Teléfono
    const name = extractName(userText);
    const phone = extractPhone(userText);
    if (name) draft.name = name;
    if (phone) draft.phone = phone;

    /** ==== Ajuste: si preguntan por horarios y hay servicio en contexto → agendar ==== */
    const askedForSlots = /\b(horario|horarios|disponibilidad|cupos?)\b/i.test(userText);
    if (intent === "faq" && askedForSlots && (svc || draft.serviceId)) {
        intent = "agendar";
    }

    /** ==== Preguntas de precio de un servicio específico (con follow-up) ==== */
    if ((asksPrice(userText) || isFollowupPriceAsk(userText, draft)) && svc) {
        const pLabel = serviceDisplayPrice(svc); // “$X.XXX”
        const dep = formatCOP((svc as any).deposit ?? null);
        const note = (svc as any).priceNote as string | null | undefined;
        const dur = readSvcDuration(svc, (kb as any)?.rules);

        const priceLine = pLabel ? `tiene un valor *desde ${pLabel}*.` : `no tiene un precio registrado en el sistema.`;
        const depLine = dep ? ` Requerimos un anticipo de ${dep} para reservar.` : "";
        const noteLine = note ? ` ${note}` : "";
        const durLine = dur ? ` La sesión dura aproximadamente *${dur} min*.` : "";

        const cuerpo = `El tratamiento de *${svc.name}* ${priceLine}${durLine}${depLine}${noteLine} ¿Te paso opciones de horario?`;

        // Memorizar intención
        draft.lastIntent = "price";
        draft.lastIntentAt = Date.now();
        await putDraft(chatId, draft);

        const saved = await persistBotReply({
            conversationId: chatId,
            empresaId,
            texto: cuerpo,
            nuevoEstado: ConversationEstado.en_proceso,
            to: toPhone ?? conversacion.phone,
            phoneNumberId,
        });
        return {
            estado: ConversationEstado.en_proceso,
            mensaje: saved.texto,
            messageId: saved.messageId,
            wamid: saved.wamid,
            media: [],
        };
    }

    /** ====== AGENDAR ====== */
    if (intent === "agendar") {
        if (draft.serviceId && draft.whenUTC && draft.name && draft.phone && draft.stage !== "confirm") {
            draft.stage = "confirm";
            await putDraft(chatId, draft);
            const local = fromUTCtoLocalTZ(new Date(draft.whenUTC), kb.timezone);
            const fecha = local.toLocaleDateString("es-CO", {
                weekday: "long",
                year: "numeric",
                month: "long",
                day: "2-digit",
            });
            const hora = local.toLocaleTimeString("es-CO", {
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
            });
            const resumen =
                `Voy a reservar tu cita, ¿me confirmas por favor?\n` +
                `• Servicio: ${draft.serviceName}\n` +
                `• Fecha/Hora: ${fecha} a las ${hora}\n` +
                `• Nombre: ${draft.name}\n` +
                `• Teléfono: ${draft.phone}\n\n` +
                `Si está correcto, dime *"confirmo"* y la agendo ✅`;
            const saved = await persistBotReply({
                conversationId: chatId,
                empresaId,
                texto: resumen,
                nuevoEstado: ConversationEstado.en_proceso,
                to: toPhone ?? conversacion.phone,
                phoneNumberId,
            });
            return {
                estado: ConversationEstado.en_proceso,
                mensaje: saved.texto,
                messageId: saved.messageId,
                wamid: saved.wamid,
                media: [],
            };
        }

        if (!svc) {
            const hint = `Perfecto. Trabajo con los servicios habilitados de la clínica. ¿Cuál te interesa? (Ej.: ${kb.services
                .slice(0, 3)
                .map((s: any) => s.name)
                .join(", ")})`;
            const saved = await persistBotReply({
                conversationId: chatId,
                empresaId,
                texto: hint,
                nuevoEstado: ConversationEstado.en_proceso,
                to: toPhone ?? conversacion.phone,
                phoneNumberId,
            });
            return {
                estado: ConversationEstado.en_proceso,
                mensaje: saved.texto,
                messageId: saved.messageId,
                wamid: saved.wamid,
                media: [],
            };
        }

        const duration = draft.duration ?? readSvcDuration(svc, (kb as any)?.rules) ?? 60;

        const nowLocal = new Date();
        const anchorLocal = rel.ok ? rel.localStart : nowLocal;
        const anchorUTC = fromLocalTZToUTC(anchorLocal, kb.timezone);

        const slots: SlotView[] = await findNextSlots({
            empresaId,
            timezone: kb.timezone,
            serviceDurationMin: duration,
            fromDateUTC: anchorUTC,
            days: 14,
            bufferMin: kb.bufferMin ?? 10,
        });

        if (!slots.length) {
            const txt = `Puedo ayudarte con *${svc.name}*, pero no veo horarios disponibles en los próximos días. ¿Te contacto con un asesor para coordinar?`;
            const saved = await persistBotReply({
                conversationId: chatId,
                empresaId,
                texto: txt,
                nuevoEstado: ConversationEstado.en_proceso,
                to: toPhone ?? conversacion.phone,
                phoneNumberId,
            });
            return {
                estado: ConversationEstado.en_proceso,
                mensaje: saved.texto,
                messageId: saved.messageId,
                wamid: saved.wamid,
                media: [],
            };
        }

        draft.serviceId = svc.id;
        draft.serviceName = svc.name;
        draft.duration = duration;
        draft.stage = "oferta";
        // memorizar intención
        draft.lastIntent = "schedule";
        draft.lastIntentAt = Date.now();
        await putDraft(chatId, draft);

        const primeros = slots.slice(0, 5).map((s) => `• ${s.label}`).join("\n");
        const prompt =
            `Para *${svc.name}* tengo estas opciones próximas:\n${primeros}\n\n` +
            `¿Te funciona alguna? Si ya tienes fecha/hora exacta, dímela (ej. “mañana 10:30”). También necesito tu *nombre* y *teléfono* para reservar.`;
        const saved = await persistBotReply({
            conversationId: chatId,
            empresaId,
            texto: prompt,
            nuevoEstado: ConversationEstado.en_proceso,
            to: toPhone ?? conversacion.phone,
            phoneNumberId,
        });
        return {
            estado: ConversationEstado.en_proceso,
            mensaje: saved.texto,
            messageId: saved.messageId,
            wamid: saved.wamid,
            media: [],
        };
    }

    if (
        intent === "confirmar" &&
        draft.stage === "confirm" &&
        draft.serviceId &&
        draft.whenUTC &&
        draft.name &&
        draft.phone
    ) {
        try {
            await bookAppointment({
                empresaId,
                conversationId: chatId,
                customerName: draft.name!,
                customerPhone: draft.phone!,
                serviceName: draft.serviceName!,
                serviceDurationMin: draft.duration ?? 60,
                timezone: kb.timezone,
                startAtUTC: new Date(draft.whenUTC),
                source: "ai",
            });
            const local = fromUTCtoLocalTZ(new Date(draft.whenUTC), kb.timezone);
            const fecha = local.toLocaleDateString("es-CO", {
                weekday: "long",
                year: "numeric",
                month: "long",
                day: "2-digit",
            });
            const hora = local.toLocaleTimeString("es-CO", {
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
            });

            const ok = `¡Listo! Tu cita de *${draft.serviceName}* quedó para **${fecha} a las ${hora}** a nombre de *${draft.name}*. 📅`;
            const saved = await persistBotReply({
                conversationId: chatId,
                empresaId,
                texto: ok,
                nuevoEstado: ConversationEstado.en_proceso,
                to: toPhone ?? conversacion.phone,
                phoneNumberId,
            });
            return {
                estado: ConversationEstado.en_proceso,
                mensaje: saved.texto,
                messageId: saved.messageId,
                wamid: saved.wamid,
                media: [],
            };
        } catch (e: any) {
            const fail = `Ese horario acaba de ocuparse. ¿Te paso 5 opciones cercanas para *${draft.serviceName}*?`;
            const saved = await persistBotReply({
                conversationId: chatId,
                empresaId,
                texto: fail,
                nuevoEstado: ConversationEstado.en_proceso,
                to: toPhone ?? conversacion.phone,
                phoneNumberId,
            });
            return {
                estado: ConversationEstado.en_proceso,
                mensaje: saved.texto,
                messageId: saved.messageId,
                wamid: saved.wamid,
                media: [],
            };
        }
    }

    /** ====== REAGENDAR ====== */
    if (intent === "reagendar") {
        const appt = await getUpcomingAppointmentForConversation(empresaId, chatId);
        if (!appt) {
            const txt =
                `No encuentro una cita futura asociada a esta conversación. ` +
                `¿Podrías indicarme el *nombre completo* con el que quedó la reserva o el *teléfono*?`;
            const saved = await persistBotReply({
                conversationId: chatId,
                empresaId,
                texto: txt,
                nuevoEstado: ConversationEstado.en_proceso,
                to: toPhone ?? conversacion.phone,
                phoneNumberId,
            });
            return {
                estado: ConversationEstado.en_proceso,
                mensaje: saved.texto,
                messageId: saved.messageId,
                wamid: saved.wamid,
                media: [],
            };
        }

        draft.targetApptId = appt.id;
        draft.stage = "reagendar_pedir";
        await putDraft(chatId, draft);

        const local = fromUTCtoLocalTZ(appt.startAt, appt.timezone || kb.timezone);
        const fecha = local.toLocaleDateString("es-CO", {
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "2-digit",
        });
        const hora = local.toLocaleTimeString("es-CO", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
        });
        const ask = `Tienes *${appt.serviceName}* para **${fecha} a las ${hora}**. Dime la *nueva fecha y hora* (ej. “mañana 10:30”) y te paso la confirmación.`;
        const saved = await persistBotReply({
            conversationId: chatId,
            empresaId,
            texto: ask,
            nuevoEstado: ConversationEstado.en_proceso,
            to: toPhone ?? conversacion.phone,
            phoneNumberId,
        });
        return {
            estado: ConversationEstado.en_proceso,
            mensaje: saved.texto,
            messageId: saved.messageId,
            wamid: saved.wamid,
            media: [],
        };
    }

    // Si ya estamos en etapa de reagendar y recibimos una nueva fecha/hora → confirmar
    if (draft.stage === "reagendar_pedir" && draft.targetApptId) {
        if (rel.ok && hhmm) {
            draft.whenUTC = combineLocalDateTime(rel.localStart, hhmm, kb.timezone).toISOString();
            draft.stage = "reagendar_confirm";
            await putDraft(chatId, draft);

            const local = fromUTCtoLocalTZ(new Date(draft.whenUTC), kb.timezone);
            const fecha = local.toLocaleDateString("es-CO", {
                weekday: "long",
                year: "numeric",
                month: "long",
                day: "2-digit",
            });
            const hora = local.toLocaleTimeString("es-CO", {
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
            });
            const resumen = `¿Confirmas mover tu cita a **${fecha} a las ${hora}**? Di *"confirmo"* y la reagendo ✅`;
            const saved = await persistBotReply({
                conversationId: chatId,
                empresaId,
                texto: resumen,
                nuevoEstado: ConversationEstado.en_proceso,
                to: toPhone ?? conversacion.phone,
                phoneNumberId,
            });
            return {
                estado: ConversationEstado.en_proceso,
                mensaje: saved.texto,
                messageId: saved.messageId,
                wamid: saved.wamid,
                media: [],
            };
        } else {
            const hint = `Entiendo, dime la *fecha y hora exacta* (ej. “pasado mañana 15:00”) para reagendar.`;
            const saved = await persistBotReply({
                conversationId: chatId,
                empresaId,
                texto: hint,
                nuevoEstado: ConversationEstado.en_proceso,
                to: toPhone ?? conversacion.phone,
                phoneNumberId,
            });
            return {
                estado: ConversationEstado.en_proceso,
                mensaje: saved.texto,
                messageId: saved.messageId,
                wamid: saved.wamid,
                media: [],
            };
        }
    }

    if (intent === "confirmar" && draft.stage === "reagendar_confirm" && draft.targetApptId && draft.whenUTC) {
        try {
            await rescheduleAppointment({
                empresaId,
                appointmentId: draft.targetApptId,
                newStartAtUTC: new Date(draft.whenUTC),
            });

            const local = fromUTCtoLocalTZ(new Date(draft.whenUTC), kb.timezone);
            const fecha = local.toLocaleDateString("es-CO", {
                weekday: "long",
                year: "numeric",
                month: "long",
                day: "2-digit",
            });
            const hora = local.toLocaleTimeString("es-CO", {
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
            });
            const ok = `¡Hecho! Reagendé tu cita para **${fecha} a las ${hora}**.`;
            const saved = await persistBotReply({
                conversationId: chatId,
                empresaId,
                texto: ok,
                nuevoEstado: ConversationEstado.en_proceso,
                to: toPhone ?? conversacion.phone,
                phoneNumberId,
            });
            return {
                estado: ConversationEstado.en_proceso,
                mensaje: saved.texto,
                messageId: saved.messageId,
                wamid: saved.wamid,
                media: [],
            };
        } catch (e: any) {
            const fail = `Ese nuevo horario acaba de ocuparse. ¿Te comparto otras opciones cercanas?`;
            const saved = await persistBotReply({
                conversationId: chatId,
                empresaId,
                texto: fail,
                nuevoEstado: ConversationEstado.en_proceso,
                to: toPhone ?? conversacion.phone,
                phoneNumberId,
            });
            return {
                estado: ConversationEstado.en_proceso,
                mensaje: saved.texto,
                messageId: saved.messageId,
                wamid: saved.wamid,
                media: [],
            };
        }
    }

    /** ====== CANCELAR ====== */
    if (intent === "cancelar") {
        const appt = await getUpcomingAppointmentForConversation(empresaId, chatId);
        if (!appt) {
            const txt =
                `No encuentro una cita futura asociada a esta conversación. ` +
                `¿Podrías indicarme el *nombre completo* o el *teléfono* con el que quedó la reserva?`;
            const saved = await persistBotReply({
                conversationId: chatId,
                empresaId,
                texto: txt,
                nuevoEstado: ConversationEstado.en_proceso,
                to: toPhone ?? conversacion.phone,
                phoneNumberId,
            });
            return {
                estado: ConversationEstado.en_proceso,
                mensaje: saved.texto,
                messageId: saved.messageId,
                wamid: saved.wamid,
                media: [],
            };
        }
        draft.targetApptId = appt.id;
        draft.stage = "cancel_confirm";
        await putDraft(chatId, draft);

        const local = fromUTCtoLocalTZ(appt.startAt, appt.timezone || kb.timezone);
        const fecha = local.toLocaleDateString("es-CO", {
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "2-digit",
        });
        const hora = local.toLocaleTimeString("es-CO", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
        });
        const ask = `Vas a cancelar *${appt.serviceName}* del **${fecha} a las ${hora}**. ¿Lo confirmas? Di *"confirmo"* y la cancelo.`;
        const saved = await persistBotReply({
            conversationId: chatId,
            empresaId,
            texto: ask,
            nuevoEstado: ConversationEstado.en_proceso,
            to: toPhone ?? conversacion.phone,
            phoneNumberId,
        });
        return {
            estado: ConversationEstado.en_proceso,
            mensaje: saved.texto,
            messageId: saved.messageId,
            wamid: saved.wamid,
            media: [],
        };
    }

    if (intent === "confirmar" && draft.stage === "cancel_confirm" && draft.targetApptId) {
        await cancelAppointment(empresaId, draft.targetApptId, "Cancelación solicitada por el cliente (IA).");
        const ok = `Tu cita fue cancelada ✅. Si deseas, puedo proponerte nuevos horarios.`;
        const saved = await persistBotReply({
            conversationId: chatId,
            empresaId,
            texto: ok,
            nuevoEstado: ConversationEstado.en_proceso,
            to: toPhone ?? conversacion.phone,
            phoneNumberId,
        });
        return {
            estado: ConversationEstado.en_proceso,
            mensaje: saved.texto,
            messageId: saved.messageId,
            wamid: saved.wamid,
            media: [],
        };
    }

    /** ==== FAQ catálogo: detectar con matcher semántico (A) ==== */
    if (isCatalogQuery(userText || caption || "")) {
        const serviciosTxt = listEnabledServices(kb);
        const cuerpo = serviciosTxt
            ? `Estos son nuestros servicios disponibles: ${serviciosTxt}.\n¿Te interesa agendar alguno en particular?`
            : `Por ahora no tengo servicios configurados para agendar. Si quieres, te doy orientación general sobre tratamientos estéticos.`;
        const saved = await persistBotReply({
            conversationId: chatId,
            empresaId,
            texto: cuerpo,
            nuevoEstado: ConversationEstado.en_proceso,
            to: toPhone ?? conversacion.phone,
            phoneNumberId,
        });
        return {
            estado: ConversationEstado.en_proceso,
            mensaje: saved.texto,
            messageId: saved.messageId,
            wamid: saved.wamid,
            media: [],
        };
    }

    /** ==== Saludo sin listar catálogo genérico ==== */
    if (intent === "saludo" && !svc && !/servicio/i.test(userText)) {
        const saludo =
            `¡Hola! Soy el asistente de la clínica estética. ` +
            `Puedo ayudarte con orientación y agendar tu cita. ¿Qué procedimiento te interesa?`;
        const saved = await persistBotReply({
            conversationId: chatId,
            empresaId,
            texto: saludo,
            nuevoEstado: ConversationEstado.en_proceso,
            to: toPhone ?? conversacion.phone,
            phoneNumberId,
        });
        return {
            estado: ConversationEstado.en_proceso,
            mensaje: saved.texto,
            messageId: saved.messageId,
            wamid: saved.wamid,
            media: [],
        };
    }

    /** ====== SALUDO / FAQ / GENERAL (LLM con imagen) ====== */
    const baseIntro = kb.empresaNombre
        ? `Asistente de clínica estética de "${kb.empresaNombre}".`
        : `Asistente de clínica estética.`;
    const system = [
        baseIntro,
        "Habla en primera persona (yo), cercano y profesional. Responde en 2–5 líneas, específico, sin párrafos largos.",
        "Puedes usar 1 emoji ocasionalmente.",
        "Mantente en el ámbito de estética (orientación y agenda).",
        // 👇 REGLAS DURAS DE SERVICIOS/PRECIOS
        "Al listar u ofrecer servicios para agendar usa SOLO los que estén en la base de datos (kb.services).",
        "Si el cliente menciona un tratamiento que NO está en kb.services, puedes dar orientación general, pero NO lo ofrezcas para agendar; sugiere alguno equivalente del catálogo.",
        "Si preguntan por servicios/horarios/dirección/políticas, usa SOLO la información del negocio (KB).",
        "NO menciones precios a menos que el usuario lo pida explícitamente.",
        "Cuando menciones precio usa únicamente el campo priceMin del KB, con el formato: “Desde $X (COP)”. Si no hay priceMin, di: “No tengo precio registrado”. Nunca inventes cifras.",
        kb.kbTexts.businessOverview ? `Contexto negocio: ${softTrim(kb.kbTexts.businessOverview, 220)}` : "",
        kb.logistics?.locationAddress ? `Dirección: ${kb.logistics.locationAddress}` : "",
        kb.logistics?.locationName ? `Sede: ${kb.logistics.locationName}` : "",
        kb.logistics?.locationMapsUrl ? `Maps: ${kb.logistics.locationMapsUrl}` : "",
        kb.kbTexts.disclaimers ? `Avisos: ${softTrim(kb.kbTexts.disclaimers, 220)}` : "",
        "Si detectas intención de agendar, guía a escoger un servicio habilitado y ofrece horarios.",
    ]
        .filter(Boolean)
        .join("\n");

    const history = await getRecentHistory(chatId, last?.id, 10);

    // Imagen contextual
    let effectiveImageUrl = isImage ? imageUrl : null;
    let textForLLM = (userText || caption || "Hola").trim();
    if (!effectiveImageUrl && textForLLM) {
        const picked = await pickImageForContext({
            conversationId: chatId,
            directUrl: null,
            userText: textForLLM,
            caption,
            referenceTs,
        });
        effectiveImageUrl = picked.url;
        if (picked.noteToAppend) textForLLM = `${textForLLM}${picked.noteToAppend}`;
    }

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
    budgetMessages(messages, Number(process.env.IA_PROMPT_BUDGET ?? 110));

    const model = process.env.IA_TEXT_MODEL || process.env.IA_MODEL || "gpt-4o-mini";
    const temperature = Number(process.env.IA_TEMPERATURE ?? 0.35);

    let texto = "";
    try {
        texto = await runChatWithBudget({
            model,
            messages,
            temperature,
            maxTokens: IA_MAX_TOKENS,
        });
    } catch (err: any) {
        console.error("[EST] OpenAI error (final):", err?.response?.data || err?.message || err);
        texto = "Gracias por escribirnos. Te puedo orientar sobre procedimientos y agendar tu cita.";
    }
    texto = closeNicely(texto);
    texto = formatConcise(texto, IA_MAX_LINES, IA_MAX_CHARS, IA_ALLOW_EMOJI);

    // Blindaje: reemplazar montos solo cuando NO es un intercambio de precio/follow-up
    const MONEY_RE = /\$?\s?\d{2,3}(?:\.\d{3})*(?:,\d{2})?/g;
    if (!(asksPrice(userText) || isFollowupPriceAsk(userText, draft))) {
        texto = texto.replace(MONEY_RE, "precio según valoración");
    }

    // ⛔️ SIN DELAY: respondemos de inmediato
    const saved = await persistBotReply({
        conversationId: chatId,
        empresaId,
        texto,
        nuevoEstado: ConversationEstado.respondido,
        to: toPhone ?? conversacion.phone,
        phoneNumberId,
    });

    return {
        estado: ConversationEstado.respondido,
        mensaje: saved.texto,
        messageId: saved.messageId,
        wamid: saved.wamid,
        media: [],
    };
}
